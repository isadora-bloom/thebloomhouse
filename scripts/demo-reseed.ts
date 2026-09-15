/**
 * demo-reseed — reseed the Crestwood demo venues through linkSignal, with
 * a live clock.
 *
 * NOVEMBER-PLAN.md wave 2, workstream W19. Implements DEMO-RESEED-DESIGN.md.
 *
 * The two findings this closes, both from the 2026-09-08 live walk:
 *
 *   Finding 4 — the demo venues have rows in `weddings` / `people` /
 *   `interactions` and effectively nothing in `couples` / `touchpoints`,
 *   because every existing demo seed writes those legacy tables with
 *   plain INSERTs and never calls the cascade. Coordinator surfaces that
 *   read the spine show blank; legacy surfaces show numbers. Same product,
 *   two answers to "how many couples do we have".
 *
 *   Finding 5 — all 61 demo leads read Frozen. `wedding_heat` (migrations
 *   316 + 321) sums `points * 0.98 ^ days_since_event`, and the seed's
 *   event dates are fixed calendar dates in spring 2026. Any demo run
 *   after about June reads dead, and it gets worse every week.
 *
 * The fix for both is one thing: generate the story as OFFSETS from a
 * live clock, and replay it through `linkSignal`, the one writer.
 *
 * Safety
 * ------
 *   - Dry run by default. Writes need `--apply`.
 *   - `.env.local` points at production, so `--apply` also needs
 *     `--allow-prod` (scripts/_safety.mjs). The double flag is friction
 *     on purpose.
 *   - Refuses to run unless every target venue comes back with
 *     `is_demo = true` from the database. A typo cannot reach a real
 *     venue.
 *   - The couple-portal hero (44444444-4444-4444-4444-444444000109,
 *     Chloe and Ryan) keeps its id. Its `weddings` row is never deleted,
 *     so the checklist, guest list, timeline and seating rows seeded
 *     against it survive untouched.
 *
 * Idempotent by wipe-and-reseed (DEMO-RESEED-DESIGN.md §6.2 option a):
 * the delete phase clears the demo venues first, so a second run at the
 * same seed produces the same state, with the offsets recomputed against
 * the new "today". The design's option (b), a rolling daily top-up so
 * heat moves day over day between runs, is deliberately NOT built here —
 * see the note at the bottom of this file.
 *
 * Usage
 * -----
 *   npx tsx scripts/demo-reseed.ts                        # dry run
 *   npx tsx scripts/demo-reseed.ts --apply --allow-prod   # reseed
 *   npx tsx scripts/demo-reseed.ts --verify               # read back
 *   npx tsx scripts/demo-reseed.ts --only-aux             # aux plan only, dry
 *   npx tsx scripts/demo-reseed.ts --only-aux --apply --allow-prod
 *     # re-run the mirror rows against a database whose spine (weddings,
 *     # people, couples, touchpoints) is already seeded — no
 *     # delete-and-rebuild of the spine, just the aux-owned tables.
 *
 * Options: --seed=N  --couples=N  --json  --live
 *
 *   --live  in addition to the static schema-facts check every plan gets,
 *           confirm each target table actually exists on the connected
 *           database with a read-only `select().limit(0)` — the phantom
 *           class W72 found (a migration declares a table; a later one
 *           renames or drops it; production never had it under that
 *           name). Read-only, safe against prod.
 *
 * Every run, dry or applied, validates the plan against
 * `scripts/demo-reseed/schema-facts.ts` before touching a writer: any
 * `aux_rows` step naming a table the migrations do not create (or later
 * drop/rename away), any column the migrations do not declare, or any
 * value outside a CHECK-derived allowed set, fails the run before
 * `--apply` would have hit the same error live.
 *
 * This workstream does not run the applier. Written for the operator.
 */

import { existsSync, readFileSync } from 'node:fs'
import { parseSafetyFlags, assertNotProd, requireApply, PROD_REF } from './_safety.mjs'
import { applyReseed, resolveExistingSpineIds, type ReseedWriters } from './demo-reseed/apply'
import { DEFAULT_COUPLE_COUNT, DEFAULT_SEED, generateDemoDataset } from './demo-reseed/generate'
import { auxOnlyDeletes, auxOnlySteps, buildReseedPlan } from './demo-reseed/plan'
import { readSchemaFacts } from './demo-reseed/schema-facts'
import {
  confirmTablesLive,
  formatLiveReport,
  formatValidationReport,
  tablesInPlan,
  validatePlan,
} from './demo-reseed/validate-plan'
import { formatVerifyReport, verifyReseed } from './demo-reseed/verify'

function loadEnv(): void {
  if (!existsSync('.env.local')) {
    console.error('[demo-reseed] .env.local not found. Run from the repo root.')
    process.exit(1)
  }
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  ) as Record<string, string>
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
}

