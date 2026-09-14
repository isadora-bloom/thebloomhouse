/**
 * W54. What happens when a connector actually runs.
 *
 * Three things are worth a test here, and they are the three that would
 * be expensive to discover in production:
 *
 *   1. Re-running a day must not double the spend. Ad platforms restate
 *      a day after it closes, so the sweep asks for the last three days
 *      every night, which means every day gets pulled three times.
 *
 *   2. One venue's credential must never reach another venue's sync.
 *      A leaked ad token does not fail loudly: it quietly files a
 *      stranger's spend against your venue and every cost figure on the
 *      page moves.
 *
 *   3. A token near its end must renew itself, and a renewal that fails
 *      must not take the whole sync down with it.
 *
 * Everything runs against an in-memory database and an injected fetch.
 * No network, no Supabase.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeSpineDb } from '@/lib/services/__tests__/fake-spine-db'

const GOOGLE_TOKENS: Record<string, string | null> = {}

vi.mock('@/lib/services/integrations/google-ads-oauth', () => ({
  readGoogleAdsOauthEnv: () => ({
    ok: true,
    env: {
      clientId: 'client',
      clientSecret: 'secret',
      developerToken: 'dev-token',
      redirectUri: 'https://example.test/callback',
    },
  }),
  getValidAccessToken: async (venueId: string) => GOOGLE_TOKENS[venueId] ?? null,
  mintOauthState: (venueId: string) => `state:${venueId}`,
  verifyOauthState: (state: string) => ({
    ok: true as const,
    venueId: state.replace(/^state:/, ''),
  }),
}))

import { syncGoogleAds, connectorStatus as googleStatus } from '../google-ads'
import { syncMetaAds, connectorStatus as metaStatus } from '../meta-ads'
import { syncTikTokAds, connectorStatus as tiktokStatus } from '../tiktok-ads'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'

/** One campaign on one day. The spend figure is a parameter so a second
 *  run can restate it the way a real platform does. */
function metaBody(spend: string) {
  return {
    data: [
      {
        date_start: '2026-09-10',
        date_stop: '2026-09-10',
        campaign_id: '2390',
        campaign_name: 'Autumn open day',
        spend,
        impressions: '15230',
        clicks: '412',
        account_currency: 'USD',
        actions: [{ action_type: 'lead', value: '6' }],
      },
    ],
  }
}

interface RecordedCall {
  url: string
  headers: Record<string, string>
}

/** A fetch that answers with one body and records what it was asked. */
function fakeFetch(
  bodyFor: (url: string) => unknown,
  calls: RecordedCall[],
): typeof fetch {
  return (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    return {
      ok: true,
      status: 200,
      json: async () => bodyFor(url),
      text: async () => JSON.stringify(bodyFor(url)),
    }
  }) as unknown as typeof fetch
}

