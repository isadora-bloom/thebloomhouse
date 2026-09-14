/**
 * S2 (2026-09-14 security audit) — the Stripe webhook's unset-secret path.
 *
 * What it used to do: log a warning saying the secret was missing, then
 * `JSON.parse(rawBody)` and process the event. The route writes
 * venues.plan_tier, so an unsigned POST carrying a
 * `customer.subscription.updated` was a free upgrade to the enterprise
 * tier for anyone who knew the URL. /api/webhooks/twilio and
 * /api/webhooks/instagram already refused in that situation; this route
 * did not.
 *
 * What it must do now: 503, and nothing else. No parse, no database
 * client, no side effect.
 *
 * Every collaborator is mocked, so a regression that reintroduces the
 * parse fails here by calling something it should not have reached.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const createServiceClientMock = vi.fn(() => {
  throw new Error('createServiceClient must not be called on the unset-secret path')
})
const recordCounterMock = vi.fn(async () => {})
const getStripeMock = vi.fn(() => {
  throw new Error('getStripe must not be called on the unset-secret path')
})

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: (...a: unknown[]) => createServiceClientMock(...(a as [])),
}))

vi.mock('@/lib/observability/metrics', () => ({
  recordCounter: (...a: unknown[]) => recordCounterMock(...(a as [])),
}))

vi.mock('@/lib/stripe', () => ({
  getStripe: (...a: unknown[]) => getStripeMock(...(a as [])),
  isStripeConfigured: () => false,
}))

vi.mock('@/lib/services/email/transport', () => ({
  sendEmail: async () => ({ ok: true, id: 'noop' }),
}))

const ORIGINAL_SECRET = process.env.STRIPE_WEBHOOK_SECRET

const EVENT = JSON.stringify({
  id: 'evt_test_s2',
  type: 'customer.subscription.updated',
  data: { object: { id: 'sub_1', customer: 'cus_1', items: { data: [] } } },
})

function post(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://bloom.test/api/webhooks/stripe', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (ORIGINAL_SECRET === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = ORIGINAL_SECRET
})

describe('POST /api/webhooks/stripe — STRIPE_WEBHOOK_SECRET unset', () => {
  it('answers 503 and names the reason', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    const { POST } = await import('../route')

    const res = await POST(post(EVENT))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({ error: 'stripe_not_configured' })
  })

  it('never reaches the database or the Stripe SDK', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    const { POST } = await import('../route')

    await POST(post(EVENT))

    expect(createServiceClientMock).not.toHaveBeenCalled()
    expect(getStripeMock).not.toHaveBeenCalled()
  })

  it('records the refusal so a silently misconfigured deploy is visible', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    const { POST } = await import('../route')

    await POST(post(EVENT))

    expect(recordCounterMock).toHaveBeenCalledWith(
      'stripe_webhook_event',
      expect.objectContaining({
        dimension: expect.objectContaining({ outcome: 'not_configured' }),
      }),
    )
  })

  it('refuses a body that is not even valid JSON, without throwing', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    const { POST } = await import('../route')

    const res = await POST(post('}{ not json'))

    expect(res.status).toBe(503)
  })
})

describe('POST /api/webhooks/stripe — secret set', () => {
  it('still refuses an unsigned delivery, with 401 rather than 503', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_value_for_unit_test'
    const { POST } = await import('../route')

    const res = await POST(post(EVENT))

    expect(res.status).toBe(401)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('refuses a wrong signature', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_value_for_unit_test'
    const { POST } = await import('../route')

    const res = await POST(post(EVENT, { 'stripe-signature': 't=1,v1=deadbeef' }))

    expect(res.status).toBe(401)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })
})
