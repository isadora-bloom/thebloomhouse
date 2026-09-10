/**
 * Unit tests for the demo-reseed generator.
 *
 * The generator is pure, so these tests are the real safety net: they pin
 * determinism, the fictional-identity rules, and the property the whole
 * workstream exists for — that heat is expressed as offsets and therefore
 * does not read Frozen across the board on whatever day the script runs.
 */

import { describe, it, expect } from 'vitest'
import { generateDemoDataset, predictHeat } from '../generate'
import {
  DEMO_VENUE_IDS,
  FORBIDDEN_EMAIL_FRAGMENTS,
  HERO_WEDDING_ID,
} from '../roster'

const TODAY = '2026-09-09T12:00:00.000Z'

describe('generateDemoDataset', () => {
  it('is deterministic for a given seed and clock', () => {
    const a = generateDemoDataset({ seed: 4242, today: TODAY })
    const b = generateDemoDataset({ seed: 4242, today: TODAY })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('produces a different roster for a different seed', () => {
    const a = generateDemoDataset({ seed: 1, today: TODAY })
    const b = generateDemoDataset({ seed: 2, today: TODAY })
    // The hero is pinned in both, so compare the generated remainder.
    const keysA = a.stories.filter((s) => !s.hero).map((s) => s.key)
    const keysB = b.stories.filter((s) => !s.hero).map((s) => s.key)
    expect(keysA).not.toEqual(keysB)
  })

  it('produces about sixty couples across the four demo venues', () => {
    const ds = generateDemoDataset({ seed: 7, today: TODAY, coupleCount: 60 })
    expect(ds.stories.length).toBeGreaterThanOrEqual(55)
    expect(ds.stories.length).toBeLessThanOrEqual(65)
    const venues = new Set(ds.stories.map((s) => s.venueId))
    expect([...venues].sort()).toEqual([...DEMO_VENUE_IDS].sort())
  })

  it('weights the roster towards Hawthorne', () => {
    const ds = generateDemoDataset({ seed: 7, today: TODAY })
    const counts = new Map<string, number>()
    for (const s of ds.stories) counts.set(s.venueId, (counts.get(s.venueId) ?? 0) + 1)
    const hawthorne = counts.get(DEMO_VENUE_IDS[0]) ?? 0
    for (const id of DEMO_VENUE_IDS.slice(1)) {
      expect(hawthorne).toBeGreaterThan(counts.get(id) ?? 0)
    }
  })

  it('never emits a real or relay email address', () => {
    const ds = generateDemoDataset({ seed: 11, today: TODAY })
    const addresses = ds.stories.flatMap((s) =>
      [s.primaryEmail, s.partnerEmail].filter((e): e is string => Boolean(e)),
    )
    expect(addresses.length).toBeGreaterThan(0)
    for (const address of addresses) {
      expect(address).toMatch(/@example\.(com|net|org)$/)
      for (const fragment of FORBIDDEN_EMAIL_FRAGMENTS) {
        expect(address.toLowerCase()).not.toContain(fragment)
      }
    }
  })

  it('carries no rixeymanor reference anywhere in the dataset', () => {
    const ds = generateDemoDataset({ seed: 12, today: TODAY })
    expect(JSON.stringify(ds).toLowerCase()).not.toContain('rixey')
  })

  it('covers every lifecycle state', () => {
    const ds = generateDemoDataset({ seed: 13, today: TODAY, coupleCount: 60 })
    const seen = new Set(ds.stories.map((s) => s.lifecycle))
    for (const state of ['inquiry', 'tour_booked', 'toured', 'booked', 'lost', 'completed']) {
      expect(seen.has(state as never)).toBe(true)
    }
  })

  it('mixes channels rather than routing everything through one', () => {
    const ds = generateDemoDataset({ seed: 14, today: TODAY })
    const originChannels = new Set(ds.stories.map((s) => s.steps[0].channel))
    expect(originChannels.size).toBeGreaterThanOrEqual(4)
  })

  it('pins the couple-portal hero to its existing wedding id', () => {
    const ds = generateDemoDataset({ seed: 15, today: TODAY })
    const heroes = ds.stories.filter((s) => s.hero)
    expect(heroes).toHaveLength(1)
    expect(heroes[0].pinnedWeddingId).toBe(HERO_WEDDING_ID)
    expect(heroes[0].venueId).toBe(DEMO_VENUE_IDS[0])
    expect(heroes[0].lifecycle).toBe('booked')
  })

  it('expresses every date as an offset, never a calendar date', () => {
    const ds = generateDemoDataset({ seed: 16, today: TODAY })
    const serialised = JSON.stringify(ds.stories)
    // A four-digit year would mean a date got baked in. `today` lives on
    // the dataset, not on a story.
    expect(serialised).not.toMatch(/20\d\d-\d\d-\d\d/)
    for (const story of ds.stories) {
      expect(Number.isFinite(story.inquiryDaysAgo)).toBe(true)
      for (const step of story.steps) {
        expect(Number.isFinite(step.daysAgo)).toBe(true)
      }
    }
  })

  it('orders each story oldest first, because linkSignal mints on the first signal', () => {
    const ds = generateDemoDataset({ seed: 17, today: TODAY })
    for (const story of ds.stories) {
      for (let i = 1; i < story.steps.length; i++) {
        expect(story.steps[i].daysAgo).toBeLessThanOrEqual(story.steps[i - 1].daysAgo)
      }
    }
  })

  it('gives every story an opening inquiry that scores heat', () => {
    const ds = generateDemoDataset({ seed: 18, today: TODAY })
    for (const story of ds.stories) {
      const first = story.steps[0]
      expect(first.direction).toBe('inbound')
      expect(first.heatEvents).toContain('initial_inquiry')
    }
  })

  it('does not leave the whole demo frozen', () => {
    const ds = generateDemoDataset({ seed: 19, today: TODAY, coupleCount: 60 })
    const tiers = { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0 }
    for (const s of ds.stories) tiers[s.expectedTier]++
    expect(tiers.frozen).toBeLessThan(ds.stories.length)
    expect(tiers.hot + tiers.warm + tiers.cool).toBeGreaterThanOrEqual(10)
    // And some genuinely are frozen — a venue where nothing ever goes
    // quiet is not a believable demo either.
    expect(tiers.frozen).toBeGreaterThan(0)
  })

  it('keeps the expected-heat spread stable as the clock moves', () => {
    // The regression finding 5 describes: run the same seed six months
    // later and the old seed reads all Frozen. Offsets must not.
    const now = generateDemoDataset({ seed: 21, today: TODAY, coupleCount: 60 })
    const later = generateDemoDataset({
      seed: 21,
      today: '2027-03-09T12:00:00.000Z',
      coupleCount: 60,
    })
    const liveNow = now.stories.filter((s) => s.expectedTier !== 'frozen').length
    const liveLater = later.stories.filter((s) => s.expectedTier !== 'frozen').length
    expect(liveLater).toBe(liveNow)
  })
})

describe('predictHeat', () => {
  it('uses the 0.98-per-day decay the wedding_heat view uses', () => {
    const fresh = predictHeat([
      {
        daysAgo: 0,
        minuteOfDay: 600,
        channel: 'gmail',
        actionType: 'reply',
        signalTier: 'high',
        direction: 'inbound',
        bodyText: '',
        heatEvents: ['initial_inquiry'],
      },
    ])
    expect(fresh).toBe(40)

    const old = predictHeat([
      {
        daysAgo: 150,
        minuteOfDay: 600,
        channel: 'gmail',
        actionType: 'reply',
        signalTier: 'high',
        direction: 'inbound',
        bodyText: '',
        heatEvents: ['initial_inquiry'],
      },
    ])
    expect(old).toBe(Math.round(40 * Math.pow(0.98, 150)))
    expect(old).toBeLessThan(20)
  })

  it('ignores outbound steps, the way the view filters on direction', () => {
    const score = predictHeat([
      {
        daysAgo: 0,
        minuteOfDay: 600,
        channel: 'gmail',
        actionType: 'venue_sent',
        signalTier: 'medium',
        direction: 'outbound',
        bodyText: '',
        heatEvents: ['initial_inquiry'],
      },
    ])
    expect(score).toBe(0)
  })

  it('clamps to 100', () => {
    const score = predictHeat([
      {
        daysAgo: 0,
        minuteOfDay: 600,
        channel: 'gmail',
        actionType: 'reply',
        signalTier: 'high',
        direction: 'inbound',
        bodyText: '',
        heatEvents: ['contract_signed', 'contract_sent', 'tour_completed', 'initial_inquiry'],
      },
    ])
    expect(score).toBe(100)
  })
})
