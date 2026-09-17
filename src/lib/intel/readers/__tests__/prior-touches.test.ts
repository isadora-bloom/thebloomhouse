/**
 * loadCouplePriorTouches — prior touches from the spine ribbon.
 *
 * The behaviour that matters: outbound venue activity is not warmth, an
 * unstamped touchpoint is listed but never promoted to inbound, and the
 * warmth ladder matches the person-keyed reader it replaces so the chip
 * does not silently change meaning.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '../../tool-sources/__tests__/fake-supabase-memory'
import { loadCouplePriorTouches } from '../prior-touches'

const VENUE = 'venue-1'
const COUPLE = 'C1'
const BEFORE = '2026-09-14T00:00:00Z'

function tp(over: Record<string, unknown>) {
  return {
    id: 'T1',
    venue_id: VENUE,
    couple_id: COUPLE,
    channel: 'instagram',
    action_type: 'story_view',
    direction: 'inbound',
    occurred_at: '2026-08-01T00:00:00Z',
    raw_payload: null,
    ...over,
  }
}

describe('loadCouplePriorTouches', () => {
  it('lists the ribbon newest first and counts inbound entries', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [
        tp({ id: 'T1', occurred_at: '2026-08-01T00:00:00Z' }),
        tp({ id: 'T2', channel: 'knot', action_type: 'inquiry', occurred_at: '2026-08-20T00:00:00Z' }),
        tp({ id: 'T3', channel: 'gmail', action_type: 'reply', occurred_at: '2026-09-01T00:00:00Z', raw_payload: { subject: 'Re: our date' } }),
      ],
    })
    const s = await loadCouplePriorTouches(sb, VENUE, COUPLE, { before: BEFORE })
    expect(s.counts.inbound).toBe(3)
    expect(s.touches.map((t) => t.date)).toEqual([
      '2026-09-01T00:00:00Z',
      '2026-08-20T00:00:00Z',
      '2026-08-01T00:00:00Z',
    ])
    expect(s.touches[0].summary).toBe('Re: our date')
    expect(s.warmth).toBe('hot')
  })

  it('drops outbound venue activity so a nurture sequence cannot fake warmth', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [
        tp({ id: 'T1', direction: 'outbound' }),
        tp({ id: 'T2', direction: 'outbound', occurred_at: '2026-08-02T00:00:00Z' }),
        tp({ id: 'T3', direction: 'outbound', occurred_at: '2026-08-03T00:00:00Z' }),
        tp({ id: 'T4', direction: 'outbound', occurred_at: '2026-08-04T00:00:00Z' }),
      ],
    })
    const s = await loadCouplePriorTouches(sb, VENUE, COUPLE, { before: BEFORE })
    expect(s.touches).toEqual([])
    expect(s.warmth).toBe('cold')
  })

  it('lists an unstamped touchpoint but counts it separately from inbound', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [tp({ id: 'T1', direction: null })],
    })
    const s = await loadCouplePriorTouches(sb, VENUE, COUPLE, { before: BEFORE })
    expect(s.counts.inbound).toBe(0)
    expect(s.counts.unstamped).toBe(1)
    expect(s.touches).toHaveLength(1)
    expect(s.warmth).toBe('warm')
  })

  it('falls back to a readable label when the payload carries no subject', async () => {
    const sb = makeFakeSupabase({ touchpoints: [tp({ id: 'T1' })] })
    const s = await loadCouplePriorTouches(sb, VENUE, COUPLE, { before: BEFORE })
    expect(s.touches[0].summary).toBe('Story view on instagram')
  })

  it('lists a fragment promoted onto the couple as a touch, since no touchpoint was written for it', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [tp({ id: 'T1', channel: 'knot', action_type: 'inquiry', occurred_at: '2026-09-01T00:00:00Z' })],
      fragments: [
        {
          venue_id: VENUE,
          channel: 'instagram',
          identity_hint: '@sarah.highland',
          occurred_at: '2026-08-10T00:00:00Z',
          promoted_to_couple_id: COUPLE,
          raw_payload: { text: 'Commented on the autumn ceremony post' },
        },
        // Someone else's fragment, still anonymous.
        {
          venue_id: VENUE,
          channel: 'instagram',
          identity_hint: '@other',
          occurred_at: '2026-08-11T00:00:00Z',
          promoted_to_couple_id: null,
          raw_payload: null,
        },
      ],
    })
    const s = await loadCouplePriorTouches(sb, VENUE, COUPLE, { before: BEFORE })
    expect(s.counts.fragments).toBe(1)
    expect(s.touches.map((t) => t.kind)).toEqual(['touchpoint', 'fragment'])
    expect(s.touches[1].summary).toBe('Commented on the autumn ceremony post')
    expect(s.warmth).toBe('warm')
  })

  it('adds tours only when the couple has a mirrored wedding', async () => {
    const tables = {
      touchpoints: [tp({ id: 'T1' })],
      tours: [
        { venue_id: VENUE, wedding_id: 'W1', scheduled_at: '2026-08-15T00:00:00Z', tour_type: 'In person', outcome: 'attended' },
      ],
    }
    const withWedding = await loadCouplePriorTouches(makeFakeSupabase(tables), VENUE, COUPLE, {
      before: BEFORE,
      sourceWeddingId: 'W1',
    })
    expect(withWedding.counts.tours).toBe(1)
    expect(withWedding.touches.find((t) => t.kind === 'tour')?.summary).toBe('In person — attended')

    const withoutWedding = await loadCouplePriorTouches(makeFakeSupabase(tables), VENUE, COUPLE, {
      before: BEFORE,
      sourceWeddingId: null,
    })
    expect(withoutWedding.counts.tours).toBe(0)
  })

  it('ignores another venue and another couple', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [
        tp({ id: 'T1', venue_id: 'venue-2' }),
        tp({ id: 'T2', couple_id: 'C9' }),
      ],
    })
    const s = await loadCouplePriorTouches(sb, VENUE, COUPLE, { before: BEFORE })
    expect(s.touches).toEqual([])
  })

  it('returns a cold empty summary with no couple, without querying', async () => {
    const sb = makeFakeSupabase({ touchpoints: [tp({})] })
    const s = await loadCouplePriorTouches(sb, VENUE, '', { before: BEFORE })
    expect(s.warmth).toBe('cold')
    expect(s.touches).toEqual([])
  })
})
