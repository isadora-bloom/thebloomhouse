// Report parity-log distribution after the initial scan.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const { data } = await sb.from('attribution_parity_log')
  .select('chain_source, cluster_source, agree')
  .eq('venue_id', RIXEY)
  .order('computed_at', { ascending: false })
  .limit(2000)

console.log('total: ' + data.length)
const chainDist = {}
const clusterDist = {}
const pairs = {}
for (const r of data) {
  const c = r.chain_source ?? '(null)'
  const cl = r.cluster_source ?? '(null)'
  chainDist[c] = (chainDist[c] || 0) + 1
  clusterDist[cl] = (clusterDist[cl] || 0) + 1
  if (!r.agree && r.chain_source !== null) {
    const k = `${c} → ${cl}`
    pairs[k] = (pairs[k] || 0) + 1
  }
}
console.log('\n--- chain distribution ---')
Object.entries(chainDist).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${v}`))
console.log('\n--- cluster distribution ---')
Object.entries(clusterDist).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${v}`))
console.log('\n--- top divergent pairs (chain → cluster) ---')
Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`  ${k.padEnd(40)} ${v}`))
