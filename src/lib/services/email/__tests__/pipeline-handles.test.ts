/**
 * W29 (NOVEMBER-PLAN.md wave 4) — a handle in an email body reaches the
 * couple. HANDLE-IDENTITY-SPEC.md §4.
 *
 * Wave 3 built the parts: `NormalizedSignal.handles`, the `handles` argument
 * on `emailToNormalizedSignal`, and `stampHandlesAndFirstSeen` inside the
 * linker. The live email pipeline passed none of it. These tests pin the
 * three things W29 added:
 *
 *   1. the direction rule — only an inbound email speaks for the couple;
 *   2. what the deterministic URL parse will and will not accept;
 *   3. the end of the journey, with a fake client: signal → stamp →
 *      `couples.handles`.
 */
import { describe, it, expect } from 'vitest'
import { handlesForEmailSignal } from '../pipeline'
import { emailToNormalizedSignal } from '@/lib/services/identity/email-to-signal'
import { stampHandlesAndFirstSeen } from '@/lib/services/identity/route-by-tier'
import { FakeSpineDb } from '@/lib/services/__tests__/fake-spine-db'

const IG_URL = 'https://www.instagram.com/rosie.hoyle/'

function inboundSignal(body: string) {
  return emailToNormalizedSignal({
    email: { messageId: 'msg-1', threadId: 'thread-1', subject: 'Our wedding' },
    interactionId: 'interaction-1',
    emailDate: '2026-06-01T10:00:00.000Z',
    rawFromName: 'Rosie Hoyle',
    rawFromEmail: 'rosie@example.com',
    handles: handlesForEmailSignal({ direction: 'inbound', body }),
  })
}

describe('handlesForEmailSignal — the direction rule', () => {
  it('an inbound email carrying an Instagram profile URL yields handles.instagram', () => {
    const body = `Hi! We loved the tour.\n\nRosie\n${IG_URL}`
    expect(handlesForEmailSignal({ direction: 'inbound', body }))
      .toEqual({ instagram: 'rosie.hoyle' })
  })

  it('a venue-sent email with the same URL yields nothing', () => {
    const body = `Lovely to meet you!\n\nRixey Manor\n${IG_URL}`
    expect(handlesForEmailSignal({ direction: 'outbound', body })).toBeNull()
  })

  it('a URL that only appears in the quoted reply chain is not the sender speaking', () => {
    const body = [
      'Sounds great, see you Saturday.',
      '',
      'On Mon, 1 Jun 2026 at 09:00, Hawthorne Manor <hello@hawthorne.example> wrote:',
      `> Follow us on Instagram: ${IG_URL}`,
    ].join('\n')
    expect(handlesForEmailSignal({ direction: 'inbound', body })).toBeNull()
  })

  it('an empty or missing body yields nothing', () => {
    expect(handlesForEmailSignal({ direction: 'inbound', body: '' })).toBeNull()
    expect(handlesForEmailSignal({ direction: 'inbound', body: null })).toBeNull()
    expect(handlesForEmailSignal({ direction: 'inbound' })).toBeNull()
  })
})

describe('handlesForEmailSignal — URL shapes that are not people', () => {
  it('a post permalink does not become the handle "p"', () => {
    const body = 'Look at this: https://www.instagram.com/p/Cx1y2z3AbCd/'
    expect(handlesForEmailSignal({ direction: 'inbound', body })).toBeNull()
  })

  it('a Knot marketplace listing does not become the handle "marketplace"', () => {
    const body = 'Enquiry via https://www.theknot.com/marketplace/rixey-manor-rixeyville-va-123456'
    expect(handlesForEmailSignal({ direction: 'inbound', body })).toBeNull()
  })

  it('a Facebook share link does not become the handle "sharer"', () => {
    const body = 'Shared: https://www.facebook.com/sharer/sharer.php?u=example.com'
    expect(handlesForEmailSignal({ direction: 'inbound', body })).toBeNull()
  })

  it('a real profile URL alongside a post link still yields the profile', () => {
    const body = `${IG_URL}\nand https://www.tiktok.com/@the.hoyles`
    expect(handlesForEmailSignal({ direction: 'inbound', body }))
      .toEqual({ instagram: 'rosie.hoyle', tiktok: 'the.hoyles' })
  })
})

