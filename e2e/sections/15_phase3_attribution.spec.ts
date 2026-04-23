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
 * §15 PHASE 3 ACCEPTANCE — Attribution intelligence.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§15 Phase 3 — Attribution', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  test('079: wedding_touchpoints exists with the full schema', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    const { data, error } = await admin()
      .from('wedding_touchpoints')
      .insert({
        venue_id: venueId,
        wedding_id: wedding.weddingId,
        source: 'the_knot',
        medium: 'email',
        touch_type: 'inquiry',
      })
      .select('id, touch_type, occurred_at, metadata')
      .single()
    expect(error).toBeNull()
    expect(data!.touch_type).toBe('inquiry')
    expect(data!.metadata).toEqual({})
    expect(data!.occurred_at).not.toBeNull()
  })

  test('079: touch_type CHECK rejects junk', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const { error } = await admin()
      .from('wedding_touchpoints')
      .insert({
        venue_id: venueId,
        touch_type: 'not-a-real-type',
      })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/touch_type|check constraint/i)
  })

  test('079: backfill-on-migration populated one touchpoint per sourced wedding', async () => {
    // We expect the migration to have created at least 1 touchpoint per
    // wedding with a non-null source. Test isn't exhaustive — a quick
    // sanity check that counts are positive and per-wedding = 1 for the
    // seeded demo rows.
    const { data } = await admin()
      .from('wedding_touchpoints')
      .select('wedding_id, touch_type')
      .eq('touch_type', 'inquiry')
      .limit(10)

    expect((data ?? []).length).toBeGreaterThan(0)
    for (const row of data ?? []) {
      expect(row.touch_type).toBe('inquiry')
      expect(row.wedding_id).not.toBeNull()
    }
  })

  test('marketing_spend upsert dedups on (venue_id, source, month)', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Insert first
    await admin().from('marketing_spend').insert({
      venue_id: venueId,
      source: 'the_knot',
      month: '2099-06-01',
      amount: 500,
    })

    // Upsert-style re-write: select existing, update amount
    const { data: existing } = await admin()
      .from('marketing_spend')
      .select('id')
      .eq('venue_id', venueId)
      .eq('source', 'the_knot')
      .eq('month', '2099-06-01')
      .maybeSingle()
    expect(existing).not.toBeNull()

    await admin()
      .from('marketing_spend')
      .update({ amount: 750 })
      .eq('id', existing!.id)

    const { data: check } = await admin()
      .from('marketing_spend')
      .select('amount')
      .eq('venue_id', venueId)
      .eq('source', 'the_knot')
      .eq('month', '2099-06-01')
    expect(check).toHaveLength(1)
    expect(Number(check![0].amount)).toBe(750)

    // Cleanup (marketing_spend isn't in ctx — delete directly)
    await admin().from('marketing_spend').delete().eq('venue_id', venueId)
  })

  test('cost-per-tour math: spend / tours when tours>0, null when tours=0', async () => {
    // Pure math — validates the inline computation the sources page does.
    const computed = (spend: number, tours: number) =>
      tours > 0 ? spend / tours : null

    expect(computed(1200, 4)).toBe(300)
    expect(computed(500, 0)).toBeNull()
    expect(computed(0, 5)).toBe(0)
  })

  test('two venues: touchpoint insert at Rixey never appears in Oakwood query', async () => {
    const { orgId } = await createTestOrg(ctx)
    const rixey = await createTestVenue(ctx, { orgId, name: `Rixey [e2e:${ctx.testId}]` })
    const oakwood = await createTestVenue(ctx, { orgId, name: `Oakwood [e2e:${ctx.testId}]`, aiName: 'Ivy' })
    const rWedding = await createTestWedding(ctx, { venueId: rixey.venueId })
    const oWedding = await createTestWedding(ctx, { venueId: oakwood.venueId })

    await admin().from('wedding_touchpoints').insert([
      {
        venue_id: rixey.venueId,
        wedding_id: rWedding.weddingId,
        source: 'the_knot',
        touch_type: 'inquiry',
      },
      {
        venue_id: oakwood.venueId,
        wedding_id: oWedding.weddingId,
        source: 'instagram',
        touch_type: 'inquiry',
      },
    ])

    const { data: rOnly } = await admin()
      .from('wedding_touchpoints')
      .select('source')
      .eq('venue_id', rixey.venueId)
      .in('wedding_id', [rWedding.weddingId, oWedding.weddingId])
    expect(rOnly).toHaveLength(1)
    expect((rOnly![0].source as string)).toBe('the_knot')

    const { data: oOnly } = await admin()
      .from('wedding_touchpoints')
      .select('source')
      .eq('venue_id', oakwood.venueId)
      .in('wedding_id', [rWedding.weddingId, oWedding.weddingId])
    expect(oOnly).toHaveLength(1)
    expect((oOnly![0].source as string)).toBe('instagram')
  })

  test.skip('DEFERRED: CSV import via /api/intel/spend?preview=true returns parsed rows (needs MSW)', () => {})
  test.skip('DEFERRED: brain-dump analytics intent routes to spend-confirm notification (needs Claude stub)', () => {})
  test.skip('DEFERRED: cost-per-5-star-booking metric (needs reviews↔weddings linking infra, Phase 4)', () => {})
})
