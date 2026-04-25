// Phase 1 self-review — verify wedding_touchpoints data is clean.
//
// Checks:
//   1. No wedding has more than one 'inquiry' or 'contract_signed' row.
//   2. Every booked/completed wedding has at least one 'contract_signed'.
//   3. Touchpoint count by type and source.
//   4. Per-source funnel (touchpoints rolled up by source × type).
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
const venueIdx = process.argv.indexOf('--venue')
const VENUE = venueIdx >= 0 ? process.argv[venueIdx + 1] : RIXEY

async function main() {
  console.log(`\n=== Self-review for venue ${VENUE.slice(0, 8)} ===`)

  // Check 1: dupes for ONE_PER_WEDDING types
  for (const tt of ['inquiry', 'contract_signed']) {
    const { data: rows } = await sb
      .from('wedding_touchpoints')
      .select('wedding_id')
      .eq('venue_id', VENUE)
      .eq('touch_type', tt)
    const count = new Map<string, number>()
    for (const r of (rows ?? []) as Array<{ wedding_id: string }>) {
      count.set(r.wedding_id, (count.get(r.wedding_id) ?? 0) + 1)
    }
    const dupes = [...count.values()].filter((n) => n > 1)
    console.log(`  [check1] ${tt}: ${rows?.length ?? 0} rows, ${count.size} weddings, ${dupes.length} with dupes`)
  }

  // Check 2: booked weddings missing contract_signed
  const { data: booked } = await sb
    .from('weddings')
    .select('id')
    .eq('venue_id', VENUE)
    .in('status', ['booked', 'completed'])
  const bookedIds = new Set<string>(((booked ?? []) as Array<{ id: string }>).map((w) => w.id))

  const { data: cs } = await sb
    .from('wedding_touchpoints')
    .select('wedding_id')
    .eq('venue_id', VENUE)
    .eq('touch_type', 'contract_signed')
  const haveCs = new Set<string>(((cs ?? []) as Array<{ wedding_id: string }>).map((r) => r.wedding_id))
  const missing = [...bookedIds].filter((id) => !haveCs.has(id))
  console.log(`  [check2] booked/completed weddings: ${bookedIds.size}, missing contract_signed: ${missing.length}`)

  // Check 3: distribution
  const { data: all } = await sb
    .from('wedding_touchpoints')
    .select('touch_type, source')
    .eq('venue_id', VENUE)
  const byType: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  for (const r of (all ?? []) as Array<{ touch_type: string; source: string | null }>) {
    byType[r.touch_type] = (byType[r.touch_type] ?? 0) + 1
    bySource[r.source ?? '(null)'] = (bySource[r.source ?? '(null)'] ?? 0) + 1
  }
  console.log(`  [check3] total touchpoints: ${all?.length ?? 0}`)
  console.log(`  [check3] by type:   ${JSON.stringify(byType)}`)
  console.log(`  [check3] by source: ${JSON.stringify(bySource)}`)

  // Check 4: per-source funnel
  const funnel: Record<string, Record<string, number>> = {}
  for (const r of (all ?? []) as Array<{ touch_type: string; source: string | null }>) {
    const s = r.source ?? '(null)'
    funnel[s] = funnel[s] ?? {}
    funnel[s][r.touch_type] = (funnel[s][r.touch_type] ?? 0) + 1
  }
  console.log(`  [check4] per-source funnel:`)
  for (const [src, cells] of Object.entries(funnel).sort()) {
    console.log(`    ${src.padEnd(20)} ${JSON.stringify(cells)}`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
