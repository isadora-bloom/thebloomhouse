import { test, expect, request } from '@playwright/test'
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
 * §19 PHASE 7 ACCEPTANCE — Omi integration (Tasks 60-65).
 *
 * Same DB-layer convention as §13-§18 plus HTTP tests against the Next.js
 * webserver for the Omi webhook (since its matching + orphan routing is
 * logic we want to exercise end-to-end).
 *
 * AI-dependent tests (tour-transcript-extract, post-tour-brief,
 * transcript-voice-learning mining) are DEFERRED — they need Claude stubs
 * and cost real money. Their data contracts (tours.transcript_extracted,
 * drafts row shape, review_language.source_type) ARE asserted here via
 * direct inserts.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§19 Phase 7 — Omi integration', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  // -------------------------------------------------------------------------
  // Task 60 — migration 082 schema changes round-trip
  // -------------------------------------------------------------------------

  test('082: venue_config has omi_webhook_token + omi_auto_match_enabled + omi_match_window_hours', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { error } = await admin().from('venue_config').update({
      omi_webhook_token: '11111111-1111-1111-1111-111111111111',
      omi_auto_match_enabled: false,
      omi_match_window_hours: 4,
    }).eq('venue_id', venueId)
    expect(error, `venue_config Omi update rejected: ${error?.message}`).toBeNull()

    const { data } = await admin()
      .from('venue_config')
      .select('omi_webhook_token, omi_auto_match_enabled, omi_match_window_hours')
      .eq('venue_id', venueId)
      .single()
    expect(data!.omi_webhook_token).toBe('11111111-1111-1111-1111-111111111111')
    expect(data!.omi_auto_match_enabled).toBe(false)
    expect(data!.omi_match_window_hours).toBe(4)
  })

  test('082: tours has omi_session_id + transcript_received_at + transcript_extracted + tour_brief_generated_at', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { data: tour, error } = await admin()
      .from('tours')
      .insert({
        venue_id: venueId,
        scheduled_at: new Date().toISOString(),
        tour_type: 'in_person',
        outcome: 'pending',
        omi_session_id: `sess-${ctx.testId}`,
        transcript_received_at: new Date().toISOString(),
        transcript_extracted: {
          attendee_types: ['couple', 'parents'],
          key_questions: [{ question: 'Can we bring our dog?', category: 'policies' }],
          emotional_signals: [{ signal: 'excited_about_space', evidence: 'They lit up in the barn' }],
          specific_interests: ['outdoor ceremony'],
          booked_date_mentions: ['June 2027'],
          summary: 'Engaged, bringing parents, warm on outdoor ceremony.',
        },
        tour_brief_generated_at: new Date().toISOString(),
      })
      .select('id, omi_session_id, transcript_extracted')
      .single()
    expect(error, `tours insert with Phase 7 columns rejected: ${error?.message}`).toBeNull()
    expect(tour!.omi_session_id).toBe(`sess-${ctx.testId}`)
    const extracted = tour!.transcript_extracted as { attendee_types: string[] }
    expect(extracted.attendee_types).toContain('parents')

    await admin().from('tours').delete().eq('id', tour!.id)
  })

  // -------------------------------------------------------------------------
  // Task 61 — Omi webhook: auth + matching
  // -------------------------------------------------------------------------

  test('Task 61: POST /api/omi/webhook rejects bad token with 401', async () => {
    const ctxReq = await request.newContext({ baseURL: 'http://localhost:3000' })
    const resp = await ctxReq.post('/api/omi/webhook?token=not-a-real-token', {
      data: { session_id: 'x', segments: [{ text: 'hello' }] },
    })
    expect(resp.status()).toBe(401)
    await ctxReq.dispose()
  })

  test('Task 61: POST /api/omi/webhook with valid token appends to nearest scheduled tour', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const token = `test-tok-${ctx.testId}-${Math.random().toString(36).slice(2, 8)}`
    await admin().from('venue_config').update({
      omi_webhook_token: token,
      omi_auto_match_enabled: true,
      omi_match_window_hours: 6,
    }).eq('venue_id', venueId)

    // Create a tour scheduled for now.
    const { data: tour } = await admin()
      .from('tours')
      .insert({
        venue_id: venueId,
        scheduled_at: new Date().toISOString(),
        tour_type: 'in_person',
        outcome: 'pending',
      })
      .select('id')
      .single()

    const sessionId = `sess-${ctx.testId}-1`
    const ctxReq = await request.newContext({ baseURL: 'http://localhost:3000' })
    const resp = await ctxReq.post(`/api/omi/webhook?token=${token}`, {
      data: {
        session_id: sessionId,
        segments: [{ text: 'Hello from the barn today.', is_user: false }],
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.matched_tour_id).toBe(tour!.id)

    // Verify the tour got the transcript + session id.
    const { data: updated } = await admin()
      .from('tours')
      .select('transcript, omi_session_id')
      .eq('id', tour!.id)
      .single()
    expect((updated!.transcript ?? '').toLowerCase()).toContain('barn')
    expect(updated!.omi_session_id).toBe(sessionId)

    // Second segment same session: appends to the same tour.
    const resp2 = await ctxReq.post(`/api/omi/webhook?token=${token}`, {
      data: {
        session_id: sessionId,
        segments: [{ text: 'Can we book for June?', is_user: false }],
      },
    })
    expect(resp2.status()).toBe(200)

    const { data: after } = await admin()
      .from('tours')
      .select('transcript')
      .eq('id', tour!.id)
      .single()
    expect((after!.transcript ?? '').toLowerCase()).toContain('june')

    await admin().from('tours').delete().eq('id', tour!.id)
    await ctxReq.dispose()
  })

  test('Task 61: webhook with no matching tour stashes in tour_transcript_orphans', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const token = `test-tok-${ctx.testId}-${Math.random().toString(36).slice(2, 8)}`
    await admin().from('venue_config').update({
      omi_webhook_token: token,
      omi_auto_match_enabled: true,
    }).eq('venue_id', venueId)

    // No tour scheduled — orphan expected.
    const sessionId = `sess-${ctx.testId}-orphan`
    const ctxReq = await request.newContext({ baseURL: 'http://localhost:3000' })
    const resp = await ctxReq.post(`/api/omi/webhook?token=${token}`, {
      data: {
        session_id: sessionId,
        segments: [{ text: 'Coordinator orphan test segment.' }],
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.session).toBe('orphan')

    const { data: orphan } = await admin()
      .from('tour_transcript_orphans')
      .select('id, transcript, status')
      .eq('venue_id', venueId)
      .eq('omi_session_id', sessionId)
      .single()
    expect(orphan!.status).toBe('pending')
    expect((orphan!.transcript ?? '').toLowerCase()).toContain('orphan')

    await admin().from('tour_transcript_orphans').delete().eq('id', orphan!.id)
    await ctxReq.dispose()
  })

  // -------------------------------------------------------------------------
  // Task 62 — transcript_extracted contract
  // -------------------------------------------------------------------------

  test('Task 62: knowledge_gaps can round-trip a question extracted from a transcript', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { error, data } = await admin()
      .from('knowledge_gaps')
      .insert({
        venue_id: venueId,
        question: 'Do you allow outside catering?',
        category: 'food',
        frequency: 1,
        status: 'open',
      })
      .select('id, frequency')
      .single()
    expect(error, `knowledge_gaps insert rejected: ${error?.message}`).toBeNull()
    expect(data!.frequency).toBe(1)

    await admin().from('knowledge_gaps').delete().eq('id', data!.id)
  })

  // -------------------------------------------------------------------------
  // Task 63 — post-tour brief drafts row shape
  // -------------------------------------------------------------------------

  test('Task 63: drafts accepts a sage_post_tour generated row', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId, status: 'inquiry' })

    const { data, error } = await admin()
      .from('drafts')
      .insert({
        venue_id: venueId,
        wedding_id: wedding.weddingId,
        draft_body: 'Thanks for the tour today, loved showing you the barn.',
        brain_used: 'sage_post_tour',
        context_type: 'client',
        status: 'pending',
        to_email: 'partner@example.com',
        confidence_score: 85,
      })
      .select('id, brain_used, status')
      .single()
    expect(error, `sage_post_tour drafts insert rejected: ${error?.message}`).toBeNull()
    expect(data!.brain_used).toBe('sage_post_tour')
    expect(data!.status).toBe('pending')

    await admin().from('drafts').delete().eq('id', data!.id)
  })

  // -------------------------------------------------------------------------
  // Task 64 — review_language source_type column (migration 083)
  // -------------------------------------------------------------------------

  test('083: review_language accepts source_type=transcript + source_reference', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { data, error } = await admin()
      .from('review_language')
      .insert({
        venue_id: venueId,
        phrase: 'made us feel at home the moment we walked in',
        theme: 'experience',
        sentiment_score: 0.95,
        frequency: 1,
        approved_for_sage: false,
        approved_for_marketing: false,
        source_type: 'transcript',
        source_reference: `tour:${ctx.testId}`,
      })
      .select('id, source_type, source_reference')
      .single()
    expect(error, `review_language source_type insert rejected — did migration 083 apply? err=${error?.message}`).toBeNull()
    expect(data!.source_type).toBe('transcript')

    await admin().from('review_language').delete().eq('id', data!.id)
  })

  // -------------------------------------------------------------------------
  // Task 61/65 — orphan attach flow
  // -------------------------------------------------------------------------

  test('Task 61: tour_transcript_orphans.status transitions to attached with attached_to_tour_id', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { data: orphan } = await admin()
      .from('tour_transcript_orphans')
      .insert({
        venue_id: venueId,
        omi_session_id: `sess-${ctx.testId}-manual`,
        transcript: 'Manual attach transcript body.',
        segments_count: 1,
        status: 'pending',
      })
      .select('id')
      .single()

    const { data: tour } = await admin()
      .from('tours')
      .insert({
        venue_id: venueId,
        scheduled_at: new Date().toISOString(),
        tour_type: 'in_person',
        outcome: 'pending',
      })
      .select('id')
      .single()

    // Simulate the PATCH-attach path at the DB level.
    await admin().from('tour_transcript_orphans').update({
      status: 'attached',
      attached_to_tour_id: tour!.id,
      attached_at: new Date().toISOString(),
    }).eq('id', orphan!.id)

    const { data: after } = await admin()
      .from('tour_transcript_orphans')
      .select('status, attached_to_tour_id')
      .eq('id', orphan!.id)
      .single()
    expect(after!.status).toBe('attached')
    expect(after!.attached_to_tour_id).toBe(tour!.id)

    await admin().from('tour_transcript_orphans').delete().eq('id', orphan!.id)
    await admin().from('tours').delete().eq('id', tour!.id)
  })

  // -------------------------------------------------------------------------
  // White label — Oakwood Omi token never attaches transcripts to Rixey tours
  // -------------------------------------------------------------------------

  test('White label: Oakwood webhook token routes only to Oakwood tours', async () => {
    const { orgId } = await createTestOrg(ctx)
    const rixey = await createTestVenue(ctx, { orgId, name: `Rixey Manor [e2e:${ctx.testId}]` })
    const oakwood = await createTestVenue(ctx, {
      orgId,
      name: `Oakwood Estate [e2e:${ctx.testId}]`,
      aiName: 'Ivy',
    })

    const oakwoodToken = `oak-tok-${ctx.testId}-${Math.random().toString(36).slice(2, 8)}`
    await admin().from('venue_config').update({
      omi_webhook_token: oakwoodToken,
      omi_auto_match_enabled: true,
    }).eq('venue_id', oakwood.venueId)

    // Scheduled tours at BOTH venues. Rixey tour should NOT match the Oakwood
    // token — the webhook scopes by venue_config lookup.
    const { data: rixeyTour } = await admin()
      .from('tours')
      .insert({ venue_id: rixey.venueId, scheduled_at: new Date().toISOString(), tour_type: 'in_person', outcome: 'pending' })
      .select('id')
      .single()
    const { data: oakwoodTour } = await admin()
      .from('tours')
      .insert({ venue_id: oakwood.venueId, scheduled_at: new Date().toISOString(), tour_type: 'in_person', outcome: 'pending' })
      .select('id')
      .single()

    const ctxReq = await request.newContext({ baseURL: 'http://localhost:3000' })
    const resp = await ctxReq.post(`/api/omi/webhook?token=${oakwoodToken}`, {
      data: {
        session_id: `sess-${ctx.testId}-wl`,
        segments: [{ text: 'White-label attach test.' }],
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.matched_tour_id).toBe(oakwoodTour!.id)

    // Rixey tour must remain untouched.
    const { data: rixeyAfter } = await admin()
      .from('tours')
      .select('transcript, omi_session_id')
      .eq('id', rixeyTour!.id)
      .single()
    expect(rixeyAfter!.transcript ?? '').not.toContain('White-label')
    expect(rixeyAfter!.omi_session_id).toBeNull()

    // Oakwood AI config carries Ivy (for the white-label brief copy).
    const { data: ai } = await admin()
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', oakwood.venueId)
      .single()
    expect(ai!.ai_name).toBe('Ivy')

    await admin().from('tours').delete().in('id', [rixeyTour!.id, oakwoodTour!.id])
    await ctxReq.dispose()
  })

  // -------------------------------------------------------------------------
  // Deferred — require Claude stub / browser render
  // -------------------------------------------------------------------------

  test.skip('DEFERRED: extractTourTranscript real Claude call populates tours.transcript_extracted', () => {})
  test.skip('DEFERRED: generatePostTourBrief produces Ivy-voiced brief for Oakwood', () => {})
  test.skip('DEFERRED: mineTranscriptVoice below MIN_ELIGIBLE_TOURS returns dataGated=true without AI call', () => {})
  test.skip('DEFERRED: /settings/omi render shows correct venue + aiName in chromium-desktop', () => {})
})
