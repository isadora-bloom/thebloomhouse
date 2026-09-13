/**
 * Last-activity overlay — the merge /agent/leads and /agent/pipeline both
 * use so "last activity" cannot drift into two different answers for the
 * same couple.
 */

import { describe, it, expect } from 'vitest'
import { withLastActivity } from '../lead-list-view'

describe('withLastActivity', () => {
  it('attaches the spine timestamp for a wedding present in the map', () => {
    const rows = [{ id: 'w1', status: 'inquiry' }]
    const out = withLastActivity(rows, { w1: '2026-09-01T00:00:00.000Z' })
    expect(out).toEqual([
      { id: 'w1', status: 'inquiry', last_activity_at: '2026-09-01T00:00:00.000Z' },
    ])
  })

  it('gives a wedding with no spine touchpoint null, not a guess', () => {
    const rows = [{ id: 'w1', status: 'inquiry' }]
    const out = withLastActivity(rows, {})
    expect(out[0]!.last_activity_at).toBeNull()
  })

  it('keeps every other field on the row untouched — a view-model merge, not a rebuild', () => {
    const rows = [
      {
        id: 'w1',
        status: 'tour_scheduled',
        partner1_name: 'Rosie',
        partner2_name: 'Sam',
        heat_score: 72,
      },
    ]
    const out = withLastActivity(rows, { w1: '2026-08-15T00:00:00.000Z' })
    expect(out[0]).toEqual({
      id: 'w1',
      status: 'tour_scheduled',
      partner1_name: 'Rosie',
      partner2_name: 'Sam',
      heat_score: 72,
      last_activity_at: '2026-08-15T00:00:00.000Z',
    })
  })

  it('maps a list of rows independently, matching each to its own wedding id', () => {
    const rows = [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]
    const out = withLastActivity(rows, {
      w1: '2026-09-01T00:00:00.000Z',
      w3: '2026-08-01T00:00:00.000Z',
    })
    expect(out.map((r) => r.last_activity_at)).toEqual([
      '2026-09-01T00:00:00.000Z',
      null,
      '2026-08-01T00:00:00.000Z',
    ])
  })

  it('is a no-op reshape on an empty row list', () => {
    expect(withLastActivity([], { w1: '2026-09-01T00:00:00.000Z' })).toEqual([])
  })
})
