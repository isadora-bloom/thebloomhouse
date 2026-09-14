/**
 * S4a / 2026-09-14 ingestion audit item 3.
 *
 * An LLM reading an inbound body could emit `contract_signed` and the
 * writer would flip `weddings.status` to 'booked'. Anyone can type
 * "DocuSign: Completed". A booking now needs a row somewhere that is not
 * the message: a signed contract, a payment, or a coordinator's click.
 *
 * Everything below the booking line is deliberately unchanged, and these
 * tests say so — the fix must not quietly turn the loss signals or the
 * tour signals into proposals too.
 */

import { describe, it, expect } from 'vitest'
import {
  nextStatus,
  hasBookingCorroboration,
  type BookingCorroboration,
  type WeddingStatus,
} from '../wedding-lifecycle-engine'

const NONE: BookingCorroboration = {
  signedContract: false,
  paymentRow: false,
  coordinatorAction: false,
}

const PRE_BOOKING: WeddingStatus[] = [
  'inquiry',
  'tour_scheduled',
  'tour_completed',
  'proposal_sent',
]

describe('booking transitions need non-text corroboration', () => {
  for (const signal of ['contract_signed', 'deposit_paid'] as const) {
    it(`${signal} from text alone is a proposal, not a transition`, () => {
      for (const from of PRE_BOOKING) {
        const d = nextStatus(from, signal, { corroboration: NONE })
        expect(d).not.toBeNull()
        expect(d!.to).toBe('booked')
        expect(d!.requiresCorroboration).toBe(true)
      }
    })

    it(`${signal} with no options at all is still a proposal`, () => {
      const d = nextStatus('inquiry', signal)
      expect(d!.requiresCorroboration).toBe(true)
    })

    it(`${signal} applies directly when a signed contract exists`, () => {
      const d = nextStatus('proposal_sent', signal, {
        corroboration: { ...NONE, signedContract: true },
      })
      expect(d!.to).toBe('booked')
      expect(d!.requiresCorroboration).toBeUndefined()
    })

    it(`${signal} applies directly when a payment row exists`, () => {
      const d = nextStatus('tour_completed', signal, {
        corroboration: { ...NONE, paymentRow: true },
      })
      expect(d!.requiresCorroboration).toBeUndefined()
    })

    it(`${signal} applies directly on a coordinator action`, () => {
      const d = nextStatus('inquiry', signal, {
        corroboration: { ...NONE, coordinatorAction: true },
      })
      expect(d!.requiresCorroboration).toBeUndefined()
    })
  }

  it('does not resurrect a terminal wedding, corroborated or not', () => {
    for (const from of ['lost', 'cancelled', 'completed'] as WeddingStatus[]) {
      expect(
        nextStatus(from, 'contract_signed', {
          corroboration: { signedContract: true, paymentRow: true, coordinatorAction: true },
        }),
      ).toBeNull()
    }
  })
})

describe('lower transitions are untouched', () => {
  it('loss signals still apply directly from every pre-booking state', () => {
    for (const from of PRE_BOOKING) {
      for (const signal of ['lead_declined', 'going_with_other', 'silent_close'] as const) {
        const d = nextStatus(from, signal)
        expect(d!.to).toBe('lost')
        expect(d!.requiresCorroboration).toBeUndefined()
      }
    }
  })

  it('tour signals still apply directly', () => {
    expect(nextStatus('inquiry', 'tour_scheduled')!.to).toBe('tour_scheduled')
    expect(nextStatus('tour_scheduled', 'tour_completed')!.to).toBe('tour_completed')
    expect(nextStatus('tour_scheduled', 'tour_cancelled')!.to).toBe('inquiry')
    expect(nextStatus('inquiry', 'proposal_sent')!.to).toBe('proposal_sent')
  })

  it('post-booking signals still apply directly', () => {
    expect(nextStatus('booked', 'wedding_held')!.to).toBe('completed')
    expect(nextStatus('booked', 'wedding_cancelled')!.to).toBe('cancelled')
  })
})

describe('hasBookingCorroboration', () => {
  it('is false for nothing, null and undefined', () => {
    expect(hasBookingCorroboration(NONE)).toBe(false)
    expect(hasBookingCorroboration(null)).toBe(false)
    expect(hasBookingCorroboration(undefined)).toBe(false)
  })

  it('is true when any single source fires', () => {
    expect(hasBookingCorroboration({ ...NONE, signedContract: true })).toBe(true)
    expect(hasBookingCorroboration({ ...NONE, paymentRow: true })).toBe(true)
    expect(hasBookingCorroboration({ ...NONE, coordinatorAction: true })).toBe(true)
  })
})
