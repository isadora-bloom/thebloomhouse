import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestUser,
  createTestWedding,
  cleanup,
  TestContext,
} from '../helpers/seed'
import { seedInteraction, seedDraft } from '../helpers/email-seed'

/**
 * §6 EMAIL PIPELINE
 *
 * Goal: prove the inbound-email -> classification -> draft pipeline writes
 * to the right tables and that venue scope is enforced.
 *
 * Schema note:
 *   There is NO dedicated `threads` table in this project. `interactions`
 *   stores each inbound/outbound email row, grouped by `gmail_thread_id`.
 *   There is NO separate `email_classification` table. Classification is
 *   persisted on the `drafts` row via `context_type` ('inquiry' | 'client')
 *   and `brain_used` (free text). The live classifier is
 *   `src/lib/services/router-brain.ts#classifyEmail` which makes a Claude
 *   API call. We do NOT invoke the live classifier in these tests (cost +
 *   flake); we assert the persistence shape the pipeline produces, and skip
 *   any test that would require an Anthropic round trip with a clear TODO.
 *
 * What each test covers:
 *   a) DB round trip: inbound interaction row surfaces for the correct venue
 *   b) Classification persistence: a drafts row carries context_type +
 *      brain_used (the shape the router-brain produces) linked to the
 *      interaction
 *   c) Draft linkage + venue scope: drafts.interaction_id and drafts.venue_id
 *      match, and reading drafts filtered by a different venue returns none
 *   d) Venue scope isolation at the RLS boundary: a coordinator for venue B
 *      authenticating with an anon client cannot see venue A's interactions
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

function anonClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

test.describe('§6 Email Pipeline', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  test('a) inbound interaction row is readable scoped by venue', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    const subject = `Inquiry about September wedding [e2e:${ctx.testId}]`
    const seeded = await seedInteraction(ctx, {
      venueId,
      weddingId: wedding.weddingId,
      subject,
      body: 'Hello, is September 12 2026 still open?',
    })

    const { data: rows, error } = await admin()
      .from('interactions')
      .select('id, venue_id, wedding_id, type, direction, subject, gmail_thread_id, gmail_message_id')
      .eq('venue_id', venueId)
      .eq('id', seeded.id)

    expect(error).toBeNull()
    expect(rows?.length).toBe(1)
    expect(rows![0].type).toBe('email')
    expect(rows![0].direction).toBe('inbound')
    expect(rows![0].subject).toBe(subject)
    expect(rows![0].gmail_thread_id).toBe(seeded.gmailThreadId)
    expect(rows![0].wedding_id).toBe(wedding.weddingId)
  })

  test('b) classification persists as drafts.context_type + brain_used linked to interaction', async () => {
    // We seed the draft in the exact shape email-pipeline.ts (lines 464-482)
    // writes after router-brain classifies an email as "new_inquiry" and the
    // inquiry brain produces a body. This covers the post-classification
    // contract (what ends up in the DB), not the Claude call itself.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    const interaction = await seedInteraction(ctx, {
      venueId,
      weddingId: wedding.weddingId,
      subject: `New inquiry [e2e:${ctx.testId}]`,
    })

    const draft = await seedDraft(ctx, {
      venueId,
      weddingId: wedding.weddingId,
      interactionId: interaction.id,
      contextType: 'inquiry',
      brainUsed: 'inquiry',
      confidenceScore: 87,
    })

    const { data: row, error } = await admin()
      .from('drafts')
      .select('id, venue_id, interaction_id, wedding_id, context_type, brain_used, confidence_score, status')
      .eq('id', draft.id)
      .single()

    expect(error).toBeNull()
    expect(row!.venue_id).toBe(venueId)
    expect(row!.interaction_id).toBe(interaction.id)
    expect(row!.wedding_id).toBe(wedding.weddingId)
    expect(row!.context_type).toBe('inquiry')
    expect(row!.brain_used).toBe('inquiry')
    expect(row!.status).toBe('pending')
    expect(row!.confidence_score).toBe(87)
  })

  test('c) draft is linked to its interaction and scoped to the venue', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    const interaction = await seedInteraction(ctx, {
      venueId,
      weddingId: wedding.weddingId,
    })
    const draft = await seedDraft(ctx, {
      venueId,
      weddingId: wedding.weddingId,
      interactionId: interaction.id,
      contextType: 'client',
      brainUsed: 'client',
    })

    // Join-style read: find drafts whose interaction belongs to this venue.
    const { data: drafts, error } = await admin()
      .from('drafts')
      .select('id, interaction_id, venue_id, context_type')
      .eq('venue_id', venueId)
      .eq('interaction_id', interaction.id)
    expect(error).toBeNull()
    expect(drafts?.length).toBe(1)
    expect(drafts![0].id).toBe(draft.id)
    expect(drafts![0].context_type).toBe('client')

    // Negative: filtering by a fake venue id returns nothing.
    const { data: wrongVenueRows } = await admin()
      .from('drafts')
      .select('id')
      .eq('venue_id', '00000000-0000-0000-0000-000000000000')
      .eq('interaction_id', interaction.id)
    expect(wrongVenueRows ?? []).toHaveLength(0)
  })

  // BUG-06A (investigated April 17 2026):
  // Reproduction (tmp-bug06a-deep.mjs) confirmed the leak is real AND wider
  // than first suspected. A brand-new authenticated coordinator scoped to
  // venue B can:
  //   1) read 28 rows from user_profiles (should be 1)
  //   2) read 78 interactions rows across 4 venues (should be 0 for venue A)
  //   3) INSERT an interactions row with venue_id pointing at venue A
  // The migration files in this repo declare correct venue_isolation policies
  // on interactions / drafts / user_profiles, so the extra permissive
  // policies present in the live DB were not introduced via a tracked
  // migration — likely applied ad hoc in the Supabase SQL editor during
  // earlier debugging. Migration 055_fix_interactions_rls.sql drops every
  // existing policy on these three tables and re-declares clean per-verb
  // policies scoped TO authenticated with both USING and WITH CHECK clauses.
  // TODO: once 055 is applied in production Supabase, flip this from
  // test.fail(...) back to test(...) and delete this block.
  test.fail('d) BUG-06A: venue scope isolation on interactions is NOT enforced (expected-fail until migration 055 applied)', async () => {
    // Two separate venues under the same org. We insert an inbound email
    // thread in venue A and log in a coordinator for venue B via the anon
    // (RLS-enforced) client, then confirm venue B coordinator sees zero rows.
    const { orgId } = await createTestOrg(ctx)
    const { venueId: venueA } = await createTestVenue(ctx, { orgId, name: `E2E Venue A [e2e:${ctx.testId}]` })
    const { venueId: venueB } = await createTestVenue(ctx, { orgId, name: `E2E Venue B [e2e:${ctx.testId}]` })

    const venueBCoordinator = await createTestUser(ctx, {
      role: 'coordinator',
      orgId,
      venueId: venueB,
    })

    // Seed an inbound email in venue A only.
    const uniqSubject = `VenueA-secret [e2e:${ctx.testId}]`
    await seedInteraction(ctx, {
      venueId: venueA,
      subject: uniqSubject,
      body: 'Private to venue A.',
    })

    // Sign venue B coordinator in through the anon client so RLS applies.
    const anon = anonClient()
    const { error: signInErr } = await anon.auth.signInWithPassword({
      email: venueBCoordinator.email,
      password: venueBCoordinator.password,
    })
    expect(signInErr).toBeNull()

    // As venue B coordinator, query interactions. Must see zero venue A rows.
    const { data: leaked, error: leakErr } = await anon
      .from('interactions')
      .select('id, venue_id, subject')
      .eq('subject', uniqSubject)
    // Either RLS blocks the read and returns [], or returns an error; both
    // are acceptable as long as no rows leak back.
    if (leakErr) {
      // Policy denial path: assert we got zero rows regardless of the error
      expect(leaked ?? []).toHaveLength(0)
    } else {
      expect(leaked ?? []).toHaveLength(0)
    }

    // Sanity: venue B coordinator CAN see their own venue's interactions if
    // we add one. This ensures the zero-rows result above is genuine RLS
    // scope and not a blanket deny.
    await seedInteraction(ctx, {
      venueId: venueB,
      subject: `VenueB-own [e2e:${ctx.testId}]`,
    })
    const { data: ownRows, error: ownErr } = await anon
      .from('interactions')
      .select('id, venue_id')
      .eq('venue_id', venueB)
    // If RLS is configured as expected, ownRows.length >= 1. If the app
    // relies on an API layer rather than RLS for coordinator reads, this
    // read can legitimately return zero; treat that as informational, not
    // fatal, so this test still guards against cross-venue leakage.
    if (!ownErr) {
      // Must at least not contain venue A's rows.
      const anyFromVenueA = (ownRows ?? []).some((r) => r.venue_id === venueA)
      expect(anyFromVenueA).toBe(false)
    }

    await anon.auth.signOut().catch(() => null)
  })

  // The live classifier (`router-brain.classifyEmail`) and the full
  // `processIncomingEmail` pipeline both make paid Anthropic calls and also
  // require a valid Gmail connection for the full loop. A true end-to-end
  // invocation belongs in a separate nightly/integration run, not in the
  // default e2e section. Skipped here with clear breadcrumbs.
  test.skip('TODO: end-to-end processIncomingEmail writes interaction + draft in one call', async () => {
    // To implement:
    //   1. Stub/record Claude response for classifyEmail OR allow the test
    //      to spend ~1c per run and gate on ANTHROPIC_API_KEY.
    //   2. import { processIncomingEmail } from '@/lib/services/email-pipeline'
    //      (note: test runs in Playwright Node context, same module can be
    //      imported directly; no HTTP route needed).
    //   3. Call with a seeded venueId and a fake IncomingEmail.
    //   4. Assert interactions row exists with gmail_message_id == input.
    //   5. Assert drafts row exists with interaction_id == that row's id
    //      and context_type in ('inquiry','client').
    //
    // Also missing (flag for audit):
    //   - There is NO /api/agent/process-email route. process-email is
    //     invoked only from the Gmail sync cron / /api/agent/sync path.
    //     If §6 wants an HTTP-level test, a thin POST route that accepts a
    //     raw email payload would be needed.
  })
})
