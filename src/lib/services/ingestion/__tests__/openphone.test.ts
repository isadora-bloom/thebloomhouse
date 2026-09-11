/**
 * Wave 4 W30 — the chokepoint SMS uses to write an inbound `interactions`
 * row and trigger classification, now generalised (a `logPrefix` /
 * `allowMint` seam) so Instagram DMs (instagram-dm.ts) route through the
 * same function instead of a new `.insert('interactions')` site.
 *
 * No network: the classifier, mintWedding and recordEngagementEvent are
 * all mocked. The Supabase client is a hand-rolled stub that records
 * what was asked of it, same style as instagram-dm.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeInboundInteractionAndClassify } from '../openphone'
import type { InboundInteractionRow } from '../openphone'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const classifyInboundIntentMock = vi.fn()
vi.mock('@/lib/services/intel/inbound-intent-classifier', () => ({
  classifyInboundIntent: (...args: unknown[]) => classifyInboundIntentMock(...args),
}))

const mintWeddingMock = vi.fn()
vi.mock('@/lib/services/identity/mint-wedding', () => ({
  mintWedding: (...args: unknown[]) => mintWeddingMock(...args),
}))

const recordEngagementEventMock = vi.fn()
vi.mock('@/lib/services/heat-mapping', () => ({
  recordEngagementEvent: (...args: unknown[]) => recordEngagementEventMock(...args),
}))

interface RecordedCall {
  table: string
  op: 'insert' | 'update' | 'select'
  payload?: unknown
}

/** Minimal Supabase stub: from(table).insert(payload).select().maybeSingle()
 *  and from(table).update(payload).eq(...). Records every call so tests
 *  can assert on the exact row shape written. */
function makeFakeSupabase(
  opts: { insertId?: string | null; insertError?: { message: string } | null } = {},
) {
  const calls: RecordedCall[] = []
  const chain = (table: string) => {
    const self: Record<string, unknown> = {}
    let op: 'insert' | 'update' | 'select' | null = null
    self.insert = (payload: unknown) => {
      op = 'insert'
      calls.push({ table, op: 'insert', payload })
      return self
    }
    self.update = (payload: unknown) => {
      op = 'update'
      calls.push({ table, op: 'update', payload })
      return self
    }
    self.select = (..._a: unknown[]) => {
      if (op !== 'insert') op = 'select'
      return self
    }
    self.eq = () => self
    self.maybeSingle = async () => {
      if (table === 'interactions' && op === 'insert') {
        if (opts.insertError) return { data: null, error: opts.insertError }
        return { data: { id: opts.insertId ?? 'interaction-1' }, error: null }
      }
      return { data: null, error: null }
    }
    return self
  }
  return {
    from: (table: string) => chain(table),
    __calls: calls,
  } as unknown as Parameters<typeof writeInboundInteractionAndClassify>[0]['supabase'] & {
    __calls: RecordedCall[]
  }
}

function smsRow(overrides: Partial<InboundInteractionRow> = {}): InboundInteractionRow {
  return {
    person_id: 'person-1',
    wedding_id: 'wedding-1',
    type: 'sms',
    direction: 'inbound',
    subject: 'SMS from 5551234567',
    body_preview: 'Hi there',
    full_body: 'Hi there',
    from_email: '5551234567',
    from_name: null,
    timestamp: '2026-09-01T00:00:00.000Z',
    signal_class: 'touchpoint',
    surface: 'voice_capture',
    author_class: 'couple',
    extracted_identity: { emails: [], phones: [], names: [] },
    ...overrides,
  }
}

const FALLBACK_VERDICT = {
  intent_class: 'client_logistics',
  referenced_couple_name: null,
  note: null,
  confidence: 70,
  extracted_facts: null,
  signals: {},
}

beforeEach(() => {
  classifyInboundIntentMock.mockReset()
  classifyInboundIntentMock.mockResolvedValue(FALLBACK_VERDICT)
  mintWeddingMock.mockReset()
  recordEngagementEventMock.mockReset()
  recordEngagementEventMock.mockReturnValue({ catch: () => {} })
  // recordEngagementEvent is called with `void ...catch(...)` in the
  // chokepoint, so the mock needs a thenable-ish shape with .catch.
  recordEngagementEventMock.mockImplementation(() =>
    Promise.resolve({ heatScore: 0, tier: 'cold' }),
  )
})

// ---------------------------------------------------------------------------
// 1. Row-shape parity — the SMS row is unchanged by the extraction
// ---------------------------------------------------------------------------

