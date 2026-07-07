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

let total = 0
let round = 0
while (true) {
  const { data: rows, error: fetchErr } = await sb.from('interactions').select('id').eq('venue_id', VENUE).limit(500)
  if (fetchErr) { console.error('fetch error:', fetchErr.message); break }
  if (!rows || rows.length === 0) { console.log('done — no more rows'); break }
  const ids = rows.map((r) => r.id)
  const { error: delErr, count } = await sb.from('interactions').delete({ count: 'exact' }).in('id', ids)
  if (delErr) { console.error('delete error:', delErr.message); break }
  total += count ?? 0
  round++
  console.log(`round ${round}: deleted ${count} (total ${total})`)
}
const { count: remaining } = await sb.from('interactions').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE)
console.log(`remaining interactions: ${remaining}`)
if ((remaining ?? 0) === 0) console.log('✓ interactions wiped')
else { console.error('interactions NOT fully wiped'); process.exit(1) }
