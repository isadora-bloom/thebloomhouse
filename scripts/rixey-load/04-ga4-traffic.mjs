// Phase 3: GA4 traffic load.
// Two annual rollups (2025 full year, 2026 YTD partial). Recorded as
// tangential_signals rows with signal_type='analytics_entry' since
// GA4 channel sessions are tangential funnel signals, not direct identity.
// Each row's signal_date = period start; payload encodes the metrics +
// period bounds.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const FILES = [
  {
    path: 'C:/Users/Ismar/Downloads/Traffic_acquisition_Session_primary_channel_group_(Default_Channel_Group) (2).csv',
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    label: 'GA4 2025 annual',
  },
  {
    path: 'C:/Users/Ismar/Downloads/Traffic_acquisition_Session_primary_channel_group_(Default_Channel_Group) (3).csv',
    period_start: '2026-01-01',
    period_end: '2026-05-03',
    label: 'GA4 2026 YTD (through May 3)',
  },
]

function parseGa4Csv(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  // First data table starts after the comment header + the first non-comment
  // row (which is the column header). Then continues until a blank line.
  let inTable = false
  let header = null
  const rows = []
  for (const line of lines) {
    if (line.startsWith('#')) continue
    if (!inTable) {
      // First non-comment line is the header.
      if (line.trim().length === 0) continue
      header = line.split(',')
      inTable = true
      continue
    }
    if (line.trim().length === 0) break
    // Skip the second table (per-user) which appears later
    if (line.startsWith('Session primary')) break
    rows.push(line.split(','))
  }
  return { header, rows }
}

const inserts = []
for (const f of FILES) {
  if (!existsSync(f.path)) {
    console.error('missing:', f.path)
    continue
  }
  const { header, rows } = parseGa4Csv(f.path)
  console.log(`${f.label}: ${rows.length} channel rows`)
  for (const r of rows) {
    const channel = r[0]
    const sessions = Number(r[1] ?? 0) || 0
    const engagedSessions = Number(r[2] ?? 0) || 0
    const engagementRate = Number(r[3] ?? 0) || 0
    const avgEngagementSec = Number(r[4] ?? 0) || 0
    const eventsPerSession = Number(r[5] ?? 0) || 0
    const eventCount = Number(r[6] ?? 0) || 0
    const keyEvents = Number(r[7] ?? 0) || 0
    const sessionKeyEventRate = Number(r[8] ?? 0) || 0
    inserts.push({
      venue_id: RIXEY_ID,
      signal_type: 'analytics_entry',
      source_platform: 'ga4',
      action_class: 'website_session',
      extracted_identity: {
        channel_group: channel,
        period_start: f.period_start,
        period_end: f.period_end,
        sessions,
        engaged_sessions: engagedSessions,
        engagement_rate: engagementRate,
        avg_engagement_sec: avgEngagementSec,
        events_per_session: eventsPerSession,
        event_count: eventCount,
        key_events: keyEvents,
        session_key_event_rate: sessionKeyEventRate,
      },
      source_context: `${f.label} — ${channel}`,
      signal_date: `${f.period_start}T00:00:00Z`,
      match_status: 'confirmed_match',
      matched_person_id: null,
      confidence_score: 1.0,
    })
  }
}

console.log(`Total signals to write: ${inserts.length}`)

// Idempotent: detect existing GA4 rows by (signal_type='analytics_entry',
// source_platform='ga4', source_context same). Delete-then-insert is
// simplest for re-runs.
const { error: delErr, count: delCount } = await sb
  .from('tangential_signals')
  .delete({ count: 'exact' })
  .eq('venue_id', RIXEY_ID)
  .eq('signal_type', 'analytics_entry')
  .eq('source_platform', 'ga4')
if (delErr) console.error('delete prior GA4 rows err:', delErr.message)
else console.log(`deleted ${delCount} prior GA4 rows`)

let inserted = 0, errors = 0
// Insert in batches of 50.
for (let i = 0; i < inserts.length; i += 50) {
  const batch = inserts.slice(i, i + 50)
  const { error } = await sb.from('tangential_signals').insert(batch)
  if (error) { errors++; console.error(`batch ${i}: ${error.message}`) } else inserted += batch.length
}
console.log(`inserted=${inserted} errors=${errors}`)
