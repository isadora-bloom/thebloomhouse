#!/usr/bin/env tsx
/**
 * Unit test — getCohortFunnel mapping (Phase 3.3 canonical function).
 *
 * getCohortFunnel wraps the existing buildCohortIntel assembler; the LOGIC
 * worth locking is the pure mapping from CohortIntel into the canonical
 * CohortFunnel shape. Tested with a hand-built CohortIntel fixture — no DB.
 * Locks:
 *   - funnel stage label → stage, count → n;
 *   - responseTime / leadTime: cohort median → canonical value; enoughData
 *     carries; median-null → no_data; present-but-below-gate → insufficient_sample;
 *   - conversionCurve drops bands with null tour rate (not plotted as 0);
 *   - knee resolved from kneeBandIndex with the rate dropoff into the next band;
 *   - textPatterns: family label → theme, summed monthly mentions → count,
 *     trend mapped (rising→rising, declining→falling, steady→flat).
 *
 * Pure. Run: npx tsx scripts/test-cohort-funnel-mapping.ts
 */
import { mapCohortIntelToFunnel } from '@/lib/intel/canonical'
import type { CohortIntel } from '@/lib/services/cohort'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

const intel = {
  generatedAt: '2026-05-01T00:00:00Z',
  funnel: {
    overall: [
      { key: 'inquiry', label: 'Inquiry', count: 100, fromPrevious: null, fromInquiry: 1 },
      { key: 'booked', label: 'Booked', count: 20, fromPrevious: 0.5, fromInquiry: 0.2 },
    ],
  },
  responseTime: { overall: { n: 40, enoughData: true, median: 6.5 } },
  leadTime: { dist: { n: 3, enoughData: false, median: 300 } },
  curve: {
    bands: [
      { label: '<1h', lowerHours: 0, upperHours: 1, couples: 30, touredRate: 0.5 },
      { label: '1-4h', lowerHours: 1, upperHours: 4, couples: 25, touredRate: 0.4 },
      { label: '4-24h', lowerHours: 4, upperHours: 24, couples: 10, touredRate: 0.1 },
      { label: '>24h', lowerHours: 24, upperHours: null, couples: 2, touredRate: null },
    ],
    kneeBandIndex: 1,
  },
  textPatterns: {
    families: [
      { family: 'pricing', label: 'Pricing', monthly: [{ month: '2026-01', mentions: 5, inboundTotal: 50 }, { month: '2026-02', mentions: 7, inboundTotal: 60 }], trend: 'rising' },
      { family: 'catering', label: 'Catering', monthly: [{ month: '2026-01', mentions: 2, inboundTotal: 50 }], trend: 'declining' },
      { family: 'dates', label: 'Dates', monthly: [{ month: '2026-01', mentions: 3, inboundTotal: 50 }], trend: 'steady' },
    ],
  },
} as unknown as CohortIntel

const f = mapCohortIntelToFunnel(intel)

check('generatedAt passes through', f.generatedAt === '2026-05-01T00:00:00Z')
check('funnel maps label→stage, count→n', f.funnel.length === 2 && f.funnel[0].stage === 'Inquiry' && f.funnel[0].n === 100 && f.funnel[1].n === 20, f.funnel)

check('responseTime value = median, enoughData true', f.responseTime.value === 6.5 && f.responseTime.n === 40 && f.responseTime.enoughData === true, f.responseTime)
check('leadTime present-but-below-gate → insufficient_sample', f.leadTime.value === 300 && f.leadTime.enoughData === false && f.leadTime.reason === 'insufficient_sample', f.leadTime)

check('conversionCurve drops null-rate band (3 of 4)', f.conversionCurve.length === 3, f.conversionCurve)
check('conversionCurve x=lowerHours y=touredRate', f.conversionCurve[0].x === 0 && f.conversionCurve[0].y === 0.5, f.conversionCurve[0])
check('no null-rate point present', f.conversionCurve.every((p) => typeof p.y === 'number'), f.conversionCurve)

check('knee responseHours = knee band upperHours (4)', f.knee?.responseHours === 4, f.knee)
check('knee dropoffAfter = 0.4 - 0.1 = 0.3', f.knee?.dropoffAfter === 0.3, f.knee)

const pricing = f.textPatterns.find((t) => t.theme === 'Pricing')!
const catering = f.textPatterns.find((t) => t.theme === 'Catering')!
const dates = f.textPatterns.find((t) => t.theme === 'Dates')!
check('textPattern count = summed monthly mentions (5+7=12)', pricing.count === 12, pricing)
check('trend rising → rising', pricing.trend === 'rising', pricing)
check('trend declining → falling', catering.trend === 'falling', catering)
check('trend steady → flat', dates.trend === 'flat', dates)

// no_data path: median null
const empty = mapCohortIntelToFunnel({
  ...intel,
  responseTime: { overall: { n: 0, enoughData: false, median: null } },
} as unknown as CohortIntel)
check('median null → value null + no_data', empty.responseTime.value === null && empty.responseTime.reason === 'no_data', empty.responseTime)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — getCohortFunnel mapping`)
process.exit(failures === 0 ? 0 : 1)
