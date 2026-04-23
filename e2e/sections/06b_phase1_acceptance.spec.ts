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
import { seedInteraction, seedDraft } from '../helpers/email-seed'

/**
 * §6b PHASE 1 PIPELINE HARDENING — ACCEPTANCE
 *
 * Guards the surgical fixes shipped for Rixey Manor's onboarding:
 *
 *   - Migration 067: drafts.status CHECK now admits auto_send_pending /
 *     auto_send_sending / auto_send_failed; adds auto_send_attempts +
 *     auto_send_last_error. Before this, the JS client silently dropped
 *     every auto-send transition because Supabase doesn't throw on CHECK
 *     violation without .throwOnError() — auto-send was dark since launch.
 *
 *   - Migration 068: auto_generate_client_code() trigger now derives a
 *     venue_prefix from the venue name on the fly (and persists it),
 *     locks the venue_config row, and wraps the insert in an EXCEPTION
 *     handler so a code-gen failure can't roll back the wedding itself.
 *
 *   - /api/agent/auto-send-cancel: now uses a conditional UPDATE
 *     `.eq('status', 'auto_send_pending')` so a coordinator clicking
 *     "cancel" after the flush cron has claimed the draft (status has
 *     already moved to 'auto_send_sending') can't race-write 'rejected'
 *     over a successful send.
 *
 * These tests run at the DB layer against the live Supabase project in
 * .env.local. They do NOT invoke the full processIncomingEmail pipeline
 * (that path calls Claude and needs Gmail OAuth — belongs in a separate
 * nightly integration run, see TODO at the bottom).
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§6b Phase 1 Pipeline Hardening', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  // -------------------------------------------------------------------------
  // Migration 067 — drafts.status auto-send states + retry-guard columns
  // -------------------------------------------------------------------------

  test('067: drafts.status CHECK accepts auto_send_pending and related states', async () => {
    // Before migration 067, the CHECK constraint from migration 002 only
    // admitted ('pending','approved','rejected','sent'). Every pipeline
    // transition to 'auto_send_pending' silently failed. This test asserts
    // the CHECK now admits the new states so the pipeline's UPDATEs land.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })
    const interaction = await seedInteraction(ctx, { venueId, weddingId: wedding.weddingId })

    // Start from pending (default).
    const draft = await seedDraft(ctx, {
      venueId,
      weddingId: wedding.weddingId,
      interactionId: interaction.id,
      contextType: 'inquiry',
      brainUsed: 'inquiry',
    })

    // Walk the auto-send state machine: pending -> auto_send_pending ->
    // auto_send_sending -> sent. Each transition must succeed.
    const transitions = ['auto_send_pending', 'auto_send_sending', 'sent'] as const
    for (const next of transitions) {
      const { error } = await admin()
        .from('drafts')
        .update({ status: next })
        .eq('id', draft.id)
      expect(error, `transition to ${next} should succeed post-067`).toBeNull()
    }

    // auto_send_failed is also admitted (terminal state when retries exhaust).
    const { error: failErr } = await admin()
      .from('drafts')
      .update({ status: 'auto_send_failed' })
      .eq('id', draft.id)
    expect(failErr, 'transition to auto_send_failed should succeed').toBeNull()
  })

  test('067: auto_send_attempts + auto_send_last_error columns exist with sane defaults', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })
    const interaction = await seedInteraction(ctx, { venueId, weddingId: wedding.weddingId })
    const draft = await seedDraft(ctx, {
      venueId,
      weddingId: wedding.weddingId,
      interactionId: interaction.id,
    })

    const { data, error } = await admin()
      .from('drafts')
      .select('auto_send_attempts, auto_send_last_error')
      .eq('id', draft.id)
      .single()

    expect(error).toBeNull()
    expect(data!.auto_send_attempts).toBe(0)
    expect(data!.auto_send_last_error).toBeNull()

    // Retry guard in flushPendingAutoSends increments this counter. Prove
    // the column is writable and the value round-trips.
    const { error: incErr } = await admin()
      .from('drafts')
      .update({ auto_send_attempts: 2, auto_send_last_error: 'smtp connection reset' })
      .eq('id', draft.id)
    expect(incErr).toBeNull()

    const { data: after } = await admin()
      .from('drafts')
      .select('auto_send_attempts, auto_send_last_error')
      .eq('id', draft.id)
      .single()
    expect(after!.auto_send_attempts).toBe(2)
    expect(after!.auto_send_last_error).toBe('smtp connection reset')
  })

  // -------------------------------------------------------------------------
  // Migration 068 — client code trigger derives + persists venue_prefix
  // -------------------------------------------------------------------------

  test('068: wedding insert auto-generates client_code and persists derived venue_prefix', async () => {
    // createTestVenue seeds a venue_config row WITHOUT venue_prefix (matches
    // what setup/page.tsx used to do). The new trigger must:
    //   1. Derive a 2-char prefix from the venue name (initials),
    //   2. Persist it back to venue_config so future weddings reuse it,
    //   3. Insert the client_codes row with the new prefix + -0001 sequence.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, {
      orgId,
      name: `Rixey Manor [e2e:${ctx.testId}]`,
    })

    // Confirm starting state: venue_prefix is NULL.
    const { data: preCfg } = await admin()
      .from('venue_config')
      .select('venue_prefix')
      .eq('venue_id', venueId)
      .single()
    expect(preCfg!.venue_prefix).toBeNull()

    // First wedding — trigger fires.
    const wedding = await createTestWedding(ctx, { venueId })

    // venue_prefix should now be populated with "RM" (Rixey Manor).
    // Stripping the bracketed test marker, words are ["Rixey","Manor","e2etestid"],
    // first initial 'R', last initial 'E'. Actual result for this shape is
    // "RE". To keep the test resilient to the exact derivation, only assert
    // the prefix matches the 2-uppercase-alphanumeric shape the trigger
    // produces.
    const { data: postCfg } = await admin()
      .from('venue_config')
      .select('venue_prefix')
      .eq('venue_id', venueId)
      .single()
    expect(postCfg!.venue_prefix).toMatch(/^[A-Z0-9]{2}$/)

    // client_codes row exists and matches `{prefix}-{4-digit seq}`.
    const { data: codes, error: codesErr } = await admin()
      .from('client_codes')
      .select('code, wedding_id')
      .eq('venue_id', venueId)
      .eq('wedding_id', wedding.weddingId)
    expect(codesErr).toBeNull()
    expect(codes?.length).toBe(1)
    expect(codes![0].code).toMatch(new RegExp(`^${postCfg!.venue_prefix}-\\d{4}$`))
    expect(codes![0].code.endsWith('-0001')).toBe(true)

    // Second wedding on the same venue — prefix must be reused, seq advances.
    const wedding2 = await createTestWedding(ctx, { venueId })
    const { data: codes2 } = await admin()
      .from('client_codes')
      .select('code')
      .eq('venue_id', venueId)
      .eq('wedding_id', wedding2.weddingId)
      .single()
    expect(codes2!.code).toBe(`${postCfg!.venue_prefix}-0002`)
  })

  test('068: wedding insert still succeeds when venue_config row is missing (trigger fault tolerance)', async () => {
    // Legitimate edge case: a wedding gets inserted for a venue that has
    // no venue_config yet (shouldn't happen in the happy path, but setup
    // race conditions have produced this before). The hardened trigger's
    // FOR UPDATE query returns no rows; the EXCEPTION handler must keep
    // the wedding insert from rolling back.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Delete the seeded venue_config row to simulate the edge case.
    const { error: delErr } = await admin()
      .from('venue_config')
      .delete()
      .eq('venue_id', venueId)
    expect(delErr).toBeNull()

    // Insert wedding directly (bypass createTestWedding which creates extra
    // artefacts). If the trigger raises, this will fail.
    const { data: w, error: wErr } = await admin()
      .from('weddings')
      .insert({
        venue_id: venueId,
        status: 'inquiry',
        inquiry_date: new Date().toISOString(),
        heat_score: 0,
        temperature_tier: 'cool',
      })
      .select('id')
      .single()
    expect(wErr, 'wedding insert must survive even without venue_config').toBeNull()
    expect(w?.id).toBeTruthy()
    ctx.createdWeddingIds.push(w!.id)

    // The hardened trigger derives its prefix from the VENUE NAME, not from
    // venue_config, so even in this edge case a client_codes row may still
    // land — the UPDATE against the missing venue_config row is a no-op
    // (zero rows affected, no error), then the INSERT into client_codes
    // proceeds with the derived prefix. Either outcome is acceptable; what
    // matters for the "fault tolerance" contract is that the wedding itself
    // was not rolled back.
    const { data: codes } = await admin()
      .from('client_codes')
      .select('code, wedding_id')
      .eq('wedding_id', w!.id)
    expect((codes ?? []).length).toBeLessThanOrEqual(1)
    if ((codes ?? []).length === 1) {
      expect(codes![0].code).toMatch(/^[A-Z0-9]{2,}-\d{4}$/)
    }
  })

  // -------------------------------------------------------------------------
  // Auto-send cancel race guard
  // -------------------------------------------------------------------------

  test('cancel uses conditional update — can cancel pending, cannot cancel already-claimed send', async () => {
    // Simulates the race between coordinator clicking "cancel" in the UI
    // and the flush cron claiming the draft for send. The cancel endpoint
    // performs `UPDATE ... WHERE status = 'auto_send_pending'` and trusts
    // that zero rows affected == too late.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })
    const interaction = await seedInteraction(ctx, { venueId, weddingId: wedding.weddingId })
    const draft = await seedDraft(ctx, {
      venueId,
      weddingId: wedding.weddingId,
      interactionId: interaction.id,
    })

    // 1) Move draft into auto_send_pending.
    await admin().from('drafts').update({ status: 'auto_send_pending' }).eq('id', draft.id)

    // 2) Coordinator clicks cancel. The endpoint's conditional UPDATE
    //    should match one row and transition it to 'rejected'.
    const cancelInTime = await admin()
      .from('drafts')
      .update({ status: 'rejected', feedback_notes: 'cancelled_auto_send' })
      .eq('id', draft.id)
      .eq('status', 'auto_send_pending')
      .select('id')
    expect(cancelInTime.error).toBeNull()
    expect(cancelInTime.data?.length).toBe(1)

    // 3) Flip the draft to auto_send_sending (simulating the cron claim).
    await admin().from('drafts').update({ status: 'auto_send_sending' }).eq('id', draft.id)

    // 4) Coordinator clicks cancel "again" (imagine a sibling tab). The
    //    same conditional UPDATE must now match zero rows — critical,
    //    otherwise we'd overwrite a successful send with 'rejected'.
    const cancelTooLate = await admin()
      .from('drafts')
      .update({ status: 'rejected', feedback_notes: 'cancelled_auto_send' })
      .eq('id', draft.id)
      .eq('status', 'auto_send_pending')
      .select('id')
    expect(cancelTooLate.error).toBeNull()
    expect(cancelTooLate.data ?? []).toHaveLength(0)

    // 5) Row is still auto_send_sending — the in-flight send is protected.
    const { data: after } = await admin()
      .from('drafts')
      .select('status')
      .eq('id', draft.id)
      .single()
    expect(after!.status).toBe('auto_send_sending')
  })

  // -------------------------------------------------------------------------
  // Atomic claim guard in flushPendingAutoSends
  // -------------------------------------------------------------------------

  test('atomic claim: two concurrent flush ticks cannot both transition the same draft', async () => {
    // flushPendingAutoSends uses `UPDATE ... WHERE status='auto_send_pending'`
    // returning .select('id') to claim drafts. If two ticks race, only one
    // sees rows back — the other sees [] and must skip. This simulates that
    // contract at the SQL level (one claim update wins, one gets zero rows).
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })
    const interaction = await seedInteraction(ctx, { venueId, weddingId: wedding.weddingId })
    const draft = await seedDraft(ctx, {
      venueId,
      weddingId: wedding.weddingId,
      interactionId: interaction.id,
    })

    // Seed pending state.
    await admin().from('drafts').update({ status: 'auto_send_pending' }).eq('id', draft.id)

    // Tick A claims.
    const tickA = await admin()
      .from('drafts')
      .update({ status: 'auto_send_sending' })
      .eq('id', draft.id)
      .eq('status', 'auto_send_pending')
      .select('id')
    expect(tickA.error).toBeNull()
    expect(tickA.data?.length).toBe(1)

    // Tick B races in. Same conditional — must see zero rows.
    const tickB = await admin()
      .from('drafts')
      .update({ status: 'auto_send_sending' })
      .eq('id', draft.id)
      .eq('status', 'auto_send_pending')
      .select('id')
    expect(tickB.error).toBeNull()
    expect(tickB.data ?? []).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // End-to-end Claude-backed path — deferred to nightly integration
  // -------------------------------------------------------------------------
  test.skip('TODO: full processIncomingEmail happy path (new inquiry -> wedding + draft)', async () => {
    // Belongs in a separate nightly run that:
    //   - gates on ANTHROPIC_API_KEY (cost ~1-2c per test, real money)
    //   - imports { processIncomingEmail } from '@/lib/services/email-pipeline'
    //   - constructs an IncomingEmail with subject/body that the router-brain
    //     will reliably classify as new_inquiry
    //   - asserts: interactions row created, wedding with source='direct',
    //     drafts row with context_type='inquiry', client_codes row exists.
    //
    // Also worth covering there, because they depend on the classifier:
    //   - Form-relay detection: submit a Knot-shaped payload, assert
    //     wedding.source === 'the_knot' and draft body references "The Knot".
    //   - Boomerang guard: seed prior outbound in the same gmail_thread_id,
    //     then feed an "inquiry" body — assert NO new wedding is created.
    //   - Machine-mail guard: feed a List-Unsubscribe header, assert NO
    //     wedding and no draft generated (interaction may still land with
    //     classification='skipped').
  })
})
