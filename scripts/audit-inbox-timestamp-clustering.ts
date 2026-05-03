// T5-Rixey-III bug 26 audit script.
//
// User reported the live inbox showing top emails at "11h, 16h, 17h, 17h
// ago" and asked if the timestamps were clustering on import time rather
// than real arrival time.
//
// Static-code finding (see comment in src/app/(platform)/agent/inbox/page.tsx
// next to `timeAgo(interaction.timestamp)`):
//   - the inbox query orders by `interactions.timestamp` desc
//     (page.tsx:1383)
//   - the email pipeline writes `interactions.timestamp = email.date`
//     where `email.date` is Gmail's reported receive time
//     (email-pipeline.ts:777, 979)
//   - outbound sends are the only path that writes `timestamp =
//     new Date().toISOString()` (email-pipeline.ts:3003) — those
//     should be brief and clustered to roughly when Sage actually
//     pressed Send, which is correct
//
// So the renderer is wired to real arrival time. Run THIS script
// against a live Supabase to verify on real data:
//   npx tsx scripts/audit-inbox-timestamp-clustering.ts <venueId>
//
// It pulls the top 20 inbox rows and prints both `timestamp` and
// `created_at` so you can eyeball whether they correlate (clustering
// on import time would show created_at ≈ timestamp ≈ now). Healthy
// real data shows `created_at` close to NOW for live-ingested rows
// while `timestamp` is whenever the email actually arrived.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const venueId = process.argv[2]
if (!venueId) {
  console.error('Usage: npx tsx scripts/audit-inbox-timestamp-clustering.ts <venueId>')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

interface Row {
  id: string
  subject: string | null
  from_email: string | null
  direction: string | null
  timestamp: string | null
  created_at: string | null
  confidence_flag: string | null
}

async function main(): Promise<void> {
  const { data, error } = await supabase
    .from('interactions')
    .select('id, subject, from_email, direction, timestamp, created_at, confidence_flag')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .order('timestamp', { ascending: false })
    .limit(20)

  if (error) {
    console.error('Query failed:', error.message)
    process.exit(1)
  }

  const now = Date.now()
  const rows = (data ?? []) as Row[]
  console.log(`Top 20 inbox rows for venue ${venueId} (now: ${new Date().toISOString()})`)
  console.log('───────────────────────────────────────────────')
  console.log('  arrived  created  Δ(s)  flag        from / subject')

  let suspicious = 0
  for (const row of rows) {
    if (!row.timestamp || !row.created_at) continue
    const arrivedAgo = (now - new Date(row.timestamp).getTime()) / 3600_000
    const createdAgo = (now - new Date(row.created_at).getTime()) / 3600_000
    const lagSec = (new Date(row.created_at).getTime() - new Date(row.timestamp).getTime()) / 1000
    // Flag rows where created_at is within 60s of timestamp AND timestamp
    // is more than 1h old. That pattern says "we wrote `now()` into
    // timestamp at import time" — the bug pattern user worried about.
    const isSuspicious = Math.abs(lagSec) < 60 && arrivedAgo > 1
    if (isSuspicious) suspicious += 1
    console.log(
      `  ${arrivedAgo.toFixed(1)}h  ${createdAgo.toFixed(1)}h  ${lagSec.toFixed(0).padStart(5)}  ${(row.confidence_flag ?? 'live').padEnd(10)}  ${(row.from_email ?? '?').slice(0, 30).padEnd(30)}  ${(row.subject ?? '').slice(0, 50)}${isSuspicious ? '  <-- SUSPICIOUS' : ''}`
    )
  }

  console.log('───────────────────────────────────────────────')
  if (suspicious > 0) {
    console.log(
      `${suspicious} row(s) had created_at ≈ timestamp despite timestamp being >1h old.\n` +
      'That pattern points to import-time leakage. Cross-check the writer\n' +
      'path that produced these rows.'
    )
    process.exit(2)
  } else {
    console.log('No clustering detected. Timestamps look like real arrival times.')
  }
}

main().catch((err) => {
  console.error('Script failed:', err)
  process.exit(1)
})
