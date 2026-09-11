/**
 * Journey phases — Discovery / Point zero / Known couple (Wave 3).
 *
 * Guards: the point-zero touchpoint is pulled out and drawn once, not
 * duplicated into discovery or known-couple; pre_zero touchpoints land
 * in discovery, post_zero (and null-phase legacy rows) in known-couple;
 * the discovery gap headline only appears past the one-day threshold;
 * and handles become chips with the right profile URL, never inventing
 * one for a platform that isn't there.
 */

import { describe, it, expect } from 'vitest'
import { buildJourneyPhases, handleChips } from '../journey-phases'
import type { CoupleJourney, TouchpointRibbon } from '@/lib/intel/canonical'

function tp(over: Partial<TouchpointRibbon> & Pick<TouchpointRibbon, 'id' | 'occurredAt'>): TouchpointRibbon {
  return {
    id: over.id,
    channel: over.channel ?? 'gmail',
    actionType: over.actionType ?? 'reply',
    occurredAt: over.occurredAt,
    cascadeStage: over.cascadeStage ?? null,
    cascadeReason: over.cascadeReason ?? null,
    zeroPhase: over.zeroPhase ?? null,
    occurredAtPrecision: over.occurredAtPrecision ?? null,
  }
}

type JourneyInput = Pick<CoupleJourney, 'ribbon' | 'pointZeroAt' | 'discovery' | 'handles'>

describe('buildJourneyPhases', () => {
  it('splits pre_zero into discovery, post_zero into known couple, and pulls out the point-zero marker once', () => {
    const journey: JourneyInput = {
      ribbon: [
        tp({ id: 'T1', channel: 'instagram', actionType: 'follow', occurredAt: '2026-06-01T00:00:00Z', zeroPhase: 'pre_zero' }),
        tp({ id: 'T2', channel: 'instagram', actionType: 'story_view', occurredAt: '2026-06-10T00:00:00Z', zeroPhase: 'pre_zero' }),
        tp({ id: 'T3', channel: 'gmail', actionType: 'inquiry', occurredAt: '2026-07-12T00:00:00Z', zeroPhase: 'post_zero' }),
        tp({ id: 'T4', channel: 'gmail', actionType: 'reply', occurredAt: '2026-07-13T00:00:00Z', zeroPhase: 'post_zero' }),
      ],
      pointZeroAt: '2026-07-12T00:00:00Z',
      discovery: {
        summary: 'First seen as @rosie.hoyle on instagram, 41 days before point zero.',
        daysBeforePointZero: 41,
        firstSeenViaHandle: true,
        firstChannel: 'instagram',
      },
      handles: { instagram: 'rosie.hoyle' },
    }

    const phases = buildJourneyPhases(journey)

    expect(phases.discovery.map((t) => t.id)).toEqual(['T1', 'T2'])
    expect(phases.pointZero?.id).toBe('T3')
    expect(phases.pointZero?.isPointZero).toBe(true)
    expect(phases.knownCouple.map((t) => t.id)).toEqual(['T4'])
    // The point-zero touchpoint is not duplicated into either band.
    expect(phases.knownCouple.some((t) => t.id === 'T3')).toBe(false)
    expect(phases.discovery.some((t) => t.id === 'T3')).toBe(false)
    // Only the earliest touchpoint on the whole ribbon is first-seen.
    expect(phases.discovery[0].isFirstSeen).toBe(true)
    expect(phases.discovery[1].isFirstSeen).toBe(false)
    expect(phases.pointZero?.isFirstSeen).toBe(false)
  })

  it('treats a null zero_phase (pre-migration-381 row) as known-couple, never as discovery', () => {
    const journey: JourneyInput = {
      ribbon: [tp({ id: 'T1', occurredAt: '2026-01-01T00:00:00Z', zeroPhase: null })],
      pointZeroAt: null,
      discovery: {
        summary: 'No first-seen date recorded yet.',
        daysBeforePointZero: null,
        firstSeenViaHandle: false,
        firstChannel: null,
      },
      handles: {},
    }
    const phases = buildJourneyPhases(journey)
    expect(phases.discovery).toEqual([])
    expect(phases.knownCouple.map((t) => t.id)).toEqual(['T1'])
    expect(phases.pointZero).toBeNull()
  })

  it('has no point-zero marker and no known-couple rows before point zero is reached', () => {
    const journey: JourneyInput = {
      ribbon: [
        tp({ id: 'T1', channel: 'instagram', occurredAt: '2026-06-01T00:00:00Z', zeroPhase: 'pre_zero' }),
      ],
      pointZeroAt: null,
      discovery: {
        summary: 'First seen via instagram.',
        daysBeforePointZero: null,
        firstSeenViaHandle: false,
        firstChannel: 'instagram',
      },
      handles: {},
    }
    const phases = buildJourneyPhases(journey)
    expect(phases.discovery.map((t) => t.id)).toEqual(['T1'])
    expect(phases.pointZero).toBeNull()
    expect(phases.knownCouple).toEqual([])
  })

  it('sources phase labels from client-terms', () => {
    const phases = buildJourneyPhases({
      ribbon: [],
      pointZeroAt: null,
      discovery: { summary: 'No first-seen date recorded yet.', daysBeforePointZero: null, firstSeenViaHandle: false, firstChannel: null },
      handles: {},
    })
    expect(phases.labels).toEqual({ discovery: 'discovery', pointZero: 'point zero', knownCouple: 'known couple' })
  })

  it('shows the discovery-gap headline only past the one-day threshold', () => {
    const base: JourneyInput = {
      ribbon: [],
      pointZeroAt: '2026-07-12T00:00:00Z',
      discovery: { summary: 'x', daysBeforePointZero: 1, firstSeenViaHandle: false, firstChannel: 'gmail' },
      handles: {},
    }
    expect(buildJourneyPhases(base).showDiscoveryGap).toBe(false)
    expect(buildJourneyPhases(base).discoveryGapPhrase).toBeNull()

    const withGap = { ...base, discovery: { ...base.discovery, daysBeforePointZero: 41 } }
    const phases = buildJourneyPhases(withGap)
    expect(phases.showDiscoveryGap).toBe(true)
    expect(phases.discoveryGapPhrase).toBe('41 days of discovery before they wrote to us')
  })

  it('carries the discovery summary and day count straight through, unchanged', () => {
    const phases = buildJourneyPhases({
      ribbon: [],
      pointZeroAt: null,
      discovery: {
        summary: 'First seen as @rosie.hoyle on instagram, 41 days before point zero.',
        daysBeforePointZero: 41,
        firstSeenViaHandle: true,
        firstChannel: 'instagram',
      },
      handles: { instagram: 'rosie.hoyle' },
    })
    expect(phases.discoverySummary).toBe('First seen as @rosie.hoyle on instagram, 41 days before point zero.')
    expect(phases.daysBeforePointZero).toBe(41)
  })
})

