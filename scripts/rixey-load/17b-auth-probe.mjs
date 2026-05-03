// Stream PP — phase 2 of the auth investigation. The first run revealed:
//   - createUser works for fresh emails (throwaway ✓)
//   - createUser('grace@rixeymanor.com') fails with "Database error checking email"
//   - listUsers() ALSO fails with "Database error finding users"
//   - inviteUserByEmail also fails
//
// Pattern: anything touching the existing auth.users table state errors,
// while a fresh insert path (admin.createUser with novel email) works.
//
// Hypothesis: a corrupted / partial row in auth.users with email=
// grace@rixeymanor.com (or matching pattern) is breaking the email-lookup
// query that runs BEFORE both listUsers and createUser-with-email-check.
// Likely: the row exists but with NULL or malformed identity rows joined
// from auth.identities, breaking the gotrue email lookup.
//
// Probe paths we can use without raw SQL:
//   - listUsers with paged step (smaller perPage) to find which page errors
//   - getUserById on a guess if we had Grace's id (we don't)
//   - createUser with permutations: trailing space, +alias, alternate domain
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

console.log('=== auth probe phase 2 ===')

// Try listUsers with small pages to find the bad row
console.log()
console.log('[1] listUsers paged probe — find which page is corrupt')
let totalSeen = 0
let pageWithError = null
let lastPageReached = 0
for (let page = 1; page <= 20; page++) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 10 })
  if (error) {
    pageWithError = page
    console.log(`  page ${page} (perPage=10): ERROR — ${error.message}`)
    break
  }
  const users = data.users ?? []
  totalSeen += users.length
  lastPageReached = page
  if (users.length < 10) {
    console.log(`  page ${page}: ${users.length} users (final). Total reached: ${totalSeen}`)
    break
  }
}
console.log(`  reached page ${lastPageReached}, total users listed: ${totalSeen}`)
if (pageWithError) {
  console.log(`  failure starts at page ${pageWithError}`)
  // Drill into the page with size 1
  for (let p = (pageWithError - 1) * 10 + 1; p <= pageWithError * 10; p++) {
    const { error } = await sb.auth.admin.listUsers({ page: p, perPage: 1 })
    if (error) {
      console.log(`    perPage=1 page ${p}: ERROR — ${error.message} (this row offset is the problem)`)
      break
    } else {
      console.log(`    perPage=1 page ${p}: ok`)
    }
  }
}

// Try email permutations — see whether the lookup is exact-string or pattern
console.log()
console.log('[2] createUser permutations on grace@rixeymanor.com')
const variants = [
  'GRACE@rixeymanor.com',
  'grace+test@rixeymanor.com',
  'grace.baker@rixeymanor.com',
  'grace@RIXEYMANOR.com',
  'grace@rixeymanor.org',
  'grace@bloomhouse.test',
]
for (const e of variants) {
  const { data, error } = await sb.auth.admin.createUser({
    email: e,
    email_confirm: true,
  })
  if (error) {
    console.log(`  ${e.padEnd(40)} ERR: ${error.message}`)
  } else {
    console.log(`  ${e.padEnd(40)} OK id=${data.user?.id}`)
    if (data.user?.id) {
      await sb.auth.admin.deleteUser(data.user.id)
    }
  }
}

// Probe: query auth.users via RPC if a service-role-callable helper exists
console.log()
console.log('[3] Try direct postgrest /auth schema (will fail unless exposed)')
{
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/users?select=id,email,deleted_at&email=ilike.*grace*`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile': 'auth',
    },
  })
  console.log('  status:', r.status)
  console.log('  body:', (await r.text()).slice(0, 400))
}

console.log()
console.log('=== done ===')
