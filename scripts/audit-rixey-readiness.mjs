// Audit whether Rixey Manor onboarding can proceed cleanly.
// Checks: (a) no stale Rixey rows (b) demo seed isolation (c) real venues present
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

console.log('=== Stale Rixey search ===')
{
  const { data } = await sb.from('venues').select('id, name, slug, created_at, demo').ilike('name', '%rixey%')
  console.log('venues matching "rixey":', data?.length ?? 0)
  for (const v of data ?? []) console.log('  ', v)
}
{
  const { data } = await sb.from('organisations').select('id, name, created_at').ilike('name', '%rixey%')
  console.log('organisations matching "rixey":', data?.length ?? 0)
  for (const o of data ?? []) console.log('  ', o)
}

console.log('\n=== All venues (to see demo vs real split) ===')
{
  const { data } = await sb.from('venues').select('id, name, slug, is_demo, created_at').order('created_at', { ascending: true })
  console.log(`total venues: ${data?.length ?? 0}`)
  for (const v of data ?? []) {
    console.log(`  ${v.is_demo ? '[DEMO]' : '[REAL]'} ${(v.name||'').padEnd(30)} slug=${v.slug ?? '(none)'}  ${v.created_at?.slice(0,10)}`)
  }
}

console.log('\n=== Demo-flag coverage — tables that should have it ===')
// Only venues + organisations have is_demo per migration 048.
for (const t of ['venues', 'organisations']) {
  const { count: d, error: e1 } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('is_demo', true)
  if (e1) { console.log(`  ${t.padEnd(20)} is_demo col missing — ${e1.message.slice(0,60)}`); continue }
  const { count: r } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('is_demo', false)
  console.log(`  ${t.padEnd(20)} is_demo=true: ${d}   is_demo=false: ${r}`)
}

console.log('\n=== Crestwood Collection demo venues (should all be demo=true) ===')
{
  const names = ['Hawthorne Manor', 'Crestwood Farm', 'The Glass House', 'Rose Hill Gardens']
  const { data } = await sb.from('venues').select('id, name, is_demo').in('name', names)
  for (const v of data ?? []) {
    const flag = v.is_demo === true ? 'OK (is_demo=true)' : `DRIFT (is_demo=${v.is_demo})`
    console.log(`  ${(v.name||'').padEnd(25)} ${flag}`)
  }
}

console.log('\n=== User accounts (so we know if the Rixey coordinator email already exists) ===')
{
  const { data: users } = await sb.auth.admin.listUsers({ page: 1, perPage: 100 })
  console.log(`total auth users: ${users?.users?.length ?? 0}`)
  const rixeyish = users?.users?.filter((u) => /rixey|isadora/i.test(u.email ?? '')) ?? []
  for (const u of rixeyish) console.log(`  ${u.email}  created=${u.created_at?.slice(0,10)}  id=${u.id}`)
}

console.log('\n=== user_profiles for possible Rixey accounts ===')
{
  const { data } = await sb.from('user_profiles').select('id, email, role, venue_id, org_id').or('email.ilike.%rixey%,email.ilike.%isadora%')
  for (const p of data ?? []) console.log('  ', p)
}
