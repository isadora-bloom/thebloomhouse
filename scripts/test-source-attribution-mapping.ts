#!/usr/bin/env tsx
/**
 * Unit test — getSourceAttribution mapping (Phase 3.3 canonical function).
 *
 * `getSourceAttribution` wraps the existing buildCoupleAttribution builder;
 * the LOGIC worth locking is the pure mapping from the builder's per-model
 * ChannelModelCell into the canonical SourceAttribution / Distribution
 * honesty shape. Tested here with a hand-built AttributionResult fixture —
 * no DB, no client. Locks:
 *   - the selected model's cells are read (not another model's);
 *   - cac is converted cents → dollars; conversion + revenuePerDollar pass through;
 *   - Distribution honesty: null value → zero_denominator (n>0) / no_data (n=0);
 *     present-but-insufficient → insufficient_sample;
 *   - topByVolume = max distinctCouples; topByConversion = max rate among
 *     enoughData channels only.
 *
 * Pure. Run: npx tsx scripts/test-source-attribution-mapping.ts
 */
import { mapAttributionToCanonical } from '@/lib/intel/canonical'
import type { AttributionResult, ChannelModelCell } from '@/lib/services/attribution/couple-attribution'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

/** Build a ChannelModelCell with sane defaults; override what matters. */
function cell(over: Partial<ChannelModelCell>): ChannelModelCell {
  return {
    weightedCouples: 0,
    weightedBooked: 0,
    weightedRevenueCents: 0,
    distinctCouples: 0,
    distinctBooked: 0,
    inquiryToBookingRate: null,
    spendCents: null,
    cacCents: null,
    revenuePerDollar: null,
    enoughData: false,
    ...over,
  }
}

const ZERO_MODELS = {
  first_touch: cell({}),
  last_touch: cell({}),
  linear: cell({}),
  time_decay: cell({}),
}

const fixture: AttributionResult = {
  venueId: 'v1',
  generatedAt: '2026-05-01T00:00:00Z',
  timezone: 'UTC',
  meta: {
    coupleCount: 0, coupleBookedCount: 0, acquisitionTouchCount: 0,
    plumbingTouchCount: 0, couplesWithoutAcquisitionTouch: 0,
    marketingSpendAvailable: true, marketingSpendNote: '',
  },
  channels: [
    {
      channel: 'knot',
      isAcquisition: true,
      models: {
        ...ZERO_MODELS,
        // first_touch: healthy channel — 20 couples, 25% conversion, $300 CAC, 4x ROAS
        first_touch: cell({ distinctCouples: 20, distinctBooked: 5, inquiryToBookingRate: 0.25, cacCents: 30000, revenuePerDollar: 4, enoughData: true }),
        // last_touch: same channel but credited differently — proves model selection matters
        last_touch: cell({ distinctCouples: 8, distinctBooked: 1, inquiryToBookingRate: 0.125, enoughData: true }),
      },
    },
    {
      channel: 'google',
      isAcquisition: true,
      models: {
        ...ZERO_MODELS,
        // first_touch: more volume, lower conversion, but enoughData
        first_touch: cell({ distinctCouples: 30, distinctBooked: 3, inquiryToBookingRate: 0.10, cacCents: null, revenuePerDollar: null, enoughData: true }),
      },
    },
    {
      channel: 'instagram',
      isAcquisition: true,
      models: {
        ...ZERO_MODELS,
        // first_touch: tiny sample — high rate but NOT enoughData (should be ignored for topByConversion)
        first_touch: cell({ distinctCouples: 2, distinctBooked: 1, inquiryToBookingRate: 0.50, enoughData: false }),
      },
    },
    {
      channel: 'referral',
      isAcquisition: true,
      models: {
        ...ZERO_MODELS,
        // first_touch: couples present but zero bookings → rate null, n>0
        first_touch: cell({ distinctCouples: 6, distinctBooked: 0, inquiryToBookingRate: null, enoughData: true }),
      },
    },
  ],
  contentMentions: [],
  couples: [],
  modelExplainers: { first_touch: '', last_touch: '', linear: '', time_decay: '' },
}

// --- first_touch model ----------------------------------------------------
{
  const sa = mapAttributionToCanonical(fixture, 'first_touch')
  check('model echoed', sa.model === 'first_touch')
  check('generatedAt passed through from builder', sa.generatedAt === '2026-05-01T00:00:00Z')
  const knot = sa.channels.find((c) => c.channel === 'knot')!
  check('knot n = distinctCouples (20)', knot.n === 20, knot)
  check('knot conversion value pass-through (0.25), enoughData', knot.conversion.value === 0.25 && knot.conversion.enoughData === true, knot.conversion)
  check('knot cac converted cents→dollars (30000→300)', knot.cac.value === 300, knot.cac)
  check('knot cac n = distinctBooked (5)', knot.cac.n === 5, knot.cac)
  check('knot revenuePerDollar pass-through (4)', knot.revenuePerDollar.value === 4, knot.revenuePerDollar)

  const google = sa.channels.find((c) => c.channel === 'google')!
  check('google cac null → no_data/zero_denominator reason (no spend)', google.cac.value === null && google.cac.enoughData === false, google.cac)

  const referral = sa.channels.find((c) => c.channel === 'referral')!
  check('referral conversion null with n>0 → zero_denominator', referral.conversion.value === null && referral.conversion.reason === 'zero_denominator', referral.conversion)

  const ig = sa.channels.find((c) => c.channel === 'instagram')!
  check('instagram present-but-insufficient → enoughData false + insufficient_sample', ig.conversion.value === 0.5 && ig.conversion.enoughData === false && ig.conversion.reason === 'insufficient_sample', ig.conversion)

  check('topByVolume = google (30 couples)', sa.topByVolume === 'google', sa.topByVolume)
  check('topByConversion = knot (0.25; ignores instagram 0.50 — not enoughData)', sa.topByConversion === 'knot', sa.topByConversion)
}

// --- last_touch model selects different cells -----------------------------
{
  const sa = mapAttributionToCanonical(fixture, 'last_touch')
  const knot = sa.channels.find((c) => c.channel === 'knot')!
  check('last_touch reads its own cell (knot n=8, conv 0.125)', knot.n === 8 && knot.conversion.value === 0.125, knot)
  check('last_touch topByVolume = knot (only channel with last_touch credit)', sa.topByVolume === 'knot', sa.topByVolume)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — getSourceAttribution mapping`)
process.exit(failures === 0 ? 0 : 1)
