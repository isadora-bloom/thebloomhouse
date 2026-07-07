import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const KEY_TABLES = [
  'weddings', 'couples', 'interactions', 'people', 'touchpoints',
  'fragments', 'candidate_matches', 'tracer_run_events', 'drafts',
  'couple_identity_profile', 'couple_intel', 'engagement_events',
  'tangential_signals', 'candidate_identities', 'email_sync_state',
  'crm_import_rows', 'import_runs',
]

let dirty = 0
for (const t of KEY_TABLES) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('venue_id', VENUE)
  if (error) { console.log(`  ${t.padEnd(30)} (skip: ${error.message.slice(0, 50)})`); continue }
  const n = count ?? 0
  if (n > 0) { console.log(`  ⚠ ${t.padEnd(28)} ${n} rows remain`); dirty++ }
  else console.log(`  ✓ ${t.padEnd(28)} 0`)
}
console.log(dirty === 0 ? '\n✓ CLEAN — all key tables empty. Ready for reimport.' : `\n⚠ ${dirty} table(s) still have rows.`)
