/**
 * loadChannelLeads — the couples behind a channel's number.
 *
 * The contract worth holding: the list is filtered from the SAME
 * builder the canonical channel rate is rolled up from, a couple with no
 * credit on a wanted channel is absent rather than present with a zero,
 * and value is null because the spine carries no revenue column.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '../../tool-sources/__tests__/fake-supabase-memory'
import { loadChannelLeads } from '../channel-leads'

const VENUE = 'venue-1'

function couple(over: Record<string, unknown> = {}) {
  return {
    id: 'C1',
    venue_id: VENUE,
    source_wedding_id: 'W1',
    primary_contact_name: 'Emma',
    partner_contact_name: 'Jake',
    partner_contact_email: null,
    primary_contact_email: 'emma@example.com',
    lifecycle_state: 'resolved',
    wedding_date: '2027-06-12',
    heat_score: 50,
    merged_into_id: null,
    decay_window_days: 120,
    last_progression_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function tp(over: Record<string, unknown> = {}) {
  return {
    id: 'T1',
    venue_id: VENUE,
    couple_id: 'C1',
    channel: 'knot',
    action_type: 'inquiry',
    signal_tier: 'high',
    direction: 'inbound',
    occurred_at: '2026-05-01T00:00:00Z',
    raw_payload: null,
    ...over,
  }
}

function tables(over: Record<string, unknown[]> = {}) {
  return {
    couples: [couple()],
    touchpoints: [tp()],
    couple_progression_events: [],
    venue_config: [],
    marketing_spend_records: [],
    marketing_spend: [],
    ...over,
  }
}

describe('loadChannelLeads', () => {
  it('returns the couple credited to a wanted channel, with spine display fields', async () => {
    const sb = makeFakeSupabase(tables())
    const leads = await loadChannelLeads(sb, VENUE, { channels: ['knot'] })
    expect(leads).toHaveLength(1)
    expect(leads[0].coupleId).toBe('C1')
    expect(leads[0].names).toBe('Emma & Jake')
    expect(leads[0].sourceWeddingId).toBe('W1')
    expect(leads[0].weddingDate).toBe('2027-06-12')
    expect(leads[0].attributedChannel).toBe('knot')
    expect(leads[0].firstTouchAt).toBe('2026-05-01T00:00:00Z')
  })

  it('never invents a value, because the spine has no revenue column', async () => {
    const sb = makeFakeSupabase(tables())
    const leads = await loadChannelLeads(sb, VENUE, { channels: ['knot'] })
    expect(leads[0].valueCents).toBeNull()
  })

  it('leaves out a couple with no credit on a wanted channel', async () => {
    const sb = makeFakeSupabase(tables())
    expect(await loadChannelLeads(sb, VENUE, { channels: ['instagram'] })).toEqual([])
  })

  it('returns nothing when asked for no channels, and does not query', async () => {
    const sb = makeFakeSupabase(tables())
    expect(await loadChannelLeads(sb, VENUE, { channels: [] })).toEqual([])
    expect(await loadChannelLeads(sb, '', { channels: ['knot'] })).toEqual([])
  })

  it('orders newest first touch first', async () => {
    const sb = makeFakeSupabase(
      tables({
        couples: [
          couple(),
          couple({ id: 'C2', source_wedding_id: 'W2', primary_contact_name: 'Ada', partner_contact_name: null }),
        ],
        touchpoints: [
          tp({ id: 'T1', couple_id: 'C1', occurred_at: '2026-05-01T00:00:00Z' }),
          tp({ id: 'T2', couple_id: 'C2', occurred_at: '2026-07-01T00:00:00Z' }),
        ],
      }),
    )
    const leads = await loadChannelLeads(sb, VENUE, { channels: ['knot'] })
    expect(leads.map((l) => l.coupleId)).toEqual(['C2', 'C1'])
  })
})
