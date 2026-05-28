import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

console.log('--- Tables that errored during wipe: verify cascade or non-existence ---')
const CHECK = [
  // Probably cascaded via FK from weddings/people:
  'merge_reattachment_log',
  'guest_tag_assignments',
  'ceremony_chair_plans',
  'contacts',
  'table_map_layouts',
  // Probably don't exist (404 schema cache):
  'budget', 'seating_assignments', 'wedding_sequences',
  'purchase_recommendations', 'channel_intel_snapshots',
  'filter_match_log', 'notifications',
]
for (const t of CHECK) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true })
  if (error) console.log(`  ${t.padEnd(35)} → ${error.message.slice(0, 60)}`)
  else console.log(`  ${t.padEnd(35)} → total rows in table: ${count ?? 0}`)
}

console.log('\n--- Spot-check: Rixey is fully wiped on core tables ---')
const CORE = ['weddings', 'people', 'interactions', 'drafts', 'tours', 'candidate_identities', 'attribution_events', 'couple_identity_profile', 'couple_intel', 'crm_import_rows']
for (const t of CORE) {
  const { count } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('venue_id', RIXEY_VENUE_ID)
  console.log(`  ${t.padEnd(35)} rixey rows: ${count ?? 0}`)
}

console.log('\n--- Spot-check: preserved tables still have Rixey data ---')
const PRESERVED = ['voice_preferences', 'voice_dna_derivations', 'review_language', 'reviews', 'brand_assets', 'knowledge_base', 'brain_dump_entries', 'marketing_spend', 'tracked_sources', 'weather_data', 'cultural_moments', 'venue_email_filters', 'gmail_connections', 'venue_config']
for (const t of PRESERVED) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('venue_id', RIXEY_VENUE_ID)
  if (error) console.log(`  ${t.padEnd(35)} → ${error.message.slice(0, 50)}`)
  else console.log(`  ${t.padEnd(35)} rixey rows: ${count ?? 0}`)
}

console.log('\n--- Venue still exists ---')
const { data: v } = await sb.from('venues').select('id, name, plan_tier, is_demo').eq('id', RIXEY_VENUE_ID).single()
console.log(`  ${JSON.stringify(v)}`)
