#!/usr/bin/env tsx
/**
 * Golden-case harness (FIX-PLAN Layer C / check-golden-cases).
 *
 * Exact identity-shape assertions that run every commit and can NEVER
 * regress (stop-the-line). Unlike the battery (a regex/shape proxy —
 * gap G15: a wrong-but-shaped answer passes), these assert exact spine
 * state from the live cascade.
 *
 * HONESTY MODEL (the whole point of this exercise). Bloom House runs a
 * SHADOW spine beside the legacy tables. So each assertion is tagged
 * with the SURFACE it targets:
 *   - surface "spine"            → evaluated NOW (linkSignal writes it today)
 *   - surface "legacy"           → PENDING: legacy-pipeline-driven (people /
 *                                  attribution_events), not produced by linkSignal.
 *                                  Un-tag when Phase 3 migrates that limb.
 *   - surface "pending:D4|D5|A2" → PENDING: needs a schema/spec addition that
 *                                  does not exist yet (point_zero cols, touchpoint
 *                                  direction/zero_phase, identifier-pool/reliability).
 *                                  Un-tag when the migration in Draft A lands.
 * PENDING assertions are REPORTED (never silently passed, never failed).
 * The run fails only on a `spine` assertion regressing. This makes the
 * gap to the canonical target visible on every run instead of hidden.
 *
 * Run:
 *   npx tsx tests/golden/run-golden-cases.ts --dry   # validate specs only (CI; no DB)
 *   npx tsx tests/golden/run-golden-cases.ts          # full run (needs a TEST-BRANCH DB)
 *
 * The full run REFUSES to touch the prod Supabase project and uses a
 * dedicated GOLDEN_TEST_VENUE (env-overridable) it cleans between runs.
 *
 * Companion: cases.json, CANONICAL-RECONCILIATION-SPECS.md (D4/D5/D6),
 * BLOOM-CONSOLIDATION-GAP-REGISTER.md (G15/G16), FIX-PLAN Layer C.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRY = process.argv.includes('--dry')
const PROD_HOST = 'jsxxgwprxuqgcauzlxcb' // never write here (gap G16)

type Surface = string // 'spine' | 'legacy' | 'pending:<reason>'
interface Assertion { check: string; surface: Surface; [k: string]: unknown }
interface Signal {
  channel: string; action: string; at: string; name?: string; partnerName?: string
  identifiers?: { kind: string; value: string; reliability?: string }[]
  body?: string; wedding_id?: string; wedding_date?: string; lead_source_field?: string
  direction?: string; repeat?: number
}
interface Case { id: string; title: string; gaps?: string[]; source?: string; signals: Signal[]; assert: Assertion[] }

const { cases } = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8')) as { cases: Case[] }

// --- the spine snapshot the assertion engine reads -------------------------
interface LinkOutcome { action: string; matched_couple_id: string | null; touchpoint_id: string | null; candidate_match_queued: boolean }
interface SpineState {
  link_outcomes: LinkOutcome[]
  couples: { id: string; lifecycle_state: string }[]
  touchpoints: { channel: string; action_type: string; occurred_at: string; couple_id: string | null }[]
  open_candidate_matches: number
  // legacy / cross-shadow (best-effort; may be empty under shadow mode)
  people: { wedding_id: string | null; first_name: string | null; last_name: string | null; role: string }[]
}

/**
 * Run a case's signals through the live cascade and snapshot the spine.
 * Lazy-imports linkSignal so --dry never loads the cascade chain.
 */
async function materialize(c: Case): Promise<SpineState> {
  // env load (mirrors scripts/data-integrity-check.ts) ----------------------
  // D-12: prefer .env.test (TEST-BRANCH creds) over .env.local (prod), so the
  // harness runs off a branch by default and prod config stays untouched. The
  // prod-refusal guard below is the backstop if .env.test points at prod by mistake.
  const envFile = existsSync('.env.test') ? '.env.test' : '.env.local'
  if (!existsSync(envFile)) throw new Error('no .env.test or .env.local — create .env.test with a TEST-BRANCH Supabase (D-12)')
  const env: Record<string, string> = {}
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  if (url.includes(PROD_HOST)) {
    throw new Error(`REFUSING to run against prod (${url}). Point NEXT_PUBLIC_SUPABASE_URL at a Supabase branch (gap G16).`)
  }
  const venueId = process.env.GOLDEN_TEST_VENUE ?? env.GOLDEN_TEST_VENUE
    ?? '0a17e57e-0000-4000-8000-000000000001' // dedicated throwaway; must exist in `venues` on the branch

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { linkSignal } = await import('@/lib/spine/cascade') as typeof import('@/lib/spine/cascade')

  // clean the test venue (children cascade on the FKs in migration 346) ------
  for (const t of ['touchpoints', 'fragments', 'candidate_matches', 'couple_progression_events', 'couple_merge_events', 'couples']) {
    await sb.from(t).delete().eq('venue_id', venueId)
  }

  const link_outcomes: LinkOutcome[] = []
  for (const [sigIdx, s] of c.signals.entries()) {
    for (let i = 0; i < (s.repeat ?? 1); i++) {
      const primary = (s.identifiers ?? [])[0]
      const r = await linkSignal({
        supabase: sb,
        venueId,
        bypassCache: true, // mandatory in tests (forwards-linker.ts CACHE_TTL_MS)
        signal: {
          // include the signal's array index so two signals that share
          // channel+action (e.g. GC-4's two Sarahs, both gmail/reply) get
          // DISTINCT external_ids and aren't collapsed by the
          // UNIQUE(venue_id,channel,external_id) idempotency constraint.
          external_id: `${c.id}-s${sigIdx}-${s.channel}-${s.action}-${i}`,
          channel: s.channel,
          action_type: s.action,
          occurred_at: s.at,
          signal_tier: s.direction === 'outbound' ? 'medium' : 'high',
          identity_hint: s.name ?? null,
          primary_name: s.name ?? null,
          partner_name: s.partnerName ?? null,
          primary_email: primary?.kind === 'email' ? primary.value : null,
          primary_phone: primary?.kind === 'phone' ? primary.value : null,
          wedding_date: s.wedding_date ?? null,
          legacy_wedding_id: s.wedding_id ?? null,
          author_class: 'couple',
          raw_payload: { direction: s.direction ?? 'inbound', body: s.body, lead_source_field: s.lead_source_field },
        } as Parameters<typeof linkSignal>[0]['signal'],
      })
      link_outcomes.push({
        action: r.action,
        matched_couple_id: r.matched_couple_id,
        touchpoint_id: r.touchpoint_id,
        candidate_match_queued: r.candidate_match_queued,
      })
    }
  }

  const { data: couples } = await sb.from('couples').select('id,lifecycle_state').eq('venue_id', venueId)
  const { data: tps } = await sb.from('touchpoints').select('channel,action_type,occurred_at,couple_id').eq('venue_id', venueId)
  const { count: openCandidates } = await sb.from('candidate_matches')
    .select('id', { count: 'exact', head: true }).eq('venue_id', venueId).is('resolution', null)

  return {
    link_outcomes,
    couples: couples ?? [],
    touchpoints: tps ?? [],
    open_candidate_matches: openCandidates ?? 0,
    people: [], // legacy people are not written by linkSignal (shadow mode) — see surface tags
  }
}

