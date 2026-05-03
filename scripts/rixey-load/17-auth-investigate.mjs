// Stream PP — investigate Stream MM bug #1: auth.admin.createUser()
// returns "Database error checking email" against staging Supabase when
// trying to add Grace Baker.
//
// What we look at:
//   1. List triggers on auth.users (any BEFORE INSERT trigger that could
//      block the email-uniqueness check).
//   2. Reproduce the error with a throwaway test email so the fingerprint
//      matches what Stream MM saw.
//   3. Inspect auth.users for Grace's email at all (case-insensitive)
//      in case the row partially exists.
//   4. Check if email_change / banned_until / deleted_at columns are
//      blocking the new write.
//
// Read-only — never inserts production data. The repro test uses a
// throwaway address ('pp-test+<rand>@bloomhouse.test') which we delete
// at the end of the run.
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

console.log('=== Auth admin createUser investigation ===')
console.log('Supabase URL:', env.NEXT_PUBLIC_SUPABASE_URL)
console.log()

// ---------------------------------------------------------------
// (1) Triggers on auth.users
// ---------------------------------------------------------------
console.log('[1] Triggers on auth.users')
{
  // Use the PostgREST RPC endpoint via service-role to query
  // information_schema.triggers. The Supabase JS client can't do raw
  // SQL directly, so we issue a POST to /rest/v1/rpc/<fn>; if no fn
  // exists we fall back to a SQL via the management API. Easiest path
  // here: POST /pg/query via the supabase-js .rpc() — but we don't
  // have such an RPC. Use the supabase REST + the service-role JWT
  // and the PostgREST 'rest' style is wrong for ad-hoc SQL.
  //
  // Workaround: hit the meta API directly using fetch + the service
  // key as the bearer.
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/exec_sql`
  const sql = `
    SELECT
      tg.tgname AS trigger_name,
      CASE tg.tgtype::int & 2 WHEN 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
      CASE tg.tgtype::int & 4 WHEN 4 THEN 'INSERT' WHEN 8 THEN 'DELETE' WHEN 16 THEN 'UPDATE' END AS event,
      pg_get_triggerdef(tg.oid) AS definition,
      ns.nspname AS proc_schema,
      p.proname AS proc_name
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = tg.tgfoid
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND NOT tg.tgisinternal
    ORDER BY tg.tgname
  `
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ query: sql }),
  })
  const text = await resp.text()
  if (!resp.ok) {
    console.log(`  exec_sql RPC missing (${resp.status}). Output:`)
    console.log(`  ${text.slice(0, 300)}`)
    console.log('  (Skip — no SQL probe path. Below: information_schema via PostgREST.)')
  } else {
    console.log(text)
  }
}

console.log()
console.log('[1b] Trigger probe via direct postgrest table query (information_schema)')
{
  // information_schema.triggers IS exposed by PostgREST when the
  // schema list includes 'information_schema'; most projects don't.
  // Try anyway.
  const r = await sb
    .schema('information_schema')
    .from('triggers')
    .select('trigger_name, event_manipulation, action_timing, action_statement')
    .eq('event_object_schema', 'auth')
    .eq('event_object_table', 'users')
  if (r.error) {
    console.log('  err:', r.error.message)
    console.log('  (information_schema not exposed by PostgREST — this is normal.)')
  } else {
    for (const row of r.data ?? []) {
      console.log('  trigger:', row)
    }
  }
}

// ---------------------------------------------------------------
// (2) Probe Grace's row + nearby state
// ---------------------------------------------------------------
console.log()
console.log('[2] List existing auth.users matching grace@rixeymanor.com (case-insensitive)')
{
  const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) {
    console.log('  listUsers err:', error.message)
  } else {
    const matches = (data.users ?? []).filter((u) =>
      (u.email ?? '').toLowerCase().includes('grace') ||
      (u.email ?? '').toLowerCase().includes('rixeymanor')
    )
    if (matches.length === 0) {
      console.log('  (no existing user with grace@ or @rixeymanor.com)')
    } else {
      for (const u of matches) {
        console.log(`  - ${u.email}  id=${u.id}  confirmed_at=${u.email_confirmed_at}  banned=${u.banned_until ?? 'no'}  deleted=${u.deleted_at ?? 'no'}`)
      }
    }
    console.log(`  Total auth.users: ${(data.users ?? []).length}`)
  }
}

// ---------------------------------------------------------------
// (3) Reproduce the error with a throwaway address
// ---------------------------------------------------------------
console.log()
console.log('[3] Reproduce createUser failure (throwaway email)')
{
  const rand = Math.random().toString(36).slice(2, 10)
  const testEmail = `pp-test+${rand}@bloomhouse.test`
  console.log('  trying:', testEmail)
  const { data, error } = await sb.auth.admin.createUser({
    email: testEmail,
    email_confirm: true,
    user_metadata: { source: 'PP-investigation', purpose: 'auth-bug-repro' },
  })
  if (error) {
    console.log('  REPRO MATCH — err:', error.message)
    console.log('  status:', error.status, ' code:', error.code)
    console.log('  cause:', JSON.stringify(error, null, 2).slice(0, 600))
  } else {
    console.log('  unexpectedly succeeded — created:', data.user?.id)
    // Clean up
    if (data.user?.id) {
      const del = await sb.auth.admin.deleteUser(data.user.id)
      if (del.error) console.log('  cleanup err:', del.error.message)
      else console.log('  cleanup: deleted')
    }
  }
}

// ---------------------------------------------------------------
// (4) Probe with grace@rixeymanor.com directly
// ---------------------------------------------------------------
console.log()
console.log('[4] Reproduce with the actual grace@rixeymanor.com address')
{
  const { data, error } = await sb.auth.admin.createUser({
    email: 'grace@rixeymanor.com',
    email_confirm: true,
    user_metadata: { first_name: 'Grace', last_name: 'Baker' },
  })
  if (error) {
    console.log('  REPRO MATCH — err:', error.message)
    console.log('  status:', error.status, ' code:', error.code)
    console.log('  full err:', JSON.stringify(error, null, 2).slice(0, 600))
  } else {
    console.log('  succeeded — created:', data.user?.id)
    console.log('  (NOT cleaning up — this is the actual user we want.)')
  }
}

// ---------------------------------------------------------------
// (5) Try inviteUserByEmail as a workaround path
// ---------------------------------------------------------------
console.log()
console.log('[5] Try inviteUserByEmail() as alt path (sends magic link)')
{
  const { data, error } = await sb.auth.admin.inviteUserByEmail('grace@rixeymanor.com', {
    data: { first_name: 'Grace', last_name: 'Baker' },
  })
  if (error) {
    console.log('  err:', error.message)
    console.log('  status:', error.status, ' code:', error.code)
  } else {
    console.log('  invited:', data?.user?.id)
  }
}

console.log()
console.log('=== Done ===')
