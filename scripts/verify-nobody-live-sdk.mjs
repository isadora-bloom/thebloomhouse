// Quick port of verify-nobody-live.sql using the admin SDK (no Management API PAT needed).
// READ-ONLY. Safe to run against prod.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const url = env.NEXT_PUBLIC_SUPABASE_URL
const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

console.log(`Checking: ${url}\n`)

// 1. Auth users via admin SDK
const { data: { users }, error: uErr } = await sb.auth.admin.listUsers({ perPage: 500 })
if (uErr) { console.error('auth.admin.listUsers failed:', uErr.message); process.exit(1) }

const now = Date.now()
const d30 = now - 30 * 24 * 3600 * 1000
const d7  = now -  7 * 24 * 3600 * 1000
const active30 = users.filter(u => u.last_sign_in_at && new Date(u.last_sign_in_at) > new Date(d30))
const active7  = users.filter(u => u.last_sign_in_at && new Date(u.last_sign_in_at) > new Date(d7))
const mostRecent = users.reduce((m, u) => {
  if (!u.last_sign_in_at) return m
  return !m || new Date(u.last_sign_in_at) > new Date(m) ? u.last_sign_in_at : m
}, null)

console.log('=== 1) Auth users ===')
console.log(`  total_users   : ${users.length}`)
console.log(`  active_30d    : ${active30.length}`)
console.log(`  active_7d     : ${active7.length}`)
console.log(`  most_recent   : ${mostRecent ?? 'none'}`)
if (active30.length > 0) {
  console.log('  ⚠ ACTIVE USERS:')
  for (const u of active30) console.log(`    ${u.email} last=${u.last_sign_in_at}`)
}

// 2. user_profiles role check
const { data: profiles } = await sb.from('user_profiles').select('id, role, email').limit(100)
const nonStaff = (profiles ?? []).filter(p => !['admin','staff','coordinator','operator'].includes(p.role))
console.log('\n=== 2) user_profiles ===')
console.log(`  total profiles: ${(profiles ?? []).length}`)
if (nonStaff.length > 0) {
  console.log('  ⚠ NON-STAFF ROLES:')
  for (const p of nonStaff) console.log(`    ${p.email} role=${p.role}`)
} else {
  console.log('  all profiles are staff/operator/coordinator/admin roles ✓')
}

// 3. Recent writes on key tables (portal-facing)
const PORTAL_TABLES = [
  'weddings', 'interactions', 'drafts', 'tours', 'guest_list',
  'budget', 'messages', 'timeline', 'contracts',
]
console.log('\n=== 3) Portal-table writes (30d) ===')
for (const t of PORTAL_TABLES) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true })
    .gte('created_at', new Date(d30).toISOString())
  if (error) { console.log(`  ${t.padEnd(20)} (skip: ${error.message.slice(0, 50)})`); continue }
  if ((count ?? 0) > 0) console.log(`  ${t.padEnd(20)} ${count} recent rows  ← note`)
  else console.log(`  ${t.padEnd(20)} 0`)
}

console.log('\n=== VERDICT ===')
const safe = active30.length === 0 && nonStaff.length === 0
console.log(safe ? '✓ SAFE — nobody live; wipe may proceed.' : '⚠ STOP — active users or non-staff roles found.')
