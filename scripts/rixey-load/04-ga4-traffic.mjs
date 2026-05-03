// Phase 3: GA4 traffic load.
// Two annual rollups (2025 full year, 2026 YTD partial).
//
// T5-Rixey-OO platform finding (2026-05-02): GA4 channel rollups now
// land in `website_traffic_history` (migration 183), NOT
// tangential_signals. Rationale: tangential_signals is per-LEAD
// identifiable touches; GA4 channel rollups are venue-level aggregates
// with no person identity. The dedicated table cleans up identity-
// cluster operations + powers Sage's "what % of my traffic is paid
// search?" answers via intel-brain.ts.
//
// Idempotent via the (venue_id, period_start, period_end,
// channel_group, source) UNIQUE INDEX — re-runs upsert.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'

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
  const { rows } = parseGa4Csv(f.path)
  console.log(`${f.label}: ${rows.length} channel rows`)
  for (const r of rows) {
    const channel = (r[0] ?? '').trim()
    if (!channel) continue
    const sessions = Number(r[1] ?? 0) || 0
    const engagedSessions = Number(r[2] ?? 0) || 0
    const engagementRate = Number(r[3] ?? 0) || 0
    const keyEvents = Number(r[7] ?? 0) || 0
    const sessionKeyEventRate = Number(r[8] ?? 0) || 0
    inserts.push({
      venue_id: RIXEY_ID,
      period_start: f.period_start,
      period_end: f.period_end,
      channel_group: channel,
      sessions,
      engaged_sessions: engagedSessions,
      key_events: keyEvents,
      engagement_rate: engagementRate,
      session_key_event_rate: sessionKeyEventRate,
      source: 'ga4',
    })
  }
}

console.log(`Total website_traffic_history rows to upsert: ${inserts.length}`)

let inserted = 0, errors = 0
// Upsert in batches of 50 against the (venue_id, period_start,
// period_end, channel_group, source) unique index.
for (let i = 0; i < inserts.length; i += 50) {
  const batch = inserts.slice(i, i + 50)
  const { error } = await sb
    .from('website_traffic_history')
    .upsert(batch, { onConflict: 'venue_id,period_start,period_end,channel_group,source' })
  if (error) { errors++; console.error(`batch ${i}: ${error.message}`) } else inserted += batch.length
}
console.log(`upserted=${inserted} errors=${errors}`)
