/**
 * Intel Canonical API — contract shape tests.
 *
 * Day 4-5 of CONSOLIDATION-PLAN-25-DAY-ANCHORED.md. These verify the
 * SHAPE of each canonical function's return — the contract from
 * INTEL-CANONICAL-API.md. They run against the STUBS now; when Days
 * 14-16 fill in the real implementations, these same tests reject any
 * implementation that drifts from the contract.
 *
 * They deliberately do NOT assert on data values (the stubs return
 * empty) — only on shape + the honesty primitives (n, enoughData).
 */

import { describe, it, expect } from 'vitest'
import {
  getVenueOverview,
  getSourceAttribution,
  getCohortFunnel,
  getCoupleJourney,
  getDailyList,
  askIntel,
  type Distribution,
} from '../canonical'

const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

/** Every Distribution must carry the honesty primitives. */
function expectDistribution(d: Distribution) {
  expect(d).toHaveProperty('value')
  expect(typeof d.n).toBe('number')
  expect(typeof d.enoughData).toBe('boolean')
  // value is number | null — never undefined, never NaN
  expect(d.value === null || typeof d.value === 'number').toBe(true)
}

describe('Intel Canonical API — contract shape', () => {
  it('getVenueOverview returns the VenueOverview shape', async () => {
    const r = await getVenueOverview(VENUE)
    expect(r.couples).toHaveProperty('total')
    expect(typeof r.couples.total).toBe('number')
    // byLifecycle must carry all six lifecycle states
    for (const k of ['channel_scoped', 'resolved', 'booked', 'completed', 'ghost', 'agent']) {
      expect(r.couples.byLifecycle).toHaveProperty(k)
    }
    expect(Array.isArray(r.recentActivity)).toBe(true)
    expect(r.dataMaturity).toHaveProperty('backfillStatus')
    expect(typeof r.dataMaturity.n).toBe('number')
    expect(typeof r.generatedAt).toBe('string')
  })

  it('getSourceAttribution returns the SourceAttribution shape + honours the model opt', async () => {
    const def = await getSourceAttribution(VENUE)
    expect(def.model).toBe('first_touch') // default
    expect(Array.isArray(def.channels)).toBe(true)
    expect(def).toHaveProperty('topByVolume')
    expect(def).toHaveProperty('topByConversion')

    const ld = await getSourceAttribution(VENUE, { model: 'last_touch' })
    expect(ld.model).toBe('last_touch')
  })

  it('getCohortFunnel returns the CohortFunnel shape with honest distributions', async () => {
    const r = await getCohortFunnel(VENUE)
    expect(Array.isArray(r.funnel)).toBe(true)
    expectDistribution(r.responseTime)
    expectDistribution(r.leadTime)
    expect(Array.isArray(r.conversionCurve)).toBe(true)
    expect(r.knee === null || typeof r.knee === 'object').toBe(true)
    expect(Array.isArray(r.textPatterns)).toBe(true)
    // operatorBreakdown is present ONLY when operatorAxis is requested
    expect(r.operatorBreakdown).toBeUndefined()
  })

  it('getCohortFunnel(operatorAxis) adds operatorBreakdown', async () => {
    const r = await getCohortFunnel(VENUE, { operatorAxis: true })
    expect(Array.isArray(r.operatorBreakdown)).toBe(true)
  })

  it('getCoupleJourney returns the CoupleJourney shape', async () => {
    const r = await getCoupleJourney(VENUE, 'some-couple-id')
    expect(r).toHaveProperty('couple')
    expect(Array.isArray(r.ribbon)).toBe(true)
    expect(Array.isArray(r.progression)).toBe(true)
    expect(r).toHaveProperty('identityProfile')
    expect(Array.isArray(r.lookAlikeCohort)).toBe(true)
  })

  it('getDailyList returns the DailyList shape', async () => {
    const r = await getDailyList(VENUE)
    expect(Array.isArray(r.needsReply)).toBe(true)
    expect(Array.isArray(r.goingCold)).toBe(true)
    expect(Array.isArray(r.toursThisWeek)).toBe(true)
    expect(Array.isArray(r.highIntent)).toBe(true)
  })

  it('askIntel returns the IntelAnswer shape and refuses honestly while stubbed', async () => {
    const r = await askIntel(VENUE, 'what is my best channel?')
    expect(typeof r.answer).toBe('string')
    expect(Array.isArray(r.evidence)).toBe(true)
    expect(['high', 'hedged', 'refused']).toContain(r.confidence)
    // stub must not fabricate confidence — it refuses
    expect(r.confidence).toBe('refused')
  })
})
