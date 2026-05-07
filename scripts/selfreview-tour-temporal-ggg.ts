/**
 * T5-Rixey-GGG self-review: tour temporal layer.
 *
 * Investigates the prerequisites for Stream GGG before/after migration
 * 196 + tour_outcome_classifier:
 *
 *   1. Bug 24 — count tours with NULL scheduled_at. If > 0, find out
 *      why (Calendly import didn't capture date? Manual entry path?)
 *      and report so the writer can be fixed.
 *
 *   2. Bug 13 — count tours where couple_display_name is NULL after
 *      backfill. Report by venue + recent count.
 *
 *   3. Bug 12 — count tours per outcome bucket per venue, before and
 *      after the classifier runs. Use this to validate the cron's
 *      effect on Rixey (280 → X completed, Y cancelled, Z no_show).
 *
 *   4. Bug 22 — count "still browsing after the tour" candidates that
 *      satisfy the post-tour temporal predicate (vs the prior
 *      post-INQUIRY predicate). This is the truthful row count for the
 *      dashboard card after the GGG fix.
 *
 * Usage:
 *   npx tsx scripts/selfreview-tour-temporal-ggg.ts
 *   npx tsx scripts/selfreview-tour-temporal-ggg.ts --classify   # also run the classifier inline (dry-run on Rixey)
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

async function main() {
  console.log('=== T5-Rixey-GGG self-review ===\n')

  // ---- Bug 24: tours with NULL scheduled_at ----
  console.log('--- Bug 24: tours with NULL scheduled_at ---')
  const { count: nullScheduled, data: nullSample } = await sb
    .from('tours')
    .select('id, venue_id, wedding_id, source, created_at, notes', { count: 'exact' })
    .is('scheduled_at', null)
    .limit(20)
  console.log(`Total tours with NULL scheduled_at: ${nullScheduled ?? 0}`)
  if ((nullScheduled ?? 0) > 0) {
    console.log('Sample:')
    for (const r of nullSample ?? []) {
      console.log(`  id=${r.id} venue=${r.venue_id} src=${r.source ?? '-'} notes=${(r.notes ?? '').slice(0, 80)}`)
    }
  } else {
    console.log('No NULL scheduled_at rows — Bug 24 is a render-time JOIN issue (multi-tour-per-wedding picker fails).')
  }

  // ---- Bug 12 + Bug 13: outcome distribution + couple-name backfill ----
  console.log('\n--- Bug 12 + 13: per-venue outcome + couple_display_name distribution ---')
  const { data: venues } = await sb.from('venues').select('id, name').eq('is_active', true)
  for (const v of (venues ?? []) as Array<{ id: string; name: string }>) {
    const { data: rows, count } = await sb
      .from('tours')
      .select('outcome, couple_display_name', { count: 'exact' })
      .eq('venue_id', v.id)
      .limit(10000)
    if (!rows) continue
    const buckets: Record<string, number> = {}
    let nullName = 0
    for (const r of rows as Array<{ outcome: string | null; couple_display_name: string | null }>) {
      const o = r.outcome ?? 'null'
      buckets[o] = (buckets[o] ?? 0) + 1
      if (!r.couple_display_name || r.couple_display_name.trim() === '') nullName++
    }
    if ((count ?? 0) === 0) continue
    console.log(`\n${v.name} (${v.id}) — ${count} tours`)
    for (const [o, n] of Object.entries(buckets).sort()) {
      console.log(`  ${o.padEnd(12)} ${n}`)
    }
    console.log(`  couple_display_name NULL: ${nullName}/${count}`)
  }

  // ---- Bug 22: post-tour browsing predicate counts ----
  console.log('\n--- Bug 22: post-tour browsing candidates ---')
  for (const v of (venues ?? []) as Array<{ id: string; name: string }>) {
    // Pull completed tours per venue
    const { data: tours } = await sb
      .from('tours')
      .select('id, wedding_id, scheduled_at, outcome')
      .eq('venue_id', v.id)
      .eq('outcome', 'completed')
      .not('scheduled_at', 'is', null)
      .not('wedding_id', 'is', null)
    const completedTours = (tours ?? []) as Array<{ id: string; wedding_id: string; scheduled_at: string }>
    if (completedTours.length === 0) continue

    // For each completed tour, count tangential signals after scheduled_at
    let postTourLeads = 0
    const wedIds = [...new Set(completedTours.map((t) => t.wedding_id))]

    const { data: candidates } = await sb
      .from('candidate_identities')
      .select('id, resolved_wedding_id')
      .in('resolved_wedding_id', wedIds)
      .is('deleted_at', null)
    const candIds = ((candidates ?? []) as Array<{ id: string; resolved_wedding_id: string }>).map((c) => c.id)
    if (candIds.length === 0) continue

    const { data: signals } = await sb
      .from('tangential_signals')
      .select('signal_date, candidate_identity_id')
      .in('candidate_identity_id', candIds)
      .not('signal_date', 'is', null)
    const sigByCand = new Map<string, string[]>()
    for (const s of (signals ?? []) as Array<{ signal_date: string; candidate_identity_id: string }>) {
      const arr = sigByCand.get(s.candidate_identity_id) ?? []
      arr.push(s.signal_date)
      sigByCand.set(s.candidate_identity_id, arr)
    }
    const candToWed = new Map<string, string>()
    for (const c of (candidates ?? []) as Array<{ id: string; resolved_wedding_id: string }>) {
      candToWed.set(c.id, c.resolved_wedding_id)
    }

    const postTourWeddings = new Set<string>()
    for (const t of completedTours) {
      const tourMs = new Date(t.scheduled_at).getTime()
      // Find candidates linked to this wedding
      for (const [candId, wedId] of candToWed.entries()) {
        if (wedId !== t.wedding_id) continue
        const dates = sigByCand.get(candId) ?? []
        if (dates.some((d) => new Date(d).getTime() > tourMs)) {
          postTourWeddings.add(t.wedding_id)
          break
        }
      }
    }
    postTourLeads = postTourWeddings.size

    console.log(`${v.name}: completed_tours=${completedTours.length}, post-tour-browsing-leads=${postTourLeads}`)
  }

  // Optional inline classifier dry-run
  if (process.argv.includes('--classify')) {
    console.log('\n--- Inline classifier dry-run on Rixey ---')
    const { classifyTourOutcomes } = await import('../src/lib/services/tour/outcome-classifier')
    const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
    const r = await classifyTourOutcomes(sb, RIXEY)
    console.log(JSON.stringify(r, null, 2))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
