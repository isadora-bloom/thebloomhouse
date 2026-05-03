// Probe Supabase connection + check whether Rixey venue exists already.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

console.log('SUPABASE URL:', env.NEXT_PUBLIC_SUPABASE_URL)
console.log()

const { data: venues, error: vErr } = await sb.from('venues').select('id, name, slug, status, created_at').order('created_at', { ascending: false })
if (vErr) {
  console.error('venues query failed:', vErr)
  process.exit(1)
}
console.log(`Existing venues (${venues.length}):`)
for (const v of venues) {
  console.log(`  ${v.slug.padEnd(28)} ${v.name.padEnd(40)} ${v.status} ${v.id}`)
}

console.log()
console.log('Looking for any rixey* slug...')
const { data: rixey } = await sb.from('venues').select('id, name, slug').ilike('slug', 'rixey%')
if (rixey && rixey.length > 0) {
  for (const v of rixey) {
    const [{ count: weddingCt }] = await Promise.all([
      sb.from('weddings').select('id', { count: 'exact', head: true }).eq('venue_id', v.id),
    ])
    console.log(`  ${v.slug} ${v.name} → ${weddingCt} weddings`)
  }
} else {
  console.log('  none found')
}

// Marketing spend table sanity
const { data: ms, error: msErr } = await sb.from('marketing_spend').select('*').limit(1)
console.log()
console.log('marketing_spend probe:', msErr ? msErr.message : `ok (sample row keys: ${ms?.[0] ? Object.keys(ms[0]).join(',') : 'no rows'})`)

const { data: ti, error: tiErr } = await sb.from('tangential_signals').select('*').limit(1)
console.log('tangential_signals probe:', tiErr ? tiErr.message : `ok (sample keys: ${ti?.[0] ? Object.keys(ti[0]).join(',') : 'no rows'})`)
