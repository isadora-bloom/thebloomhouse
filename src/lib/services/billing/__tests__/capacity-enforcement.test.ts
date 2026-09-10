/**
 * Unit tests for capacity-enforcement.ts (W18, Nov-plan wave 2).
 *
 * Proves the honest-non-fatal contract: crossing a cap never fails the
 * check itself, always reports the real used/limit numbers, and fires
 * exactly one admin notification (dedup is admin-notifications.ts's job,
 * exercised separately — this file just proves createNotification is
 * called with the right payload shape when over cap, and NOT called when
 * under cap).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CapacityLimits } from '@/lib/auth/plan-tiers'

const notifications: Array<Record<string, unknown>> = []

vi.mock('@/lib/services/admin-notifications', () => ({
  createNotification: vi.fn(async (opts: Record<string, unknown>) => {
    notifications.push(opts)
  }),
}))

// resolveBillingState is exercised directly by billing-state.test.ts;
// here it's mocked so this file can pin capacity-enforcement's own
// branching (over cap / under cap / unlimited) without re-deriving trial
// state each time.
const billingState = {
  venueId: 'venue-1',
  storedTier: 'solo' as const,
  isTrial: false,
  trialEndsAt: null,
  trialExpired: false,
  daysRemaining: null,
  subscriptionStatus: 'active',
  effectiveCapacity: { inquiriesPerMonth: 150, venues: 1, activeCouplesInPortal: 50 } as CapacityLimits,
}

vi.mock('@/lib/services/billing/billing-state', () => ({
  resolveBillingState: vi.fn(async () => billingState),
}))

import { checkAndRecordCapacityHit } from '@/lib/services/billing/capacity-enforcement'

function fakeClient(count: number, opts: { errors?: boolean } = {}) {
  return {
    from(_table: string) {
      return {
        select(_cols: string, _selectOpts?: { count?: string; head?: boolean }) {
          return this
        },
        eq(_col: string, _val: unknown) {
          return this
        },
        is(_col: string, _val: unknown) {
          return this
        },
        gte(_col: string, _val: unknown) {
          return opts.errors
            ? Promise.resolve({ count: null, error: { message: 'boom' } })
            : Promise.resolve({ count, error: null })
        },
      }
    },
  } as any
}

describe('checkAndRecordCapacityHit', () => {
  beforeEach(() => {
    notifications.length = 0
    billingState.effectiveCapacity = { inquiriesPerMonth: 150, venues: 1, activeCouplesInPortal: 50 }
    billingState.isTrial = false
    billingState.storedTier = 'solo'
  })

  it('does not fire a notification when usage is under the cap', async () => {
    const result = await checkAndRecordCapacityHit('venue-1', fakeClient(149))
    expect(result).toEqual({ checked: true, overCap: false, used: 149, limit: 150 })
    expect(notifications).toHaveLength(0)
  })

  it('fires exactly one cap-hit notification when usage exceeds the cap', async () => {
    const result = await checkAndRecordCapacityHit('venue-1', fakeClient(151))
    expect(result).toEqual({ checked: true, overCap: true, used: 151, limit: 150 })
    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe('capacity_cap_hit')
    expect(notifications[0].venueId).toBe('venue-1')
    expect(String(notifications[0].body)).toMatch(/still being captured/)
  })

  it('never enforces a cap for the unlimited (enterprise-shaped) tier', async () => {
    billingState.effectiveCapacity = { inquiriesPerMonth: null, venues: null, activeCouplesInPortal: null }
    const result = await checkAndRecordCapacityHit('venue-1', fakeClient(999999))
    expect(result).toEqual({ checked: true, overCap: false, used: 0, limit: null })
    expect(notifications).toHaveLength(0)
  })

  it('uses trial-flavoured notification copy for a never-subscribed venue over its evaluation cap', async () => {
    billingState.isTrial = true
    billingState.effectiveCapacity = { inquiriesPerMonth: 100, venues: 1, activeCouplesInPortal: 30 }
    await checkAndRecordCapacityHit('venue-1', fakeClient(101))
    expect(String(notifications[0].body)).toMatch(/trial/i)
  })

  it('never throws and reports checked:false when the count query errors', async () => {
    const result = await checkAndRecordCapacityHit('venue-1', fakeClient(0, { errors: true }))
    expect(result.checked).toBe(false)
    expect(notifications).toHaveLength(0)
  })

  it('is a no-op for an empty venueId', async () => {
    const result = await checkAndRecordCapacityHit('', fakeClient(999))
    expect(result.checked).toBe(false)
  })
})