describe('approximate first-seen precision (Wave 4, W31)', () => {
  it('shows "about N weeks" instead of an exact day count when first-seen is week-precise', () => {
    const journey: JourneyInput = {
      ribbon: [],
      pointZeroAt: '2026-07-12T00:00:00Z',
      discovery: {
        summary: 'x',
        daysBeforePointZero: 21,
        firstSeenViaHandle: true,
        firstChannel: 'instagram',
        firstSeenPrecision: 'week',
      },
      handles: {},
    }
    const phases = buildJourneyPhases(journey)
    expect(phases.discoveryGapPhrase).toBe('about 3 weeks of discovery before they wrote to us')
  })

  it('shows "about N months" when first-seen is month-precise', () => {
    const journey: JourneyInput = {
      ribbon: [],
      pointZeroAt: '2026-07-12T00:00:00Z',
      discovery: {
        summary: 'x',
        daysBeforePointZero: 60,
        firstSeenViaHandle: false,
        firstChannel: 'instagram',
        firstSeenPrecision: 'month',
      },
      handles: {},
    }
    const phases = buildJourneyPhases(journey)
    expect(phases.discoveryGapPhrase).toBe('about 2 months of discovery before they wrote to us')
  })

  it('keeps the exact day count when precision is unset (most channels)', () => {
    const journey: JourneyInput = {
      ribbon: [],
      pointZeroAt: '2026-07-12T00:00:00Z',
      discovery: {
        summary: 'x',
        daysBeforePointZero: 41,
        firstSeenViaHandle: false,
        firstChannel: 'gmail',
        firstSeenPrecision: null,
      },
      handles: {},
    }
    const phases = buildJourneyPhases(journey)
    expect(phases.discoveryGapPhrase).toBe('41 days of discovery before they wrote to us')
  })

  it('marks only the earliest ribbon touchpoint as first-seen', () => {
    const journey: JourneyInput = {
      ribbon: [
        tp({ id: 'T1', occurredAt: '2026-06-01T00:00:00Z', zeroPhase: 'pre_zero', occurredAtPrecision: 'week' }),
        tp({ id: 'T2', occurredAt: '2026-06-10T00:00:00Z', zeroPhase: 'pre_zero' }),
      ],
      pointZeroAt: null,
      discovery: {
        summary: 'x',
        daysBeforePointZero: null,
        firstSeenViaHandle: false,
        firstChannel: null,
        firstSeenPrecision: 'week',
      },
      handles: {},
    }
    const phases = buildJourneyPhases(journey)
    expect(phases.discovery[0].isFirstSeen).toBe(true)
    expect(phases.discovery[0].occurredAtPrecision).toBe('week')
    expect(phases.discovery[1].isFirstSeen).toBe(false)
  })
})

describe('handleChips', () => {
  it('builds a chip with a working profile URL for a known platform', () => {
    expect(handleChips({ instagram: 'rosie.hoyle' })).toEqual([
      { platform: 'instagram', handle: 'rosie.hoyle', url: 'https://instagram.com/rosie.hoyle' },
    ])
  })

  it('never invents a handle for a platform absent from the map', () => {
    expect(handleChips({ instagram: 'rosie.hoyle', tiktok: undefined })).toEqual([
      { platform: 'instagram', handle: 'rosie.hoyle', url: 'https://instagram.com/rosie.hoyle' },
    ])
  })

  it('returns an empty list for an empty handle map', () => {
    expect(handleChips({})).toEqual([])
  })

  it('builds one chip per platform when a couple has more than one', () => {
    const chips = handleChips({ instagram: 'rosie.hoyle', knot: 'rosie-hoyle-12345' })
    expect(chips).toHaveLength(2)
    expect(chips.find((c) => c.platform === 'knot')?.url).toBe('https://www.theknot.com/rosie-hoyle-12345')
  })
})