describe('writeInboundInteractionAndClassify — row shape', () => {
  it('writes the same interactions row SMS has always written', async () => {
    const supabase = makeFakeSupabase()
    const result = await writeInboundInteractionAndClassify({
      supabase,
      venueId: 'venue-1',
      row: smsRow(),
      logPrefix: 'openphone',
      externalMessageId: 'msg-1',
      allowMint: true,
      mintSource: 'sms_inbound',
      mintSignals: { email: null, phone: '5551234567' },
    })

    const insertCall = supabase.__calls.find(
      (c) => c.table === 'interactions' && c.op === 'insert',
    )
    expect(insertCall).toBeTruthy()
    expect(insertCall!.payload).toMatchObject({
      venue_id: 'venue-1',
      person_id: 'person-1',
      wedding_id: 'wedding-1',
      type: 'sms',
      direction: 'inbound',
      subject: 'SMS from 5551234567',
      body_preview: 'Hi there',
      full_body: 'Hi there',
      from_email: '5551234567',
      from_name: null,
      timestamp: '2026-09-01T00:00:00.000Z',
      signal_class: 'touchpoint',
      surface: 'voice_capture',
      author_class: 'couple',
    })
    expect(result.interactionId).toBe('interaction-1')
  })

  it('returns a null interactionId and never classifies when the insert fails', async () => {
    const supabase = makeFakeSupabase({ insertError: { message: 'db down' } })
    const result = await writeInboundInteractionAndClassify({
      supabase,
      venueId: 'venue-1',
      row: smsRow(),
      logPrefix: 'openphone',
      externalMessageId: 'msg-2',
      allowMint: true,
    })
    expect(result.interactionId).toBeNull()
    expect(classifyInboundIntentMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2. Classifier trigger
// ---------------------------------------------------------------------------

describe('writeInboundInteractionAndClassify — classifier', () => {
  it('runs the inbound-intent classifier exactly once for an inbound row, tagged sms', async () => {
    const supabase = makeFakeSupabase()
    const result = await writeInboundInteractionAndClassify({
      supabase,
      venueId: 'venue-1',
      row: smsRow(),
      logPrefix: 'openphone',
      externalMessageId: 'msg-3',
      allowMint: true,
    })
    expect(classifyInboundIntentMock).toHaveBeenCalledTimes(1)
    const args = classifyInboundIntentMock.mock.calls[0][0] as {
      interactionId: string
      channel: string
      body: string
      venueId: string
    }
    expect(args.channel).toBe('sms')
    expect(args.interactionId).toBe('interaction-1')
    expect(args.body).toBe('Hi there')
    expect(args.venueId).toBe('venue-1')
    expect(result.intentClass).toBe('client_logistics')
  })

  it('never classifies an outbound row', async () => {
    const supabase = makeFakeSupabase()
    await writeInboundInteractionAndClassify({
      supabase,
      venueId: 'venue-1',
      row: smsRow({ direction: 'outbound', subject: 'SMS to 5551234567' }),
      logPrefix: 'openphone',
      externalMessageId: 'msg-4',
      allowMint: true,
    })
    expect(classifyInboundIntentMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. Classifier-gated mint
// ---------------------------------------------------------------------------

describe('writeInboundInteractionAndClassify — mint gate', () => {
  it('mints when allowMint is true, the signal is reachable, and the verdict is new_inquiry', async () => {
    classifyInboundIntentMock.mockResolvedValue({
      ...FALLBACK_VERDICT,
      intent_class: 'new_inquiry',
    })
    mintWeddingMock.mockResolvedValue({
      weddingId: 'wedding-new',
      personId: 'person-new',
      isNew: true,
      resolvedVia: 'created_new',
    })
    const supabase = makeFakeSupabase()
    const result = await writeInboundInteractionAndClassify({
      supabase,
      venueId: 'venue-1',
      row: smsRow({ wedding_id: null }),
      logPrefix: 'openphone',
      externalMessageId: 'msg-5',
      allowMint: true,
      mintSource: 'sms_inbound',
      mintSignals: { email: null, phone: '5551234567' },
      postMintHeatEventType: 'sms_received',
      postMintHeatMetadata: { source: 'openphone', channel: 'sms' },
    })
    expect(mintWeddingMock).toHaveBeenCalledTimes(1)
    expect(result.weddingId).toBe('wedding-new')
    const updateCall = supabase.__calls.find(
      (c) => c.table === 'interactions' && c.op === 'update',
    )
    expect(updateCall?.payload).toMatchObject({ wedding_id: 'wedding-new' })
    expect(recordEngagementEventMock).toHaveBeenCalledTimes(1)
  })

  it('never mints when allowMint is false, even for a new_inquiry verdict (the Instagram case)', async () => {
    classifyInboundIntentMock.mockResolvedValue({
      ...FALLBACK_VERDICT,
      intent_class: 'new_inquiry',
    })
    const supabase = makeFakeSupabase()
    const result = await writeInboundInteractionAndClassify({
      supabase,
      venueId: 'venue-1',
      row: smsRow({ wedding_id: null, type: 'sms' }),
      logPrefix: 'instagram-dm',
      externalMessageId: 'instagram:dm:mid.1',
      allowMint: false,
    })
    expect(mintWeddingMock).not.toHaveBeenCalled()
    expect(result.weddingId).toBeNull()
  })

  it('never mints when weddingId is already set, whatever the verdict', async () => {
    classifyInboundIntentMock.mockResolvedValue({
      ...FALLBACK_VERDICT,
      intent_class: 'new_inquiry',
    })
    const supabase = makeFakeSupabase()
    const result = await writeInboundInteractionAndClassify({
      supabase,
      venueId: 'venue-1',
      row: smsRow({ wedding_id: 'wedding-existing' }),
      logPrefix: 'openphone',
      externalMessageId: 'msg-6',
      allowMint: true,
      mintSource: 'sms_inbound',
      mintSignals: { email: null, phone: '5551234567' },
    })
    expect(mintWeddingMock).not.toHaveBeenCalled()
    expect(result.weddingId).toBe('wedding-existing')
  })
})
