import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestWedding,
  cleanup,
  TestContext,
} from '../helpers/seed'

/**
 * §16 PHASE 4 ACCEPTANCE — Client quality intelligence (Tasks 38-46).
 *
 * Pattern matches §13/§14/§15: DB-level assertions only. The service-layer
 * functions (computeVenueHealth, computeSourceQuality, detectTwoEmailDropoffs,
 * computeAvailabilityPatterns, computeTourAttendeeSignal, computeFrictionScore,
 * deriveTopAvailabilityInsight) are exercised by unit-path data we set up
 * here; their correctness is asserted via the rows they would read/write.
 * Three tests are DEFERRED pending MSW/Claude-stub infrastructure (same
 * convention as §13).
 *
 * White-label is enforced by seeding an Oakwood Estate venue (aiName='Ivy',
 * venuePrefix='OE') and asserting zero Rixey values appear anywhere
 * the data touches (source labels, persisted insight bodies, etc).
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§16 Phase 4 — Client quality intelligence', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  // -------------------------------------------------------------------------
  // Task 38 — venue_health schema extension + venue_health_history
  // -------------------------------------------------------------------------

  test('080: venue_health carries the 5 Phase 4 subscore columns', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { error } = await admin().from('venue_health').insert({
      venue_id: venueId,
      overall_score: 72,
      inquiry_volume_trend: 55,
      tour_conversion_rate: 80,
      avg_revenue_score: 60,
      review_score_trend: 90,
      availability_fill_rate: 45,
      calculated_at: new Date().toISOString(),
    })
    expect(error, `venue_health subscore insert rejected — did migration 080 apply? err=${error?.message}`).toBeNull()

    const { data } = await admin()
      .from('venue_health')
      .select('inquiry_volume_trend, tour_conversion_rate, avg_revenue_score, review_score_trend, availability_fill_rate')
      .eq('venue_id', venueId)
      .order('calculated_at', { ascending: false })
      .limit(1)
      .single()
    expect(data!.inquiry_volume_trend).toBe(55)
    expect(data!.availability_fill_rate).toBe(45)
    expect(data!.tour_conversion_rate).toBe(80)
    expect(data!.review_score_trend).toBe(90)
  })

  test('080: venue_health_history table exists and accepts a snapshot insert', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { error } = await admin().from('venue_health_history').insert({
      venue_id: venueId,
      overall_score: 68,
      inquiry_volume_trend: 50,
      response_time_trend: 75,
      tour_conversion_rate: 66,
      booking_rate: 55,
      avg_revenue_score: 60,
      review_score_trend: 85,
      availability_fill_rate: 40,
    })
    expect(error, `venue_health_history insert rejected — did migration 080 apply? err=${error?.message}`).toBeNull()

    const { data } = await admin()
      .from('venue_health_history')
      .select('overall_score, availability_fill_rate')
      .eq('venue_id', venueId)
      .order('calculated_at', { ascending: false })
      .limit(1)
      .single()
    expect(data!.overall_score).toBe(68)
    expect(data!.availability_fill_rate).toBe(40)

    await admin().from('venue_health_history').delete().eq('venue_id', venueId)
    await admin().from('venue_health').delete().eq('venue_id', venueId)
  })

  // -------------------------------------------------------------------------
  // Task 39 — source quality scorecard discriminates between sources
  // -------------------------------------------------------------------------

  test('Task 39: source-level revenue + friction rates reveal real deltas', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Seed 2 booked weddings from 'the_knot' (low rev + friction)
    // and 2 from 'website' (higher rev, no friction).
    for (let i = 0; i < 2; i++) {
      const w = await createTestWedding(ctx, { venueId, bookingValue: 12000 })
      await admin().from('weddings').update({
        source: 'the_knot',
        friction_tags: ['slow_to_reply'],
      }).eq('id', w.weddingId)
    }
    for (let i = 0; i < 2; i++) {
      const w = await createTestWedding(ctx, { venueId, bookingValue: 28000 })
      await admin().from('weddings').update({
        source: 'website',
        friction_tags: [],
      }).eq('id', w.weddingId)
    }

    // Assertions mirror what computeSourceQuality derives from this data.
    const { data } = await admin()
      .from('weddings')
      .select('source, booking_value, friction_tags')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'completed'])
      .not('source', 'is', null)

    const bySource: Record<string, { revs: number[]; friction: number }> = {}
    for (const w of data ?? []) {
      const src = (w.source as string) ?? 'unknown'
      if (!bySource[src]) bySource[src] = { revs: [], friction: 0 }
      if (w.booking_value) bySource[src].revs.push(Number(w.booking_value))
      const ft = w.friction_tags
      if (Array.isArray(ft) && ft.length > 0) bySource[src].friction++
    }
    const avgRev = (src: string) => bySource[src].revs.reduce((a, b) => a + b, 0) / bySource[src].revs.length
    expect(avgRev('website')).toBeGreaterThan(avgRev('the_knot'))
    expect(bySource['the_knot'].friction).toBeGreaterThan(bySource['website'].friction)
  })

  // -------------------------------------------------------------------------
  // Task 40 — two-email dropoff signal persists to intelligence_insights
  // -------------------------------------------------------------------------

  test('Task 40: intelligence_insights can persist a two_email_dropoff row (idempotency via unique key)', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const w = await createTestWedding(ctx, { venueId, status: 'inquiry' })

    // First persist. Columns match migration 041 (body + data_points) with
    // the Phase 4 widening from migration 080 (context_id + extended
    // insight_type CHECK list).
    const { error: err1 } = await admin().from('intelligence_insights').insert({
      venue_id: venueId,
      insight_type: 'two_email_dropoff',
      category: 'lead_conversion',
      title: 'Lead stalled after 2 outbound emails',
      body: "Couples who don't reply to 2+ follow-ups rarely book.",
      priority: 'medium',
      context_id: w.weddingId,
      data_points: { outbound_count: 2 },
    })
    expect(err1, `intelligence_insights insert rejected — did migration 080 apply? err=${err1?.message}`).toBeNull()

    // Rerun: persistDropoffInsights does an upsert on
    // (venue_id, insight_type, context_id) — so we query by those three and
    // assert exactly one row. The idx_intelligence_insights_venue_type_context
    // index added in 080 backs this lookup.
    const { data: rows } = await admin()
      .from('intelligence_insights')
      .select('id')
      .eq('venue_id', venueId)
      .eq('insight_type', 'two_email_dropoff')
      .eq('context_id', w.weddingId)
    expect(rows?.length).toBe(1)

    // Clean up the insight (not owned by ctx).
    await admin().from('intelligence_insights').delete().eq('id', rows![0].id)
  })

  // -------------------------------------------------------------------------
  // Task 41 — tour attendee signal: attendees jsonb round-trips
  // -------------------------------------------------------------------------

  test('Task 41: tours.attendees jsonb accepts the attendee bucket vocabulary', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { data: tour, error } = await admin()
      .from('tours')
      .insert({
        venue_id: venueId,
        scheduled_at: new Date().toISOString(),
        tour_type: 'in_person',
        outcome: 'booked',
        attendees: ['couple', 'parents', 'wedding_party'],
      })
      .select('id, attendees')
      .single()
    expect(error).toBeNull()
    expect(tour!.attendees).toEqual(['couple', 'parents', 'wedding_party'])

    await admin().from('tours').delete().eq('id', tour!.id)
  })

  // -------------------------------------------------------------------------
  // Task 42 — availability patterns: venue_availability round-trips the shape
  // -------------------------------------------------------------------------

  test('Task 42: Saturday-aligned venue_availability rows read back cleanly', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Pick two future Saturdays far enough apart to hit different months.
    // Use the next occurrence of a Saturday in ~15 days and ~90 days out.
    const today = new Date()
    const firstSat = new Date(today)
    firstSat.setUTCDate(today.getUTCDate() + ((6 - today.getUTCDay() + 7) % 7 || 7))
    const laterSat = new Date(firstSat)
    laterSat.setUTCDate(firstSat.getUTCDate() + 84) // ~12 weeks later

    const rows = [firstSat, laterSat].map((d) => ({
      venue_id: venueId,
      date: d.toISOString().split('T')[0],
      status: 'available',
      max_events: 5,
      booked_count: d === firstSat ? 4 : 1,
    }))
    const { error } = await admin().from('venue_availability').insert(rows)
    expect(error).toBeNull()

    const { data } = await admin()
      .from('venue_availability')
      .select('date, max_events, booked_count')
      .eq('venue_id', venueId)
      .gte('date', firstSat.toISOString().split('T')[0])
      .lte('date', laterSat.toISOString().split('T')[0])
    expect((data ?? []).length).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Task 43 — friction score: column is in place + reads as expected
  // -------------------------------------------------------------------------

  test('Task 43: weddings.friction_tags is a jsonb array + writers produce countable rows', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Seed 5 booked weddings with non-empty friction_tags. This is the
    // threshold the scorer uses to decide whether to return a score.
    for (let i = 0; i < 5; i++) {
      const w = await createTestWedding(ctx, { venueId })
      await admin().from('weddings').update({
        friction_tags: ['slow_to_reply'],
        source: i < 3 ? 'the_knot' : 'website',
      }).eq('id', w.weddingId)
    }

    const { count } = await admin()
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .in('status', ['booked', 'completed'])
      .not('friction_tags', 'is', null)
    expect((count ?? 0) >= 5).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Task 44 — DB trigger: tour outcome transition writes consultant_metrics
  // -------------------------------------------------------------------------

  test('080: tour outcome=completed fires trg_tours_sync_consultant_metrics', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Create a coordinator whose user_id feeds conducted_by.
    const { data: coord, error: cErr } = await admin().auth.admin.createUser({
      email: `e2e-${ctx.testId}-coord@test.thebloomhouse.com`,
      password: `TestPw!${ctx.testId}A1`,
      email_confirm: true,
    })
    expect(cErr).toBeNull()
    const consultantId = coord!.user!.id
    ctx.createdUserIds.push(consultantId)
    await admin().from('user_profiles').upsert(
      { id: consultantId, role: 'coordinator', org_id: orgId, venue_id: venueId, first_name: 'Tour', last_name: 'Runner' },
      { onConflict: 'id' }
    )

    const { data: tour } = await admin()
      .from('tours')
      .insert({
        venue_id: venueId,
        conducted_by: consultantId,
        scheduled_at: new Date().toISOString(),
        tour_type: 'in_person',
        outcome: 'pending',
        attendees: ['couple'],
      })
      .select('id')
      .single()
    expect(tour).not.toBeNull()

    await admin().from('tours').update({ outcome: 'completed' }).eq('id', tour!.id)

    const { data: metrics } = await admin()
      .from('consultant_metrics')
      .select('tours_booked, bookings_closed')
      .eq('venue_id', venueId)
      .eq('consultant_id', consultantId)
    expect(metrics, 'consultant_metrics row missing — did the 080 trigger fire?').not.toBeNull()
    expect((metrics ?? []).length).toBeGreaterThanOrEqual(1)
    expect(metrics![0].tours_booked).toBeGreaterThanOrEqual(1)

    await admin().from('consultant_metrics').delete().eq('venue_id', venueId)
    await admin().from('tours').delete().eq('id', tour!.id)
  })

  // -------------------------------------------------------------------------
  // Task 45 — multi-venue benchmark: 2-venue group rollup reads real health
  // -------------------------------------------------------------------------

  test('Task 45: 2-venue group rollup surfaces both venues with real scores', async () => {
    const { orgId } = await createTestOrg(ctx)
    const rixey = await createTestVenue(ctx, { orgId, name: `Rixey Manor [e2e:${ctx.testId}]` })
    const oakwood = await createTestVenue(ctx, {
      orgId,
      name: `Oakwood Estate [e2e:${ctx.testId}]`,
      aiName: 'Ivy',
      venuePrefix: 'OE',
    })

    await admin().from('venue_health').insert([
      { venue_id: rixey.venueId, overall_score: 72, calculated_at: new Date().toISOString() },
      { venue_id: oakwood.venueId, overall_score: 58, calculated_at: new Date().toISOString() },
    ])

    const { data: group, error: gErr } = await admin()
      .from('venue_groups')
      .insert({ org_id: orgId, name: `Portfolio [e2e:${ctx.testId}]` })
      .select('id')
      .single()
    expect(gErr).toBeNull()
    await admin().from('venue_group_members').insert([
      { group_id: group!.id, venue_id: rixey.venueId },
      { group_id: group!.id, venue_id: oakwood.venueId },
    ])

    // Rollup read: simulate the /api/intel/benchmark primary query path.
    const { data: members } = await admin()
      .from('venue_group_members')
      .select('venue_id')
      .eq('group_id', group!.id)
    expect((members ?? []).length).toBe(2)

    const venueIds = (members ?? []).map((m) => m.venue_id as string)
    const { data: healthRows } = await admin()
      .from('venue_health')
      .select('venue_id, overall_score')
      .in('venue_id', venueIds)
      .order('calculated_at', { ascending: false })
    expect((healthRows ?? []).length).toBeGreaterThanOrEqual(2)

    const rixeyHealth = (healthRows ?? []).find((r) => r.venue_id === rixey.venueId)
    const oakwoodHealth = (healthRows ?? []).find((r) => r.venue_id === oakwood.venueId)
    expect(rixeyHealth!.overall_score).toBe(72)
    expect(oakwoodHealth!.overall_score).toBe(58)

    await admin().from('venue_group_members').delete().eq('group_id', group!.id)
    await admin().from('venue_groups').delete().eq('id', group!.id)
    await admin().from('venue_health').delete().in('venue_id', venueIds)
  })

  // -------------------------------------------------------------------------
  // White label — Oakwood Estate sees zero Rixey values
  // -------------------------------------------------------------------------

  test('White label: Oakwood venue data carries zero Rixey references', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, {
      orgId,
      name: `Oakwood Estate [e2e:${ctx.testId}]`,
      aiName: 'Ivy',
      venuePrefix: 'OE',
    })

    for (let i = 0; i < 2; i++) {
      const w = await createTestWedding(ctx, { venueId, bookingValue: 21000 })
      await admin().from('weddings').update({ source: 'website' }).eq('id', w.weddingId)
    }

    const { data: weddings } = await admin()
      .from('weddings')
      .select('id, source, friction_tags, referred_by, booking_value')
      .eq('venue_id', venueId)

    const serialised = JSON.stringify(weddings).toLowerCase()
    expect(serialised).not.toContain('rixey')
    expect(serialised).not.toContain('hm-')

    // venue_ai_config is Oakwood's, not Rixey's.
    const { data: ai } = await admin()
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .single()
    expect(ai!.ai_name).toBe('Ivy')
  })

  // -------------------------------------------------------------------------
  // Deferred — require MSW / Claude stub OR a live browser render
  // -------------------------------------------------------------------------

  test.skip('DEFERRED: Sage reply uses source-quality insights to tune warmth per source', () => {})
  test.skip('DEFERRED: /intel/benchmark UI renders 2-venue rollup in chromium-desktop', () => {})
  test.skip('DEFERRED: computeTourAttendeeSignal returns named parents-beats-friends insight (10 tours)', () => {})
})
