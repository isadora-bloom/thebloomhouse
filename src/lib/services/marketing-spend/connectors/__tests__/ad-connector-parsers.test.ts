/**
 * W54. The three ad platforms' reporting shapes, and the rules around
 * them.
 *
 * Every fixture below is the documented response shape for its platform,
 * written out by hand. Nothing here touches the network or a database.
 * What is under test is the part that is easy to get subtly wrong and
 * impossible to notice afterwards: a spend figure off by a factor of a
 * hundred, a day shifted by one, a conversion count inflated by counting
 * video views as enquiries.
 */

import { describe, it, expect } from 'vitest'
import {
  parseGoogleAdsResponse,
  buildCampaignQuery,
  normaliseCustomerId,
} from '../google-ads'
import {
  parseMetaInsightsResponse,
  countLeadActions,
  parseMetaAdAccounts,
  metaTokenNeedsExtending,
  buildInsightsUrl,
} from '../meta-ads'
import {
  parseTikTokReportResponse,
  parseTikTokTokenResponse,
  parseTikTokAdvertisers,
  readTikTokEnvelope,
  tiktokStatDay,
  tiktokTokenNeedsRefresh,
  buildReportUrl,
} from '../tiktok-ads'
import {
  decimalToCents,
  microsToCents,
  defaultWindow,
  resolveWindow,
  statusFromConnection,
  resolveStoredToken,
  countDays,
  PROVIDER_CHANNEL,
} from '../shared'

// ---------------------------------------------------------------------------
// Google Ads
// ---------------------------------------------------------------------------

/** Documented search-stream shape: an array of chunks of results. */
const GOOGLE_FIXTURE = [
  {
    results: [
      {
        campaign: { id: '111', name: 'Brand search' },
        segments: { date: '2026-09-10' },
        metrics: {
          costMicros: '4230000',
          impressions: '1204',
          clicks: '48',
          conversions: 2.5,
        },
        customer: { currencyCode: 'USD' },
      },
      {
        campaign: { id: '222', name: 'Venue tours' },
        segments: { date: '2026-09-10' },
        metrics: {
          costMicros: '1000000',
          impressions: '300',
          clicks: '9',
          conversions: 0,
        },
        customer: { currencyCode: 'USD' },
      },
    ],
    fieldMask: 'campaign.id,campaign.name,segments.date',
  },
  {
    results: [
      {
        campaign: { id: '111', name: 'Brand search' },
        segments: { date: '2026-09-11' },
        metrics: {
          costMicros: '2115000',
          impressions: '600',
          clicks: '21',
          conversions: 1,
        },
        customer: { currencyCode: 'USD' },
      },
    ],
  },
]

