/**
 * T5-Rixey-KKK B6+B7 diagnosis: phantom Knot bookings.
 *
 * Source Comparison and Source Quality both show "The Knot" with 1
 * booking, but DB-truth says zero booked weddings have
 * `weddings.source = 'the_knot'`. Find which wedding(s) get credited
 * to Knot through which path so we can decide:
 *
 *   (A) the wedding genuinely came from Knot — its signals support
 *       it — and `weddings.source` is wrong (data bug, backfill).
 *   (B) Knot signals were touchpoint/CRM and the attribution rule is
 *       wrong (code bug, fix the filter).
 *
 * Walks three paths the page reads from:
 *
 *   1. wedding_touchpoints with source ILIKE '%knot%' on a booked
 *      wedding (this is what computeSourceFunnel sees for last_touch
 *      + linear).
 *   2. attribution_events with source_platform ILIKE '%knot%' joined
 *      to booked weddings (this is what source-quality.ts sees for
 *      the firstTouchByWedding map).
 *   3. weddings.source = 'the_knot' AND status IN ('booked','completed')
 *      — DB truth control.
 *
 * Prints offending wedding IDs + the underlying signal that triggered
 * each row's attribution + recommends the diagnosis.
 *
 * Run:
 *   npx tsx scripts/rixey-load/audit-knot-phantom.ts
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  // ---- 0) DB truth: which booked weddings (if any) have source='the_knot'? ----
  console.log('\n--- 0) DB truth — weddings.source = the_knot AND booked ---')
  const { data: directKnot } = await sb
    .from('weddings')
    .select('id, status, source, booking_value, inquiry_date, booked_at')
    .eq('venue_id', RIXEY_VENUE_ID)
    .in('status', ['booked', 'completed'])
    .eq('source', 'the_knot')
  console.log(`  weddings with source='the_knot' AND booked: ${directKnot?.length ?? 0}`)
  for (const w of directKnot ?? []) {
    console.log(`    ${w.id} | status=${w.status} | bv=${w.booking_value} | inq=${w.inquiry_date} | booked=${w.booked_at}`)
  }

  // ---- 1) wedding_touchpoints path (drives Source Comparison via funnel) ----
  console.log('\n--- 1) wedding_touchpoints with source ~ knot on booked weddings ---')
  // Pull all booked wedding ids first.
  const { data: bookedWeddings } = await sb
    .from('weddings')
    .select('id, source, status')
    .eq('venue_id', RIXEY_VENUE_ID)
    .in('status', ['booked', 'completed'])
  const bookedIds = new Set<string>((bookedWeddings ?? []).map((w) => w.id as string))
  const sourceById = new Map<string, string | null>()
  for (const w of bookedWeddings ?? []) sourceById.set(w.id as string, (w.source as string | null) ?? null)
  console.log(`  total booked weddings (any source): ${bookedIds.size}`)

  const { data: knotTps } = await sb
    .from('wedding_touchpoints')
    .select('wedding_id, source, touch_type, occurred_at, signal_class, metadata')
    .eq('venue_id', RIXEY_VENUE_ID)
    .ilike('source', '%knot%')
  const knotTpsOnBooked = (knotTps ?? []).filter((r) => bookedIds.has(r.wedding_id as string))
  console.log(`  knot touchpoints (any wedding): ${knotTps?.length ?? 0}`)
  console.log(`  knot touchpoints on BOOKED weddings: ${knotTpsOnBooked.length}`)
  // Print touch_type + signal_class breakdown (after mig 200 these
  // should all be classified).
  const tpBreakdown = new Map<string, number>()
  for (const r of knotTpsOnBooked) {
    const k = `${r.touch_type}/${r.signal_class}`
    tpBreakdown.set(k, (tpBreakdown.get(k) ?? 0) + 1)
  }
  for (const [k, n] of tpBreakdown) console.log(`    ${k}: ${n}`)

  // What does the funnel logic see? After mig 200 the page filters to
  // signal_class='source' on last_touch + linear. Anything that survived
  // is a real Knot source attribution.
  const survivingForLastTouchLinear = knotTpsOnBooked.filter((r) => r.signal_class === 'source')
  console.log(`  ...after KKK signal_class='source' filter: ${survivingForLastTouchLinear.length}`)
  for (const r of survivingForLastTouchLinear.slice(0, 10)) {
    console.log(`    wedding=${r.wedding_id} type=${r.touch_type} src=${r.source} cls=${r.signal_class} t=${r.occurred_at}`)
  }

  // What is the wedding's CURRENT source for these survivors? If the
  // touchpoint says knot and the wedding's source IS the_knot, the
  // attribution is consistent. If the touchpoint says knot but the
  // wedding's source is NOT the_knot, this is the leak — the page
  // shows knot bookings via the touchpoints path while DB-truth via
  // weddings.source disagrees.
  console.log('\n  consistency check (survivor wedding.source):')
  for (const r of survivingForLastTouchLinear) {
    const ws = sourceById.get(r.wedding_id as string) ?? '(null)'
    const flag = ws === 'the_knot' ? 'OK' : 'LEAK'
    console.log(`    ${flag} wedding=${r.wedding_id} | wedding.source=${ws} | tp.source=${r.source}`)
  }

  // ---- 2) attribution_events path (drives Source Quality via firstTouchByWedding) ----
  console.log('\n--- 2) attribution_events with source_platform ~ knot, is_first_touch=true, on booked weddings ---')
  const { data: knotAttribs } = await sb
    .from('attribution_events')
    .select('wedding_id, source_platform, is_first_touch, signal_class, decided_at, tier, bucket, reverted_at')
    .eq('venue_id', RIXEY_VENUE_ID)
    .ilike('source_platform', '%knot%')
    .eq('is_first_touch', true)
    .is('reverted_at', null)
  const knotAttribsOnBooked = (knotAttribs ?? []).filter((r) => bookedIds.has(r.wedding_id as string))
  console.log(`  first-touch knot attribution_events (any wedding): ${knotAttribs?.length ?? 0}`)
  console.log(`  ...on BOOKED weddings: ${knotAttribsOnBooked.length}`)
  for (const r of knotAttribsOnBooked) {
    const ws = sourceById.get(r.wedding_id as string) ?? '(null)'
    const flag = ws === 'the_knot' ? 'OK' : 'LEAK'
    console.log(`    ${flag} wedding=${r.wedding_id} | wedding.source=${ws} | ae.platform=${r.source_platform} | tier=${r.tier} bucket=${r.bucket} cls=${r.signal_class} t=${r.decided_at}`)
  }

  // ---- 3) Diagnose ----
  console.log('\n--- 3) Diagnosis ---')
  if ((directKnot?.length ?? 0) === 0 && knotAttribsOnBooked.length === 0 && survivingForLastTouchLinear.length === 0) {
    console.log('  CLEAN: zero phantom rows surviving the KKK signal_class filter.')
    console.log('         Pre-mig the page likely showed counts from non-source touchpoints')
    console.log('         (email_reply / tour_booked / proposal_sent rows where source was')
    console.log('         carried through from the inquiry leg).')
  } else if (knotAttribsOnBooked.some((r) => bookedIds.has(r.wedding_id as string))) {
    console.log('  attribution_events leak detected — first-touch knot rows exist on weddings')
    console.log('  whose wedding.source is NOT the_knot. Source Quality reads firstTouchByWedding')
    console.log('  from these rows, so it credits knot. Fix: either a) require the wedding cohort')
    console.log('  to have a knot-class signal in the cluster (which would have already won')
    console.log('  first-touch via cluster compute), or b) backfill wedding.source from the')
    console.log('  attribution_events first-touch row when wedding.source is null/unknown.')
  } else {
    console.log('  Mixed — see survivor list above.')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
