/**
 * Wave 3 W28 — Instagram DM ingestion.
 *
 * Covers the five things the brief pins:
 *   1. signature verification: valid, invalid, missing
 *   2. the challenge handshake
 *   3. event to signal mapping, with and without the username lookup
 *      succeeding
 *   4. idempotency on repeated mids
 *   5. the interaction row the SMS path would write
 *
 * No network. The Graph lookup takes an injected fetch, and the Supabase
 * client is a hand-rolled stub that records what was asked of it. The
 * spine is never touched: linkSignal is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildInstagramDmSignal,
  buildInstagramInteractionRow,
  ingestInstagramDm,
  instagramDmExternalId,
  parseInstagramWebhook,
  type InstagramInboundMessage,
} from '../instagram-dm'
import {
  checkVerifyHandshake,
  verifyMetaSignature,
} from '@/lib/services/integrations/instagram-meta'
import { createHmac } from 'crypto'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const linkSignalMock = vi.fn()

vi.mock('@/lib/spine/cascade', () => ({
  linkSignal: (...args: unknown[]) => linkSignalMock(...args),
}))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => makeSupabaseStub({ existingTouchpoint: false }),
}))

/**
 * Minimal Supabase stub. Only the chain instagram-dm actually uses:
 *   from(table).select(cols).eq(..).eq(..).eq(..).limit(n).maybeSingle()
 * and from(table).update(obj).eq(..)
 */
function makeSupabaseStub(opts: {
  existingTouchpoint?: boolean
  existingFragment?: boolean
  onSelect?: (table: string) => void
}) {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {}
    const passthrough = () => self
    self.select = (..._a: unknown[]) => {
      opts.onSelect?.(table)
      return self
    }
    self.eq = passthrough
    self.limit = passthrough
    self.update = passthrough
    self.maybeSingle = async () => {
      if (table === 'touchpoints' && opts.existingTouchpoint) {
        return { data: { id: 'tp-1' }, error: null }
      }
      if (table === 'fragments' && opts.existingFragment) {
        return { data: { id: 'fr-1' }, error: null }
      }
      return { data: null, error: null }
    }
    return self
  }
  return { from: (table: string) => chain(table) } as never
}

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 400,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof fetch
}

function fetchThatThrows(): typeof fetch {
  return (async () => {
    throw new Error('network down')
  }) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IG_BUSINESS_ID = '17841400000000001'
const SENDER_IGSID = '6789012345678901'

function metaBody(overrides?: {
  mid?: string
  text?: string
  timestamp?: number
  isEcho?: boolean
  object?: string
}) {
  return {
    object: overrides?.object ?? 'instagram',
    entry: [
      {
        id: IG_BUSINESS_ID,
        time: 1_757_000_000_000,
        messaging: [
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: IG_BUSINESS_ID },
            timestamp: overrides?.timestamp ?? 1_757_000_000_000,
            message: {
              mid: overrides?.mid ?? 'mid.ABC123',
              text: overrides?.text ?? 'Hi! Is 12 September 2027 still free?',
              ...(overrides?.isEcho ? { is_echo: true } : {}),
            },
          },
        ],
      },
    ],
  }
}

function inboundMessage(
  overrides: Partial<InstagramInboundMessage> = {},
): InstagramInboundMessage {
  return {
    mid: 'mid.ABC123',
    senderIgsid: SENDER_IGSID,
    recipientId: IG_BUSINESS_ID,
    igBusinessId: IG_BUSINESS_ID,
    text: 'Hi! Is 12 September 2027 still free?',
    timestampMs: 1_757_000_000_000,
    attachmentTypes: [],
    isEcho: false,
    ...overrides,
  }
}

