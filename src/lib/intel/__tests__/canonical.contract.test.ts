/**
 * Intel Canonical API — contract shape tests.
 *
 * These verify the SHAPE of each canonical function's return — the
 * contract from INTEL-CANONICAL-API.md — and reject drift.
 *
 * Now that the readers are REAL (they construct a service client for a
 * non-empty venue), these call each function with an EMPTY venueId so they
 * take the honest-empty short-circuit and never touch a database. The
 * honest-empty return has the SAME shape as a populated one, so shape +
 * honesty-primitive assertions still hold. Populated-path behavior is
 * covered by the per-reader unit tests (scripts/test-*-reader.ts /
 * test-*-mapping.ts), which drive the injectable cores with mocks.
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
    const r = await getVenueOverview('')
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
    const def = await getSourceAttribution('')
    expect(def.model).toBe('first_touch') // default
    expect(Array.isArray(def.channels)).toBe(true)
    expect(def).toHaveProperty('topByVolume')
    expect(def).toHaveProperty('topByConversion')

    const ld = await getSourceAttribution('', { model: 'last_touch' })
    expect(ld.model).toBe('last_touch') // model opt honoured even on empty path
  })

  it('getCohortFunnel returns the CohortFunnel shape with honest distributions', async () => {
    const r = await getCohortFunnel('')
    expect(Array.isArray(r.funnel)).toBe(true)
    expectDistribution(r.responseTime)
    expectDistribution(r.leadTime)
    expect(Array.isArray(r.conversionCurve)).toBe(true)
    expect(r.knee === null || typeof r.knee === 'object').toBe(true)
    expect(Array.isArray(r.textPatterns)).toBe(true)
    // operatorAxis is NOT yet wired into the builder (documented in
    // getCohortFunnel), so operatorBreakdown is absent until it is.
    expect(r.operatorBreakdown).toBeUndefined()
  })

  it('getCohortFunnel(operatorAxis) — operatorBreakdown not yet wired (absent)', async () => {
    const r = await getCohortFunnel('', { operatorAxis: true })
    // When the operator axis is implemented this becomes an array; until
    // then the contract is "absent", matching the implementation.
    expect(r.operatorBreakdown).toBeUndefined()
  })

  it('getCoupleJourney returns the CoupleJourney shape', async () => {
    const r = await getCoupleJourney('', '')
    expect(r).toHaveProperty('couple')
    expect(Array.isArray(r.ribbon)).toBe(true)
    expect(Array.isArray(r.progression)).toBe(true)
    expect(r).toHaveProperty('identityProfile')
    expect(Array.isArray(r.lookAlikeCohort)).toBe(true)
  })

  it('getDailyList returns the DailyList shape', async () => {
    const r = await getDailyList('')
    expect(Array.isArray(r.needsReply)).toBe(true)
    expect(Array.isArray(r.goingCold)).toBe(true)
    expect(Array.isArray(r.toursThisWeek)).toBe(true)
    expect(Array.isArray(r.highIntent)).toBe(true)
  })

  it('askIntel returns the IntelAnswer shape and refuses honestly while stubbed', async () => {
    const r = await askIntel('', 'what is my best channel?')
    expect(typeof r.answer).toBe('string')
    expect(Array.isArray(r.evidence)).toBe(true)
    expect(['high', 'hedged', 'refused']).toContain(r.confidence)
    // stub must not fabricate confidence — it refuses
    expect(r.confidence).toBe('refused')
  })
})
