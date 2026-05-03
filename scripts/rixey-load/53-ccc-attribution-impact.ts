/**
 * T5-Rixey-CCC follow-up: examine the 56 weddings that received new
 * backtrack attributions and compare their lead_source pre/post-CCC
 * to gauge real attribution impact.
 *
 * Run: npx tsx scripts/rixey-load/53-ccc-attribution-impact.ts
 */

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

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  // Get distinct wedding_ids that received CCC backtrack attribution events.
  const { data: ev } = await sb
    .from('attribution_events')
    .select('wedding_id, source_platform, is_first_touch')
    .eq('venue_id', RIXEY)
    .like('reasoning', 'backtrack%')
    .is('reverted_at', null)

  const wids = new Set<string>()
  const distinct: any[] = []
  for (const r of (ev ?? []) as any[]) {
    if (wids.has(r.wedding_id)) continue
    wids.add(r.wedding_id)
    distinct.push(r)
  }
  console.log(`distinct weddings receiving CCC attribution: ${wids.size}`)

  // Pull those weddings' current lead_source.
  const wedIds = Array.from(wids)
  const { data: weds } = await sb
    .from('weddings')
    .select('id, lead_source, source, crm_source')
    .in('id', wedIds)

  const dist: Record<string, number> = {}
  let nullCount = 0
  let weakCount = 0
  let knotCount = 0
  let otherCount = 0
  for (const w of (weds ?? []) as any[]) {
    const ls = (w.lead_source ?? '(null)') as string
    dist[ls] = (dist[ls] ?? 0) + 1
    if (w.lead_source === null) nullCount++
    else if (['calendly', 'honeybook', 'website', 'web_form', 'venue_calculator', 'generic_csv', 'dubsado'].includes(w.lead_source)) weakCount++
    else if (w.lead_source === 'the_knot') knotCount++
    else otherCount++
  }
  console.log(`\nlead_source distribution among the ${wids.size} CCC-attributed weddings:`)
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`)
  }
  console.log(`\nbreakdown:`)
  console.log(`  already lead_source=the_knot:                    ${knotCount}  (CCC re-confirmed existing attribution)`)
  console.log(`  weak/touchpoint lead_source (would benefit):     ${weakCount}  (CCC found real source — derivation needs to override)`)
  console.log(`  other real channel:                              ${otherCount}`)
  console.log(`  NULL lead_source:                                ${nullCount}  (CCC backfilled — derivation should pick this up)`)

  // Spot-check: how does the source-derivation chain rate the now-resolved
  // candidates? The new attribution_events may rank lower than the existing
  // value via priority order. The chain reads attribution_events at priority 5.
  // If a wedding currently has lead_source=calendly (priority 4 from email
  // domain), the cluster-discovered the_knot (priority 5) won't override.
  console.log(`\nNote: deriveLeadSourceForWedding only fills NULL lead_source.`)
  console.log(`Existing (often weak) attributions stay until coordinator override.`)
  console.log(`CCC's full impact will land on FUTURE inquiries that get backtrack-attributed`)
  console.log(`OR via /intel/clients/[id]/lead-source-override coordinator path.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