function numberFlag(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (!raw) return fallback
  const parsed = Number(raw.split('=')[1])
  if (!Number.isFinite(parsed)) {
    console.error(`[demo-reseed] --${name} must be a number`)
    process.exit(1)
  }
  return parsed
}

async function main(): Promise<void> {
  loadEnv()

  const { apply, allowProd } = parseSafetyFlags(process.argv)
  const verifyOnly = process.argv.includes('--verify')
  const asJson = process.argv.includes('--json')
  const onlyAux = process.argv.includes('--only-aux')
  const checkLive = process.argv.includes('--live')
  const seed = numberFlag('seed', DEFAULT_SEED)
  const coupleCount = numberFlag('couples', DEFAULT_COUPLE_COUNT)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!url || !key) {
    console.error('[demo-reseed] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.')
    process.exit(1)
  }

  // The prod gate guards WRITES. A dry run and `--verify` only read, and
  // refusing to read against prod would make the dry run useless (the
  // demo data this reseeds lives in production). So the gate fires only
  // when `--apply` was passed.
  if (apply) assertNotProd(url, { allowProd })
  if (!apply && !verifyOnly && url.includes(PROD_REF)) {
    console.log('[demo-reseed] dry run against PROD. Reads only. --apply would need --allow-prod.')
  }

  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  if (verifyOnly) {
    const { aggregatePulse } = await import('../src/lib/services/intel/pulse-aggregator')
    const report = await verifyReseed(supabase, {
      aggregatePulse: (sb, venueId, opts) => aggregatePulse(sb, venueId, opts),
    })
    if (asJson) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log('\n[demo-reseed] verify\n')
      console.log(formatVerifyReport(report))
      console.log('')
    }
    process.exit(report.pass ? 0 : 1)
  }

  const today = new Date().toISOString()
  const dataset = generateDemoDataset({ seed, today, coupleCount })
  const plan = buildReseedPlan(dataset)

  if (onlyAux) {
    const deletes = auxOnlyDeletes(plan)
    const steps = auxOnlySteps(plan)
    const rows = steps.reduce((sum, s) => sum + (s.rows?.length ?? 0), 0)
    const tables = new Set(steps.map((s) => s.table))
    console.log('\n[demo-reseed] aux plan only (--only-aux)')
    console.log(`  seed          : ${plan.seed}`)
    console.log(`  today         : ${plan.today}`)
    console.log(`  venues        : ${plan.venueIds.length}`)
    console.log(`  aux tables    : ${tables.size} (${deletes.length} with a delete op)`)
    console.log(`  aux rows      : ${rows}`)
    console.log('')
    if (asJson) console.log(JSON.stringify({ auxTables: tables.size, auxRows: rows }, null, 2))
  } else {
    console.log('\n[demo-reseed] plan')
    console.log(`  seed          : ${plan.seed}`)
    console.log(`  today         : ${plan.today}`)
    console.log(`  venues        : ${plan.venueIds.length}`)
    console.log(`  stories       : ${plan.summary.stories}`)
    console.log(`  signals       : ${plan.summary.signals}`)
    console.log(`  heat events   : ${plan.summary.heatEvents}`)
    console.log(
      `  lifecycle     : ${Object.entries(plan.summary.byLifecycle)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ')}`,
    )
    console.log(
      `  expected heat : ${Object.entries(plan.summary.byExpectedTier)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ')}   (advisory — wedding_heat is the truth, run --verify)`,
    )
    console.log(`  preserving    : ${plan.preserveWeddingIds.join(', ')}`)
    console.log('')

    if (asJson) {
      console.log(JSON.stringify(plan.summary, null, 2))
    }
  }

  // Validate the plan against what the migrations actually declare
  // BEFORE anything is written. W72: this is what would have caught the
  // 2026-09-15 aux-step errors (a phantom table, two CHECK violations)
  // on the dry run that preceded that apply.
  const scopedPlan = onlyAux
    ? { ...plan, deletes: auxOnlyDeletes(plan), steps: auxOnlySteps(plan) }
    : plan
  const facts = readSchemaFacts()
  const validation = validatePlan(scopedPlan, facts)
  console.log(formatValidationReport(validation))
  console.log('')

  if (checkLive) {
    const liveChecks = await confirmTablesLive(supabase, tablesInPlan(scopedPlan))
    console.log(formatLiveReport(liveChecks))
    console.log('')
  }

  if (!validation.pass) {
    console.log('  Refusing to proceed — fix the plan before writing anything.')
    console.log('')
    process.exit(1)
  }

  const dryRun = !requireApply(apply, 'demo-reseed')

  const writers = dryRun ? stubWriters() : await liveWriters()

  const result = await applyReseed({
    supabase,
    plan,
    dataset,
    writers,
    dryRun,
    mode: onlyAux ? 'aux-only' : 'full',
    log: (line) => console.log(line),
  })

  console.log('')
  console.log(`[demo-reseed] ${dryRun ? 'would write' : 'wrote'}`)
  if (!onlyAux) {
    console.log(`  weddings minted    : ${result.minted}`)
    console.log(`  couples mirrored   : ${result.mirrored}`)
    console.log(`  signals linked     : ${result.signalsLinked}`)
    console.log(`  signals duplicate  : ${result.signalsDuplicate}`)
    console.log(`  heat events        : ${result.heatEventsWritten}`)
    console.log(`  tour rows          : ${result.toursWritten}`)
    console.log(`  lost deal rows     : ${result.lostDealsWritten}`)
    console.log(`  wedding updates    : ${result.weddingsUpdated}`)
  }
  console.log(
    `  aux rows           : ${Object.values(result.auxRowsByTable).reduce((a, b) => a + b, 0)} across ${Object.keys(result.auxRowsByTable).length} tables`,
  )
  if (result.errors.length > 0) {
    console.log(`\n  ${result.errors.length} errors:`)
    for (const e of result.errors.slice(0, 40)) console.log(`    - ${e}`)
    if (result.errors.length > 40) console.log(`    ... ${result.errors.length - 40} more`)
  }
  console.log('')
  if (dryRun) {
    console.log('  Nothing was written. Re-run with --apply --allow-prod to reseed,')
    console.log('  then with --verify to read the result back.')
  } else {
    console.log('  Next: npx tsx scripts/demo-reseed.ts --verify')
  }
  console.log('')

  process.exit(result.errors.length > 0 ? 1 : 0)
}

