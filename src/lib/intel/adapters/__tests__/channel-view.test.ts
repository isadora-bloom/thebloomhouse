/**
 * Channel-truth view — the shape both /intel/sources and
 * /intel/attribution render.
 *
 * The point of these tests is that the view is a pure function of one
 * SourceAttribution. Give the same reader output to both pages and they
 * get the same rows, the same leaders and the same withheld cells. If
 * anyone reintroduces a rate calculation here, these break.
 */

import { describe, it, expect } from 'vitest'
import type { Distribution, SourceAttribution } from '@/lib/intel/canonical'
import {
  UNKNOWN_ACQUISITION_CHANNEL,
  buildChannelTruthView,
  channelTruthHeadline,
} from '../channel-view'
import { WITHHELD } from '../honesty'

function d(value: number | null, n: number, enoughData: boolean): Distribution {
  if (value === null) {
    return { value: null, n, enoughData: false, reason: n > 0 ? 'zero_denominator' : 'no_data' }
  }
  return enoughData
    ? { value, n, enoughData: true }
    : { value, n, enoughData: false, reason: 'insufficient_sample' }
}

const fixture: SourceAttribution = {
  model: 'first_touch',
  channels: [
    {
      channel: 'the_knot',
      n: 40,
      conversion: d(0.1, 40, true),
      cac: d(900, 4, true),
      revenuePerDollar: d(4.2, 40, true),
    },
    {
      channel: 'instagram',
      n: 12,
      conversion: d(0.25, 12, true),
      cac: d(null, 3, false),
      revenuePerDollar: d(null, 12, false),
    },
    {
      channel: 'zola',
      n: 3,
      conversion: d(0.66, 3, false),
      cac: d(null, 2, false),
      revenuePerDollar: d(null, 3, false),
    },
    {
      channel: UNKNOWN_ACQUISITION_CHANNEL,
      n: 90,
      conversion: d(null, 90, false),
      cac: d(null, 0, false),
      revenuePerDollar: d(null, 0, false),
    },
  ],
  topByVolume: 'the_knot',
  topByConversion: 'instagram',
  generatedAt: '2026-09-08T12:00:00.000Z',
}

describe('buildChannelTruthView', () => {
  it('passes the reader leaders straight through rather than recomputing', () => {
    const v = buildChannelTruthView(fixture)
    expect(v.topByVolume).toBe('the_knot')
    expect(v.topByConversion).toBe('instagram')
    expect(v.volumeDivergesFromConversion).toBe(true)
  })

  it('never lets the unattributed bucket win a leader badge, even at the highest n', () => {
    const v = buildChannelTruthView(fixture)
    const unattributed = v.rows.find((r) => r.isUnattributed)!
    expect(unattributed.n).toBe(90)
    expect(unattributed.isVolumeLeader).toBe(false)
    expect(unattributed.isConversionLeader).toBe(false)
  })

  it('sorts by volume and pushes the unattributed bucket last', () => {
    const v = buildChannelTruthView(fixture)
    expect(v.rows.map((r) => r.channel)).toEqual([
      'the_knot',
      'instagram',
      'zola',
      UNKNOWN_ACQUISITION_CHANNEL,
    ])
  })

  it('withholds a below-floor conversion by default and shows it in the audit view', () => {
    const spending = buildChannelTruthView(fixture)
    const auditing = buildChannelTruthView(fixture, { showWithheldValues: true })
    const zolaSpending = spending.rows.find((r) => r.channel === 'zola')!
    const zolaAuditing = auditing.rows.find((r) => r.channel === 'zola')!
    expect(zolaSpending.conversion.text).toBe(WITHHELD)
    expect(zolaAuditing.conversion.text).toBe('66%')
    // Both dim it: the audit view shows the number, it does not trust it.
    expect(zolaSpending.conversion.dim).toBe(true)
    expect(zolaAuditing.conversion.dim).toBe(true)
  })

  it('totals credits rather than couples, and says so via the number', () => {
    const v = buildChannelTruthView(fixture)
    expect(v.totalCredits).toBe(40 + 12 + 3 + 90)
  })

  it('summarises how many channels cleared the floor', () => {
    const v = buildChannelTruthView(fixture)
    expect(v.sufficiency.total).toBe(4)
    expect(v.sufficiency.enough).toBe(2)
    expect(v.sufficiency.maxN).toBe(90)
  })

  it('is a pure function of the attribution — same input, identical output', () => {
    const a = buildChannelTruthView(fixture)
    const b = buildChannelTruthView(fixture)
    expect(a.rows).toEqual(b.rows)
    expect(a.generatedAt).toBe(b.generatedAt)
  })

  it('carries the reader generatedAt through unchanged', () => {
    expect(buildChannelTruthView(fixture).generatedAt).toBe('2026-09-08T12:00:00.000Z')
  })
})

describe('channelTruthHeadline', () => {
  it('says volume is not conversion when the leaders differ', () => {
    const headline = channelTruthHeadline(buildChannelTruthView(fixture))
    expect(headline).toContain('Volume is not conversion')
  })

  it('says so plainly when one channel leads both', () => {
    const same: SourceAttribution = { ...fixture, topByConversion: 'the_knot' }
    const headline = channelTruthHeadline(buildChannelTruthView(same))
    expect(headline).toContain('leads on both')
  })

  it('claims no leader when nothing has cleared its floor', () => {
    const thin: SourceAttribution = {
      ...fixture,
      topByVolume: null,
      topByConversion: null,
    }
    expect(channelTruthHeadline(buildChannelTruthView(thin))).toContain(
      'no leader is claimed',
    )
  })

  it('does not invent a conversion leader when only volume is known', () => {
    const volumeOnly: SourceAttribution = { ...fixture, topByConversion: null }
    const headline = channelTruthHeadline(buildChannelTruthView(volumeOnly))
    expect(headline).toContain('No channel has enough booked couples yet')
  })

  it('handles an empty channel list without a leader claim', () => {
    const empty: SourceAttribution = {
      ...fixture,
      channels: [],
      topByVolume: null,
      topByConversion: null,
    }
    expect(channelTruthHeadline(buildChannelTruthView(empty))).toContain(
      'No channels credited yet',
    )
  })
})
