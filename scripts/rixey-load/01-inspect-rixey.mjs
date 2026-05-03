// Inspect existing Rixey state before deciding wipe vs upsert.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const counts = async () => {
  const tables = [
    'weddings', 'people', 'interactions', 'tours', 'lost_deals',
    'marketing_spend', 'tangential_signals', 'lead_source_derivation_log',
    'intelligence_insights', 'attribution_events', 'candidate_identities',
    'engagement_events', 'lead_score_history',
  ]
  for (const t of tables) {
    const { count, error } = await sb.from(t).select('id', { count: 'exact', head: true }).eq('venue_id', RIXEY_ID)
    console.log(`  ${t.padEnd(32)} ${error ? error.message : count}`)
  }
}
console.log('Per-table counts on Rixey:')
await counts()

console.log()
console.log('weddings.crm_source breakdown:')
const { data: bySource } = await sb
  .from('weddings')
  .select('crm_source, confidence_flag')
  .eq('venue_id', RIXEY_ID)
const tally = {}
for (const w of bySource ?? []) {
  const k = `${w.crm_source ?? 'null'} / ${w.confidence_flag ?? 'null'}`
  tally[k] = (tally[k] ?? 0) + 1
}
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(40)} ${v}`)

console.log()
console.log('marketing_spend rows on Rixey:')
const { data: ms } = await sb.from('marketing_spend').select('source, month, amount, source_provenance, confidence_flag').eq('venue_id', RIXEY_ID).order('month')
console.log(`  total: ${ms?.length ?? 0}`)
for (const r of (ms ?? []).slice(0, 20)) {
  console.log(`  ${r.month}  ${r.source.padEnd(20)} $${r.amount}  prov=${r.source_provenance} conf=${r.confidence_flag ?? '-'}`)
}

console.log()
console.log('venue_ai_config:')
const { data: cfg } = await sb.from('venue_ai_config').select('*').eq('venue_id', RIXEY_ID).maybeSingle()
console.log(cfg ? `  ai_name=${cfg.ai_name} ai_email=${cfg.ai_email}` : '  none')

console.log()
console.log('venue_config:')
const { data: vc } = await sb.from('venue_config').select('*').eq('venue_id', RIXEY_ID).maybeSingle()
console.log(vc ? `  business_name=${vc.business_name} timezone=${vc.timezone}` : '  none')

console.log()
console.log('user_profiles for Rixey venue:')
const { data: profiles } = await sb.from('user_profiles').select('id, role, first_name, last_name').eq('venue_id', RIXEY_ID)
for (const p of profiles ?? []) console.log(`  ${p.role.padEnd(18)} ${p.first_name} ${p.last_name} ${p.id}`)