describe('emailToNormalizedSignal — what the pipeline hands the linker', () => {
  it('an inbound email produces a signal with handles.instagram', () => {
    const signal = inboundSignal(`Hi!\n\nRosie\n${IG_URL}`)
    expect(signal.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('the outbound sites pass null, so the signal carries no handles', () => {
    const signal = emailToNormalizedSignal({
      email: { messageId: 'msg-2', threadId: 'thread-1', subject: 'Re: Our wedding' },
      interactionId: 'interaction-2',
      emailDate: '2026-06-01T11:00:00.000Z',
      rawFromName: null,
      rawFromEmail: null,
      actionType: 'venue_sent',
      signalTier: 'medium',
      handles: handlesForEmailSignal({
        direction: 'outbound',
        body: `Thanks Rosie!\n\nRixey Manor\n${IG_URL}`,
      }),
    })
    expect(signal.handles).toBeNull()
  })
})

describe('the whole journey, against a fake client', () => {
  it('an inbound email body ends up on couples.handles and moves first_seen_at back', async () => {
    const db = new FakeSpineDb()
    db.seed('couples', [
      { id: 'couple-1', venue_id: 'venue-1', handles: null, first_seen_at: null },
    ])

    const signal = inboundSignal(`Hi!\n\nRosie\n${IG_URL}`)
    const outcome = await stampHandlesAndFirstSeen({
      supabase: db.client(),
      venueId: 'venue-1',
      coupleId: 'couple-1',
      signal,
    })

    expect(outcome.handlesAdded).toEqual(['instagram'])
    expect(outcome.handleConflicts).toEqual([])
    const couple = db.table('couples')[0]!
    expect(couple.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(couple.first_seen_at).toBe('2026-06-01T10:00:00.000Z')
  })

  it('a venue-sent email with the same URL leaves couples.handles alone', async () => {
    const db = new FakeSpineDb()
    db.seed('couples', [
      { id: 'couple-1', venue_id: 'venue-1', handles: null, first_seen_at: null },
    ])

    const signal = emailToNormalizedSignal({
      email: { messageId: 'msg-3', threadId: 'thread-1', subject: 'Re: Our wedding' },
      interactionId: 'interaction-3',
      emailDate: '2026-06-02T10:00:00.000Z',
      rawFromName: null,
      rawFromEmail: null,
      actionType: 'venue_sent',
      signalTier: 'medium',
      handles: handlesForEmailSignal({
        direction: 'outbound',
        body: `Lovely to meet you!\n\nRixey Manor\n${IG_URL}`,
      }),
    })
    const outcome = await stampHandlesAndFirstSeen({
      supabase: db.client(),
      venueId: 'venue-1',
      coupleId: 'couple-1',
      signal,
    })

    expect(outcome.handlesAdded).toEqual([])
    expect(db.table('couples')[0]!.handles).toBeNull()
  })

  it('a different handle on a platform the couple already holds is a conflict, not an overwrite', async () => {
    const db = new FakeSpineDb()
    db.seed('couples', [
      {
        id: 'couple-1',
        venue_id: 'venue-1',
        handles: { instagram: 'rosie.and.sam' },
        first_seen_at: '2026-01-01T00:00:00.000Z',
      },
    ])

    const outcome = await stampHandlesAndFirstSeen({
      supabase: db.client(),
      venueId: 'venue-1',
      coupleId: 'couple-1',
      signal: inboundSignal(`Hi!\n\nRosie\n${IG_URL}`),
    })

    expect(outcome.handlesAdded).toEqual([])
    expect(outcome.handleConflicts).toEqual(['instagram'])
    expect(db.table('couples')[0]!.handles).toEqual({ instagram: 'rosie.and.sam' })
    // The disagreement is queued where an operator will find it.
    expect(db.table('couple_merge_events')).toHaveLength(1)
    expect(db.table('couple_merge_events')[0]!.event_type).toBe('handle_contradiction')
    // first_seen_at only ever moves earlier, and this email is later.
    expect(db.table('couples')[0]!.first_seen_at).toBe('2026-01-01T00:00:00.000Z')
  })
})
