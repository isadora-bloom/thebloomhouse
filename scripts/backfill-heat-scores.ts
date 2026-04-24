// Heat score backfill. Run once to repair weddings that have
// engagement_events but whose heat_score was never recalculated.
//
// Context: email-pipeline.ts previously inserted the `initial_inquiry`
// event directly via supabase.from().insert() instead of through the
// recordEngagementEvent wrapper. That skipped the recalculateHeatScore
// call, so new_inquiry weddings lived at heat_score=0 forever unless
// the classifier later emitted F6 heat signals (which trigger a recalc
// through recordEngagementEventsBatch). Most plain inquiries never did.
//
// This script walks every active wedding (any status except lost /
// cancelled) and recomputes heat_score from its engagement_events using
// the canonical recalculateHeatScore function. Idempotent — a wedding
// that already has a correct score will just get rewritten to the same
// value.
//
// Usage:
//   npx tsx scripts/backfill-heat-scores.ts               # dry-run report
//   npx tsx scripts/backfill-heat-scores.ts --apply       # execute
//   npx tsx scripts/backfill-heat-scores.ts --venue <id>  # restrict
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { recalculateHeatScore } from '../src/lib/services/heat-mapping'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    })
)

process.env.NEXT_PUBLIC_SUPABASE_URL ??= env.NEXT_PUBLIC_SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY ??= env.SUPABASE_SERVICE_ROLE_KEY

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const APPLY = process.argv.includes('--apply')
const venueIdx = process.argv.indexOf('--venue')
const VENUE_FILTER = venueIdx >= 0 ? process.argv[venueIdx + 1] : null

async function main() {
  // Pull every wedding in a live lead stage (excluding lost/cancelled —
  // those are terminal and heat is 0 by design).
  let q = sb
    .from('weddings')
    .select('id, venue_id, status, heat_score, temperature_tier, notes')
    .in('status', [
      'inquiry',
      'tour_scheduled',
      'tour_completed',
      'proposal_sent',
      'booked',
      'completed',
    ])
  if (VENUE_FILTER) q = q.eq('venue_id', VENUE_FILTER)

  const { data: weddings, error } = await q
  if (error) {
    console.error('Failed to fetch weddings:', error.message)
    process.exit(1)
  }

  console.log(`Found ${weddings?.length ?? 0} weddings to check` +
    (VENUE_FILTER ? ` (venue=${VENUE_FILTER.slice(0, 8)})` : '') +
    (APPLY ? ' — APPLYING' : ' — DRY RUN'))

  let checked = 0
  let changed = 0
  const byChangeBucket = { stayed_0: 0, new_positive: 0, changed_by_10_plus: 0, changed_small: 0 }

  for (const w of weddings ?? []) {
    checked++
    const oldScore = w.heat_score as number | null
    if (!APPLY) {
      const { data: events } = await sb
        .from('engagement_events')
        .select('points, created_at')
        .eq('wedding_id', w.id)
      const now = Date.now()
      let total = 0
      for (const e of events ?? []) {
        const days = Math.max(0, (now - new Date(e.created_at as string).getTime()) / 86400_000)
        total += ((e.points as number) || 0) * Math.pow(0.98, days)
      }
      const projected = Math.max(0, Math.min(100, Math.round(total)))
      const delta = projected - (oldScore ?? 0)
      if (projected === 0 && (oldScore ?? 0) === 0) byChangeBucket.stayed_0++
      else if ((oldScore ?? 0) === 0 && projected > 0) byChangeBucket.new_positive++
      else if (Math.abs(delta) >= 10) byChangeBucket.changed_by_10_plus++
      else if (delta !== 0) byChangeBucket.changed_small++
      if (delta !== 0) changed++
      if (checked <= 10) {
        console.log(`  ${w.id.slice(0, 8)} venue=${w.venue_id.slice(0, 8)} status=${w.status}  ${oldScore ?? 'null'} → ${projected}  (events=${events?.length ?? 0})`)
      }
      continue
    }
    try {
      const result = await recalculateHeatScore(w.venue_id as string, w.id as string)
      const delta = result.newScore - (oldScore ?? 0)
      if (delta !== 0) {
        changed++
        if (checked <= 10 || Math.abs(delta) >= 10) {
          console.log(`  ${w.id.slice(0, 8)} ${oldScore ?? 'null'} → ${result.newScore} tier=${result.temperatureTier}`)
        }
      }
    } catch (err) {
      console.error(`  ${w.id.slice(0, 8)} FAILED:`, (err as Error).message)
    }
  }

  console.log(`\nChecked: ${checked}`)
  console.log(`Would change: ${changed}` + (APPLY ? ' (applied)' : ' (dry run)'))
  if (!APPLY) {
    console.log('\nBuckets:')
    for (const [b, n] of Object.entries(byChangeBucket)) console.log(`  ${b.padEnd(22)}${n}`)
    console.log('\nRerun with --apply to execute.')
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
