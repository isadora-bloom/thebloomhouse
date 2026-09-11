/**
 * W25 (NOVEMBER-PLAN.md wave 3) — email-to-signal handle carry-through.
 * HANDLE-IDENTITY-SPEC.md §4: the signal's `handles` field is always
 * re-normalised through `normalizeHandle()`, so a caller that forwards
 * raw @handle strings (or junk) never lands it unclean on the signal.
 */
import { describe, it, expect } from 'vitest'
import { emailToNormalizedSignal } from '../email-to-signal'

const baseInput = {
  email: { messageId: 'msg-1', threadId: 'thread-1', subject: 'Inquiry' },
  interactionId: 'interaction-1',
  emailDate: '2026-06-01T00:00:00.000Z',
  rawFromEmail: 'rosie@example.com',
  rawFromName: 'Rosie Hoyle',
}

describe('emailToNormalizedSignal — handles (Wave 3)', () => {
  it('normalises a raw @handle before it lands on the signal', () => {
    const signal = emailToNormalizedSignal({
      ...baseInput,
      handles: { instagram: '@Rosie.Hoyle' },
    })
    expect(signal.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('drops a malformed handle silently — signal.handles is null, not the junk', () => {
    const signal = emailToNormalizedSignal({
      ...baseInput,
      handles: { instagram: 'not a handle at all!!' },
    })
    expect(signal.handles).toBeNull()
  })

  it('omitted handles input: byte-identical to pre-Wave-3 shape (null)', () => {
    const signal = emailToNormalizedSignal(baseInput)
    expect(signal.handles).toBeNull()
  })

  it('carries a multi-platform map through, each entry normalised independently', () => {
    const signal = emailToNormalizedSignal({
      ...baseInput,
      handles: { instagram: '@rosie.hoyle', tiktok: 'not valid !!' },
    })
    expect(signal.handles).toEqual({ instagram: 'rosie.hoyle' })
  })
})
