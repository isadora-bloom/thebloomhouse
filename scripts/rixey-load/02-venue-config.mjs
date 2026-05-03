// Phase 1: ensure Rixey venue_ai_config + venue_config + user_profiles
// match the go-live brief. Idempotent.
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

// ---- venue_ai_config: set ai_name + ai_email ----
console.log('[venue_ai_config] updating ai_name + ai_email...')
const { error: aiErr } = await sb
  .from('venue_ai_config')
  .update({
    ai_name: 'Rixey Concierge',
    ai_email: 'info@rixeymanor.com',
  })
  .eq('venue_id', RIXEY_ID)
if (aiErr) console.error('  err:', aiErr.message)
else console.log('  ok')

// ---- venue_config: ensure timezone + coordinator email ----
console.log('[venue_config] updating coordinator_email + business_name...')
const { error: vcErr } = await sb
  .from('venue_config')
  .update({
    business_name: 'Rixey Manor',
    coordinator_email: 'info@rixeymanor.com',
    timezone: 'America/New_York',
  })
  .eq('venue_id', RIXEY_ID)
if (vcErr) console.error('  err:', vcErr.message)
else console.log('  ok')

// ---- user_profiles: ensure Grace Baker exists ----
// We can't create auth.users without their email + password. user_profiles
// has a FK to auth.users(id). To add Grace, we need her in auth first.
// Use service-role admin API.
console.log('[auth] checking for grace@rixeymanor.com user...')
const { data: existingUsers } = await sb.auth.admin.listUsers({ page: 1, perPage: 100 })
const grace = existingUsers.users.find((u) => u.email?.toLowerCase() === 'grace@rixeymanor.com')
let graceUserId = grace?.id ?? null
if (!graceUserId) {
  console.log('[auth] creating grace@rixeymanor.com auth user...')
  const { data: created, error: cErr } = await sb.auth.admin.createUser({
    email: 'grace@rixeymanor.com',
    email_confirm: true,
    user_metadata: { first_name: 'Grace', last_name: 'Baker' },
  })
  if (cErr) console.error('  err:', cErr.message)
  else {
    graceUserId = created.user.id
    console.log('  created:', graceUserId)
  }
} else {
  console.log('  exists:', graceUserId)
}

if (graceUserId) {
  // Upsert user_profiles row.
  const { error: upErr } = await sb
    .from('user_profiles')
    .upsert({
      id: graceUserId,
      venue_id: RIXEY_ID,
      role: 'coordinator',
      first_name: 'Grace',
      last_name: 'Baker',
    }, { onConflict: 'id' })
  if (upErr) console.error('[user_profiles] grace upsert err:', upErr.message)
  else console.log('[user_profiles] grace ok')
}

// ---- Verify ----
console.log()
console.log('Final state:')
const { data: cfg } = await sb.from('venue_ai_config').select('ai_name, ai_email').eq('venue_id', RIXEY_ID).maybeSingle()
console.log('  venue_ai_config:', cfg)
const { data: vc } = await sb.from('venue_config').select('business_name, coordinator_email, timezone').eq('venue_id', RIXEY_ID).maybeSingle()
console.log('  venue_config:', vc)
const { data: profiles } = await sb.from('user_profiles').select('id, role, first_name, last_name').eq('venue_id', RIXEY_ID)
for (const p of profiles ?? []) console.log(`  user_profile: ${p.role.padEnd(18)} ${p.first_name} ${p.last_name} ${p.id}`)
