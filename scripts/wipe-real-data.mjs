// Wipe all non-demo data (venues, orgs, user_profiles) in prod Supabase.
// Preserves: is_demo=true venues + organisations, auth users (none exist),
// and any global/reference tables (market_intelligence, industry_benchmarks,
// rate_limits, stripe_events).
//
// Usage:
//   node scripts/wipe-real-data.mjs              # dry-run (default)
//   node scripts/wipe-real-data.mjs --execute    # actually delete
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const EXECUTE = process.argv.includes('--execute')

console.log(EXECUTE ? '=== EXECUTING WIPE ===' : '=== DRY RUN (pass --execute to actually delete) ===\n')

// --- 1. Enumerate targets ---------------------------------------------------
const { data: realVenues } = await sb.from('venues').select('id, name, slug').eq('is_demo', false)
const { data: realOrgs   } = await sb.from('organisations').select('id, name').eq('is_demo', false)
const realVenueIds = (realVenues ?? []).map((v) => v.id)
const realOrgIds   = (realOrgs   ?? []).map((o) => o.id)

console.log(`Real venues to delete: ${realVenues?.length ?? 0}`)
for (const v of (realVenues ?? []).slice(0, 5)) console.log(`  ${v.name} (${v.slug})`)
if ((realVenues?.length ?? 0) > 5) console.log(`  ... and ${realVenues.length - 5} more`)

console.log(`\nReal orgs to delete: ${realOrgs?.length ?? 0}`)
for (const o of (realOrgs ?? []).slice(0, 5)) console.log(`  ${o.name}`)
if ((realOrgs?.length ?? 0) > 5) console.log(`  ... and ${realOrgs.length - 5} more`)

// --- 2. Enumerate a sample of impacted child rows for transparency ---------
console.log('\n=== Child-row counts that will cascade-delete ===')
for (const t of ['weddings', 'people', 'interactions', 'drafts', 'user_profiles', 'knowledge_base', 'booked_dates', 'sage_conversations', 'api_costs']) {
  if (realVenueIds.length === 0) { console.log(`  ${t.padEnd(22)} —`); continue }
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).in('venue_id', realVenueIds)
  if (error) console.log(`  ${t.padEnd(22)} (skip: ${error.message.slice(0,40)})`)
  else console.log(`  ${t.padEnd(22)} ${count} rows`)
}

// user_profiles is org-scoped too
{
  const { count } = await sb.from('user_profiles').select('*', { count: 'exact', head: true }).in('org_id', realOrgIds)
  console.log(`  user_profiles (by org): ${count}`)
}

if (!EXECUTE) {
  console.log('\nDry run complete. Re-run with --execute to delete.')
  process.exit(0)
}

// --- 3. Execute ------------------------------------------------------------
console.log('\n=== Deleting ===')

// 3a. user_profiles (FK not cascaded from orgs; from venues depends on schema)
{
  const { error, count } = await sb.from('user_profiles').delete({ count: 'exact' }).in('org_id', realOrgIds)
  if (error) console.error('  user_profiles by org:', error.message)
  else console.log(`  user_profiles by org: deleted ${count}`)
}
{
  const { error, count } = await sb.from('user_profiles').delete({ count: 'exact' }).in('venue_id', realVenueIds)
  if (error) console.error('  user_profiles by venue:', error.message)
  else console.log(`  user_profiles by venue: deleted ${count}`)
}

// 3b. Tables with venue_id that do NOT cascade (from migrations 014/016/017/019/049)
const NON_CASCADE_TABLES = [
  'wedding_details', 'wedding_tables', 'storefront', 'venue_assets', 'venue_resources', // 014
  'wedding_detail_config', // 016
  'budget_items', 'budget_payments', 'wedding_config', 'wedding_timeline', 'notifications', 'couple_budget', // 017
  'rsvp_config', 'rsvp_responses', // 019
  'team_invitations', // 049
]
for (const t of NON_CASCADE_TABLES) {
  const { error, count } = await sb.from(t).delete({ count: 'exact' }).in('venue_id', realVenueIds)
  if (error) console.log(`  ${t.padEnd(22)} skip/err: ${error.message.slice(0,60)}`)
  else console.log(`  ${t.padEnd(22)} deleted ${count}`)
}

// 3c. venues (remaining children cascade via FK ON DELETE CASCADE)
{
  const { error, count } = await sb.from('venues').delete({ count: 'exact' }).eq('is_demo', false)
  if (error) console.error('  venues:', error.message)
  else console.log(`  venues: deleted ${count}`)
}

// 3d. Delete organisations
{
  const { error, count } = await sb.from('organisations').delete({ count: 'exact' }).eq('is_demo', false)
  if (error) console.error('  organisations:', error.message)
  else console.log(`  organisations: deleted ${count}`)
}

// --- 4. Verify --------------------------------------------------------------
console.log('\n=== Post-wipe state ===')
{
  const { count: demoV } = await sb.from('venues').select('*', { count: 'exact', head: true }).eq('is_demo', true)
  const { count: realV } = await sb.from('venues').select('*', { count: 'exact', head: true }).eq('is_demo', false)
  const { count: demoO } = await sb.from('organisations').select('*', { count: 'exact', head: true }).eq('is_demo', true)
  const { count: realO } = await sb.from('organisations').select('*', { count: 'exact', head: true }).eq('is_demo', false)
  console.log(`  venues: ${demoV} demo, ${realV} real (should be 4 / 0)`)
  console.log(`  orgs  : ${demoO} demo, ${realO} real (should be 1 / 0)`)
}
