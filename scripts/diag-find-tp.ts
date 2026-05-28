import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = l.indexOf('=')
  if (i > 0 && !l.startsWith('#')) process.env[l.slice(0, i)] = l.slice(i + 1).replace(/^['"]|['"]$/g, '')
}
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  const tpId = 'fc849523-1264-40ad-a711-52a6991cc93d'
  for (const t of ['touchpoints', 'wedding_touchpoints', 'interactions', 'engagement_events', 'fragments']) {
    const { data, error } = await s.from(t).select('id').eq('id', tpId).maybeSingle()
    console.log(t.padEnd(24), data ? 'FOUND' : error ? `ERR: ${error.message}` : 'not found')
  }

  // How many touchpoints does Rixey have at all?
  const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  const { count: tpCount } = await s
    .from('touchpoints')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
  console.log(`\nRixey touchpoints total: ${tpCount}`)
  const { count: wtCount } = await s
    .from('wedding_touchpoints')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
  console.log(`Rixey wedding_touchpoints total: ${wtCount}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
