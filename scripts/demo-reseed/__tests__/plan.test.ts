/**
 * Unit tests for the demo-reseed plan builder.
 *
 * The plan is what a dry run prints, so it is also what an operator reads
 * before deciding to write. These tests pin the two orderings that make
 * the replay correct (oldest first; mint before the couple's first
 * signal), the venue scoping on every delete, and the hero's survival.
 */

import { describe, it, expect } from 'vitest'
import { generateDemoDataset } from '../generate'
import { buildReseedPlan, externalIdFor, offsetDate, offsetIso, RESEED_DELETE_TABLES } from '../plan'
import { DEMO_VENUE_IDS, HERO_WEDDING_ID } from '../roster'

const TODAY = '2026-09-09T12:00:00.000Z'
const dataset = generateDemoDataset({ seed: 555, today: TODAY, coupleCount: 60 })
const plan = buildReseedPlan(dataset)

describe('offsetIso', () => {
  it('walks backwards from the given day, not from the real clock', () => {
    expect(offsetIso(TODAY, 0, 9 * 60)).toBe('2026-09-09T09:00:00.000Z')
    expect(offsetIso(TODAY, 1, 9 * 60)).toBe('2026-09-08T09:00:00.000Z')
    expect(offsetIso(TODAY, 30, 0)).toBe('2026-08-10T00:00:00.000Z')
  })

  it('treats a negative offset as the future, for a tour not yet held', () => {
    expect(offsetIso(TODAY, -7, 14 * 60)).toBe('2026-09-16T14:00:00.000Z')
  })

  it('renders a date column as yyyy-mm-dd', () => {
    expect(offsetDate(TODAY, 0)).toBe('2026-09-09')
  })
})

describe('buildReseedPlan — deletes', () => {
  it('scopes every delete to the four demo venues', () => {
    expect(plan.deletes.length).toBe(RESEED_DELETE_TABLES.length)
    for (const op of plan.deletes) {
      expect(op.venueIds).toEqual([...DEMO_VENUE_IDS])
    }
  })

  it('clears the spine before the legacy tables it hangs off', () => {
    const order = plan.deletes.map((d) => d.table)
    expect(order.indexOf('touchpoints')).toBeLessThan(order.indexOf('couples'))
    expect(order.indexOf('couples')).toBeLessThan(order.indexOf('weddings'))
    expect(order.indexOf('people')).toBeLessThan(order.indexOf('weddings'))
    expect(order.indexOf('engagement_events')).toBeLessThan(order.indexOf('weddings'))
  })

  it('spares the couple-portal hero wedding and its people', () => {
    const weddings = plan.deletes.find((d) => d.table === 'weddings')
    const people = plan.deletes.find((d) => d.table === 'people')
    expect(weddings?.keepIds).toEqual([HERO_WEDDING_ID])
    expect(people?.keepWeddingIds).toEqual([HERO_WEDDING_ID])
    expect(plan.preserveWeddingIds).toEqual([HERO_WEDDING_ID])
  })

  it('refuses a venue that is not one of the four', () => {
    expect(() =>
      buildReseedPlan({
        ...dataset,
        venueIds: ['00000000-0000-0000-0000-000000000000'],
      }),
    ).toThrow(/not one of the four Crestwood demo venues/)
  })
})

describe('buildReseedPlan — replay order', () => {
  it('is sorted oldest first', () => {
    for (let i = 1; i < plan.steps.length; i++) {
      expect(plan.steps[i].occurredAt >= plan.steps[i - 1].occurredAt).toBe(true)
    }
  })

  it('mints a story wedding before that story sends its first signal', () => {
    const firstIndex = new Map<string, number>()
    plan.steps.forEach((step, i) => {
      const seen = firstIndex.get(`${step.storyKey}:${step.kind}`)
      if (seen === undefined) firstIndex.set(`${step.storyKey}:${step.kind}`, i)
    })
    for (const story of dataset.stories) {
      const anchor = story.hero
        ? firstIndex.get(`${story.key}:hero_contact_sync`)
        : firstIndex.get(`${story.key}:mint_wedding`)
      const mirror = firstIndex.get(`${story.key}:mirror_couple`)
      const firstSignal = firstIndex.get(`${story.key}:link_signal`)
      expect(anchor).toBeDefined()
      expect(mirror).toBeDefined()
      expect(firstSignal).toBeDefined()
      expect(anchor!).toBeLessThan(mirror!)
      expect(mirror!).toBeLessThan(firstSignal!)
    }
  })

  it('mirrors the couple explicitly, because mintWedding fires its mirror fire-and-forget', () => {
    const mirrors = plan.steps.filter((s) => s.kind === 'mirror_couple')
    expect(mirrors.length).toBe(dataset.stories.length)
  })

  it('updates the wedding state last for every story', () => {
    const lastIndex = new Map<string, number>()
    plan.steps.forEach((step, i) => lastIndex.set(`${step.storyKey}:${step.kind}`, i))
    for (const story of dataset.stories) {
      const state = lastIndex.get(`${story.key}:wedding_state`)!
      const lastSignal = lastIndex.get(`${story.key}:link_signal`)!
      expect(state).toBeGreaterThan(lastSignal)
    }
  })
})

