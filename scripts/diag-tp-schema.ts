import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = l.indexOf('=')
  if (i > 0 && !l.startsWith('#')) process.env[l.slice(0, i)] = l.slice(i + 1).replace(/^['"]|['"]$/g, '')
}
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  const { data } = await s.from('touchpoints').select('*').eq('id', 'fc849523-1264-40ad-a711-52a6991cc93d').maybeSingle()
  if (!data) { console.log('not found'); return }
  console.log('Columns:', Object.keys(data).join(', '))
  console.log('\nFull row:')
  console.log(JSON.stringify(data, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
