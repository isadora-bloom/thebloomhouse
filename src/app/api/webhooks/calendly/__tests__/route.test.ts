/**
 * S2 (2026-09-14 security audit) — the Calendly webhook's unset-secret path.
 *
 * What it used to do: log a warning saying the secret was missing, then
 * parse the body and carry on. An unsigned POST could create tour_booked
 * engagement events, fire a cancellation against a real wedding, and
 * write discovery-source attribution, for any venue, from anywhere.
 *
 * What it must do now: 503, and nothing else.
 *
 * The service client is mocked to throw, so any regression that reaches
 * the database fails loudly rather than quietly writing a row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createHmac } from 'crypto'

// The route imports its dependencies lazily, so the first test in a loaded
// full-suite run can spend most of the default five seconds on module load
// (seen 2026-09-14: 6.6s and 5.4s). Twenty seconds still fails a hang.
vi.setConfig({ testTimeout: 20_000 })

const createServiceClientMock = vi.fn(() => {
  throw new Error('createServiceClient must not be called without a verified signature')
})
const recordEngagementEventMock = vi.fn(async () => {})

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: (...a: unknown[]) => createServiceClientMock(...(a as [])),
}))

vi.mock('@/lib/services/heat-mapping', () => ({
  recordEngagementEvent: (...a: unknown[]) => recordEngagementEventMock(...(a as [])),
}))

const SECRET = 'calendly-test-secret'
const ORIGINAL_SECRET = process.env.CALENDLY_WEBHOOK_SECRET

const BODY = JSON.stringify({
  event: 'invitee.created',
  payload: {
    uri: 'https://api.calendly.com/scheduled_events/abc/invitees/def',
    email: 'someone@example.com',
    name: 'Someone Example',
  },
})

function sign(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex')
  return `t=${ts},v1=${mac}`
}

function post(body: string, signature?: string): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (signature) headers.set('calendly-webhook-signature', signature)
  return new NextRequest('https://bloom.test/api/webhooks/calendly', {
    method: 'POST',
    headers,
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
  if (ORIGINAL_SECRET === undefined) delete process.env.CALENDLY_WEBHOOK_SECRET
  else process.env.CALENDLY_WEBHOOK_SECRET = ORIGINAL_SECRET
})

describe('POST /api/webhooks/calendly — CALENDLY_WEBHOOK_SECRET unset', () => {
  it('answers 503 and names the reason', async () => {
    delete process.env.CALENDLY_WEBHOOK_SECRET
    const { POST } = await import('../route')

    const res = await POST(post(BODY))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({ error: 'calendly_not_configured' })
  })

  it('refuses even a correctly signed delivery — there is nothing to verify against', async () => {
    delete process.env.CALENDLY_WEBHOOK_SECRET
    const { POST } = await import('../route')

    const res = await POST(post(BODY, sign(BODY)))

    expect(res.status).toBe(503)
  })

  it('never reaches the database or the heat map', async () => {
    delete process.env.CALENDLY_WEBHOOK_SECRET
    const { POST } = await import('../route')

    await POST(post(BODY))

    expect(createServiceClientMock).not.toHaveBeenCalled()
    expect(recordEngagementEventMock).not.toHaveBeenCalled()
  })

  it('refuses a body that is not valid JSON, without throwing', async () => {
    delete process.env.CALENDLY_WEBHOOK_SECRET
    const { POST } = await import('../route')

    const res = await POST(post('}{ not json'))

    expect(res.status).toBe(503)
  })
})

describe('POST /api/webhooks/calendly — secret set', () => {
  it('refuses a delivery with no signature header', async () => {
    process.env.CALENDLY_WEBHOOK_SECRET = SECRET
    const { POST } = await import('../route')

    const res = await POST(post(BODY))

    expect(res.status).toBe(401)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('refuses a signature made with the wrong secret', async () => {
    process.env.CALENDLY_WEBHOOK_SECRET = SECRET
    const { POST } = await import('../route')

    const res = await POST(post(BODY, sign(BODY, 'not-the-secret')))

    expect(res.status).toBe(401)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('refuses a stale signature outside the tolerance window', async () => {
    process.env.CALENDLY_WEBHOOK_SECRET = SECRET
    const { POST } = await import('../route')

    const stale = Math.floor(Date.now() / 1000) - 3600
    const res = await POST(post(BODY, sign(BODY, SECRET, stale)))

    expect(res.status).toBe(401)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })
})
