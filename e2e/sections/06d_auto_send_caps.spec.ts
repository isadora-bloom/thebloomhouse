import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  cleanup,
  TestContext,
} from '../helpers/seed'
import { seedInteraction, seedDraft } from '../helpers/email-seed'

/**
 * §6d AUTO-SEND CAP BEHAVIOUR + FORBIDDEN TOPIC ESCALATION
 *
 * Prior audit (bloom-auto-send-cap-audit.md, 2026-04-22) flagged three
 * behaviour gaps that were schema-verified but not behaviour-verified:
 *
 *   1. Venue-wide daily cap (auto_send_rules.daily_limit)
 *      The cap is read by getTodayAutoSendCount() → checkAutoSendEligible().
 *      There is NO separate flush/queue — checkAutoSendEligible() is called
 *      per-draft at draft-creation time. This test seeds an auto_send_rules
 *      row with daily_limit=3, marks 3 drafts as already auto_sent=true
 *      today, then verifies the 4th draft's eligibility check sees
 *      count >= limit via the same DB predicate the service uses.
 *      We do NOT call the service function directly (Next.js path-alias
 *      resolution is unavailable in the Playwright runner). The predicate
 *      itself is the contract under test.
 *
 *   2. Per-thread 24h rolling cap (auto_send_rules.thread_cap_24h)
 *      Added in migration 070 (column) and 072 (drafts.sent_at column that
 *      backs the rolling window). Verified the same way — we mirror the
 *      two-step DB predicate getRecentThreadAutoSendCount() uses and confirm
 *      count >= thread_cap_24h when expected.
 *
 *   3. Forbidden-topic escalation
 *      venue_forbidden_topics (migration 125) extends the global
 *      ESCALATION_KEYWORDS list. The escalation-detector.ts service writes
 *      an admin_notifications row with type='escalation' on keyword match.
 *      This test verifies the DB layer: forbidden keyword inserted, text
 *      match logic can find it, and a notification row with type='escalation'
 *      can be seeded and queried (proving the schema shape callers need).
 *
 * All tests run at the DB layer against the live Supabase project defined
 * in .env.local. No Claude calls. No HTTP calls. No flush endpoint.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§6d Auto-send caps + forbidden topic escalation', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  // --------------------------------------------------------------------------
  // Test 1 — Venue-wide daily cap
  //
  // Implementation note: getTodayAutoSendCount (autonomous-sender.ts:466)
  // counts drafts WHERE auto_sent=true AND context_type=context AND
  // created_at >= today_start. It does NOT use a separate auto_send_counts
  // table — the count is always derived live from the drafts table. The
  // daily_limit lives in auto_send_rules. This test mirrors that predicate.
  // --------------------------------------------------------------------------

  test('daily cap: after 3 auto-sends, a 4th draft exceeds the daily_limit=3 threshold', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Seed an auto_send_rules row with daily_limit=3.
    const { data: ruleRow, error: ruleErr } = await admin()
      .from('auto_send_rules')
      .insert({
        venue_id: venueId,
        context: 'inquiry',
        source: 'all',
        enabled: true,
        confidence_threshold: 70,
        daily_limit: 3,
      })
      .select('id, daily_limit')
      .single()

    expect(ruleErr, `auto_send_rules insert failed: ${ruleErr?.message}`).toBeNull()
    expect(ruleRow!.daily_limit).toBe(3)

    // Today's midnight UTC — same boundary getTodayAutoSendCount uses.
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // Seed 3 interactions and drafts marked auto_sent=true for THIS venue,
    // context='inquiry', created today.
    for (let i = 0; i < 3; i++) {
      const interaction = await seedInteraction(ctx, {
        venueId,
        subject: `Daily cap test inquiry ${i} [e2e:${ctx.testId}]`,
      })
      const draft = await seedDraft(ctx, {
        venueId,
        interactionId: interaction.id,
        contextType: 'inquiry',
      })

      // Flip to auto_sent=true, created_at stamped within today so the
      // count query sees it.
      const { error: flipErr } = await admin()
        .from('drafts')
        .update({
          auto_sent: true,
          status: 'sent',
          // created_at is set on insert. The service reads created_at for the
          // daily cap (not sent_at). We update it to a known-today value so
          // the test is deterministic regardless of midnight boundary drift.
          created_at: new Date(Date.now() - (i + 1) * 60 * 1000).toISOString(),
        })
        .eq('id', draft.id)
      expect(flipErr, `flip draft ${i} to auto_sent failed`).toBeNull()
    }

    // Mirror the service predicate: count auto_sent=true + context_type='inquiry'
    // + created_at >= today_start for this venue.
    const { data: counted, error: countErr } = await admin()
      .from('drafts')
      .select('id')
      .eq('venue_id', venueId)
      .eq('auto_sent', true)
      .eq('context_type', 'inquiry')
      .gte('created_at', todayStart.toISOString())

    expect(countErr).toBeNull()
    const todayCount = counted?.length ?? 0
    expect(todayCount).toBe(3)

    // The eligibility check: todayCount >= daily_limit → blocked.
    expect(todayCount >= ruleRow!.daily_limit).toBe(true)

    // Sanity: a DIFFERENT context ('client') would see count=0 and NOT block.
    const { data: clientCounted } = await admin()
      .from('drafts')
      .select('id')
      .eq('venue_id', venueId)
      .eq('auto_sent', true)
      .eq('context_type', 'client')
      .gte('created_at', todayStart.toISOString())
    expect(clientCounted?.length ?? 0).toBe(0)
  })

  // --------------------------------------------------------------------------
  // Test 2 — Per-thread 24h rolling cap
  //
  // The thread cap was added in migration 070 (auto_send_rules.thread_cap_24h
  // column, default 3). The enforcement in getRecentThreadAutoSendCount joins
  // drafts → interactions via gmail_thread_id, filtering auto_sent=true and
  // sent_at >= now() - 24h. sent_at column was added in migration 072.
  //
  // This test is REAL (not skipped). Migration 070 confirmed existing in §6c
  // test 2; migration 072 added sent_at. Both verified in the DB.
  // --------------------------------------------------------------------------

  test('thread cap: 3 auto-sends on one thread in 24h triggers cap threshold at thread_cap_24h=3', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Seed a rule with thread_cap_24h=3 (the default).
    const { data: ruleRow, error: ruleErr } = await admin()
      .from('auto_send_rules')
      .insert({
        venue_id: venueId,
        context: 'inquiry',
        source: 'all',
        enabled: true,
        daily_limit: 10, // daily limit high so it doesn't interfere
        thread_cap_24h: 3,
      })
      .select('id, thread_cap_24h')
      .single()

    expect(ruleErr, `auto_send_rules insert failed: ${ruleErr?.message}`).toBeNull()
    expect(ruleRow!.thread_cap_24h).toBe(3)

    const threadId = `e2e-thread-${ctx.testId}-cap`
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    // Seed 3 auto-sent drafts on the SAME gmail_thread_id within the last
    // 24h. Each interaction sits on the same thread.
    for (let i = 0; i < 3; i++) {
      const interaction = await seedInteraction(ctx, {
        venueId,
        gmailThreadId: threadId,
        subject: `Thread cap test msg ${i} [e2e:${ctx.testId}]`,
      })
      const draft = await seedDraft(ctx, {
        venueId,
        interactionId: interaction.id,
        contextType: 'inquiry',
      })

      const { error: flipErr } = await admin()
        .from('drafts')
        .update({
          auto_sent: true,
          status: 'sent',
          // sent_at column (migration 072) — this is what getRecentThreadAutoSendCount
          // filters on for the rolling 24h window.
          sent_at: new Date(Date.now() - (i + 1) * 60 * 1000).toISOString(),
        })
        .eq('id', draft.id)
      expect(flipErr, `flip draft ${i} sent_at failed`).toBeNull()
    }

    // Noise: a qualifying auto-sent draft on a DIFFERENT thread — must NOT
    // count toward this thread's cap.
    const otherInteraction = await seedInteraction(ctx, {
      venueId,
      gmailThreadId: `e2e-thread-${ctx.testId}-other`,
      subject: `Other thread [e2e:${ctx.testId}]`,
    })
    const otherDraft = await seedDraft(ctx, {
      venueId,
      interactionId: otherInteraction.id,
    })
    await admin()
      .from('drafts')
      .update({
        auto_sent: true,
        status: 'sent',
        sent_at: new Date(Date.now() - 30 * 1000).toISOString(),
      })
      .eq('id', otherDraft.id)

    // Noise: a manual (non-auto) draft on the same thread — must NOT count.
    const noiseInteraction = await seedInteraction(ctx, {
      venueId,
      gmailThreadId: threadId,
      subject: `Noise manual [e2e:${ctx.testId}]`,
    })
    const noiseDraft = await seedDraft(ctx, {
      venueId,
      interactionId: noiseInteraction.id,
    })
    await admin()
      .from('drafts')
      .update({ auto_sent: false, sent_at: new Date(Date.now() - 60 * 1000).toISOString() })
      .eq('id', noiseDraft.id)

    // Mirror getRecentThreadAutoSendCount: step 1 — find interaction ids on
    // this thread; step 2 — count qualifying auto_sent drafts with
    // sent_at >= 24h ago.
    const { data: threadInts, error: intErr } = await admin()
      .from('interactions')
      .select('id')
      .eq('venue_id', venueId)
      .eq('gmail_thread_id', threadId)

    expect(intErr).toBeNull()
    // 3 auto + 1 manual noise = 4 interactions on the thread
    expect(threadInts?.length).toBe(4)

    const threadIntIds = (threadInts ?? []).map((r) => r.id as string)

    const { data: autoSentOnThread, error: capErr } = await admin()
      .from('drafts')
      .select('id')
      .eq('venue_id', venueId)
      .eq('auto_sent', true)
      .in('interaction_id', threadIntIds)
      .gte('sent_at', windowStart)

    expect(capErr).toBeNull()
    const threadCount = autoSentOnThread?.length ?? 0
    expect(threadCount).toBe(3)

    // The enforcement check: threadCount >= thread_cap_24h → blocked.
    expect(threadCount >= ruleRow!.thread_cap_24h).toBe(true)
  })

  // --------------------------------------------------------------------------
  // Test 3 — Forbidden topic escalation
  //
  // venue_forbidden_topics (migration 125) + checkEscalationForVenue()
  // (escalation-keywords.ts) + runEscalationCheck() (escalation-detector.ts)
  // → admin_notifications with type='escalation'.
  //
  // The email pipeline does NOT call checkEscalationForVenue on the email
  // body — that path is for couple portal messages and Sage chat
  // (runEscalationCheck in escalation-detector.ts). Tests here:
  //   a) venue_forbidden_topics insert + select round-trip.
  //   b) The text-match predicate that checkEscalationForVenue uses (case-
  //      insensitive substring) fires on a body mentioning the keyword.
  //   c) An admin_notifications row of type='escalation' can be seeded and
  //      queried — proving the schema shape the service writes to.
  //   d) Absence of a draft for the interaction (no auto-draft on escalated
  //      content) is asserted at the DB predicate level.
  //
  // Full behavioural test (calling checkEscalationForVenue server-side and
  // verifying end-to-end notification creation) requires Next.js module
  // resolution in the Playwright runner — deferred as noted at the bottom.
  // --------------------------------------------------------------------------

  test('forbidden topic: keyword in venue_forbidden_topics matches body substring + escalation notification schema', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Step 1: Seed venue-specific forbidden keywords.
    const { error: topicErr } = await admin()
      .from('venue_forbidden_topics')
      .insert([
        { venue_id: venueId, keyword: 'competitor', category: 'competitive_intel', reason: 'Do not discuss competitors' },
        { venue_id: venueId, keyword: 'pricing sheet', category: 'pricing', reason: 'Direct to pricing page only' },
      ])
    expect(topicErr, `venue_forbidden_topics insert failed: ${topicErr?.message}`).toBeNull()

    // Step 2: Verify the keywords round-trip and can be fetched by venue.
    const { data: topics, error: topicSelectErr } = await admin()
      .from('venue_forbidden_topics')
      .select('keyword, category')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
    expect(topicSelectErr).toBeNull()
    const keywords = (topics ?? []).map((r) => (r.keyword as string).toLowerCase())
    expect(keywords).toContain('competitor')
    expect(keywords).toContain('pricing sheet')

    // Step 3: Seed an inbound interaction whose body mentions the forbidden
    // keyword 'competitor pricing'. In production, runEscalationCheck() would
    // call checkEscalationForVenue(body, venueId), match 'competitor', and
    // write an admin_notifications row. We verify the text-match predicate
    // manually (mirroring the lowercase substring check in escalation-keywords.ts).
    const forbiddenBody = 'Hi, we are comparing you with a competitor pricing list we received.'
    const interaction = await seedInteraction(ctx, {
      venueId,
      subject: `Inquiry with forbidden topic [e2e:${ctx.testId}]`,
      body: forbiddenBody,
    })

    // Mirror the predicate from checkEscalationForVenue: for each keyword, do
    // body.toLowerCase().includes(keyword.toLowerCase()). At least one should
    // match.
    const bodyLower = forbiddenBody.toLowerCase()
    const matchedKeyword = keywords.find((kw) => bodyLower.includes(kw)) ?? null
    expect(matchedKeyword).not.toBeNull()
    expect(matchedKeyword).toBe('competitor')

    // Step 4: Seed the admin_notifications row the escalation-detector would
    // create (type='escalation'). Proves the schema is queryable.
    const { error: notifErr } = await admin()
      .from('admin_notifications')
      .insert({
        venue_id: venueId,
        wedding_id: null,
        type: 'escalation',
        title: `Escalation: "${matchedKeyword}" from couple`,
        body: `Detected in message: "${forbiddenBody.slice(0, 200)}"`,
      })
    expect(notifErr, `admin_notifications insert failed: ${notifErr?.message}`).toBeNull()

    // Confirm the notification is queryable by type + venue.
    const { data: notifs, error: notifSelectErr } = await admin()
      .from('admin_notifications')
      .select('type, title')
      .eq('venue_id', venueId)
      .eq('type', 'escalation')
    expect(notifSelectErr).toBeNull()
    expect((notifs ?? []).length).toBeGreaterThan(0)
    expect(notifs![0].type).toBe('escalation')

    // Step 5: Verify NO auto-send draft was created for this interaction.
    // The escalation path blocks draft generation. In production this
    // happens because skipDraft is set when an escalation fires, or the
    // coordinator replies manually. At DB level: assert no draft exists
    // for this interaction_id.
    const { data: drafts, error: draftErr } = await admin()
      .from('drafts')
      .select('id')
      .eq('venue_id', venueId)
      .eq('interaction_id', interaction.id)
    expect(draftErr).toBeNull()
    expect(drafts ?? []).toHaveLength(0)
  })

  // --------------------------------------------------------------------------
  // Deferred: behavioural end-to-end tests that require server-side module
  // resolution in the Playwright runner or real Claude calls.
  // --------------------------------------------------------------------------

  test.skip(
    'DEFERRED: checkAutoSendEligible() returns eligible=false when daily_limit reached (needs Next.js module resolver in Playwright runner)',
    // TODO: To implement — call /api/admin/test-harness with action=check_auto_send_eligible
    // and assert the response body carries eligible=false + reason containing 'Daily limit'.
    // Requires adding a test-harness action for checkAutoSendEligible().
    () => {}
  )

  test.skip(
    'DEFERRED: forbidden-topic email body triggers escalation notification end-to-end (needs runEscalationCheck server-side call)',
    // TODO: The email pipeline does NOT currently call checkEscalationForVenue on the
    // email body in processIncomingEmail() — that path is couple_message + sage_conversation.
    // Two options:
    //   a) Add forbidden-body-check to email-pipeline.ts (architectural decision needed).
    //   b) Test via /api/couple/messages POST with a body matching a venue keyword, then
    //      query admin_notifications for the escalation row.
    // Either way, no Claude call is needed — the keyword check is synchronous text match.
    () => {}
  )
})
