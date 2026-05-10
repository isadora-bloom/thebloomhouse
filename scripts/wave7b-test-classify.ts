/**
 * Wave 7B verification test:
 *   1. Classify a single Rixey Knot attribution_event (forensic only,
 *      noLLM=true) — verify role decision.
 *   2. Bulk-reclassify a small batch (limit=20, noLLM) and report
 *      role distribution.
 *   3. Run getRoleSummary and report the validation share for Knot.
 *
 * Usage:
 *   npx tsx scripts/wave7b-test-classify.ts
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

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

async function main() {
  const env = loadEnv()
  for (const k of Object.keys(env)) process.env[k] = env[k]

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // 1. Pick one knot attribution_event in attribution-bucket (pre-inquiry signal)
  const { data: target } = await sb
    .from('attribution_events')
    .select('id, source_platform, decided_at, wedding_id, bucket, signal_class, role')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('source_platform', 'the_knot')
    .eq('bucket', 'attribution')
    .is('reverted_at', null)
    .limit(1)
  console.log('[step 1] target attribution_event:', target?.[0])

  if (!target?.[0]) {
    console.log('No knot attribution-bucket event found.')
    return
  }
  const eventId = (target[0] as { id: string }).id

  // Dynamic import of the classifier services so the env is set first
  const { classifyAndPersistAttributionEvent } = await import(
    '../src/lib/services/attribution-roles/classify'
  )
  const { reclassifyVenueAttribution } = await import(
    '../src/lib/services/attribution-roles/reclassify-venue'
  )
  const { getRoleSummary } = await import(
    '../src/lib/services/attribution-roles/role-summary'
  )

  console.log('\n[step 1a] running classify on single event with noLLM=true')
  const r1 = await classifyAndPersistAttributionEvent(
    { attributionEventId: eventId },
    { supabase: sb as never, noLLM: true },
  )
  console.log('  result.role:', r1.role)
  console.log('  result.confidence:', r1.role_confidence_0_100)
  console.log('  result.reasoning:', r1.reasoning)
  console.log('  evidence.forensic_path:', r1.evidence.forensic_path)
  console.log('  same-platform signals:', r1.evidence.same_platform_signals.length)
  console.log('  other-platform signals:', r1.evidence.other_platform_signals.length)

  // 2. Bulk reclassify a small batch
  console.log('\n[step 2] bulk reclassify limit=20 force=true noLLM=true')
  const r2 = await reclassifyVenueAttribution({
    venueId: RIXEY_VENUE_ID,
    limit: 20,
    offset: 0,
    force: true,
    noLLM: true,
    supabase: sb as never,
  })
  console.log('  processed:', r2.processed)
  console.log('  classified:', r2.classified)
  console.log('  failed:', r2.failed)
  console.log('  byRole:', r2.byRole)
  console.log('  totalCostCents:', r2.totalCostCents)
  console.log('  duration_ms:', r2.duration_ms)
  if (r2.failures.length) console.log('  failures sample:', r2.failures.slice(0, 3))

  // 3. Larger reclassify so role-summary is meaningful
  console.log('\n[step 3] full venue reclassify limit=200 force=true noLLM=true')
  const r3 = await reclassifyVenueAttribution({
    venueId: RIXEY_VENUE_ID,
    limit: 200,
    offset: 0,
    force: true,
    noLLM: true,
    supabase: sb as never,
  })
  console.log('  processed:', r3.processed)
  console.log('  classified:', r3.classified)
  console.log('  failed:', r3.failed)
  console.log('  byRole:', r3.byRole)
  console.log('  hasMore:', r3.hasMore, 'nextOffset:', r3.nextOffset)
  if (r3.failures.length) console.log('  failures sample:', r3.failures.slice(0, 5))

  // Drain remaining unknown events in pages of 200, offset=0 each time
  // (because the page ordering is ASC nullsFirst on role_classified_at,
  // newly-classified rows fall to the bottom and unclassified stay at
  // the top — so re-running with offset=0 advances the staleness
  // frontier).
  let pages = 0
  while (pages < 5) {
    const { count: stillUnknown } = await sb
      .from('attribution_events')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', RIXEY_VENUE_ID)
      .eq('role', 'unknown')
      .is('reverted_at', null)
    if (!stillUnknown || stillUnknown === 0) break
    pages += 1
    console.log(`\n[drain ${pages}] still ${stillUnknown} unknown — running another page (offset=0)`)
    const rd = await reclassifyVenueAttribution({
      venueId: RIXEY_VENUE_ID,
      limit: 200,
      offset: 0,
      force: false, // skip already-fresh
      noLLM: true,
      supabase: sb as never,
    })
    console.log(`  classified=${rd.classified} skipped_fresh=${rd.skipped_fresh} byRole=`, rd.byRole)
    if (rd.classified === 0 && rd.skipped_fresh > 0) break
  }

  console.log('\n[step 4] getRoleSummary')
  const summary = await getRoleSummary(RIXEY_VENUE_ID, { supabase: sb as never })
  console.log('  totalEvents:', summary.totalEvents)
  console.log('  byRole:', summary.byRole)
  console.log('  unclassified:', summary.unclassifiedCount)
  console.log('  byChannel:')
  for (const cell of summary.byChannel) {
    const valShare =
      cell.validation_share_0_1 === null
        ? 'n/a'
        : `${Math.round(cell.validation_share_0_1 * 100)}%`
    console.log(
      `    ${cell.channel}: total=${cell.total} acq=${cell.acquisition} val=${cell.validation} conv=${cell.conversion} mixed=${cell.mixed} unk=${cell.unknown} | %validation=${valShare}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
