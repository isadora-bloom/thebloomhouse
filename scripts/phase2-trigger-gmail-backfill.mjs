// ============================================================================
// Phase 2 step D.4 — (re)start the Gmail historical backfill after the wipe.
//
// The wipe resets email_sync_state, but the backfill job state lives on the
// venues row (migration 357) and stays 'complete' from the July run. The
// email_poll cron only drains a job whose status is 'pending' or 'running',
// so after a wipe nothing restarts on its own. This does exactly what the
// "Import historical email" button does (POST /api/agent/backfill-booked-couples)
// without needing a coordinator browser session.
//
// Dry-run by default; --apply to write; prod refused without --allow-prod.
// ============================================================================
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { parseSafetyFlags, assertNotProd, requireApply } from './_safety.mjs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const { apply, allowProd } = parseSafetyFlags(process.argv)
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const url = env.NEXT_PUBLIC_SUPABASE_URL
assertNotProd(url, { allowProd })
const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: venue, error } = await sb
  .from('venues')
  .select('id, name, gmail_backfill_status, gmail_backfill_phase, gmail_backfill_cursor, gmail_backfill_emails, gmail_backfill_updated_at')
  .eq('id', RIXEY_VENUE_ID)
  .single()
if (error || !venue) { console.error('venue lookup failed:', error?.message); process.exit(1) }
console.log('Current backfill state:', JSON.stringify(venue, null, 1))

if (venue.gmail_backfill_status === 'running' || venue.gmail_backfill_status === 'pending') {
  console.log('Already pending/running. Nothing to do.')
  process.exit(0)
}
if (!requireApply(apply, 'phase2-trigger-gmail-backfill')) process.exit(0)

const { error: upErr } = await sb
  .from('venues')
  .update({
    gmail_backfill_status: 'pending',
    gmail_backfill_phase: 'general',
    gmail_backfill_cursor: 0,
    gmail_backfill_emails: 0,
    gmail_backfill_updated_at: new Date().toISOString(),
  })
  .eq('id', RIXEY_VENUE_ID)
if (upErr) { console.error('update failed:', upErr.message); process.exit(1) }
console.log('Backfill enqueued (status=pending, phase=general). The email_poll cron drains it every 5 min, ~4 min per chunk.')
