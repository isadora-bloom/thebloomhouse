import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// 1. Check web_visits table exists
const { error: wvErr } = await sb.from('web_visits').select('id').limit(1)
console.log(`web_visits table: ${wvErr ? `MISSING (${wvErr.message})` : 'exists'}`)

// 2. Knot: how many theknot emails in recent months vs all time
const months = ['2026-04', '2026-05', '2026-06', '2026-07']
console.log('\nKnot interactions by month (DB):')
for (const m of months) {
  const next = m === '2026-07' ? '2026-08' : m.slice(0,5) + String(parseInt(m.slice(5)) + 1).padStart(2,'0')
  const { count } = await sb.from('interactions').select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY).ilike('from_email', '%theknot%')
    .gte('timestamp', `${m}-01`).lt('timestamp', `${next}-01`)
  console.log(`  ${m}: ${count}`)
}

// 3. calendly_qa: how populated is it?
const { count: wedTotal } = await sb.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', RIXEY)
const { count: wedCalendlyQA } = await sb.from('weddings').select('*', { count: 'exact', head: true })
  .eq('venue_id', RIXEY).not('calendly_qa', 'is', null)
console.log(`\ncalendy_qa: ${wedCalendlyQA}/${wedTotal} weddings have it`)

// 4. Calendly "New Event:" emails in interactions (backfill material)
const { count: newEventEmails } = await sb.from('interactions').select('*', { count: 'exact', head: true })
  .eq('venue_id', RIXEY).ilike('subject', '%New Event:%')
const { count: newEventEmailsAlt } = await sb.from('interactions').select('*', { count: 'exact', head: true })
  .eq('venue_id', RIXEY).ilike('subject', '%calendly%')
console.log(`Calendly "New Event:" emails in interactions: ${newEventEmails}`)
console.log(`Calendly "calendly" in subject: ${newEventEmailsAlt}`)

// 5. discovery_sources / attribution_events counts
const { count: dsCt } = await sb.from('discovery_sources').select('*', { count: 'exact', head: true }).eq('venue_id', RIXEY)
const { count: aeCt } = await sb.from('attribution_events').select('*', { count: 'exact', head: true }).eq('venue_id', RIXEY)
console.log(`\ndiscovery_sources: ${dsCt}, attribution_events: ${aeCt}`)