describe('Google Ads reporting', () => {
  it('turns a search-stream response into one row per campaign per day', () => {
    const rows = parseGoogleAdsResponse(GOOGLE_FIXTURE)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      spendDate: '2026-09-10',
      campaignId: '111',
      campaignName: 'Brand search',
      // 4,230,000 micros is $4.23, which is 423 cents.
      amountCents: 423,
      impressions: 1204,
      clicks: 48,
      conversions: 2.5,
      currency: 'USD',
    })
    expect(countDays(rows)).toBe(2)
  })

  it('accepts the non-streaming single-object shape too', () => {
    const rows = parseGoogleAdsResponse({ results: GOOGLE_FIXTURE[0].results })
    expect(rows).toHaveLength(2)
  })

  it('drops a row with no date rather than guessing one', () => {
    const rows = parseGoogleAdsResponse([
      {
        results: [
          {
            campaign: { id: '1' },
            segments: {},
            metrics: { costMicros: '900000' },
          },
        ],
      },
    ])
    expect(rows).toEqual([])
  })

  it('survives an empty or malformed body without throwing', () => {
    expect(parseGoogleAdsResponse(null)).toEqual([])
    expect(parseGoogleAdsResponse([])).toEqual([])
    expect(parseGoogleAdsResponse({ results: 'not an array' })).toEqual([])
  })

  it('asks for the campaign grain segmented by date', () => {
    const q = buildCampaignQuery('2026-09-01', '2026-09-03')
    expect(q).toContain('segments.date')
    expect(q).toContain('metrics.cost_micros')
    expect(q).toContain("BETWEEN '2026-09-01' AND '2026-09-03'")
  })

  it('accepts the account id in either form Google shows it', () => {
    expect(normaliseCustomerId('123-456-7890')).toBe('1234567890')
    expect(normaliseCustomerId('1234567890')).toBe('1234567890')
    expect(normaliseCustomerId('  ')).toBeNull()
    expect(normaliseCustomerId(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Meta Ads
// ---------------------------------------------------------------------------

/** Documented insights shape with time_increment=1. */
const META_FIXTURE = {
  data: [
    {
      date_start: '2026-09-10',
      date_stop: '2026-09-10',
      campaign_id: '2390',
      campaign_name: 'Autumn open day',
      spend: '84.19',
      impressions: '15230',
      clicks: '412',
      account_currency: 'USD',
      actions: [
        { action_type: 'video_view', value: '3100' },
        { action_type: 'lead', value: '6' },
        { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
        { action_type: 'post_engagement', value: '211' },
      ],
    },
    {
      date_start: '2026-09-11',
      date_stop: '2026-09-11',
      campaign_id: '2390',
      campaign_name: 'Autumn open day',
      spend: '0',
      impressions: '0',
      clicks: '0',
      account_currency: 'USD',
      actions: [],
    },
  ],
  paging: { cursors: { before: 'x', after: 'y' } },
}

describe('Meta Ads reporting', () => {
  it('turns an insights response into one row per campaign per day', () => {
    const rows = parseMetaInsightsResponse(META_FIXTURE)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      spendDate: '2026-09-10',
      campaignId: '2390',
      campaignName: 'Autumn open day',
      amountCents: 8419,
      impressions: 15230,
      clicks: 412,
      conversions: 8,
      currency: 'USD',
    })
  })

  it('counts only the lead-shaped actions, not every action Meta lists', () => {
    // 3,100 video views and 211 post engagements are in the fixture. If
    // they were counted the number would be 3,319 and every cost per
    // enquiry on the page would read as a fraction of the truth.
    expect(countLeadActions(META_FIXTURE.data[0].actions)).toBe(8)
    expect(countLeadActions([{ action_type: 'video_view', value: '900' }])).toBe(0)
    expect(countLeadActions(undefined)).toBe(0)
    expect(countLeadActions('nonsense')).toBe(0)
  })

  it('keeps a zero-spend day rather than dropping it', () => {
    const rows = parseMetaInsightsResponse(META_FIXTURE)
    expect(rows[1].amountCents).toBe(0)
    expect(rows[1].spendDate).toBe('2026-09-11')
  })

  it('survives an empty or malformed body without throwing', () => {
    expect(parseMetaInsightsResponse(null)).toEqual([])
    expect(parseMetaInsightsResponse({ data: null })).toEqual([])
    expect(parseMetaInsightsResponse({ error: { message: 'nope' } })).toEqual([])
  })

  it('reads the ad accounts a grant reaches, with or without the act_ prefix', () => {
    const accounts = parseMetaAdAccounts({
      data: [
        { id: 'act_778899', account_id: '778899', name: 'Crestwood', business: { id: '55' } },
        { id: 'act_112233', name: 'Second account' },
      ],
    })
    expect(accounts[0]).toEqual({ id: '778899', name: 'Crestwood', businessId: '55' })
    expect(accounts[1].id).toBe('112233')
  })

  it('asks for the daily grain, not the window total', () => {
    const url = buildInsightsUrl({
      adAccountId: '778899',
      since: '2026-09-10',
      until: '2026-09-12',
    })
    expect(url).toContain('/act_778899/insights')
    expect(url).toContain('time_increment=1')
    expect(url).toContain('level=campaign')
    expect(decodeURIComponent(url)).toContain('{"since":"2026-09-10","until":"2026-09-12"}')
  })
})

// ---------------------------------------------------------------------------
// TikTok Ads
// ---------------------------------------------------------------------------

const TIKTOK_FIXTURE = {
  code: 0,
  message: 'OK',
  data: {
    list: [
      {
        dimensions: { campaign_id: '17700', stat_time_day: '2026-09-10 00:00:00' },
        metrics: {
          campaign_name: 'Reels reach',
          spend: '52.40',
          impressions: '90210',
          clicks: '1204',
          conversion: '4',
        },
      },
      {
        dimensions: { campaign_id: '17700', stat_time_day: '2026-09-11 00:00:00' },
        metrics: {
          campaign_name: 'Reels reach',
          spend: '48.00',
          impressions: '81000',
          clicks: '990',
          conversion: '3',
        },
      },
    ],
    page_info: { page: 1, page_size: 1000, total_number: 2, total_page: 1 },
  },
}

describe('TikTok Ads reporting', () => {
  it('turns a report response into one row per campaign per day', () => {
    const rows = parseTikTokReportResponse(TIKTOK_FIXTURE, 'GBP')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      spendDate: '2026-09-10',
      campaignId: '17700',
      campaignName: 'Reels reach',
      amountCents: 5240,
      impressions: 90210,
      clicks: 1204,
      conversions: 4,
      currency: 'GBP',
    })
  })

  it('treats a non-zero code as a refusal, not as a quiet day', () => {
    // This is the trap worth guarding. TikTok answers HTTP 200 with an
    // error in the body, and a reader that only checked resp.ok would
    // record a day of no spend that in fact never got asked for.
    const refused = { code: 40001, message: 'Advertiser not authorized', data: null }
    expect(readTikTokEnvelope(refused).ok).toBe(false)
    expect(readTikTokEnvelope(refused).message).toBe('Advertiser not authorized')
    expect(parseTikTokReportResponse(refused)).toEqual([])
    expect(readTikTokEnvelope(TIKTOK_FIXTURE).ok).toBe(true)
  })

  it('takes the day off the front of stat_time_day', () => {
    expect(tiktokStatDay('2026-09-10 00:00:00')).toBe('2026-09-10')
    expect(tiktokStatDay('2026-09-10')).toBe('2026-09-10')
    expect(tiktokStatDay('not a date')).toBeNull()
    expect(tiktokStatDay(null)).toBeNull()
  })

  it('reads the tokens and advertiser ids out of a grant response', () => {
    const tokens = parseTikTokTokenResponse(
      {
        code: 0,
        message: 'OK',
        data: {
          access_token: 'tok-live',
          refresh_token: 'ref-live',
          expires_in: 86400,
          refresh_token_expires_in: 31536000,
          advertiser_ids: ['7012345678901234567'],
          scope: ['Ad Account Management', 'Reporting'],
        },
      },
      Date.parse('2026-09-14T00:00:00Z'),
    )
    expect(tokens?.accessToken).toBe('tok-live')
    expect(tokens?.refreshToken).toBe('ref-live')
    expect(tokens?.advertiserIds).toEqual(['7012345678901234567'])
    expect(tokens?.expiresAt).toBe('2026-09-15T00:00:00.000Z')
    expect(tokens?.scope).toBe('Ad Account Management,Reporting')
  })

  it('returns nothing from a refused grant response', () => {
    expect(parseTikTokTokenResponse({ code: 40002, message: 'bad code' })).toBeNull()
    expect(parseTikTokTokenResponse({ code: 0, data: {} })).toBeNull()
  })

  it('reads the advertiser name and currency', () => {
    const list = parseTikTokAdvertisers({
      code: 0,
      message: 'OK',
      data: {
        list: [
          { advertiser_id: '7012345678901234567', advertiser_name: 'Crestwood', currency: 'GBP' },
        ],
      },
    })
    expect(list).toEqual([
      { id: '7012345678901234567', name: 'Crestwood', currency: 'GBP' },
    ])
  })

  it('asks for the campaign grain by day', () => {
    const url = buildReportUrl({
      advertiserId: '7012345678901234567',
      since: '2026-09-10',
      until: '2026-09-12',
    })
    expect(url).toContain('data_level=AUCTION_CAMPAIGN')
    expect(decodeURIComponent(url)).toContain('["campaign_id","stat_time_day"]')
    expect(url).toContain('start_date=2026-09-10')
    expect(url).toContain('end_date=2026-09-12')
  })
})

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

describe('money and counts', () => {
  it('reads a decimal string as whole cents', () => {
    expect(decimalToCents('84.19')).toBe(8419)
    expect(decimalToCents('0')).toBe(0)
    expect(decimalToCents(12.005)).toBe(1201)
    expect(decimalToCents('')).toBe(0)
    expect(decimalToCents('nonsense')).toBe(0)
    expect(decimalToCents('-5')).toBe(0)
  })

  it('reads micros as whole cents', () => {
    expect(microsToCents('1000000')).toBe(100)
    expect(microsToCents(4_230_000)).toBe(423)
    expect(microsToCents(null)).toBe(0)
  })
})

describe('the reporting window', () => {
  const now = new Date('2026-09-14T09:00:00Z')

  it('defaults to today and the two days before it', () => {
    expect(defaultWindow(3, now)).toEqual({
      since: '2026-09-12',
      until: '2026-09-14',
    })
  })

  it('honours an explicit window and puts a reversed one the right way round', () => {
    expect(resolveWindow('2026-09-01', '2026-09-05', 3, now)).toEqual({
      since: '2026-09-01',
      until: '2026-09-05',
    })
    expect(resolveWindow('2026-09-05', '2026-09-01', 3, now)).toEqual({
      since: '2026-09-01',
      until: '2026-09-05',
    })
  })

  it('ignores a date that is not a date', () => {
    expect(resolveWindow('last tuesday', undefined, 3, now)).toEqual({
      since: '2026-09-12',
      until: '2026-09-14',
    })
  })
})

describe('connector status', () => {
  it('says connected only when the row says so AND a token exists', () => {
    expect(statusFromConnection({ status: 'connected', access_token: 'tok' })).toBe(
      'connected',
    )
    expect(statusFromConnection({ status: 'connected', refresh_token: 'ref' })).toBe(
      'connected',
    )
    expect(statusFromConnection({ status: 'connected', access_token: null })).toBe(
      'manual',
    )
    expect(statusFromConnection({ status: 'connected', access_token: '  ' })).toBe(
      'manual',
    )
    expect(statusFromConnection({ status: 'pending', access_token: 'tok' })).toBe(
      'manual',
    )
    expect(statusFromConnection({ status: 'error', access_token: 'tok' })).toBe(
      'manual',
    )
    expect(statusFromConnection({ status: 'revoked', access_token: 'tok' })).toBe(
      'manual',
    )
    expect(statusFromConnection(null)).toBe('manual')
  })

  it('prefers a token held by env-var name over one held on the row', () => {
    process.env.W54_TEST_TOKEN = 'from-the-environment'
    try {
      expect(
        resolveStoredToken({
          status: 'connected',
          token_env_key: 'W54_TEST_TOKEN',
          access_token: 'on-the-row',
        }),
      ).toBe('from-the-environment')
      expect(
        resolveStoredToken({
          status: 'connected',
          token_env_key: 'W54_TEST_MISSING',
          access_token: 'on-the-row',
        }),
      ).toBe('on-the-row')
    } finally {
      delete process.env.W54_TEST_TOKEN
    }
  })
})

describe('token lifetimes', () => {
  const now = Date.parse('2026-09-14T00:00:00Z')

  it('extends a Meta token inside its last week and leaves a fresh one alone', () => {
    expect(metaTokenNeedsExtending('2026-09-18T00:00:00Z', now)).toBe(true)
    expect(metaTokenNeedsExtending('2026-11-01T00:00:00Z', now)).toBe(false)
    // Already lapsed still counts as needing the exchange attempted.
    expect(metaTokenNeedsExtending('2026-09-01T00:00:00Z', now)).toBe(true)
    // No expiry recorded means we have nothing to act on, so leave it.
    expect(metaTokenNeedsExtending(null, now)).toBe(false)
  })

  it('refreshes a TikTok token inside its last day', () => {
    expect(tiktokTokenNeedsRefresh('2026-09-14T06:00:00Z', now)).toBe(true)
    expect(tiktokTokenNeedsRefresh('2026-09-20T00:00:00Z', now)).toBe(false)
    expect(tiktokTokenNeedsRefresh(undefined, now)).toBe(false)
  })
})

describe('channel keys', () => {
  it('uses the canonical keys attribution joins spend on', () => {
    // loadSpendByChannel matches spend.channel to touchpoint.channel
    // verbatim. A connector that invented its own key would write spend
    // nobody could attribute.
    expect(PROVIDER_CHANNEL).toEqual({
      google_ads: 'google_ads',
      meta_ads: 'meta_ads',
      tiktok_ads: 'tiktok_ads',
    })
  })
})
