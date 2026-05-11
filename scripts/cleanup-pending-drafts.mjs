import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// venues.prefix lives on venue_config, not venues. Look up via join.
const { data: vc, error: vcErr } = await sb.from('venue_config').select('venue_id, business_name').eq('venue_prefix', 'RM').single()
if (vcErr || !vc) {
  console.error('venue_config lookup failed:', vcErr)
  // Fallback: try the Rixey venue ID we know from prior work
  console.log('Falling back to known Rixey venue_id')
}
const venueId = vc?.venue_id ?? 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const venueName = vc?.business_name ?? 'Rixey Manor (fallback)'
console.log('Venue:', venueName, venueId)

const { count: pendingBefore } = await sb.from('drafts').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('status', 'pending')
const { count: autoSendEnabled } = await sb.from('auto_send_rules').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('enabled', true)
console.log('BEFORE: pending drafts =', pendingBefore, '| auto-send rules enabled =', autoSendEnabled)

const ts = '2026-05-11 Lindy→Bloom transition: bulk-rejected for clean slate'
const { data: rejectedRows, error: rejectErr } = await sb
  .from('drafts')
  .update({ status: 'rejected', feedback_notes: ts })
  .eq('venue_id', venueId)
  .eq('status', 'pending')
  .select('id')
if (rejectErr) console.error('Reject error:', rejectErr)
else console.log('Rejected:', rejectedRows?.length ?? 0, 'drafts')

const { data: pausedRows, error: pauseErr } = await sb
  .from('auto_send_rules')
  .update({ enabled: false })
  .eq('venue_id', venueId)
  .eq('enabled', true)
  .select('id, context, source')
if (pauseErr) console.error('Pause error:', pauseErr)
else {
  console.log('Paused auto-send rules:', pausedRows?.length ?? 0)
  if (pausedRows?.length) console.log('  Rules paused:', JSON.stringify(pausedRows, null, 2))
}

const { count: pendingAfter } = await sb.from('drafts').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('status', 'pending')
const { count: autoSendAfter } = await sb.from('auto_send_rules').select('id', { count: 'exact', head: true }).eq('venue_id', venueId).eq('enabled', true)
console.log('AFTER: pending drafts =', pendingAfter, '| auto-send rules enabled =', autoSendAfter)