describe('buildReseedPlan — signals', () => {
  const signalSteps = plan.steps.filter((s) => s.kind === 'link_signal')

  it('produces one signal step per generated step', () => {
    const expected = dataset.stories.reduce((sum, s) => sum + s.steps.length, 0)
    expect(signalSteps.length).toBe(expected)
    expect(plan.summary.signals).toBe(expected)
  })

  it('gives every signal a stable external id, which is what makes a re-run a no-op', () => {
    const ids = signalSteps.map((s) => s.signal!.external_id)
    expect(new Set(ids).size).toBe(ids.length)
    const again = buildReseedPlan(generateDemoDataset({ seed: 555, today: TODAY, coupleCount: 60 }))
    const idsAgain = again.steps
      .filter((s) => s.kind === 'link_signal')
      .map((s) => s.signal!.external_id)
    expect(idsAgain).toEqual(ids)
    expect(ids).toContain(externalIdFor(dataset.stories[0], 0))
  })

  it('always hands the matcher a real contact, never a relay address', () => {
    for (const step of signalSteps) {
      const signal = step.signal!
      expect(signal.primary_email).toMatch(/@example\.(com|net|org)$/)
      expect(signal.primary_name).toBeTruthy()
      const raw = signal.raw_payload as Record<string, unknown>
      // Relay channels carry no From header identity, exactly as live
      // ingestion sees them.
      if (['knot', 'weddingwire', 'instagram', 'website'].includes(signal.channel)) {
        expect(raw.raw_from_email ?? null).toBeNull()
      }
    }
  })

  it('anchors every signal to its story wedding so linkSignal takes the fast path', () => {
    for (const step of signalSteps) {
      expect(step.signal!.legacy_wedding_id).toBeTruthy()
    }
    const heroSignals = signalSteps.filter((s) => s.storyKey === 'hero-chloe-ryan')
    expect(heroSignals.length).toBeGreaterThan(0)
    for (const step of heroSignals) {
      expect(step.signal!.legacy_wedding_id).toBe(HERO_WEDDING_ID)
    }
  })

  it('stamps occurred_at from the offset, so the instant moves with the clock', () => {
    const laterPlan = buildReseedPlan(
      generateDemoDataset({ seed: 555, today: '2027-01-09T12:00:00.000Z', coupleCount: 60 }),
    )
    const a = plan.steps.find((s) => s.kind === 'link_signal')!
    const b = laterPlan.steps.find((s) => s.kind === 'link_signal')!
    expect(b.occurredAt).not.toBe(a.occurredAt)
    expect(new Date(b.occurredAt).getTime()).toBeGreaterThan(new Date(a.occurredAt).getTime())
  })
})

describe('buildReseedPlan — heat and lifecycle', () => {
  it('fires heat events only on inbound steps', () => {
    for (const step of plan.steps) {
      if (step.kind !== 'heat_events') continue
      expect(step.heatDirection).toBe('inbound')
    }
  })

  it('reports a heat spread that is not entirely frozen', () => {
    const tiers = plan.summary.byExpectedTier
    expect(tiers.frozen).toBeLessThan(plan.summary.stories)
    expect(tiers.hot + tiers.warm + tiers.cool).toBeGreaterThan(0)
  })

  it('maps each lifecycle to a legal weddings.status', () => {
    const legal = new Set([
      'inquiry',
      'tour_scheduled',
      'tour_completed',
      'proposal_sent',
      'booked',
      'completed',
      'lost',
      'cancelled',
    ])
    for (const step of plan.steps) {
      if (step.kind !== 'wedding_state') continue
      expect(legal.has(step.weddingPatch!.status as string)).toBe(true)
    }
  })

  it('gives a booked story a booked_at and a lost story a lost_at', () => {
    for (const story of dataset.stories) {
      const state = plan.steps.find(
        (s) => s.kind === 'wedding_state' && s.storyKey === story.key,
      )!
      if (story.lifecycle === 'booked' || story.lifecycle === 'completed') {
        expect(state.weddingPatch!.booked_at).toBeTruthy()
      }
      if (story.lifecycle === 'lost') {
        expect(state.weddingPatch!.lost_at).toBeTruthy()
        expect(state.weddingPatch!.lost_reason).toBeTruthy()
      }
    }
  })

  it('leaves a future tour without an outcome', () => {
    for (const step of plan.steps) {
      if (step.kind !== 'tour_row') continue
      const scheduled = new Date(step.row!.scheduled_at as string).getTime()
      if (scheduled > new Date(TODAY).getTime()) {
        expect(step.row!.outcome).toBeNull()
      }
    }
  })
})
