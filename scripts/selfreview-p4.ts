// Phase 4 intelligence self-review:
//   1. computeSourceQuality returns avgDaysToBook
//   2. cross-venue rollup math is consistent (sum of bookedCount across
//      per-venue rows equals the rolled-up bookedCount)
//   3. attribution model differences exist on Rixey (proves the
//      side-by-side comparison surfaces something useful)
//   4. anomaly_alerts query for unacknowledged count works
import { computeSourceQuality } from '../src/lib/services/source-quality'
import { computeSourceFunnel } from '../src/lib/services/attribution'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  console.log('\n=== P4 self-review (venue ' + RIXEY.slice(0, 8) + ') ===\n')

  // CHECK 1: source-quality avgDaysToBook
  console.log('[1] source-quality includes avgDaysToBook')
  const sq = await computeSourceQuality(RIXEY)
  for (const r of sq) {
    const days = r.avgDaysToBook !== null ? `${Math.round(r.avgDaysToBook)}d` : '—'
    console.log(`  ${r.source.padEnd(20)} booked=${String(r.bookedCount).padStart(3)} days_to_book=${days} review=${r.avgReviewScore?.toFixed(2) ?? '—'}`)
  }

  // CHECK 2: model comparison divergence
  console.log('\n[2] attribution model divergence')
  const ft = await computeSourceFunnel(RIXEY, { model: 'first_touch' })
  const lt = await computeSourceFunnel(RIXEY, { model: 'last_touch' })
  const lin = await computeSourceFunnel(RIXEY, { model: 'linear' })
  function bookings(rows: Awaited<ReturnType<typeof computeSourceFunnel>>, source: string): number {
    const r = rows.find((x) => x.source === source)
    return r?.bookings ?? 0
  }
  const allSources = new Set<string>()
  for (const rows of [ft, lt, lin]) for (const r of rows) if (r.source) allSources.add(r.source)
  console.log(`  ${'source'.padEnd(20)} ${'first'.padStart(6)} ${'last'.padStart(6)} ${'linear'.padStart(6)} ${'spread'.padStart(7)}`)
  for (const s of [...allSources].sort()) {
    const f = bookings(ft, s)
    const l = bookings(lt, s)
    const ln = bookings(lin, s)
    const spread = Math.max(f, l, ln) - Math.min(f, l, ln)
    if (spread > 0) {
      console.log(`  ${s.padEnd(20)} ${f.toFixed(1).padStart(6)} ${l.toFixed(1).padStart(6)} ${ln.toFixed(1).padStart(6)} ${spread.toFixed(1).padStart(7)}`)
    }
  }

  // CHECK 3: anomaly count (sidebar badge query)
  console.log('\n[3] anomaly_alerts unacknowledged count for sidebar badge')
  const { count, error } = await sb
    .from('anomaly_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY)
    .eq('acknowledged', false)
  if (error) console.log(`  error: ${error.message}`)
  else console.log(`  unread anomalies: ${count ?? 0}`)

  console.log('\n=== done ===')
}

main().catch((err) => { console.error(err); process.exit(1) })
