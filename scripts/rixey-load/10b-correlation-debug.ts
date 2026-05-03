// Debug: print what series are available for Rixey + their non-zero day counts.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main() {

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const WINDOW_DAYS = 90
const now = new Date()
const start = new Date(now.getTime() - WINDOW_DAYS * 86400e3)

console.log(`Window: ${start.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)} (${WINDOW_DAYS}d)`)

// inquiries
const { data: inquiries } = await sb
  .from('weddings')
  .select('inquiry_date')
  .eq('venue_id', RIXEY_ID)
  .is('merged_into_id', null)
  .gte('inquiry_date', start.toISOString())
  .lt('inquiry_date', now.toISOString())
const days = new Set()
for (const w of inquiries ?? []) if (w.inquiry_date) days.add(w.inquiry_date.slice(0, 10))
console.log(`inquiries: ${inquiries?.length} rows, ${days.size} distinct days`)

// engagement_events marketing_metric
const { data: mm } = await sb
  .from('engagement_events')
  .select('event_type, metadata, created_at')
  .eq('venue_id', RIXEY_ID)
  .eq('direction', 'inbound')
  .eq('event_type', 'marketing_metric')
  .gte('created_at', start.toISOString())
console.log(`engagement_events(marketing_metric): ${mm?.length ?? 0}`)

// tangential_signals
const { data: ts } = await sb
  .from('tangential_signals')
  .select('extracted_identity, signal_date, created_at, source_platform')
  .eq('venue_id', RIXEY_ID)
  .or(`signal_date.gte.${start.toISOString()},and(signal_date.is.null,created_at.gte.${start.toISOString()})`)
console.log(`tangential_signals: ${ts?.length ?? 0}`)
const platCounts: Record<string, number> = {}
for (const r of ts ?? []) {
  const p = ((r.extracted_identity as any)?.platform) ?? r.source_platform ?? 'other'
  platCounts[p] = (platCounts[p] ?? 0) + 1
}
console.log('  by extracted_identity.platform fallback source_platform:', platCounts)

// FRED
const { count: fredCt } = await sb.from('fred_indicators').select('id', { count: 'exact', head: true }).gte('observation_date', start.toISOString().slice(0, 10))
console.log(`fred_indicators in window: ${fredCt}`)

// calendar
const { count: calCt } = await sb.from('external_calendar_events').select('id', { count: 'exact', head: true }).gte('start_date', start.toISOString().slice(0, 10)).lte('start_date', now.toISOString().slice(0, 10))
console.log(`external_calendar_events in window: ${calCt}`)

// cultural_moments confirmed
const { data: cmConfirmed } = await sb.from('venue_cultural_moment_state').select('moment_id, status').eq('venue_id', RIXEY_ID).eq('status', 'confirmed')
console.log(`cultural_moments confirmed for Rixey: ${cmConfirmed?.length ?? 0}`)

// Ask: what's MIN_NONZERO_DAYS gate doing?
console.log()
console.log('MIN_NONZERO_DAYS=20 gate: inquiries has', days.size, 'non-zero days. Pass:', days.size >= 20)
}
main().catch(e => { console.error(e); process.exit(1) })