function spendRows(db: FakeSpineDb) {
  return db.table('marketing_spend_records')
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env.META_ADS_APP_ID = 'meta-app'
  process.env.META_ADS_APP_SECRET = 'meta-secret'
  process.env.META_ADS_OAUTH_REDIRECT_URI = 'https://example.test/meta'
  process.env.TIKTOK_ADS_APP_ID = 'tt-app'
  process.env.TIKTOK_ADS_APP_SECRET = 'tt-secret'
  process.env.TIKTOK_ADS_OAUTH_REDIRECT_URI = 'https://example.test/tiktok'
  for (const k of Object.keys(GOOGLE_TOKENS)) delete GOOGLE_TOKENS[k]
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe('re-running a day', () => {
  it('does not double the spend', async () => {
    const db = new FakeSpineDb()
    db.seed('meta_ads_connections', [
      {
        venue_id: VENUE_A,
        ad_account_id: '778899',
        status: 'connected',
        access_token: 'tok-a',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
    ])
    const calls: RecordedCall[] = []
    const supabase = db.client()

    const first = await syncMetaAds({
      venueId: VENUE_A,
      since: '2026-09-10',
      until: '2026-09-10',
      supabase,
      fetchImpl: fakeFetch(() => metaBody('84.19'), calls),
    })
    expect(first.ok).toBe(true)
    expect(first.rowsInserted).toBe(1)
    expect(spendRows(db)).toHaveLength(1)
    expect(spendRows(db)[0].amount_cents).toBe(8419)

    const second = await syncMetaAds({
      venueId: VENUE_A,
      since: '2026-09-10',
      until: '2026-09-10',
      supabase,
      fetchImpl: fakeFetch(() => metaBody('84.19'), calls),
    })
    expect(second.ok).toBe(true)
    expect(second.rowsInserted).toBe(0)
    expect(second.rowsUpdated).toBe(1)

    // One row, one day, the same figure. Not two rows and not 168.38.
    expect(spendRows(db)).toHaveLength(1)
    expect(spendRows(db)[0].amount_cents).toBe(8419)
  })

  it('takes the platform restating a day, rather than ignoring it', async () => {
    const db = new FakeSpineDb()
    db.seed('meta_ads_connections', [
      {
        venue_id: VENUE_A,
        ad_account_id: '778899',
        status: 'connected',
        access_token: 'tok-a',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
    ])
    const calls: RecordedCall[] = []
    const supabase = db.client()
    const run = (spend: string) =>
      syncMetaAds({
        venueId: VENUE_A,
        since: '2026-09-10',
        until: '2026-09-10',
        supabase,
        fetchImpl: fakeFetch(() => metaBody(spend), calls),
      })

    await run('84.19')
    await run('81.02') // Meta credited back some invalid clicks overnight.

    expect(spendRows(db)).toHaveLength(1)
    expect(spendRows(db)[0].amount_cents).toBe(8102)
  })
})

// ---------------------------------------------------------------------------
// Venue isolation
// ---------------------------------------------------------------------------

describe('venue isolation', () => {
  it('never uses venue B token or account for a venue A sync (Meta)', async () => {
    const db = new FakeSpineDb()
    db.seed('meta_ads_connections', [
      {
        venue_id: VENUE_A,
        ad_account_id: 'aaa111',
        status: 'connected',
        access_token: 'tok-venue-a',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
      {
        venue_id: VENUE_B,
        ad_account_id: 'bbb222',
        status: 'connected',
        access_token: 'tok-venue-b',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
    ])
    const calls: RecordedCall[] = []
    await syncMetaAds({
      venueId: VENUE_A,
      since: '2026-09-10',
      until: '2026-09-10',
      supabase: db.client(),
      fetchImpl: fakeFetch(() => metaBody('10.00'), calls),
    })

    const serialised = JSON.stringify(calls)
    expect(serialised).toContain('tok-venue-a')
    expect(serialised).toContain('aaa111')
    expect(serialised).not.toContain('tok-venue-b')
    expect(serialised).not.toContain('bbb222')

    // And the spend landed on venue A only.
    expect(spendRows(db).map((r) => r.venue_id)).toEqual([VENUE_A])
  })

  it('never uses venue B token or account for a venue A sync (TikTok)', async () => {
    const db = new FakeSpineDb()
    db.seed('tiktok_ads_connections', [
      {
        venue_id: VENUE_A,
        advertiser_id: '7000000000000000001',
        currency: 'GBP',
        status: 'connected',
        access_token: 'tt-venue-a',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
      {
        venue_id: VENUE_B,
        advertiser_id: '7000000000000000002',
        status: 'connected',
        access_token: 'tt-venue-b',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
    ])
    const calls: RecordedCall[] = []
    const result = await syncTikTokAds({
      venueId: VENUE_A,
      since: '2026-09-10',
      until: '2026-09-10',
      supabase: db.client(),
      fetchImpl: fakeFetch(
        () => ({
          code: 0,
          message: 'OK',
          data: {
            list: [
              {
                dimensions: {
                  campaign_id: '17700',
                  stat_time_day: '2026-09-10 00:00:00',
                },
                metrics: {
                  campaign_name: 'Reels reach',
                  spend: '52.40',
                  impressions: '90210',
                  clicks: '1204',
                  conversion: '4',
                },
              },
            ],
          },
        }),
        calls,
      ),
    })

    expect(result.ok).toBe(true)
    const serialised = JSON.stringify(calls)
    expect(serialised).toContain('tt-venue-a')
    expect(serialised).toContain('7000000000000000001')
    expect(serialised).not.toContain('tt-venue-b')
    expect(serialised).not.toContain('7000000000000000002')
    // The currency came off venue A's own row, not a default.
    expect(spendRows(db)[0].currency).toBe('GBP')
  })

  it('never uses venue B token or account for a venue A sync (Google)', async () => {
    const db = new FakeSpineDb()
    db.seed('google_ads_connections', [
      {
        venue_id: VENUE_A,
        customer_id: '111-111-1111',
        status: 'connected',
        access_token: 'g-venue-a',
        refresh_token: 'g-refresh-a',
      },
      {
        venue_id: VENUE_B,
        customer_id: '222-222-2222',
        status: 'connected',
        access_token: 'g-venue-b',
        refresh_token: 'g-refresh-b',
      },
    ])
    GOOGLE_TOKENS[VENUE_A] = 'g-venue-a'
    GOOGLE_TOKENS[VENUE_B] = 'g-venue-b'

    const calls: RecordedCall[] = []
    const result = await syncGoogleAds({
      venueId: VENUE_A,
      since: '2026-09-10',
      until: '2026-09-10',
      supabase: db.client(),
      fetchImpl: fakeFetch(
        () => [
          {
            results: [
              {
                campaign: { id: '111', name: 'Brand search' },
                segments: { date: '2026-09-10' },
                metrics: {
                  costMicros: '4230000',
                  impressions: '1204',
                  clicks: '48',
                  conversions: 2,
                },
                customer: { currencyCode: 'USD' },
              },
            ],
          },
        ],
        calls,
      ),
    })

    expect(result.ok).toBe(true)
    const serialised = JSON.stringify(calls)
    expect(serialised).toContain('g-venue-a')
    expect(serialised).toContain('customers/1111111111/')
    expect(serialised).not.toContain('g-venue-b')
    expect(serialised).not.toContain('2222222222')
    expect(spendRows(db).map((r) => r.venue_id)).toEqual([VENUE_A])
  })

  it('refuses for a venue with no connection, even while another venue is connected', async () => {
    const db = new FakeSpineDb()
    db.seed('meta_ads_connections', [
      {
        venue_id: VENUE_B,
        ad_account_id: 'bbb222',
        status: 'connected',
        access_token: 'tok-venue-b',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
    ])
    const calls: RecordedCall[] = []
    const result = await syncMetaAds({
      venueId: VENUE_A,
      supabase: db.client(),
      fetchImpl: fakeFetch(() => metaBody('10.00'), calls),
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_connected')
    expect(calls).toHaveLength(0)
    expect(spendRows(db)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Status, per venue
// ---------------------------------------------------------------------------

describe('status per venue', () => {
  it('answers connected for the venue that connected and manual for the one that did not', async () => {
    const db = new FakeSpineDb()
    db.seed('meta_ads_connections', [
      { venue_id: VENUE_B, status: 'connected', access_token: 'tok-b' },
    ])
    db.seed('tiktok_ads_connections', [
      { venue_id: VENUE_A, status: 'pending', access_token: null },
    ])
    db.seed('google_ads_connections', [
      { venue_id: VENUE_A, status: 'connected', refresh_token: 'ref-a' },
    ])
    const supabase = db.client()

    expect(await metaStatus(VENUE_B, supabase)).toBe('connected')
    expect(await metaStatus(VENUE_A, supabase)).toBe('manual')
    expect(await tiktokStatus(VENUE_A, supabase)).toBe('manual')
    expect(await googleStatus(VENUE_A, supabase)).toBe('connected')
    expect(await googleStatus(VENUE_B, supabase)).toBe('manual')
  })
})

// ---------------------------------------------------------------------------
// Token renewal
// ---------------------------------------------------------------------------

describe('token renewal', () => {
  it('extends a Meta token that is nearly done and stores the new one', async () => {
    const db = new FakeSpineDb()
    db.seed('meta_ads_connections', [
      {
        venue_id: VENUE_A,
        ad_account_id: '778899',
        status: 'connected',
        access_token: 'tok-old',
        // Inside the last week, so the connector should renew first.
        token_expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    ])
    const calls: RecordedCall[] = []
    const doFetch = fakeFetch((url) => {
      if (url.includes('oauth/access_token')) {
        return { access_token: 'tok-new', token_type: 'bearer', expires_in: 5_184_000 }
      }
      return metaBody('12.00')
    }, calls)

    const result = await syncMetaAds({
      venueId: VENUE_A,
      since: '2026-09-10',
      until: '2026-09-10',
      supabase: db.client(),
      fetchImpl: doFetch,
    })

    expect(result.ok).toBe(true)
    // The renewal happened, and the report call carried the new token.
    expect(calls.some((c) => c.url.includes('fb_exchange_token'))).toBe(true)
    const reportCall = calls.find((c) => c.url.includes('/insights'))
    expect(reportCall?.headers.Authorization).toBe('Bearer tok-new')
    expect(db.table('meta_ads_connections')[0].access_token).toBe('tok-new')
  })

  it('carries on with the old Meta token when the renewal is refused', async () => {
    const db = new FakeSpineDb()
    db.seed('meta_ads_connections', [
      {
        venue_id: VENUE_A,
        ad_account_id: '778899',
        status: 'connected',
        access_token: 'tok-old',
        token_expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    ])
    const calls: RecordedCall[] = []
    const doFetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input)
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      if (url.includes('fb_exchange_token')) {
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'nope' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => metaBody('12.00'),
        text: async () => '',
      }
    }) as unknown as typeof fetch

    const result = await syncMetaAds({
      venueId: VENUE_A,
      since: '2026-09-10',
      until: '2026-09-10',
      supabase: db.client(),
      fetchImpl: doFetch,
    })

    // A failed renewal is noted on the row, but the day still lands. The
    // old token usually has time left on it; losing a day of spend over a
    // retryable refresh would be the worse trade.
    expect(result.ok).toBe(true)
    expect(spendRows(db)).toHaveLength(1)
    const reportCall = calls.find((c) => c.url.includes('/insights'))
    expect(reportCall?.headers.Authorization).toBe('Bearer tok-old')
  })

  it('refreshes a TikTok token that has lapsed', async () => {
    const db = new FakeSpineDb()
    db.seed('tiktok_ads_connections', [
      {
        venue_id: VENUE_A,
        advertiser_id: '7000000000000000001',
        status: 'connected',
        access_token: 'tt-old',
        refresh_token: 'tt-refresh',
        token_expires_at: new Date(Date.now() - 3600_000).toISOString(),
      },
    ])
    const calls: RecordedCall[] = []
    const doFetch = fakeFetch((url) => {
      if (url.includes('refresh_token')) {
        return {
          code: 0,
          message: 'OK',
          data: {
            access_token: 'tt-new',
            refresh_token: 'tt-refresh-2',
            expires_in: 86_400,
            advertiser_ids: ['7000000000000000001'],
          },
        }
      }
      return {
        code: 0,
        message: 'OK',
        data: {
          list: [
            {
              dimensions: {
                campaign_id: '17700',
                stat_time_day: '2026-09-10 00:00:00',
              },
              metrics: { spend: '10.00', impressions: '1', clicks: '1', conversion: '0' },
            },
          ],
        },
      }
    }, calls)

    const result = await syncTikTokAds({
      venueId: VENUE_A,
      since: '2026-09-10',
      until: '2026-09-10',
      supabase: db.client(),
      fetchImpl: doFetch,
    })

    expect(result.ok).toBe(true)
    expect(calls.some((c) => c.url.includes('/oauth2/refresh_token/'))).toBe(true)
    const reportCall = calls.find((c) => c.url.includes('/report/integrated/get/'))
    expect(reportCall?.headers['Access-Token']).toBe('tt-new')
    expect(db.table('tiktok_ads_connections')[0].access_token).toBe('tt-new')
  })
})

// ---------------------------------------------------------------------------
// Refusals that are not errors
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('says not_configured when the app credentials are absent', async () => {
    delete process.env.META_ADS_APP_ID
    const db = new FakeSpineDb()
    const result = await syncMetaAds({ venueId: VENUE_A, supabase: db.client() })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_configured')
    expect(result.message).toContain('META_ADS_APP_ID')
  })

  it('says no_account when a venue connected but never chose an account', async () => {
    const db = new FakeSpineDb()
    db.seed('meta_ads_connections', [
      {
        venue_id: VENUE_A,
        ad_account_id: null,
        status: 'connected',
        access_token: 'tok-a',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
    ])
    const result = await syncMetaAds({ venueId: VENUE_A, supabase: db.client() })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_account')
  })

  it('treats a TikTok error body as a refusal even though the request was a 200', async () => {
    const db = new FakeSpineDb()
    db.seed('tiktok_ads_connections', [
      {
        venue_id: VENUE_A,
        advertiser_id: '7000000000000000001',
        status: 'connected',
        access_token: 'tt-a',
        token_expires_at: '2027-01-01T00:00:00Z',
      },
    ])
    const calls: RecordedCall[] = []
    const result = await syncTikTokAds({
      venueId: VENUE_A,
      supabase: db.client(),
      fetchImpl: fakeFetch(
        () => ({ code: 40001, message: 'Advertiser not authorized', data: null }),
        calls,
      ),
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('api_error')
    expect(result.message).toContain('Advertiser not authorized')
    // Nothing written, and the row says what went wrong.
    expect(spendRows(db)).toHaveLength(0)
    expect(db.table('tiktok_ads_connections')[0].status).toBe('error')
  })
})
