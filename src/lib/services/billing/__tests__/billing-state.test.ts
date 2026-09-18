/**
 * Unit tests for billing-state.ts — the honest read behind venues.plan_tier
 * (W18, Nov-plan wave 2). No real Supabase: a fake client is passed
 * directly into resolveBillingState/isTrialExpiredNoSub via their optional
 * `supabase` parameter, so no vi.mock is needed at all.
 */

import { describe, it, expect } from 'vitest'
import { resolveBillingState, isTrialExpiredNoSub } from '@/lib/services/billing/billing-state'
import { CAPACITY_LIMITS } from '@/lib/auth/plan-tiers'

// ---------------------------------------------------------------------------
// Fake Supabase client — only implements the exact chain
// resolveBillingState uses: .from('venues').select(...).eq(...).limit(1)
// ---------------------------------------------------------------------------

function fakeClient(row: Record<string, unknown> | null, opts: { throws?: boolean } = {}) {
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return this
        },
        eq(_col: string, _val: unknown) {
          return this
        },
        limit(_n: number) {
          if (opts.throws) throw new Error('simulated db failure')
          return Promise.resolve({ data: row ? [row] : [], error: null })
        },
      }
    },
  } as any
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('resolveBillingState', () => {
  it('returns the fail-open empty state when the venue row is missing', async () => {
    const state = await resolveBillingState('venue-missing', fakeClient(null))
    expect(state.isTrial).toBe(false)
    expect(state.trialExpired).toBe(false)
    expect(state.storedTier).toBe('solo')
  })

  it('returns the empty state immediately for an empty venueId, without querying', async () => {
    const state = await resolveBillingState('', fakeClient({ plan_tier: 'growth' }))
    expect(state.isTrial).toBe(false)
    expect(state.venueId).toBe('')
  })

  it('treats a venue with a stripe_subscription_id as never on trial, even if trial_ends_at is in the past', async () => {
    const client = fakeClient({
      plan_tier: 'solo',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_123',
      trial_ends_at: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    })
    const state = await resolveBillingState('venue-paid', client)
    expect(state.isTrial).toBe(false)
    expect(state.trialExpired).toBe(false)
    expect(state.effectiveCapacity).toEqual(CAPACITY_LIMITS.solo)
  })

  it('a never-subscribed venue with a future trial_ends_at is on trial but not expired', async () => {
    const client = fakeClient({
      plan_tier: 'solo',
      subscription_status: null,
      stripe_subscription_id: null,
      trial_ends_at: new Date(Date.now() + 5 * DAY_MS).toISOString(),
    })
    const state = await resolveBillingState('venue-trial', client)
    expect(state.isTrial).toBe(true)
    expect(state.trialExpired).toBe(false)
    expect(state.daysRemaining).toBeGreaterThan(0)
    // Honest capacity for a never-paid venue is the smallest tier's caps,
    // not whatever the DB default happened to stamp on plan_tier.
    expect(state.effectiveCapacity).toEqual(CAPACITY_LIMITS.pre_opening)
  })

  it('a never-subscribed venue past trial_ends_at is expired', async () => {
    const client = fakeClient({
      plan_tier: 'solo',
      subscription_status: null,
      stripe_subscription_id: null,
      trial_ends_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    })
    const state = await resolveBillingState('venue-expired', client)
    expect(state.isTrial).toBe(true)
    expect(state.trialExpired).toBe(true)
    expect(state.daysRemaining).toBe(0)
  })

  it('a never-subscribed venue with no trial_ends_at at all is on trial but never marked expired', async () => {
    const client = fakeClient({
      plan_tier: 'solo',
      subscription_status: null,
      stripe_subscription_id: null,
      trial_ends_at: null,
    })
    const state = await resolveBillingState('venue-no-clock', client)
    expect(state.isTrial).toBe(true)
    expect(state.trialExpired).toBe(false)
    expect(state.daysRemaining).toBeNull()
  })

  it('coerces an unrecognised plan_tier value to solo rather than throwing', async () => {
    const client = fakeClient({
      plan_tier: 'some_legacy_value',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
      trial_ends_at: null,
    })
    const state = await resolveBillingState('venue-legacy', client)
    expect(state.storedTier).toBe('solo')
  })
})

