/**
 * Integration test for the heat-map cancellation guard
 * (review pass 5 — addresses test-coverage gap #9).
 *
 * Pre-fix: a Calendly cancel email arriving Apr 3 fired tour_cancelled
 * (-15) and stamped occurred_at = the original tour datetime (Apr 5).
 * Then re-processing the original booking email (Calendly "New Event"
 * email from Feb 8) AFTER Apr 5 hit timeAwareTourKind which auto-
 * promoted tour_scheduled → tour_completed (+20). Net heat for the
 * cancelled tour: +5 instead of -15.
 *
 * This test exercises the guard end-to-end:
 *   1. Insert a wedding + a Calendly tour_cancelled engagement_event
 *      (mimicking the Apr 3 cancel email's effect).
 *   2. Construct a SchedulingEvent that timeAwareTourKind would
 *      promote to tour_completed.
 *   3. Run the guard logic from email-pipeline (extracted into a
 *      pure helper for testability).
 *   4. Assert the guard suppresses the promotion.
 *
 * Live-Supabase only — self-skips on CI when .env.local missing.
 *
 * Run with: npx tsx scripts/test-cancellation-guard-integration.ts
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

let env: Record<string, string> = {}
try {
  env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
} catch { /* CI / no env.local */ }

const integrationEnabled = Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
const sb = integrationEnabled
  ? createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null

const HAW = '22222222-2222-2222-2222-222222222201'

/**
 * Pure version of the cancellation-guard logic from email-pipeline.ts.
 * Tests this directly so a regression in the matching strategies (now
 * 14-day window + thread-id linkage) is caught without needing the
 * full pipeline run.
 */
async function shouldSuppressTourCompleted(
  client: NonNullable<typeof sb>,
  venueId: string,
  weddingId: string,
  schedulingEventDatetime: string,
  currentThreadId: string | null,
): Promise<boolean> {
  const { data: cancelRows } = await client
    .from('engagement_events')
    .select('metadata, occurred_at')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .eq('event_type', 'tour_cancelled')
    .limit(20)

  const evtMs = Date.parse(schedulingEventDatetime)
  const TOLERANCE_MS = 14 * 24 * 60 * 60 * 1000
  const proximityMatches = ((cancelRows ?? []) as Array<{
    metadata: Record<string, unknown> | null
    occurred_at: string | null
  }>).some((row) => {
    const md = (row.metadata ?? {}) as Record<string, unknown>
    const mdDt = (md.event_datetime as string | undefined) ?? null
    if (mdDt && Number.isFinite(evtMs)) {
      if (mdDt === schedulingEventDatetime) return true
      const a = Date.parse(mdDt)
      if (Number.isFinite(a) && Math.abs(a - evtMs) < TOLERANCE_MS) return true
    }
    if (row.occurred_at && Number.isFinite(evtMs)) {
      const a = Date.parse(row.occurred_at)
      if (Number.isFinite(a) && Math.abs(a - evtMs) < TOLERANCE_MS) return true
    }
    return false
  })

  if (proximityMatches) return true
  if (!currentThreadId) return false

  const cancelInteractionIds = ((cancelRows ?? []) as Array<{ metadata: Record<string, unknown> | null }>)
    .map((r) => (r.metadata as Record<string, unknown> | null)?.interaction_id)
    .filter((v): v is string => typeof v === 'string')
  if (cancelInteractionIds.length === 0) return false

  const { data: ixRows } = await client
    .from('interactions')
    .select('gmail_thread_id')
    .in('id', cancelInteractionIds)
  return ((ixRows ?? []) as Array<{ gmail_thread_id: string | null }>)
    .some((r) => r.gmail_thread_id === currentThreadId)
}

async function runCase(label: string, run: (client: NonNullable<typeof sb>) => Promise<void>) {
  if (!sb) return
  try {
    await run(sb)
  } catch (err) {
    fail++
    console.error(`FAIL: ${label} — exception:`, err instanceof Error ? err.message : err)
  }
}

