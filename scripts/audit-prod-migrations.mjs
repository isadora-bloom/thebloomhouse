// Probe prod Supabase for the presence of every table and column that
// recent migrations should have added. Surfaces any that are missing so we
// know which migrations never applied.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const tables = [
  // Core
  ['venues', ['id', 'name', 'slug', 'org_id', 'status', 'is_demo', 'city', 'state', 'plan_tier', 'onboarded_at']],
  ['organisations', ['id', 'name', 'owner_id', 'is_demo']],
  ['user_profiles', ['id', 'venue_id', 'org_id', 'role', 'first_name', 'last_name']],
  ['venue_config', ['venue_id', 'business_name', 'timezone', 'capacity', 'base_price', 'onboarding_completed']],
  ['weddings', ['id', 'venue_id', 'event_code', 'couple_invited_at', 'couple_registered_at']],
  // Recent
  ['venue_groups', ['id', 'org_id', 'name', 'description']],
  ['venue_group_members', ['id', 'group_id', 'venue_id']],
  ['team_invitations', ['id', 'org_id', 'venue_id', 'email', 'role', 'token', 'status', 'expires_at']],
  ['gmail_connections', ['id', 'venue_id', 'email', 'access_token']],
  ['rate_limits', ['id', 'bucket', 'identifier']],
  ['stripe_events', ['id', 'event_id', 'type']],
  // Intelligence
  ['intelligence_insights', ['id', 'venue_id', 'category', 'title', 'insight']],
  ['insight_outcomes', ['id', 'insight_id', 'action_taken']],
  ['event_feedback', ['id', 'venue_id', 'wedding_id']],
]

console.log('=== Table & column audit ===')
for (const [tbl, cols] of tables) {
  const { error } = await sb.from(tbl).select(cols.join(',')).limit(1)
  if (error) {
    const missing = error.message.match(/column "?([^"]+)"? does not exist/i)?.[1]
    const tableMissing = /schema cache|does not exist/i.test(error.message) && error.code === 'PGRST205'
    if (tableMissing) console.log(`  ${tbl.padEnd(26)} TABLE MISSING`)
    else if (missing) console.log(`  ${tbl.padEnd(26)} column missing: ${missing}`)
    else console.log(`  ${tbl.padEnd(26)} ERR ${error.code}: ${error.message.slice(0, 70)}`)
  } else {
    console.log(`  ${tbl.padEnd(26)} ok`)
  }
}
