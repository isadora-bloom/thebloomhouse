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
