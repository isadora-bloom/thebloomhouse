// Verify the backtrace cron job structurally works by exercising the
// service layer the cron handler delegates to. We don't go through the
// HTTP route because the handler is just `auth + dispatch` — the
// interesting code is scanBacktraceAllVenues, which we test by
// calling findBacktraceCandidates per Gmail-connected venue and
// applying the same 7-day notification dedup the handler does.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { findBacktraceCandidates } from '../src/lib/services/source-backtrace'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function main() {
  console.log('=== backtrace cron self-review (no HTTP) ===\n')

  // Mirror the cron handler's filter: only scan venues with an
  // active gmail_connections row.
  const { data: connectedRows } = await sb
    .from('gmail_connections')
    .select('venue_id, email_address')
    .eq('sync_enabled', true)
    .eq('status', 'active')
  const venueIds = new Set<string>()
  const emailByVenue = new Map<string, string>()
  for (const row of (connectedRows ?? []) as Array<{ venue_id: string; email_address: string }>) {
    if (row.venue_id) {
      venueIds.add(row.venue_id)
      emailByVenue.set(row.venue_id, row.email_address)
    }
  }
  console.log(`Gmail-connected venues: ${venueIds.size}`)
  for (const v of venueIds) console.log(`  - ${v.slice(0, 8)} (${emailByVenue.get(v)})`)

  if (venueIds.size === 0) {
    console.log('\n(no Gmail connections; cron would no-op — that is the expected outcome)')
    return
  }

  for (const venueId of venueIds) {
    console.log(`\n--- ${venueId.slice(0, 8)} ---`)

    // CHECK 1: structural — does findBacktraceCandidates run and
    // return without throwing?
    let candidates
    try {
      candidates = await findBacktraceCandidates(venueId, { useLiveGmail: false })
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const high = candidates.filter((c) => c.confidence === 'high').length
    const medium = candidates.filter((c) => c.confidence === 'medium').length
    const total = candidates.length
    console.log(`  candidates total=${total} high=${high} medium=${medium}`)

    // CHECK 2: the 7-day dedup query the cron uses. Confirm it works
    // and reports the right gating decision without actually
    // creating a notification (read-only check).
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: recent } = await sb
      .from('admin_notifications')
      .select('id, created_at, read')
      .eq('venue_id', venueId)
      .eq('type', 'source_backtrace_ready')
      .gte('created_at', sevenDaysAgo)
      .limit(1)
    const recentArr = (recent ?? []) as Array<{ id: string; created_at: string; read: boolean }>
    if (recentArr.length > 0) {
      console.log(`  dedup: would SKIP — recent notif at ${recentArr[0].created_at} (read=${recentArr[0].read})`)
    } else if (high > 0) {
      console.log(`  dedup: would NOTIFY — ${high} high-confidence and no notif in 7d`)
    } else {
      console.log(`  dedup: would NOT notify (high=0)`)
    }
  }

  console.log('\n=== done ===')
}

main().catch((err) => { console.error(err); process.exit(1) })