/** Dry-run writers. Never called, because the applier returns before
 *  reaching them, but the shape has to exist for the walk. */
function stubWriters(): ReseedWriters {
  const refuse = (): never => {
    throw new Error('demo-reseed: a writer was reached during a dry run. This is a bug.')
  }
  return {
    linkSignal: refuse,
    mintWedding: refuse,
    mirrorCouple: refuse,
    recordHeat: refuse,
  }
}

/**
 * The real writers. Imported dynamically so `loadEnv()` has already
 * mirrored `.env.local` onto `process.env` before any module builds a
 * service client at import time.
 *
 * Note for the operator on cost: `mintWedding` fires the identity cascade
 * and a reconstruction enqueue, fire and forget, per wedding. On a
 * freshly wiped demo venue there are no `candidate_identities` or
 * `tangential_signals` rows for the cascade to chew on, so it exits
 * cheaply. `linkSignal` gets an explicit judge budget of 1: a clean
 * story with a populated `primary_email` should never need the LLM judge,
 * so any judge call during a reseed means the story data is too vague,
 * not that the budget was too small.
 */
async function liveWriters(): Promise<ReseedWriters> {
  const { linkSignal, mintWedding } = await import('../src/lib/spine/cascade')
  const { mirrorCoupleFromWedding } = await import(
    '../src/lib/services/identity/mirror-couple'
  )
  const { recordEngagementEventsBatch } = await import('../src/lib/services/heat-mapping')
  const { newJudgeBudget } = await import('../src/lib/services/identity/llm-judge')

  return {
    linkSignal: async (args) =>
      linkSignal({
        supabase: args.supabase,
        venueId: args.venueId,
        signal: args.signal,
        bypassCache: true,
        judgeBudget: newJudgeBudget(1),
        source: 'demo-reseed',
      }),
    mintWedding: async (input) =>
      mintWedding({
        venueId: input.venueId,
        source: 'csv_import',
        reason: input.reason,
        supabase: input.supabase,
        signals: input.signals,
      }),
    mirrorCouple: async (input) =>
      mirrorCoupleFromWedding({
        venueId: input.venueId,
        weddingId: input.weddingId,
        supabase: input.supabase,
      }),
    recordHeat: async (venueId, weddingId, events, direction, occurredAt) =>
      recordEngagementEventsBatch(venueId, weddingId, events, direction, occurredAt),
    resolveExistingSpine: async ({ supabase, dataset }) =>
      resolveExistingSpineIds(supabase, dataset),
  }
}

main().catch((err) => {
  console.error('[demo-reseed] FATAL:', err)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Not built here, on purpose
// ---------------------------------------------------------------------------
// DEMO-RESEED-DESIGN.md §6.2 sketches a rolling top-up as the better
// long-run answer: keep the couples, append a couple of fresh signals near
// daysAgo 0 every night, and let the old ones age into frozen the way
// `decay_window_days` intends. That gives movement day over day rather
// than a fresh coat of paint on each run. It needs run-to-run state (which
// couples exist, which signals already fired) and its own decay sweep, and
// it is not what the November gate asks for. This script is option (a),
// wipe and reseed, which is deterministic, idempotent, and honest about
// what it does.
