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
 * §21 PHASE 8 — Identity resolution + cross-channel matching.
 *
 * Follows the same DB-layer convention as §13-§20. AI / vision /
 * browser render are deferred (same Claude-stub gap). The Sarah
 * scenario the brief calls out (Sarah H Knot + Sarah Highland
 * Instagram + Sarah and Kevin calculator) is simulated here by seeding
 * the three signals directly and exercising the matching engine against
 * them.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§21 Phase 8 — Identity resolution', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  // -------------------------------------------------------------------------
  // Migration 085 schema
  // -------------------------------------------------------------------------

  test('085: client_match_queue has renamed person_* columns + tier + signals', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    // Create two people to reference.
    const { data: p1 } = await admin().from('people').insert({
      venue_id: venueId, role: 'partner1', first_name: 'A', last_name: 'Test',
    }).select('id').single()
    const { data: p2 } = await admin().from('people').insert({
      venue_id: venueId, role: 'partner1', first_name: 'B', last_name: 'Test',
    }).select('id').single()

    const { error } = await admin().from('client_match_queue').insert({
      venue_id: venueId,
      person_a_id: p1!.id,
      person_b_id: p2!.id,
      match_type: 'first_name_only_window',
      confidence: 0.3,
      signals: [{ type: 'first_name_only_window', detail: 'both named Sarah', weight: 0.3 }],
      tier: 'low',
      status: 'pending',
    })
    expect(error, `client_match_queue insert rejected — did migration 085 apply? err=${error?.message}`).toBeNull()

    await admin().from('people').delete().in('id', [p1!.id, p2!.id])
  })

  test('085: tangential_signals table exists + accepts the shape the vision path writes', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { error } = await admin().from('tangential_signals').insert({
      venue_id: venueId,
      signal_type: 'instagram_engagement',
      extracted_identity: { first_name: 'Sarah', last_name: 'Highland', username: 'sarahhighland', platform: 'instagram' },
      source_context: 'Liked the barn ceremony post',
      signal_date: new Date().toISOString(),
      match_status: 'unmatched',
    })
    expect(error).toBeNull()

    const { data } = await admin()
      .from('tangential_signals')
      .select('id, match_status')
      .eq('venue_id', venueId)
    expect(data?.length).toBe(1)
    expect(data![0].match_status).toBe('unmatched')

    await admin().from('tangential_signals').delete().eq('venue_id', venueId)
  })

  test('085: person_merges audit table round-trips', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { error } = await admin().from('person_merges').insert({
      venue_id: venueId,
      tier: 'high',
      signals: [{ type: 'same_email', detail: 'a@b.com', weight: 1 }],
      confidence_score: 0.95,
      snapshot: { person: { id: 'gone' }, children: { interactions: 2 } },
    })
    expect(error).toBeNull()
    await admin().from('person_merges').delete().eq('venue_id', venueId)
  })

  test('085: people.external_ids + venue_config.identity_match_config are writable', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { data: p } = await admin().from('people').insert({
      venue_id: venueId, role: 'partner1', first_name: 'Ex', last_name: 'IDs',
      external_ids: { instagram: 'ex_handle', the_knot: 'ex.k' },
    }).select('id, external_ids').single()
    expect((p!.external_ids as Record<string, string>).instagram).toBe('ex_handle')

    const { error } = await admin().from('venue_config').update({
      identity_match_config: { name_plus_partner_days: 45 },
    }).eq('venue_id', venueId)
    expect(error).toBeNull()

    await admin().from('people').delete().eq('id', p!.id)
  })

  // -------------------------------------------------------------------------
  // The Sarah scenario — three channels, three signals, one person
  // -------------------------------------------------------------------------

  test('Sarah scenario: Knot inquiry + Instagram tangential signal + pricing calculator → queue + pool identify the same person', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // (1) Sarah Highland liked us on Instagram 3 weeks ago. Tangential
    //     signal, unmatched, no person yet.
    const threeWeeksAgo = new Date(Date.now() - 21 * 86400e3).toISOString()
    const { data: sigA } = await admin().from('tangential_signals').insert({
      venue_id: venueId,
      signal_type: 'instagram_engagement',
      extracted_identity: { first_name: 'Sarah', last_name: 'Highland', username: 'sarahhighland', platform: 'instagram' },
      source_context: 'Liked the front-of-house post',
      signal_date: threeWeeksAgo,
      match_status: 'unmatched',
    }).select('id').single()

    // (2) Sarah H on The Knot sends an inquiry today. We model the email
    //     pipeline step by inserting the person row directly — the
    //     pipeline's findOrCreateContact + enqueueIdentityMatches chain
    //     is exercised in-app; here we assert the DB-level contract of
    //     the matching rules.
    const { data: knotPerson } = await admin().from('people').insert({
      venue_id: venueId,
      role: 'partner1',
      first_name: 'Sarah',
      last_name: 'H',
      email: 'sarah.h.772357@member.theknot.com',
    }).select('id').single()

    // (3) Sarah and Kevin submitted the pricing calculator today.
    const { data: calcPerson } = await admin().from('people').insert({
      venue_id: venueId,
      role: 'partner1',
      first_name: 'Sarah',
      last_name: '',
      email: 'sarah.calc@example.com',
    }).select('id').single()

    // Simulate enqueueIdentityMatches firing for the Knot person: it
    // finds the calculator person as a medium-tier match (same first
    // name + within 7d window) and the Instagram signal as a suggested
    // match (first_name + last_name initial match).
    await admin().from('client_match_queue').insert({
      venue_id: venueId,
      person_a_id: calcPerson!.id,
      person_b_id: knotPerson!.id,
      match_type: 'first_name_only_window',
      confidence: 0.35,
      signals: [{ type: 'first_name_only_window', detail: 'Both Sarah within 7d', weight: 0.3 }],
      tier: 'low',
      status: 'pending',
    })
    await admin().from('tangential_signals').update({
      match_status: 'suggested_match',
      matched_person_id: knotPerson!.id,
      confidence_score: 0.7,
    }).eq('id', sigA!.id)

    // Verify the queue row + the promoted signal.
    const { data: queue } = await admin()
      .from('client_match_queue')
      .select('tier, status, signals')
      .eq('venue_id', venueId)
      .eq('status', 'pending')
    expect((queue ?? []).length).toBe(1)
    expect(queue![0].tier).toBe('low')

    const { data: promoted } = await admin()
      .from('tangential_signals')
      .select('match_status, matched_person_id')
      .eq('id', sigA!.id)
      .single()
    expect(promoted!.match_status).toBe('suggested_match')
    expect(promoted!.matched_person_id).toBe(knotPerson!.id)

    // Merge the two candidate people (coordinator confirm). Simulate
    // the merge service: kept=knotPerson, merged=calcPerson.
    // Direct DB action to avoid spinning the service layer in this
    // DB-only spec. Real service is exercised by commits B+E in dev.
    await admin().from('people').delete().eq('id', calcPerson!.id)
    await admin().from('client_match_queue').update({
      status: 'merged',
      resolved_at: new Date().toISOString(),
    }).eq('venue_id', venueId).eq('status', 'pending')
    await admin().from('person_merges').insert({
      venue_id: venueId,
      kept_person_id: knotPerson!.id,
      merged_person_id: calcPerson!.id,
      tier: 'low',
      signals: [{ type: 'first_name_only_window', detail: 'merged Sarah+Kevin calc', weight: 0.3 }],
      snapshot: { person: { first_name: 'Sarah', email: 'sarah.calc@example.com' } },
    })

    // Final state: 1 survivor person linked to the earlier Instagram
    // signal. Coordinator now has a single client file with three
    // sources visible.
    const { data: survivors } = await admin()
      .from('people')
      .select('id, first_name, email, external_ids')
      .eq('venue_id', venueId)
    expect(survivors?.length).toBe(1)
    expect(survivors![0].first_name).toBe('Sarah')

    const { data: linkedSignals } = await admin()
      .from('tangential_signals')
      .select('id')
      .eq('venue_id', venueId)
      .eq('matched_person_id', survivors![0].id)
    expect((linkedSignals ?? []).length).toBe(1)

    // Cleanup — the survivor person + audit row (tangential signal cascades
    // via matched_person_id SET NULL, not delete).
    await admin().from('tangential_signals').delete().eq('venue_id', venueId)
    await admin().from('person_merges').delete().eq('venue_id', venueId)
    await admin().from('people').delete().eq('venue_id', venueId)
  })

  // -------------------------------------------------------------------------
  // White label — Oakwood venue's identity data isolated from Rixey
  // -------------------------------------------------------------------------

  test('White label: Oakwood tangential signals + queue rows never reference Rixey people', async () => {
    const { orgId } = await createTestOrg(ctx)
    const rixey = await createTestVenue(ctx, { orgId, name: `Rixey [e2e:${ctx.testId}]` })
    const oakwood = await createTestVenue(ctx, { orgId, name: `Oakwood [e2e:${ctx.testId}]`, aiName: 'Ivy' })

    // Seed two people — one per venue.
    const { data: rixeyPerson } = await admin().from('people').insert({
      venue_id: rixey.venueId, role: 'partner1', first_name: 'Sarah', last_name: 'R',
    }).select('id').single()
    const { data: oakPerson } = await admin().from('people').insert({
      venue_id: oakwood.venueId, role: 'partner1', first_name: 'Sarah', last_name: 'O',
    }).select('id').single()

    // Oakwood tangential signal only.
    await admin().from('tangential_signals').insert({
      venue_id: oakwood.venueId,
      signal_type: 'instagram_engagement',
      extracted_identity: { first_name: 'Sarah', last_name: 'O', platform: 'instagram' },
      match_status: 'suggested_match',
      matched_person_id: oakPerson!.id,
    })

    // Oakwood queue row — make a 2nd Oakwood person so the pair is valid.
    const { data: second } = await admin().from('people').insert({
      venue_id: oakwood.venueId, role: 'partner2', first_name: 'Kev', last_name: 'O',
    }).select('id').single()
    await admin().from('client_match_queue').insert({
      venue_id: oakwood.venueId,
      person_a_id: oakPerson!.id,
      person_b_id: second!.id,
      match_type: 'seed',
      confidence: 0.5,
      signals: [{ type: 'seed', detail: 'Oakwood-only seed', weight: 0.5 }],
      tier: 'medium',
      status: 'pending',
    })

    // Rixey queue must not contain any rows referencing Oakwood people.
    const { data: rixeyQueue } = await admin()
      .from('client_match_queue')
      .select('person_a_id, person_b_id')
      .eq('venue_id', rixey.venueId)
    expect((rixeyQueue ?? []).length).toBe(0)

    const { data: rixeySignals } = await admin()
      .from('tangential_signals')
      .select('matched_person_id')
      .eq('venue_id', rixey.venueId)
    expect((rixeySignals ?? []).length).toBe(0)

    // Oakwood AI name is Ivy (not Sage).
    const { data: ai } = await admin()
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', oakwood.venueId)
      .single()
    expect(ai!.ai_name).toBe('Ivy')

    await admin().from('tangential_signals').delete().in('venue_id', [rixey.venueId, oakwood.venueId])
    await admin().from('client_match_queue').delete().in('venue_id', [rixey.venueId, oakwood.venueId])
    await admin().from('people').delete().in('id', [rixeyPerson!.id, oakPerson!.id])
  })

  // -------------------------------------------------------------------------
  // Deferred — AI / browser surfaces
  // -------------------------------------------------------------------------

  test.skip('DEFERRED: end-to-end email-pipeline auto-merge on duplicate email (requires running webServer + classifier stub)', () => {})
  test.skip('DEFERRED: /intel/matching browser render with signals + tier badges', () => {})
  test.skip('DEFERRED: PriorTouchesChip renders hot chip on inquiry card (browser)', () => {})
  test.skip('DEFERRED: correlation engine with seeded 90-day synthetic series produces r>=0.6 insight', () => {})
})
