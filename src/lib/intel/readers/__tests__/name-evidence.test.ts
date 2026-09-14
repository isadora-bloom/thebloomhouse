/**
 * loadCoupleNameEvidence — the evidence chain, keyed on the couple.
 *
 * What these pin down: the reader is the only thing that knows the
 * couple-to-wedding join, tenancy is enforced on the couple row rather
 * than on a wedding row, the chain sorts pinned-then-confidence, and
 * partnerCount is 1 only when the forensic profile actually said so.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '../../tool-sources/__tests__/fake-supabase-memory'
import { loadCoupleNameEvidence } from '../name-evidence'

const VENUE = 'venue-1'

function couple(over: Record<string, unknown> = {}) {
  return {
    id: 'C1',
    venue_id: VENUE,
    source_wedding_id: 'W1',
    handles: { instagram: 'emma.and.jake' },
    merged_into_id: null,
    ...over,
  }
}

function person(over: Record<string, unknown> = {}) {
  return {
    id: 'P1',
    venue_id: VENUE,
    wedding_id: 'W1',
    role: 'partner1',
    first_name: 'Emma',
    last_name: 'Reid',
    email: 'emma@example.com',
    phone: null,
    display_handle: null,
    name_confidence: 80,
    name_picked_source: 'contract_signer',
    name_evidence: [],
    ...over,
  }
}

describe('loadCoupleNameEvidence', () => {
  it('returns the partners and the spine handle map', async () => {
    const sb = makeFakeSupabase({
      couples: [couple()],
      people: [person(), person({ id: 'P2', role: 'partner2', first_name: 'Jake' })],
      couple_identity_profile: [],
    })
    const out = await loadCoupleNameEvidence(sb, VENUE, 'C1')
    expect(out?.partners.map((p) => p.first_name)).toEqual(['Emma', 'Jake'])
    expect(out?.handles).toEqual({ instagram: 'emma.and.jake' })
    expect(out?.chainUnavailable).toBe(false)
  })

  it('drops rows that are not partner1 or partner2', async () => {
    const sb = makeFakeSupabase({
      couples: [couple()],
      people: [person(), person({ id: 'P3', role: 'planner', first_name: 'Nina' })],
      couple_identity_profile: [],
    })
    const out = await loadCoupleNameEvidence(sb, VENUE, 'C1')
    expect(out?.partners).toHaveLength(1)
  })

  it('sorts the evidence chain pinned first, then confidence, then recency', async () => {
    const sb = makeFakeSupabase({
      couples: [couple()],
      people: [
        person({
          name_evidence: [
            { source: 'gmail_from_name', confidence: 40, captured_at: '2026-01-01T00:00:00Z' },
            { source: 'contract_signer', confidence: 90, captured_at: '2026-02-01T00:00:00Z' },
            { source: 'tour_transcript', confidence: 90, captured_at: '2026-03-01T00:00:00Z' },
            { source: 'manual_override', confidence: 100, captured_at: '2025-12-01T00:00:00Z', pinned: true },
          ],
        }),
      ],
      couple_identity_profile: [],
    })
    const out = await loadCoupleNameEvidence(sb, VENUE, 'C1')
    expect(out?.partners[0].name_evidence.map((e) => e.source)).toEqual([
      'manual_override',
      'tour_transcript',
      'contract_signer',
      'gmail_from_name',
    ])
  })

  it('says one decision maker only when the forensic profile said so', async () => {
    const phantom = makeFakeSupabase({
      couples: [couple()],
      people: [person()],
      couple_identity_profile: [
        { wedding_id: 'W1', profile: { names: { is_phantom_partner_relationship: true } } },
      ],
    })
    expect((await loadCoupleNameEvidence(phantom, VENUE, 'C1'))?.partnerCount).toBe(1)

    const silent = makeFakeSupabase({
      couples: [couple()],
      people: [person()],
      couple_identity_profile: [{ wedding_id: 'W1', profile: { names: {} } }],
    })
    expect((await loadCoupleNameEvidence(silent, VENUE, 'C1'))?.partnerCount).toBeNull()

    const none = makeFakeSupabase({
      couples: [couple()],
      people: [person()],
      couple_identity_profile: [],
    })
    expect((await loadCoupleNameEvidence(none, VENUE, 'C1'))?.partnerCount).toBeNull()
  })

  it('says the chain is unavailable rather than empty when there is no mirrored wedding', async () => {
    const sb = makeFakeSupabase({
      couples: [couple({ source_wedding_id: null })],
      people: [person()],
      couple_identity_profile: [],
    })
    const out = await loadCoupleNameEvidence(sb, VENUE, 'C1')
    expect(out?.chainUnavailable).toBe(true)
    expect(out?.partners).toEqual([])
    expect(out?.handles).toEqual({ instagram: 'emma.and.jake' })
  })

  it('refuses another venue and a merged-away couple', async () => {
    const foreign = makeFakeSupabase({ couples: [couple({ venue_id: 'venue-2' })], people: [], couple_identity_profile: [] })
    expect(await loadCoupleNameEvidence(foreign, VENUE, 'C1')).toBeNull()

    const merged = makeFakeSupabase({ couples: [couple({ merged_into_id: 'C9' })], people: [], couple_identity_profile: [] })
    expect(await loadCoupleNameEvidence(merged, VENUE, 'C1')).toBeNull()
  })
})
