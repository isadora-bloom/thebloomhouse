import { test, expect, request as pwRequest } from '@playwright/test'
import { SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  cleanup,
  TestContext,
  adminClient,
} from '../helpers/seed'

/**
 * §21 PHASE 8 — Identity resolution + cross-channel matching.
 *
 * Rewritten 2026-09-16. The first version simulated the Sarah scenario
 * (Sarah H on The Knot + Sarah Highland on Instagram + Sarah and Kevin on
 * the calculator) by inserting rows straight into `tangential_signals`,
 * `client_match_queue` and `person_merges` and reading them back. Those
 * tables are the pool migration 400 retired: no writer fills them, so a
 * spec that inserts into them by hand tests nothing the product does.
 *
 * The spine is couples, touchpoints, fragments and candidate_matches,
 * written by one function, `linkSignal`. Sarah's convergence across
 * channels is asserted in §22 gap 1 (Instagram fragment + Knot inquiry
 * through the real email pipeline). What this file keeps is the venue
 * boundary on that same writer, and the one 085 surface still in use.
 *
 * `/api/admin/test-harness` is the sanctioned way to call the writer from
 * a spec; it is gated by TEST_HARNESS_SECRET.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  _admin = adminClient()
  return _admin
}

const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT ?? 3100}`
const HARNESS_SECRET = process.env.TEST_HARNESS_SECRET ?? process.env.CRON_SECRET

test.describe('§21 Phase 8 — Identity resolution', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  test('085: people.external_ids + venue_config.identity_match_config are writable', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { data: p, error: pErr } = await admin().from('people').insert({
      venue_id: venueId, role: 'partner1', first_name: 'Ex', last_name: 'IDs',
      external_ids: { instagram: 'ex_handle', the_knot: 'ex.k' },
    }).select('id, external_ids').single()
    expect(pErr, `people seed (p): ${pErr?.message}`).toBeNull()
    expect((p!.external_ids as Record<string, string>).instagram).toBe('ex_handle')

    const { error } = await admin().from('venue_config').update({
      identity_match_config: { name_plus_partner_days: 45 },
    }).eq('venue_id', venueId)
    expect(error).toBeNull()

    await admin().from('people').delete().eq('id', p!.id)
  })

  // -------------------------------------------------------------------------
  // White label — the same handle at two venues stays two identities
  // -------------------------------------------------------------------------

  test('White label: a handle filed at Oakwood converges on the Oakwood couple and never on Rixey', async () => {
    test.skip(!HARNESS_SECRET, 'TEST_HARNESS_SECRET not set')
    const { orgId } = await createTestOrg(ctx)
    const rixey = await createTestVenue(ctx, { orgId, name: `Rixey [e2e:${ctx.testId}]` })
    const oakwood = await createTestVenue(ctx, { orgId, name: `Oakwood [e2e:${ctx.testId}]`, aiName: 'Ivy' })

    const harness = await pwRequest.newContext({ baseURL: BASE_URL, timeout: 120_000 })
    const link = async (venueId: string, signal: Record<string, unknown>) => {
      const res = await harness.post('/api/admin/test-harness', {
        headers: { Authorization: `Bearer ${HARNESS_SECRET}`, 'Content-Type': 'application/json' },
        data: { action: 'link_signal', venueId, signal },
      })
      const body = await res.json()
      expect(res.status(), `link_signal answered ${res.status()}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200)
      return body.result as { action: string; matched_couple_id: string | null; reason?: string }
    }

    try {
      // The same Instagram account comments on a post at each venue. Two
      // fragments, one per venue: a handle alone is not enough identity to
      // mint anyone.
      const handle = `sarah.o.${ctx.testId}`
      const igExternalId = `ig-comment-${ctx.testId}`
      for (const venueId of [rixey.venueId, oakwood.venueId]) {
        const r = await link(venueId, {
          external_id: igExternalId,
          channel: 'instagram',
          action_type: 'ig_comment',
          occurred_at: new Date(Date.now() - 3 * 86400e3).toISOString(),
          signal_tier: 'low',
          identity_hint: `@${handle}`,
          handles: { instagram: handle },
          raw_payload: { text: `White-label comment [e2e:${ctx.testId}]` },
        })
        expect(['fragment', 'cold_start'], `comment should file as a fragment, got ${r.action} (${r.reason})`).toContain(r.action)
      }

      // Sarah then inquires at Oakwood only, and the inquiry carries her
      // handle. That mints an Oakwood couple and promotes the Oakwood
      // fragment onto it by (platform, handle).
      const inquiry = await link(oakwood.venueId, {
        external_id: `knot-${ctx.testId}`,
        channel: 'knot',
        action_type: 'knot_message',
        occurred_at: new Date().toISOString(),
        signal_tier: 'high',
        identity_hint: null,
        primary_name: 'Sarah Oakes',
        partner_name: 'Kev Oakes',
        primary_email: `sarah.o.${ctx.testId}@example.com`,
        handles: { instagram: handle },
        author_class: 'couple',
        raw_payload: { text: `Knot inquiry [e2e:${ctx.testId}]` },
      })
      expect(['minted', 'cold_start'], `inquiry should mint, got ${inquiry.action} (${inquiry.reason})`).toContain(inquiry.action)

      const { data: oakCouple, error: oakErr } = await admin().from('couples')
        .select('id, venue_id')
        .eq('venue_id', oakwood.venueId)
        .contains('handles', { instagram: handle })
        .is('merged_into_id', null)
        .maybeSingle()
      expect(oakErr, `Oakwood couple lookup: ${oakErr?.message}`).toBeNull()
      expect(oakCouple?.id, 'Oakwood should have one couple carrying the handle').toBeTruthy()

      const { data: frags } = await admin().from('fragments')
        .select('venue_id, promoted_to_couple_id')
        .eq('channel', 'instagram')
        .eq('external_id', igExternalId)
        .in('venue_id', [rixey.venueId, oakwood.venueId])
      const oakFragment = (frags ?? []).find((f) => f.venue_id === oakwood.venueId)
      const rixeyFragment = (frags ?? []).find((f) => f.venue_id === rixey.venueId)
      expect(oakFragment?.promoted_to_couple_id, 'the Oakwood fragment should promote onto the Oakwood couple').toBe(oakCouple!.id)
      expect(rixeyFragment, 'the Rixey fragment should still exist').toBeTruthy()
      expect(rixeyFragment?.promoted_to_couple_id, 'the Rixey fragment must stay anonymous: the handle converged at another venue').toBeNull()

      // Nothing at Rixey carries the handle, and no Rixey touchpoint points
      // at the Oakwood couple.
      const { data: rixeyCouples } = await admin().from('couples')
        .select('id').eq('venue_id', rixey.venueId).contains('handles', { instagram: handle })
      expect(rixeyCouples?.length ?? 0).toBe(0)
      const { data: crossed } = await admin().from('touchpoints')
        .select('id').eq('venue_id', rixey.venueId).eq('couple_id', oakCouple!.id)
      expect(crossed?.length ?? 0).toBe(0)

      // Oakwood's assistant is Ivy, not Sage.
      const { data: ai } = await admin()
        .from('venue_ai_config')
        .select('ai_name')
        .eq('venue_id', oakwood.venueId)
        .single()
      expect(ai!.ai_name).toBe('Ivy')
    } finally {
      await harness.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // Deferred — AI / browser surfaces
  // -------------------------------------------------------------------------

  test.skip('DEFERRED: end-to-end email-pipeline auto-merge on duplicate email (requires running webServer + classifier stub)', () => {})
  test.skip('DEFERRED: /intel/matching browser render with signals + tier badges', () => {})
  test.skip('DEFERRED: PriorTouchesChip renders hot chip on inquiry card (browser)', () => {})
  test.skip('DEFERRED: correlation engine with seeded 90-day synthetic series produces r>=0.6 insight', () => {})
})
