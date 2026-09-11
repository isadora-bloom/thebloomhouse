/**
 * Replay every social engagement onto the identity spine.
 *
 * Wave 3, W23 (NOVEMBER-PLAN.md, HANDLE-IDENTITY-SPEC.md §4 and §5).
 *
 * Every `social_engagements` row on disk predates the spine. They were
 * matched against the legacy `people` table by handle lookup, by trigram
 * name similarity at 0.5, and by "the email local part contains the
 * handle" at confidence 50, and none of them ever produced a touchpoint.
 * This re-runs all of them through `linkSignal`, the one writer, so a
 * follow three weeks before the inquiry finally shows up on the couple's
 * ribbon.
 *
 * Safety
 * ------
 *   - Dry run by default. Nothing is written, and `linkSignal` is not
 *     even called: the default run shapes every row and reports what it
 *     would do, so it is safe against production.
 *   - Writing needs `--apply`. `.env.local` points at production, so
 *     `--apply` also needs `--allow-prod` (scripts/_safety.mjs). The
 *     double flag is friction on purpose.
 *   - Idempotent. `external_id` pins the CAPTURE date, not today, so a
 *     second run returns 'duplicate' for every row it already linked.
 *     Re-running is safe and is the intended recovery move.
 *
 * Usage:
 *
 *   npx tsx scripts/replay-social-to-spine.ts
 *       dry run over every venue, prints the plan
 *
 *   npx tsx scripts/replay-social-to-spine.ts --venue=<uuid>
 *       one venue only
 *
 *   npx tsx scripts/replay-social-to-spine.ts --apply --allow-prod
 *       writes: touchpoints / fragments / candidates via linkSignal,
 *       plus match_status + match_method + couple_id on each
 *       social_engagements row
 *
 *   npx tsx scripts/replay-social-to-spine.ts --apply --allow-prod --limit=200
 *       bounded first pass
 */

import { existsSync, readFileSync } from 'node:fs'
import { parseSafetyFlags, assertNotProd, requireApply, PROD_REF } from './_safety.mjs'
import { replaySocialEngagements } from '../src/lib/services/identity/replay/social'

function loadEnv(): void {
  if (!existsSync('.env.local')) {
    console.error('[replay-social] .env.local not found. Run from the repo root.')
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

function stringFlag(name: string): string | null {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))
  return raw ? raw.slice(name.length + 3) : null
}

function numberFlag(name: string, fallback: number): number {
  const raw = stringFlag(name)
  if (raw === null) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    console.error(`[replay-social] --${name} must be a number`)
    process.exit(1)
  }
  return parsed
}

async function main(): Promise<void> {
  loadEnv()

  const { apply, allowProd } = parseSafetyFlags(process.argv)
  const venueFlag = stringFlag('venue')
  const limit = numberFlag('limit', 5000)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!url || !key) {
    console.error('[replay-social] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.')
    process.exit(1)
  }

  // The prod gate guards writes. A dry run reads only, and refusing to
  // read prod would make it useless, since the rows this replays live
  // there. So the gate fires only when --apply was passed.
  if (apply) assertNotProd(url, { allowProd })
  if (!apply && url.includes(PROD_REF)) {
    console.log('[replay-social] dry run against PROD. Reads only. --apply would need --allow-prod.')
  }
  const writing = requireApply(apply, 'replay-social-to-spine')

  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  let venueIds: string[]
  if (venueFlag) {
    venueIds = [venueFlag]
  } else {
    const { data, error } = await supabase.from('venues').select('id').limit(1000)
    if (error) {
      console.error(`[replay-social] venues read failed: ${error.message}`)
      process.exit(1)
    }
    venueIds = ((data ?? []) as Array<{ id: string }>).map((v) => v.id)
  }

  console.log(`[replay-social] ${writing ? 'APPLYING' : 'dry run'} over ${venueIds.length} venue(s)\n`)

  let totalScanned = 0
  let totalProcessed = 0
  let totalSkipped = 0

  for (const venueId of venueIds) {
    const result = await replaySocialEngagements({
      supabase,
      venueId,
      limit,
      // Dry run stops before the linker entirely. Shaping is pure, so
      // the report is honest without a single write.
      shapeOnly: !writing,
    })
    totalScanned += result.scanned
    totalProcessed += result.processed
    totalSkipped += result.skipped

    if (result.scanned === 0) continue

    console.log(`venue ${venueId}`)
    console.log(`  scanned ${result.scanned}, shaped ${result.processed}, skipped ${result.skipped}`)
    for (const [reason, n] of Object.entries(result.skipped_reasons)) {
      if (n > 0) console.log(`    skipped ${reason}: ${n}`)
    }
    if (writing) {
      const o = result.outcomes
      console.log(
        `  attached ${o.attached}, minted ${o.minted}, candidates ${o.candidate_medium + o.candidate_low}, `
          + `fragments ${o.fragment}, duplicates ${o.duplicate}, cold start ${o.cold_start}`,
      )
      for (const s of result.samples.slice(0, 10)) {
        console.log(`    @${s.handle} -> ${s.outcome}${s.couple_name ? ` (${s.couple_name})` : ''}`)
      }
    } else {
      for (const s of result.samples.slice(0, 10)) {
        console.log(`    @${s.handle} would link at ${s.occurred_at}`)
      }
    }
    for (const e of result.errors) console.log(`  error: ${e}`)
    console.log('')
  }

  console.log(
    `[replay-social] ${writing ? 'wrote' : 'would write'}: `
      + `${totalProcessed} signals from ${totalScanned} rows, ${totalSkipped} skipped`,
  )
  if (!writing) {
    console.log('[replay-social] Nothing was written. Re-run with --apply --allow-prod to link.')
  }
}

main().catch((err) => {
  console.error('[replay-social] FATAL:', err)
  process.exit(1)
})