describe('isTrialExpiredNoSub', () => {
  it('returns true only for an expired, never-subscribed venue', async () => {
    const client = fakeClient({
      plan_tier: 'solo',
      subscription_status: null,
      stripe_subscription_id: null,
      trial_ends_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    })
    expect(await isTrialExpiredNoSub('venue-expired', client)).toBe(true)
  })

  it('returns false for a subscribed venue regardless of trial_ends_at', async () => {
    const client = fakeClient({
      plan_tier: 'growth',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_9',
      trial_ends_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    })
    expect(await isTrialExpiredNoSub('venue-paid', client)).toBe(false)
  })

  it('fails open (false) rather than throwing when the lookup itself throws', async () => {
    const client = fakeClient(null, { throws: true })
    await expect(isTrialExpiredNoSub('venue-broken', client)).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// billing_exempt — a venue Bloom has decided not to charge (migration 423)
//
// Rixey Manor is free forever. Before the exemption existed it read as a trial
// that expired on 2026-05-04, because `isTrial` came straight off
// `stripe_subscription_id IS NULL`. The consequences were not cosmetic: the
// trial banner on every platform page, inquiry capacity capped to the
// pre_opening tier while plan_tier said enterprise, and autonomous sending
// switched off via isTrialExpiredNoSub.
// ---------------------------------------------------------------------------

describe('billing_exempt', () => {
  const rixeyLike = {
    plan_tier: 'enterprise',
    subscription_status: null,
    stripe_subscription_id: null,
    // Four and a half months in the past, as production had it.
    trial_ends_at: new Date(Date.now() - 135 * DAY_MS).toISOString(),
  }

  it('without the exemption, a long-expired trial caps an enterprise venue to pre_opening', async () => {
    const state = await resolveBillingState('rixey', fakeClient({ ...rixeyLike, billing_exempt: false }))
    expect(state.isTrial).toBe(true)
    expect(state.trialExpired).toBe(true)
    expect(state.storedTier).toBe('enterprise')
    expect(state.effectiveCapacity).toEqual(CAPACITY_LIMITS.pre_opening)
  })

  it('with the exemption, the same venue is not on trial and keeps its own tier', async () => {
    const state = await resolveBillingState('rixey', fakeClient({ ...rixeyLike, billing_exempt: true }))
    expect(state.billingExempt).toBe(true)
    expect(state.isTrial).toBe(false)
    expect(state.trialExpired).toBe(false)
    expect(state.daysRemaining).toBe(null)
    expect(state.effectiveCapacity).toEqual(CAPACITY_LIMITS.enterprise)
  })

  it('an exempt venue keeps trial_ends_at for the record, it just stops mattering', async () => {
    const state = await resolveBillingState('rixey', fakeClient({ ...rixeyLike, billing_exempt: true }))
    expect(state.trialEndsAt).toBe(rixeyLike.trial_ends_at)
    expect(state.trialExpired).toBe(false)
  })

  it('stops autonomous sending being refused for an exempt venue', async () => {
    expect(await isTrialExpiredNoSub('rixey', fakeClient({ ...rixeyLike, billing_exempt: false }))).toBe(true)
    expect(await isTrialExpiredNoSub('rixey', fakeClient({ ...rixeyLike, billing_exempt: true }))).toBe(false)
  })

  it('a null or missing flag reads as not exempt, so nothing changes by accident', async () => {
    for (const value of [null, undefined]) {
      const state = await resolveBillingState('v', fakeClient({ ...rixeyLike, billing_exempt: value }))
      expect(state.billingExempt).toBe(false)
      expect(state.isTrial).toBe(true)
    }
  })

  it('the exemption does not invent a tier: a solo exempt venue stays solo', async () => {
    const state = await resolveBillingState(
      'v',
      fakeClient({ ...rixeyLike, plan_tier: 'solo', billing_exempt: true }),
    )
    expect(state.effectiveCapacity).toEqual(CAPACITY_LIMITS.solo)
  })
})