beforeEach(() => {
  linkSignalMock.mockReset()
  linkSignalMock.mockResolvedValue({
    action: 'fragment',
    matched_couple_id: null,
    tier: null,
    matcher_score: null,
    judge_invoked: false,
    judge_outcome: null,
    touchpoint_id: null,
    candidate_match_queued: false,
    reason: 'identity-poor',
    duplicate: false,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Signature verification
// ---------------------------------------------------------------------------

describe('verifyMetaSignature', () => {
  const secret = 'app-secret-value'
  const body = JSON.stringify(metaBody())
  const good = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`

  it('accepts a signature computed over the exact body', () => {
    expect(verifyMetaSignature(body, good, secret)).toBe(true)
  })

  it('rejects a signature for a different body', () => {
    const other = createHmac('sha256', secret).update('{}', 'utf8').digest('hex')
    expect(verifyMetaSignature(body, `sha256=${other}`, secret)).toBe(false)
  })

  it('rejects a signature made with the wrong secret', () => {
    const wrong = createHmac('sha256', 'not-the-secret')
      .update(body, 'utf8')
      .digest('hex')
    expect(verifyMetaSignature(body, `sha256=${wrong}`, secret)).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(verifyMetaSignature(body, null, secret)).toBe(false)
  })

  it('rejects a header without the sha256= prefix', () => {
    expect(verifyMetaSignature(body, good.slice('sha256='.length), secret)).toBe(false)
  })

  it('rejects a header that is not hex', () => {
    expect(verifyMetaSignature(body, 'sha256=not-hex-at-all', secret)).toBe(false)
  })

  it('rejects when the app secret is empty', () => {
    expect(verifyMetaSignature(body, good, '')).toBe(false)
  })

  it('is not fooled by a truncated but matching prefix', () => {
    const truncated = `sha256=${good.slice('sha256='.length, -2)}`
    expect(verifyMetaSignature(body, truncated, secret)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Challenge handshake
// ---------------------------------------------------------------------------

describe('checkVerifyHandshake', () => {
  const token = 'verify-token-value'

  function params(overrides: Record<string, string> = {}) {
    return new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': token,
      'hub.challenge': '1158201444',
      ...overrides,
    })
  }

  it('echoes the challenge when the token matches', () => {
    expect(checkVerifyHandshake(params(), token)).toBe('1158201444')
  })

  it('refuses a wrong token', () => {
    expect(checkVerifyHandshake(params({ 'hub.verify_token': 'nope' }), token)).toBeNull()
  })

  it('refuses a token of a different length without throwing', () => {
    expect(checkVerifyHandshake(params({ 'hub.verify_token': 'x' }), token)).toBeNull()
  })

  it('refuses a mode other than subscribe', () => {
    expect(checkVerifyHandshake(params({ 'hub.mode': 'unsubscribe' }), token)).toBeNull()
  })

  it('refuses when the challenge is absent', () => {
    const p = params()
    p.delete('hub.challenge')
    expect(checkVerifyHandshake(p, token)).toBeNull()
  })

  it('refuses when no token is configured', () => {
    expect(checkVerifyHandshake(params(), '')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3a. Webhook parsing
// ---------------------------------------------------------------------------

describe('parseInstagramWebhook', () => {
  it('lifts one inbound message out of the envelope', () => {
    const messages = parseInstagramWebhook(metaBody())
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      mid: 'mid.ABC123',
      senderIgsid: SENDER_IGSID,
      igBusinessId: IG_BUSINESS_ID,
      text: 'Hi! Is 12 September 2027 still free?',
      timestampMs: 1_757_000_000_000,
    })
  })

  it('ignores an object that is not instagram', () => {
    expect(parseInstagramWebhook(metaBody({ object: 'page' }))).toHaveLength(0)
  })

  it('skips echoes of our own outbound', () => {
    expect(parseInstagramWebhook(metaBody({ isEcho: true }))).toHaveLength(0)
  })

  it('skips a message whose sender is the business account itself', () => {
    const body = metaBody()
    body.entry[0].messaging[0].sender.id = IG_BUSINESS_ID
    expect(parseInstagramWebhook(body)).toHaveLength(0)
  })

  it('skips read receipts and reactions, which carry no mid', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: IG_BUSINESS_ID,
          messaging: [
            { sender: { id: SENDER_IGSID }, read: { mid: 'mid.X' } },
            { sender: { id: SENDER_IGSID }, reaction: { emoji: '❤' } },
          ],
        },
      ],
    }
    expect(parseInstagramWebhook(body)).toHaveLength(0)
  })

  it('keeps attachment types when a DM carries no text', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: IG_BUSINESS_ID,
          messaging: [
            {
              sender: { id: SENDER_IGSID },
              recipient: { id: IG_BUSINESS_ID },
              timestamp: 1_757_000_000_000,
              message: {
                mid: 'mid.IMG',
                attachments: [{ type: 'image', payload: { url: 'https://x' } }],
              },
            },
          ],
        },
      ],
    }
    const messages = parseInstagramWebhook(body)
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toBe('')
    expect(messages[0].attachmentTypes).toEqual(['image'])
  })

  it('survives junk without throwing', () => {
    expect(parseInstagramWebhook(null)).toEqual([])
    expect(parseInstagramWebhook('nope')).toEqual([])
    expect(parseInstagramWebhook({ object: 'instagram' })).toEqual([])
    expect(parseInstagramWebhook({ object: 'instagram', entry: [null, 3] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3b. Event to signal mapping
// ---------------------------------------------------------------------------

describe('buildInstagramDmSignal', () => {
  it('sets handles.instagram when the lookup succeeded', () => {
    const signal = buildInstagramDmSignal({
      message: inboundMessage(),
      username: '@Rosie.Hoyle',
      profileName: 'Rosie Hoyle',
    })
    expect(signal.channel).toBe('instagram')
    expect(signal.action_type).toBe('dm')
    expect(signal.external_id).toBe('instagram:dm:mid.ABC123')
    expect(signal.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(signal.primary_name).toBe('Rosie Hoyle')
    expect(signal.identity_hint).toBe('Rosie Hoyle')
    expect(signal.occurred_at).toBe(new Date(1_757_000_000_000).toISOString())
    expect(signal.raw_payload.full_body).toBe('Hi! Is 12 September 2027 still free?')
    expect(signal.raw_payload.sender_igsid).toBe(SENDER_IGSID)
    expect(signal.raw_payload.handle_lookup_ok).toBe(true)
  })

  it('normalises a profile URL into a bare handle', () => {
    const signal = buildInstagramDmSignal({
      message: inboundMessage(),
      username: 'https://instagram.com/Rosie.Hoyle/',
      profileName: null,
    })
    expect(signal.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('leaves handles null and keeps the IGSID when the lookup failed', () => {
    const signal = buildInstagramDmSignal({
      message: inboundMessage(),
      username: null,
      profileName: null,
    })
    expect(signal.handles).toBeNull()
    expect(signal.raw_payload.sender_igsid).toBe(SENDER_IGSID)
    expect(signal.raw_payload.handle_lookup_ok).toBe(false)
    expect(signal.identity_hint).toBeNull()
  })

  it('never invents a handle from a username our normaliser rejects', () => {
    const signal = buildInstagramDmSignal({
      message: inboundMessage(),
      username: 'not a valid handle!!',
      profileName: 'Someone',
    })
    expect(signal.handles).toBeNull()
    // The raw value survives for forensics even though it was rejected.
    expect(signal.raw_payload.raw_username).toBe('not a valid handle!!')
    // And the name still corroborates, because a display name is allowed
    // to be a hint even when it cannot attach on its own.
    expect(signal.identity_hint).toBe('Someone')
  })

  it('falls back to now when Meta sent no timestamp', () => {
    const before = Date.now()
    const signal = buildInstagramDmSignal({
      message: inboundMessage({ timestampMs: null }),
      username: null,
      profileName: null,
    })
    const at = new Date(signal.occurred_at).getTime()
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('marks the author as the couple and the tier as high', () => {
    const signal = buildInstagramDmSignal({
      message: inboundMessage(),
      username: 'rosie.hoyle',
      profileName: null,
    })
    expect(signal.author_class).toBe('couple')
    expect(signal.signal_tier).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// 4. Ingestion, lookup and idempotency
// ---------------------------------------------------------------------------

describe('ingestInstagramDm', () => {
  it('resolves the username through the Graph lookup and links', async () => {
    const supabase = makeSupabaseStub({})
    const result = await ingestInstagramDm({
      supabase,
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage(),
      fetchImpl: fetchReturning({ username: 'rosie.hoyle', name: 'Rosie Hoyle' }),
    })
    expect(result.outcome).toBe('linked')
    expect(result.handleResolved).toBe(true)
    expect(linkSignalMock).toHaveBeenCalledTimes(1)
    const passed = linkSignalMock.mock.calls[0][0] as {
      signal: { handles: unknown; external_id: string }
      source: string
    }
    expect(passed.signal.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(passed.signal.external_id).toBe('instagram:dm:mid.ABC123')
    expect(passed.source).toBe('live:instagram_dm')
  })

  it('links with handles null when the Graph lookup fails', async () => {
    const supabase = makeSupabaseStub({})
    const result = await ingestInstagramDm({
      supabase,
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage(),
      fetchImpl: fetchReturning({ error: { message: 'bad token' } }, false),
    })
    expect(result.outcome).toBe('linked')
    expect(result.handleResolved).toBe(false)
    const passed = linkSignalMock.mock.calls[0][0] as {
      signal: { handles: unknown; raw_payload: Record<string, unknown> }
    }
    expect(passed.signal.handles).toBeNull()
    expect(passed.signal.raw_payload.sender_igsid).toBe(SENDER_IGSID)
  })

  it('links with handles null when the Graph call throws', async () => {
    const supabase = makeSupabaseStub({})
    const result = await ingestInstagramDm({
      supabase,
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage(),
      fetchImpl: fetchThatThrows(),
    })
    expect(result.outcome).toBe('linked')
    expect(result.handleResolved).toBe(false)
  })

  it('skips the lookup entirely when there is no page token', async () => {
    const supabase = makeSupabaseStub({})
    const fetchImpl = vi.fn()
    const result = await ingestInstagramDm({
      supabase,
      venueId: 'venue-1',
      pageToken: null,
      message: inboundMessage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.handleResolved).toBe(false)
    expect(result.outcome).toBe('linked')
  })

  it('is idempotent on a repeated mid: the second delivery never reaches linkSignal', async () => {
    // First delivery: nothing on the spine yet.
    const fresh = makeSupabaseStub({})
    const first = await ingestInstagramDm({
      supabase: fresh,
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage(),
      fetchImpl: fetchReturning({ username: 'rosie.hoyle', name: 'Rosie Hoyle' }),
    })
    expect(first.outcome).toBe('linked')
    expect(linkSignalMock).toHaveBeenCalledTimes(1)

    // Meta redelivers the same mid. The touchpoint now exists.
    const seen = makeSupabaseStub({ existingTouchpoint: true })
    const lookup = vi.fn()
    const second = await ingestInstagramDm({
      supabase: seen,
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage(),
      fetchImpl: lookup as unknown as typeof fetch,
    })
    expect(second.outcome).toBe('duplicate')
    expect(second.externalId).toBe('instagram:dm:mid.ABC123')
    // No second Graph call, no second link.
    expect(lookup).not.toHaveBeenCalled()
    expect(linkSignalMock).toHaveBeenCalledTimes(1)
  })

  it('treats an existing fragment as seen too', async () => {
    const seen = makeSupabaseStub({ existingFragment: true })
    const result = await ingestInstagramDm({
      supabase: seen,
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage(),
      fetchImpl: fetchReturning({ username: 'rosie.hoyle', name: null }),
    })
    expect(result.outcome).toBe('duplicate')
    expect(linkSignalMock).not.toHaveBeenCalled()
  })

  it('passes a duplicate verdict from linkSignal straight through', async () => {
    linkSignalMock.mockResolvedValueOnce({
      action: 'duplicate',
      matched_couple_id: null,
      tier: null,
      matcher_score: null,
      judge_invoked: false,
      judge_outcome: null,
      touchpoint_id: null,
      candidate_match_queued: false,
      reason: 'external_id seen',
      duplicate: true,
    })
    const result = await ingestInstagramDm({
      supabase: makeSupabaseStub({}),
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage(),
      fetchImpl: fetchReturning({ username: 'rosie.hoyle', name: null }),
    })
    expect(result.outcome).toBe('duplicate')
  })

  it('skips a message with neither text nor attachment', async () => {
    const result = await ingestInstagramDm({
      supabase: makeSupabaseStub({}),
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage({ text: '', attachmentTypes: [] }),
      fetchImpl: fetchReturning({}),
    })
    expect(result.outcome).toBe('skipped_empty')
    expect(linkSignalMock).not.toHaveBeenCalled()
  })

  it('never throws when linkSignal fails', async () => {
    linkSignalMock.mockRejectedValueOnce(new Error('cascade exploded'))
    const result = await ingestInstagramDm({
      supabase: makeSupabaseStub({}),
      venueId: 'venue-1',
      pageToken: 'page-token',
      message: inboundMessage(),
      fetchImpl: fetchReturning({ username: 'rosie.hoyle', name: null }),
    })
    expect(result.outcome).toBe('failed')
    expect(result.reason).toContain('cascade exploded')
  })
})

// ---------------------------------------------------------------------------
// 5. The interaction row (built, not yet wired — see the file header)
// ---------------------------------------------------------------------------

describe('buildInstagramInteractionRow', () => {
  it('uses the nearest existing type vocabulary and the voice_capture surface', () => {
    const row = buildInstagramInteractionRow({
      venueId: 'venue-1',
      message: inboundMessage(),
      username: 'rosie.hoyle',
      profileName: 'Rosie Hoyle',
    })
    // interactions.type has no 'dm' value as of migration 230, so the
    // nearest existing one is 'sms'.
    expect(row.type).toBe('sms')
    expect(row.surface).toBe('voice_capture')
    expect(row.direction).toBe('inbound')
    expect(row.author_class).toBe('couple')
    expect(row.signal_class).toBe('touchpoint')
    expect(row.subject).toBe('Instagram DM from @rosie.hoyle')
    expect(row.from_email).toBe('@rosie.hoyle')
    expect(row.from_name).toBe('Rosie Hoyle')
  })

  it('names the sender by the IGSID when no handle and no profile name resolved', () => {
    const row = buildInstagramInteractionRow({
      venueId: 'venue-1',
      message: inboundMessage(),
      username: null,
      profileName: null,
    })
    expect(row.subject).toBe(`Instagram DM from ${SENDER_IGSID}`)
    expect(row.from_email).toBeNull()
  })
})

describe('instagramDmExternalId', () => {
  it('is the one place the id shape is decided', () => {
    expect(instagramDmExternalId('mid.XYZ')).toBe('instagram:dm:mid.XYZ')
  })
})
