/**
 * Wave 3 W28 — the Instagram webhook route itself.
 *
 * The helpers are unit-tested next to the ingester; this file pins the
 * route's contract with Meta, which is the bit that is easy to get
 * subtly wrong:
 *
 *   - dry until credentials exist: 503, not a crash, not a 500
 *   - GET echoes hub.challenge as bare text, refuses a wrong token
 *   - POST verifies against the RAW bytes, before parsing
 *   - POST acknowledges with 200 for anything it cannot use, because
 *     Meta retries on non-2xx and escalates to disabling the webhook
 *
 * No network, no database. The connection lookup and the ingester are
 * mocked; nothing here can reach Supabase.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createHmac } from 'crypto'

const findConnectionMock = vi.fn()
const ingestMock = vi.fn()

vi.mock('@/lib/services/integrations/instagram-meta', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/services/integrations/instagram-meta')
  >()
  return {
    ...actual,
    findConnectionByIgBusinessId: (...a: unknown[]) => findConnectionMock(...a),
  }
})

vi.mock('@/lib/services/ingestion/instagram-dm', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/services/ingestion/instagram-dm')
  >()
  return {
    ...actual,
    ingestInstagramDm: (...a: unknown[]) => ingestMock(...a),
  }
})

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => ({}) }),
}))

const APP_SECRET = 'test-app-secret'
const VERIFY_TOKEN = 'test-verify-token'
const IG_BUSINESS_ID = '17841400000000001'

function setEnv(configured: boolean) {
  if (configured) {
    process.env.INSTAGRAM_APP_ID = 'app-id'
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET
    process.env.INSTAGRAM_VERIFY_TOKEN = VERIFY_TOKEN
  } else {
    delete process.env.INSTAGRAM_APP_ID
    delete process.env.INSTAGRAM_APP_SECRET
    delete process.env.INSTAGRAM_VERIFY_TOKEN
  }
}

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

function postRequest(body: string, signature: string | null): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (signature) headers.set('x-hub-signature-256', signature)
  return new NextRequest('https://bloom.test/api/webhooks/instagram', {
    method: 'POST',
    headers,
    body,
  })
}

function getRequest(query: Record<string, string>): NextRequest {
  const url = new URL('https://bloom.test/api/webhooks/instagram')
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return new NextRequest(url, { method: 'GET' })
}

const BODY = JSON.stringify({
  object: 'instagram',
  entry: [
    {
      id: IG_BUSINESS_ID,
      time: 1_757_000_000_000,
      messaging: [
        {
          sender: { id: '6789012345678901' },
          recipient: { id: IG_BUSINESS_ID },
          timestamp: 1_757_000_000_000,
          message: { mid: 'mid.ABC123', text: 'Is 12 September 2027 free?' },
        },
      ],
    },
  ],
})

beforeEach(() => {
  findConnectionMock.mockReset()
  ingestMock.mockReset()
  findConnectionMock.mockResolvedValue({
    connection: { venueId: 'venue-1' },
    pageToken: 'page-token',
  })
  ingestMock.mockResolvedValue({
    outcome: 'linked',
    externalId: 'instagram:dm:mid.ABC123',
    handleResolved: true,
    action: 'attached',
    matchedCoupleId: 'couple-1',
    reason: 'handle_exact',
  })
  setEnv(true)
})

afterEach(() => {
  setEnv(false)
  vi.restoreAllMocks()
})

describe('GET /api/webhooks/instagram', () => {
  it('returns 503 and names the missing env vars when not configured', async () => {
    setEnv(false)
    const { GET } = await import('../route')
    const resp = await GET(getRequest({ 'hub.mode': 'subscribe' }))
    expect(resp.status).toBe(503)
    const body = await resp.json()
    expect(body.error).toBe('instagram_not_configured')
    expect(body.missing).toEqual([
      'INSTAGRAM_APP_ID',
      'INSTAGRAM_APP_SECRET',
      'INSTAGRAM_VERIFY_TOKEN',
    ])
  })

  it('echoes the challenge as bare text when the token matches', async () => {
    const { GET } = await import('../route')
    const resp = await GET(
      getRequest({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      }),
    )
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('text/plain')
    expect(await resp.text()).toBe('1158201444')
  })

  it('refuses a wrong verify token with 403', async () => {
    const { GET } = await import('../route')
    const resp = await GET(
      getRequest({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': '1158201444',
      }),
    )
    expect(resp.status).toBe(403)
  })
})

describe('POST /api/webhooks/instagram', () => {
  it('returns 503 when not configured, without reading the body', async () => {
    setEnv(false)
    const { POST } = await import('../route')
    const resp = await POST(postRequest(BODY, sign(BODY)))
    expect(resp.status).toBe(503)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('accepts a correctly signed delivery and ingests it', async () => {
    const { POST } = await import('../route')
    const resp = await POST(postRequest(BODY, sign(BODY)))
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ received: true, ingested: 1 })
    expect(ingestMock).toHaveBeenCalledTimes(1)
    const args = ingestMock.mock.calls[0][0] as {
      venueId: string
      pageToken: string
      message: { mid: string }
    }
    expect(args.venueId).toBe('venue-1')
    expect(args.pageToken).toBe('page-token')
    expect(args.message.mid).toBe('mid.ABC123')
  })

  it('rejects a bad signature with 401 and ingests nothing', async () => {
    const { POST } = await import('../route')
    const resp = await POST(postRequest(BODY, sign(BODY, 'wrong-secret')))
    expect(resp.status).toBe(401)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('rejects a missing signature header with 401', async () => {
    const { POST } = await import('../route')
    const resp = await POST(postRequest(BODY, null))
    expect(resp.status).toBe(401)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('rejects a signature computed over a different body', async () => {
    const { POST } = await import('../route')
    const resp = await POST(postRequest(BODY, sign('{"object":"instagram"}')))
    expect(resp.status).toBe(401)
  })

  it('drops an event for an Instagram account no venue claims, still 200', async () => {
    findConnectionMock.mockResolvedValueOnce(null)
    const { POST } = await import('../route')
    const resp = await POST(postRequest(BODY, sign(BODY)))
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ received: true, dropped: 1 })
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('acknowledges a signed body that is not JSON rather than retrying forever', async () => {
    const junk = 'not json at all'
    const { POST } = await import('../route')
    const resp = await POST(postRequest(junk, sign(junk)))
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ received: true, parsed: false })
  })

  it('acknowledges an echo with nothing ingested', async () => {
    const echo = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: IG_BUSINESS_ID,
          messaging: [
            {
              sender: { id: IG_BUSINESS_ID },
              recipient: { id: '6789012345678901' },
              message: { mid: 'mid.OUT', text: 'thanks!', is_echo: true },
            },
          ],
        },
      ],
    })
    const { POST } = await import('../route')
    const resp = await POST(postRequest(echo, sign(echo)))
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ received: true, ingested: 0 })
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('one failing message does not cost the rest of the batch', async () => {
    const two = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: IG_BUSINESS_ID,
          messaging: [
            {
              sender: { id: 'a' },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 1,
              message: { mid: 'mid.1', text: 'one' },
            },
            {
              sender: { id: 'b' },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 2,
              message: { mid: 'mid.2', text: 'two' },
            },
          ],
        },
      ],
    })
    ingestMock.mockRejectedValueOnce(new Error('boom'))
    const { POST } = await import('../route')
    const resp = await POST(postRequest(two, sign(two)))
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ received: true, ingested: 1, dropped: 1 })
    expect(ingestMock).toHaveBeenCalledTimes(2)
  })

  it('looks the connection up once per account, not once per message', async () => {
    const two = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: IG_BUSINESS_ID,
          messaging: [
            {
              sender: { id: 'a' },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 1,
              message: { mid: 'mid.1', text: 'one' },
            },
            {
              sender: { id: 'a' },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 2,
              message: { mid: 'mid.2', text: 'two' },
            },
          ],
        },
      ],
    })
    const { POST } = await import('../route')
    await POST(postRequest(two, sign(two)))
    expect(findConnectionMock).toHaveBeenCalledTimes(1)
  })
})
