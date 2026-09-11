/**
 * getCoupleJourney (loadCoupleJourney) — Wave 3 handle-identity fields.
 *
 * HANDLE-IDENTITY-SPEC.md §3 + NOVEMBER-PLAN.md W27: the reader now
 * surfaces `couples.handles`, `couples.first_seen_at`, `couples.
 * point_zero_at` and per-touchpoint `zero_phase`, plus a discovery
 * summary built only from those spine facts. These tests drive
 * `loadCoupleJourney` against a fake, in-memory Supabase client — the
 * same fake-readers pattern the tool-source tests use (`makeFakeSupabase`
 * from `../tool-sources/__tests__/fake-supabase-memory`) — so nothing
 * here touches a database.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '../tool-sources/__tests__/fake-supabase-memory'
import { loadCoupleJourney } from '../canonical'

const VENUE = 'venue-1'

describe('loadCoupleJourney — Wave 3 fields', () => {
  it('returns handles, firstSeenAt, pointZeroAt and per-touchpoint zeroPhase, with a handle-led discovery summary', async () => {
    const supabase = makeFakeSupabase({
      couples: [
        {
          id: 'C1',
          venue_id: VENUE,
          primary_contact_name: 'Rosie Hoyle',
          lifecycle_state: 'resolved',
          merged_into_id: null,
          handles: { instagram: 'rosie.hoyle' },
          first_seen_at: '2026-06-01T00:00:00Z',
          point_zero_at: '2026-07-12T00:00:00Z',
        },
      ],
      touchpoints: [
        { id: 'T1', couple_id: 'C1', channel: 'instagram', action_type: 'follow', occurred_at: '2026-06-01T00:00:00Z', raw_payload: null, zero_phase: 'pre_zero' },
        { id: 'T2', couple_id: 'C1', channel: 'instagram', action_type: 'story_view', occurred_at: '2026-06-15T00:00:00Z', raw_payload: null, zero_phase: 'pre_zero' },
        { id: 'T3', couple_id: 'C1', channel: 'gmail', action_type: 'inquiry', occurred_at: '2026-07-12T00:00:00Z', raw_payload: null, zero_phase: 'post_zero' },
      ],
    })

    const j = await loadCoupleJourney(supabase, VENUE, 'C1')

    expect(j.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(j.firstSeenAt).toBe('2026-06-01T00:00:00Z')
    expect(j.pointZeroAt).toBe('2026-07-12T00:00:00Z')

    expect(j.ribbon.find((t) => t.id === 'T1')?.zeroPhase).toBe('pre_zero')
    expect(j.ribbon.find((t) => t.id === 'T3')?.zeroPhase).toBe('post_zero')

    // Earliest touchpoint (T1) is on instagram, and the couple has an
    // instagram handle, so discovery names the handle, not just the
    // channel — and states the true gap: 41 days.
    expect(j.discovery.firstSeenViaHandle).toBe(true)
    expect(j.discovery.firstChannel).toBe('instagram')
    expect(j.discovery.daysBeforePointZero).toBe(41)
    expect(j.discovery.summary).toBe(
      'First seen as @rosie.hoyle on instagram, 41 days before point zero.',
    )
  })

  it('falls back to the channel when the earliest touchpoint carries no handle', async () => {
    const supabase = makeFakeSupabase({
      couples: [
        {
          id: 'C2',
          venue_id: VENUE,
          primary_contact_name: 'No Handle Here',
          lifecycle_state: 'resolved',
          merged_into_id: null,
          handles: {},
          first_seen_at: '2026-08-01T00:00:00Z',
          point_zero_at: '2026-08-01T00:00:00Z',
        },
      ],
      touchpoints: [
        { id: 'T1', couple_id: 'C2', channel: 'knot', action_type: 'knot_message', occurred_at: '2026-08-01T00:00:00Z', raw_payload: null, zero_phase: 'post_zero' },
      ],
    })
    const j = await loadCoupleJourney(supabase, VENUE, 'C2')
    expect(j.discovery.firstSeenViaHandle).toBe(false)
    expect(j.discovery.summary).toBe('First seen via knot, the same day they reached point zero.')
  })

  it('says so honestly when first_seen_at was never set — never invents a date', async () => {
    const supabase = makeFakeSupabase({
      couples: [
        {
          id: 'C3',
          venue_id: VENUE,
          primary_contact_name: 'No First Seen',
          lifecycle_state: 'channel_scoped',
          merged_into_id: null,
          handles: {},
          first_seen_at: null,
          point_zero_at: null,
        },
      ],
      touchpoints: [
        { id: 'T1', couple_id: 'C3', channel: 'gmail', action_type: 'inquiry', occurred_at: '2026-08-01T00:00:00Z', raw_payload: null, zero_phase: null },
      ],
    })
    const j = await loadCoupleJourney(supabase, VENUE, 'C3')
    expect(j.firstSeenAt).toBeNull()
    expect(j.discovery.summary).toBe('No first-seen date recorded yet.')
    expect(j.discovery.daysBeforePointZero).toBeNull()
    expect(j.ribbon[0]?.zeroPhase).toBeNull()
  })

  it('does not show a day gap when point zero has not happened yet', async () => {
    const supabase = makeFakeSupabase({
      couples: [
        {
          id: 'C4',
          venue_id: VENUE,
          primary_contact_name: 'Pre Zero Only',
          lifecycle_state: 'channel_scoped',
          merged_into_id: null,
          handles: { instagram: 'pre.zero.only' },
          first_seen_at: '2026-08-01T00:00:00Z',
          point_zero_at: null,
        },
      ],
      touchpoints: [
        { id: 'T1', couple_id: 'C4', channel: 'instagram', action_type: 'follow', occurred_at: '2026-08-01T00:00:00Z', raw_payload: null, zero_phase: 'pre_zero' },
      ],
    })
    const j = await loadCoupleJourney(supabase, VENUE, 'C4')
    expect(j.pointZeroAt).toBeNull()
    expect(j.discovery.daysBeforePointZero).toBeNull()
    expect(j.discovery.summary).toBe('First seen as @pre.zero.only on instagram.')
  })

  it('honest-empty (no couple, no venue) still carries the Wave 3 shape', async () => {
    const supabase = makeFakeSupabase({ couples: [] })
    const j = await loadCoupleJourney(supabase, VENUE, 'missing')
    expect(j.couple).toBeNull()
    expect(j.handles).toEqual({})
    expect(j.firstSeenAt).toBeNull()
    expect(j.pointZeroAt).toBeNull()
    expect(j.discovery.summary).toBe('No first-seen date recorded yet.')
  })
})