// --- assertion engine ------------------------------------------------------
type Verdict = { ok: boolean; pending?: string; msg?: string }

function evalAssertion(a: Assertion, s: SpineState): Verdict {
  if (a.surface !== 'spine') return { ok: true, pending: a.surface } // legacy / pending:* → reported, not run

  const actions = s.link_outcomes.map((o) => o.action)
  switch (a.check) {
    case 'couple_count':
      return { ok: s.couples.length === a.eq, msg: `couple_count ${s.couples.length} ≠ ${a.eq}` }
    case 'couple_count_min':
      return { ok: s.couples.length >= (a.min as number), msg: `couple_count ${s.couples.length} < ${a.min}` }
    case 'link_actions_eq':
      return { ok: JSON.stringify(actions) === JSON.stringify(a.eq), msg: `link actions [${actions}] ≠ [${a.eq}]` }
    case 'link_actions_include':
      return { ok: (a.eq as string[]).every((x) => actions.includes(x)), msg: `link actions [${actions}] missing ${a.eq}` }
    case 'link_action_absent':
      return { ok: !actions.includes(a.eq as string), msg: `link action "${a.eq}" should not occur (got [${actions}])` }
    case 'lifecycle_state_any':
      return { ok: s.couples.some((c) => c.lifecycle_state === a.eq), msg: `no couple with lifecycle_state=${a.eq}` }
    case 'review_queue_open_min':
      return { ok: s.open_candidate_matches >= (a.min as number), msg: `open candidate_matches ${s.open_candidate_matches} < ${a.min}` }
    case 'touchpoint_count_min':
      return { ok: s.touchpoints.length >= (a.min as number), msg: `touchpoints ${s.touchpoints.length} < ${a.min}` }
    default:
      return { ok: false, msg: `unknown spine check "${a.check}"` }
  }
}

function validateSpec(c: Case): string[] {
  const errs: string[] = []
  if (!c.id || !c.title) errs.push('missing id/title')
  if (!Array.isArray(c.signals) || !c.signals.length) errs.push('no signals')
  if (!Array.isArray(c.assert) || !c.assert.length) errs.push('no assertions')
  for (const a of c.assert ?? []) {
    if (!a.check || !a.surface) errs.push(`assertion missing check/surface: ${JSON.stringify(a)}`)
  }
  return errs
}

// --- run -------------------------------------------------------------------
async function main(): Promise<number> {
  let failed = 0
  let pendingTotal = 0
  for (const c of cases) {
    const specErrs = validateSpec(c)
    if (specErrs.length) {
      failed++
      console.error(`✗ ${c.id} (malformed spec)`)
      for (const e of specErrs) console.error(`    - ${e}`)
      continue
    }
    if (DRY) { console.log(`✓ ${c.id} ${c.title} (spec valid, ${c.assert.length} assertions)`); continue }

    let state: SpineState
    try {
      state = await materialize(c)
    } catch (err) {
      failed++
      console.error(`✗ ${c.id} — harness error: ${(err as Error).message}`)
      continue
    }
    const fails: string[] = []
    const pendings: string[] = []
    for (const a of c.assert) {
      const v = evalAssertion(a, state)
      if (v.pending) pendings.push(`${a.check} [${v.pending}]`)
      else if (!v.ok) fails.push(v.msg ?? a.check)
    }
    pendingTotal += pendings.length
    if (fails.length) {
      failed++
      console.error(`✗ ${c.id} ${c.title}`)
      for (const m of fails) console.error(`    FAIL: ${m}`)
    } else {
      console.log(`✓ ${c.id} ${c.title} — ${c.assert.length - pendings.length} spine assertions passed`)
    }
    for (const p of pendings) console.log(`    · pending: ${p}`)
  }

  console.log(`\n${cases.length - failed}/${cases.length} golden cases ${DRY ? 'valid' : 'passed'}${DRY ? '' : `, ${pendingTotal} pending assertions (legacy/spec-gap — see Draft A)`}.`)
  if (failed) {
    console.error('\nSTOP-THE-LINE — a golden case regressed. Halt merges until fixed (FIX-PLAN Layer C).')
    return 1
  }
  return 0
}

main().then((code) => process.exit(code))
