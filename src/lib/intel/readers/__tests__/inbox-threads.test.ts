/**
 * W63 — the spine inbox thread list.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '@/lib/intel/tool-sources/__tests__/fake-supabase-memory'
import {
  coupleDisplayName,
  lifecycleToWeddingStatus,
  loadInboxThreads,
} from '../inbox-threads'

const VENUE = 'venue-a'
const OTHER = 'venue-b'

function tp(over: Record<string, unknown>) {
  return {
    id: 't1',
    venue_id: VENUE,
    couple_id: 'c1',
    channel: 'gmail',
    action_type: 'reply',
    direction: 'inbound',
    occurred_at: '2026-09-10T09:00:00.000Z',
    raw_payload: {
      subject: 'Autumn dates',
      thread_id: 'thread-1',
      interaction_id: 'int-1',
      full_body: '<p>Are you free in October?</p>',
      raw_from_email: 'sarah@example.com',
      raw_from_name: 'Sarah Ross',
    },
    ...over,
  }
}

function couple(over: Record<string, unknown>) {
  return {
    id: 'c1',
    venue_id: VENUE,
    primary_contact_name: 'Sarah Ross',
    partner_contact_name: 'Tom Ross',
    primary_contact_email: 'sarah@example.com',
    lifecycle_state: 'resolved',
    source_wedding_id: 'w1',
    merged_into_id: null,
    ...over,
  }
}

const VENUES = [{ id: VENUE, name: 'Hawthorne Manor' }]

describe('loadInboxThreads', () => {
  it('reads the message off the spine and names the couple', async () => {
    const db = makeFakeSupabase({
      touchpoints: [tp({})],
      couples: [couple({})],
      venues: VENUES,
      drafts: [],
      client_codes: [{ wedding_id: 'w1', code: 'BH-0042' }],
      venue_vendor_domains: [],
    })
    const res = await loadInboxThreads(db, [VENUE])
    expect(res.rows).toHaveLength(1)
    const row = res.rows[0]
    expect(row.subject).toBe('Autumn dates')
    expect(row.personName).toBe('Sarah Ross & Tom Ross')
    expect(row.bodyPreview).toBe('Are you free in October?')
    expect(row.threadId).toBe('thread-1')
    expect(row.venueName).toBe('Hawthorne Manor')
    expect(row.weddingId).toBe('w1')
    expect(row.clientCode).toBe('BH-0042')
    expect(row.direction).toBe('inbound')
  })

  it('keeps the venue scope', async () => {
    const db = makeFakeSupabase({
      touchpoints: [tp({ venue_id: OTHER })],
      couples: [couple({ venue_id: OTHER })],
      venues: VENUES,
      drafts: [],
    })
    const res = await loadInboxThreads(db, [VENUE])
    expect(res.rows).toHaveLength(0)
  })

  it('leaves non-message channels out of the inbox', async () => {
    const db = makeFakeSupabase({
      touchpoints: [tp({ id: 't1', channel: 'calendly', action_type: 'tour_booked' }), tp({ id: 't2' })],
      couples: [couple({})],
      venues: VENUES,
      drafts: [],
    })
    const res = await loadInboxThreads(db, [VENUE])
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].id).toBe('t2')
  })

  it('reports an unstamped direction as unknown rather than inferring one', async () => {
    const db = makeFakeSupabase({
      touchpoints: [tp({ direction: null })],
      couples: [couple({})],
      venues: VENUES,
      drafts: [],
    })
    const res = await loadInboxThreads(db, [VENUE])
    expect(res.rows[0].direction).toBeNull()
    expect(res.unknownDirection).toBe(1)
  })

  it('attaches a pending draft by the message it answers', async () => {
    const db = makeFakeSupabase({
      touchpoints: [tp({})],
      couples: [couple({})],
      venues: VENUES,
      drafts: [
        {
          id: 'd1',
          venue_id: VENUE,
          status: 'pending',
          interaction_id: 'int-1',
          wedding_id: 'w1',
          draft_body: 'We are free.',
          subject: 'Re: Autumn dates',
          to_email: 'sarah@example.com',
          brain_used: 'inquiry',
          confidence_score: 88,
          auto_sent: false,
          created_at: '2026-09-10T10:00:00.000Z',
        },
      ],
    })
    const res = await loadInboxThreads(db, [VENUE])
    expect(res.rows[0].pendingDraft?.id).toBe('d1')
    expect(res.rows[0].pendingDraft?.draftBody).toBe('We are free.')
  })

  it('attaches an unlinked draft to the couple’s most recent inbound', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        tp({ id: 't-old', occurred_at: '2026-09-01T09:00:00.000Z', raw_payload: { thread_id: 'thread-1' } }),
        tp({ id: 't-new', occurred_at: '2026-09-10T09:00:00.000Z', raw_payload: { thread_id: 'thread-1' } }),
      ],
      couples: [couple({})],
      venues: VENUES,
      drafts: [
        {
          id: 'd1',
          venue_id: VENUE,
          status: 'pending',
          interaction_id: null,
          wedding_id: 'w1',
          draft_body: 'Reply',
          subject: null,
          to_email: null,
          brain_used: null,
          confidence_score: null,
          auto_sent: false,
          created_at: '2026-09-10T10:00:00.000Z',
        },
      ],
    })
    const res = await loadInboxThreads(db, [VENUE])
    const withDraft = res.rows.filter((r) => r.pendingDraft)
    expect(withDraft).toHaveLength(1)
    expect(withDraft[0].id).toBe('t-new')
  })

  it('puts a booked couple in the client folder', async () => {
    const db = makeFakeSupabase({
      touchpoints: [tp({})],
      couples: [couple({ lifecycle_state: 'booked' })],
      venues: VENUES,
      drafts: [],
    })
    const res = await loadInboxThreads(db, [VENUE])
    expect(res.rows[0].folder).toBe('client')
  })

  it('puts an unanchored message from a known advertiser domain in advertiser', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        tp({
          couple_id: null,
          raw_payload: { subject: 'Grow your bookings', raw_from_email: 'sales@hubspot.com' },
        }),
      ],
      couples: [],
      venues: VENUES,
      drafts: [],
    })
    const res = await loadInboxThreads(db, [VENUE])
    expect(res.rows[0].folder).toBe('advertiser')
  })

  it('honours the venue’s curated vendor-domain list', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        tp({
          couple_id: null,
          raw_payload: { subject: 'Flowers', raw_from_email: 'hi@bloomsbury-florist.com' },
        }),
      ],
      couples: [],
      venues: VENUES,
      drafts: [],
      venue_vendor_domains: [{ venue_id: VENUE, domain: 'bloomsbury-florist.com' }],
    })
    const res = await loadInboxThreads(db, [VENUE])
    expect(res.rows[0].folder).toBe('vendor')
  })

  it('filters to one thread when asked', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        tp({ id: 't1', raw_payload: { thread_id: 'thread-1', subject: 'One' } }),
        tp({ id: 't2', raw_payload: { thread_id: 'thread-2', subject: 'Two' } }),
      ],
      couples: [couple({})],
      venues: VENUES,
      drafts: [],
    })
    const res = await loadInboxThreads(db, [VENUE], { threadId: 'thread-2' })
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].subject).toBe('Two')
  })

  it('searches subject, body and sender', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        tp({ id: 't1', raw_payload: { subject: 'Autumn dates', full_body: 'October please' } }),
        tp({ id: 't2', raw_payload: { subject: 'Catering', full_body: 'Menus' } }),
      ],
      couples: [couple({})],
      venues: VENUES,
      drafts: [],
    })
    const res = await loadInboxThreads(db, [VENUE], { search: 'october' })
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].id).toBe('t1')
  })

  it('is honest-empty with no venue in scope', async () => {
    const db = makeFakeSupabase({ touchpoints: [tp({})] })
    const res = await loadInboxThreads(db, [])
    expect(res.rows).toEqual([])
    expect(res.truncated).toBe(false)
  })
})

describe('coupleDisplayName', () => {
  it('joins both halves, falls back to one, and never invents a name', () => {
    expect(coupleDisplayName({ primary_contact_name: 'A', partner_contact_name: 'B' } as never)).toBe('A & B')
    expect(coupleDisplayName({ primary_contact_name: 'A', partner_contact_name: null } as never)).toBe('A')
    expect(coupleDisplayName({ primary_contact_name: null, partner_contact_name: null } as never)).toBeNull()
    expect(coupleDisplayName(undefined)).toBeNull()
  })
})

describe('lifecycleToWeddingStatus', () => {
  it('maps the spine vocabulary onto the decider’s', () => {
    expect(lifecycleToWeddingStatus('booked')).toBe('booked')
    expect(lifecycleToWeddingStatus('completed')).toBe('completed')
    expect(lifecycleToWeddingStatus('ghost')).toBe('lost')
    expect(lifecycleToWeddingStatus('resolved')).toBe('inquiry')
    expect(lifecycleToWeddingStatus('channel_scoped')).toBe('inquiry')
    expect(lifecycleToWeddingStatus('agent')).toBeNull()
    expect(lifecycleToWeddingStatus(null)).toBeNull()
  })
})
