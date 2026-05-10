/**
 * Wave 6A — TikTok Ads connector (STUB).
 *
 * TODO Wave 6A2: implement TikTok Business API client.
 *   - OAuth flow (advertiser_id + access_token per venue)
 *   - POST /open_api/v1.3/report/integrated/get/ for daily metrics
 *   - Rate limit handling
 *   - Map TikTok's "spend" to amount_cents (TikTok returns string-decimal)
 *   - Forward to recordSpend with ingestedBy='tiktok_ads_connector'
 */

export interface TikTokAdsSyncInput {
  venueId: string
  accessToken?: string
  since?: string
  until?: string
}

export interface ConnectorStubResult {
  ok: false
  reason: 'connector_stub'
  message: string
  rowsIngested: 0
}

export type TikTokAdsSyncResult = ConnectorStubResult

export async function syncTikTokAds(
  _input: TikTokAdsSyncInput,
): Promise<TikTokAdsSyncResult> {
  // TODO Wave 6A2: implement TikTok Business API client.
  return {
    ok: false,
    reason: 'connector_stub',
    message: 'TikTok Ads connector is a stub; live integration ships in Wave 6A2.',
    rowsIngested: 0,
  }
}
