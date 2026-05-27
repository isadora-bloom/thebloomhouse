// Reject all pending Rixey drafts older than 7 days. Operator-flagged
// 2026-05-27 — queue was overwhelming.
//
// Usage:
//   node --env-file=.env.local scripts/clear-stale-pending-drafts.mjs
//   node --env-file=.env.local scripts/clear-stale-pending-drafts.mjs --apply
//
// Dry-run by default. --apply writes. Recent drafts (last 7 days) are
// preserved on purpose — those are most likely time-sensitive.

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const WINDOW_DAYS = 7

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const { data: vc } = await sb
  .from('venue_config')
  .select('venue_id, business_name')
  .eq('venue_prefix', 'RM')
  .single()
const venueId = vc?.venue_id ?? 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const venueName = vc?.business_name ?? 'Rixey Manor (fallback)'

const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
console.log('='.repeat(78))
console.log(`clear-stale-pending-drafts -- ${APPLY ? 'APPLY (writes)' : 'DRY RUN'}`)
console.log(`Venue       : ${venueName} (${venueId})`)
console.log(`Cutoff      : ${cutoffIso} (anything created BEFORE this gets rejected)`)
console.log(`Keep window : last ${WINDOW_DAYS} days`)
console.log('='.repeat(78))

const { data: stale, error: queryErr } = await sb
  .from('drafts')
  .select('id, to_email, subject, created_at, prompt_version_used')
  .eq('venue_id', venueId)
  .eq('status', 'pending')
  .lt('created_at', cutoffIso)
  .order('created_at', { ascending: true })

if (queryErr) { console.error('query failed:', queryErr); process.exit(1) }

console.log(`\nWould reject ${stale.length} stale pending draft(s).`)
if (stale.length > 0) {
  console.log(`\nOldest 10:`)
  for (const r of stale.slice(0, 10)) {
    console.log(`  ${r.created_at.slice(0,10)} | ${(r.to_email ?? '').padEnd(45)} | ${(r.subject ?? '').slice(0,50)}`)
  }
  if (stale.length > 10) console.log(`  ... and ${stale.length - 10} more`)
}

const { count: keepCount } = await sb
  .from('drafts')
  .select('id', { count: 'exact', head: true })
  .eq('venue_id', venueId)
  .eq('status', 'pending')
  .gte('created_at', cutoffIso)
console.log(`\nWould keep  : ${keepCount ?? 0} draft(s) created within the last ${WINDOW_DAYS} days.`)

if (!APPLY) {
  console.log(`\nDRY RUN. Pass --apply to reject.`)
  process.exit(0)
}

if (stale.length === 0) {
  console.log('\nNothing to do.')
  process.exit(0)
}

const ids = stale.map((r) => r.id)
const noteTs = new Date().toISOString().slice(0,10)
const { data: rejected, error: updErr } = await sb
  .from('drafts')
  .update({
    status: 'rejected',
    feedback_notes: `${noteTs} bulk-rejected: stale pending draft (>${WINDOW_DAYS}d old) cleared by operator to drain overwhelming queue`,
  })
  .in('id', ids)
  .eq('venue_id', venueId)
  .eq('status', 'pending')
  .select('id')

if (updErr) { console.error('update failed:', updErr); process.exit(1) }

console.log(`\n✓ Rejected ${rejected?.length ?? 0} draft(s).`)
console.log(`Feedback note: "bulk-rejected: stale pending draft (>${WINDOW_DAYS}d old) cleared by operator to drain overwhelming queue"`)
console.log('='.repeat(78))