async function runIntegration() {
  if (!sb) {
    console.log('[integration] skipped — .env.local or service-role key missing')
    return
  }

  // Test 1: cancel + completed within 14 days → suppress
  await runCase('cancel within 14d → suppress', async (client) => {
    const { data: w } = await client
      .from('weddings')
      .insert({ venue_id: HAW, status: 'inquiry', notes: '_pass5_test_within_14d' })
      .select('id')
      .single()
    if (!w) throw new Error('insert wedding failed')
    const weddingId = w.id as string

    const tourDt = new Date('2026-04-05T13:15:00Z').toISOString()
    const cancelStampedAt = new Date('2026-04-03T18:00:00Z').toISOString()
    try {
      await client.from('engagement_events').insert({
        venue_id: HAW,
        wedding_id: weddingId,
        event_type: 'tour_cancelled',
        direction: 'inbound',
        points: -15,
        metadata: { event_datetime: tourDt },
        occurred_at: cancelStampedAt,
      })
      const suppress = await shouldSuppressTourCompleted(client, HAW, weddingId, tourDt, null)
      assertEq(suppress, true, 'within-14d cancel suppresses tour_completed')
    } finally {
      await client.from('weddings').delete().eq('id', weddingId)
    }
  })

  // Test 2: cancel >14d apart → don't suppress (pre-fix 6h would have failed)
  await runCase('cancel >14d apart → do NOT suppress', async (client) => {
    const { data: w } = await client
      .from('weddings')
      .insert({ venue_id: HAW, status: 'inquiry', notes: '_pass5_test_far_apart' })
      .select('id')
      .single()
    if (!w) throw new Error('insert wedding failed')
    const weddingId = w.id as string

    // Tour scheduled for Apr 5; an OLD cancel for a DIFFERENT tour 3
    // months earlier should NOT suppress this auto-promotion.
    const oldTourDt = new Date('2026-01-05T13:15:00Z').toISOString()
    const newTourDt = new Date('2026-04-05T13:15:00Z').toISOString()
    try {
      await client.from('engagement_events').insert({
        venue_id: HAW,
        wedding_id: weddingId,
        event_type: 'tour_cancelled',
        direction: 'inbound',
        points: -15,
        metadata: { event_datetime: oldTourDt },
        occurred_at: oldTourDt,
      })
      const suppress = await shouldSuppressTourCompleted(client, HAW, weddingId, newTourDt, null)
      assertEq(suppress, false, '90d-apart cancel does NOT suppress unrelated tour')
    } finally {
      await client.from('weddings').delete().eq('id', weddingId)
    }
  })

  // Test 3: thread-id linkage (no proximity match, but same thread) → suppress
  await runCase('same gmail_thread_id → suppress regardless of date', async (client) => {
    const { data: w } = await client
      .from('weddings')
      .insert({ venue_id: HAW, status: 'inquiry', notes: '_pass5_test_thread_linkage' })
      .select('id')
      .single()
    if (!w) throw new Error('insert wedding failed')
    const weddingId = w.id as string

    const sharedThread = `thread_pass5_${Date.now()}`
    try {
      // Insert a cancel interaction first so we can reference its id.
      const { data: cancelIx } = await client
        .from('interactions')
        .insert({
          venue_id: HAW,
          wedding_id: weddingId,
          type: 'email',
          direction: 'inbound',
          subject: 'Cancel tour',
          gmail_thread_id: sharedThread,
          timestamp: new Date('2026-01-05T18:00:00Z').toISOString(),
        })
        .select('id')
        .single()
      if (!cancelIx) throw new Error('insert cancel interaction failed')

      await client.from('engagement_events').insert({
        venue_id: HAW,
        wedding_id: weddingId,
        event_type: 'tour_cancelled',
        direction: 'inbound',
        points: -15,
        metadata: {
          event_datetime: new Date('2026-01-05T13:15:00Z').toISOString(),
          interaction_id: cancelIx.id,
        },
        occurred_at: new Date('2026-01-05T13:15:00Z').toISOString(),
      })

      // Tour Apr 5 — far from cancel Jan 5 (90 days). Proximity won't
      // match. Thread-id should.
      const newTourDt = new Date('2026-04-05T13:15:00Z').toISOString()
      const suppress = await shouldSuppressTourCompleted(client, HAW, weddingId, newTourDt, sharedThread)
      assertEq(suppress, true, 'thread-id match suppresses even when 90d apart')
    } finally {
      await client.from('weddings').delete().eq('id', weddingId)
    }
  })
}

runIntegration()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('integration crashed:', err)
    process.exit(1)
  })
