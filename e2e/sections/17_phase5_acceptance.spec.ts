import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  cleanup,
  TestContext,
} from '../helpers/seed'

/**
 * §17 PHASE 5 ACCEPTANCE — Voice and marketing feedback loop (Tasks 47-52).
 *
 * DB-layer assertions only, same convention as §13/§14/§15/§16. The UI
 * rendering of /intel/voice-dna and the dashboard Weekly Learned card
 * are exercised in development and screenshot-tested elsewhere; here we
 * validate the data contracts: voice_preferences isolation, review_language
 * approval flags, venue_ai_config.ai_name carry-through, and the composed
 * "learned this week" inputs. Claude-stub rendering tests are DEFERRED.
 *
 * White-label is enforced by seeding both Rixey Manor and Oakwood Estate
 * under the same org and asserting Oakwood's voice data carries zero
 * Rixey references and uses its own AI assistant name (Ivy).
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§17 Phase 5 — Voice and marketing feedback loop', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  // -------------------------------------------------------------------------
  // Task 47 — voice stack schema + venue isolation
  // -------------------------------------------------------------------------

  test('voice_preferences accepts the full CHECK vocabulary + source references', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const rows = [
      { preference_type: 'banned_phrase', content: 'reach out', score: 0.2 },
      { preference_type: 'approved_phrase', content: 'get in touch', score: 0.9 },
      { preference_type: 'dimension', content: 'warmth', score: 8 },
      { preference_type: 'rule', content: 'Always mention parking for guests', score: 1 },
    ]
    for (const r of rows) {
      const { error } = await admin().from('voice_preferences').insert({
        venue_id: venueId,
        preference_type: r.preference_type,
        content: r.content,
        score: r.score,
        sample_count: 3,
        source_type: 'review',
      })
      expect(error, `voice_preferences ${r.preference_type} rejected: ${error?.message}`).toBeNull()
    }

    const { data } = await admin()
      .from('voice_preferences')
      .select('preference_type, content')
      .eq('venue_id', venueId)
    expect(data?.length).toBe(4)

    await admin().from('voice_preferences').delete().eq('venue_id', venueId)
  })

  test('voice_training_sessions CHECK admits the 3 known game types', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    for (const game_type of ['would_you_send', 'cringe_or_fine', 'quick_quiz']) {
      const { error } = await admin().from('voice_training_sessions').insert({
        venue_id: venueId,
        game_type,
        completed_rounds: 10,
        total_rounds: 10,
        staff_email: `staff-${ctx.testId}@test.thebloomhouse.com`,
      })
      expect(error, `session ${game_type} rejected: ${error?.message}`).toBeNull()
    }

    await admin().from('voice_training_sessions').delete().eq('venue_id', venueId)
  })

  // -------------------------------------------------------------------------
  // Task 48 — Voice DNA composes from real rows (contract assertions)
  // -------------------------------------------------------------------------

  test('Task 48: venue_ai_config carries all five dimension columns the hero page reads', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { error } = await admin().from('venue_ai_config').update({
      warmth_level: 8,
      formality_level: 3,
      playfulness_level: 7,
      brevity_level: 5,
      enthusiasm_level: 9,
    }).eq('venue_id', venueId)
    expect(error).toBeNull()

    const { data } = await admin()
      .from('venue_ai_config')
      .select('ai_name, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level')
      .eq('venue_id', venueId)
      .single()
    expect(data!.ai_name).toBe('Sage')
    expect(data!.warmth_level).toBe(8)
    expect(data!.formality_level).toBe(3)
    expect(data!.playfulness_level).toBe(7)
    expect(data!.brevity_level).toBe(5)
    expect(data!.enthusiasm_level).toBe(9)
  })

  // -------------------------------------------------------------------------
  // Task 49 — Marketing copy suggestions source data
  // -------------------------------------------------------------------------

  test('Task 49: review_language approved_for_marketing filter returns only approved rows', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const phrases = [
      { phrase: 'felt like home from the first tour', theme: 'experience', frequency: 4, approved_for_marketing: true },
      { phrase: 'catering was restaurant-quality', theme: 'food_catering', frequency: 6, approved_for_marketing: true },
      { phrase: 'the parking was ok', theme: 'other', frequency: 1, approved_for_marketing: false },
    ]
    for (const p of phrases) {
      const { error } = await admin().from('review_language').insert({
        venue_id: venueId,
        phrase: p.phrase,
        theme: p.theme,
        sentiment_score: 0.9,
        frequency: p.frequency,
        approved_for_sage: true,
        approved_for_marketing: p.approved_for_marketing,
      })
      expect(error).toBeNull()
    }

    const { data } = await admin()
      .from('review_language')
      .select('phrase, theme, frequency')
      .eq('venue_id', venueId)
      .eq('approved_for_marketing', true)
      .order('frequency', { ascending: false })
    expect(data?.length).toBe(2)
    expect(data![0].phrase).toContain('catering')
    expect(data![0].frequency).toBe(6)

    await admin().from('review_language').delete().eq('venue_id', venueId)
  })

  // -------------------------------------------------------------------------
  // Task 50 — Weekly learned digest inputs (composed from existing tables)
  // -------------------------------------------------------------------------

  test('Task 50: voice + training counts in last 7 days drive the voice bullet', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Add some activity this week.
    await admin().from('voice_preferences').insert([
      { venue_id: venueId, preference_type: 'banned_phrase', content: 'hit us back', score: 0.1, sample_count: 2 },
      { venue_id: venueId, preference_type: 'approved_phrase', content: 'let us know', score: 0.9, sample_count: 2 },
    ])
    await admin().from('voice_training_sessions').insert({
      venue_id: venueId,
      game_type: 'would_you_send',
      completed_rounds: 5,
      total_rounds: 5,
      completed_at: new Date().toISOString(),
      staff_email: `staff-${ctx.testId}@test.thebloomhouse.com`,
    })

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { count: prefCount } = await admin()
      .from('voice_preferences')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('created_at', sevenDaysAgo)
    expect((prefCount ?? 0) >= 2).toBe(true)

    const { count: sessionCount } = await admin()
      .from('voice_training_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('started_at', sevenDaysAgo)
    expect((sessionCount ?? 0) >= 1).toBe(true)

    await admin().from('voice_preferences').delete().eq('venue_id', venueId)
    await admin().from('voice_training_sessions').delete().eq('venue_id', venueId)
  })

  // -------------------------------------------------------------------------
  // Task 51 — edit loop inputs (banned + approved pairs in voice_preferences)
  // -------------------------------------------------------------------------

  test('Task 51: banned and approved phrase pairs coexist in voice_preferences per venue', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    await admin().from('voice_preferences').insert([
      { venue_id: venueId, preference_type: 'banned_phrase', content: 'reach out', score: 0.2, sample_count: 3 },
      { venue_id: venueId, preference_type: 'approved_phrase', content: 'get in touch', score: 0.9, sample_count: 3 },
    ])

    const { data } = await admin()
      .from('voice_preferences')
      .select('preference_type, content')
      .eq('venue_id', venueId)
      .in('preference_type', ['banned_phrase', 'approved_phrase'])
    expect(data?.length).toBe(2)
    const banned = data!.find((r) => r.preference_type === 'banned_phrase')
    const approved = data!.find((r) => r.preference_type === 'approved_phrase')
    expect(banned?.content).toBe('reach out')
    expect(approved?.content).toBe('get in touch')

    await admin().from('voice_preferences').delete().eq('venue_id', venueId)
  })

  // -------------------------------------------------------------------------
  // White label — Oakwood sees Oakwood voice data only, uses Ivy
  // -------------------------------------------------------------------------

  test('White label: Oakwood voice_preferences do not surface for Rixey scope', async () => {
    const { orgId } = await createTestOrg(ctx)
    const rixey = await createTestVenue(ctx, {
      orgId,
      name: `Rixey Manor [e2e:${ctx.testId}]`,
    })
    const oakwood = await createTestVenue(ctx, {
      orgId,
      name: `Oakwood Estate [e2e:${ctx.testId}]`,
      aiName: 'Ivy',
      venuePrefix: 'OE',
    })

    await admin().from('voice_preferences').insert([
      { venue_id: rixey.venueId, preference_type: 'approved_phrase', content: 'chat soon', score: 0.9, sample_count: 1 },
      { venue_id: oakwood.venueId, preference_type: 'approved_phrase', content: 'delighted to host you', score: 0.9, sample_count: 1 },
    ])
    await admin().from('review_language').insert([
      { venue_id: rixey.venueId, phrase: 'Rixey made us feel special', theme: 'experience', frequency: 4, approved_for_marketing: true, sentiment_score: 0.9 },
      { venue_id: oakwood.venueId, phrase: 'Oakwood is breathtaking', theme: 'space', frequency: 5, approved_for_marketing: true, sentiment_score: 0.95 },
    ])

    // Oakwood reads at Oakwood scope: only its own rows.
    const { data: oakPref } = await admin()
      .from('voice_preferences')
      .select('content')
      .eq('venue_id', oakwood.venueId)
    const { data: oakRev } = await admin()
      .from('review_language')
      .select('phrase')
      .eq('venue_id', oakwood.venueId)

    const serialised = (JSON.stringify(oakPref) + JSON.stringify(oakRev)).toLowerCase()
    expect(serialised).not.toContain('rixey')
    expect(serialised).toContain('oakwood')

    // Oakwood's AI name is Ivy.
    const { data: aiCfg } = await admin()
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', oakwood.venueId)
      .single()
    expect(aiCfg!.ai_name).toBe('Ivy')

    await admin().from('voice_preferences').delete().in('venue_id', [rixey.venueId, oakwood.venueId])
    await admin().from('review_language').delete().in('venue_id', [rixey.venueId, oakwood.venueId])
  })

  // -------------------------------------------------------------------------
  // Deferred — require Claude stub / MSW / live browser
  // -------------------------------------------------------------------------

  test.skip('DEFERRED: /intel/voice-dna renders Ivy for Oakwood coordinator in chromium-desktop', () => {})
  test.skip('DEFERRED: WeeklyLearnedCard silently hides on 402 for starter-tier venues', () => {})
  test.skip('DEFERRED: marketing-copy-from-reviews AI suggestion endpoint (if later introduced)', () => {})
})
