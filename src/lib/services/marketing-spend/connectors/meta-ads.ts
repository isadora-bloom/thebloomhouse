/**
 * Wave 6A — Meta Ads connector (STUB).
 *
 * TODO Wave 6A2: implement Meta Marketing API client.
 *   - OAuth flow (long-lived page access token per venue)
 *   - GET /act_<adAccountId>/insights with daily breakdown
 *   - Rate limit handling (Meta uses tier-based throttling)
 *   - Map Meta's "spend" (string with decimals) to amount_cents
 *   - Forward to recordSpend with ingestedBy='meta_ads_connector'
 */

export interface MetaAdsSyncInput {
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

export type MetaAdsSyncResult = ConnectorStubResult

export async function syncMetaAds(
  _input: MetaAdsSyncInput,
): Promise<MetaAdsSyncResult> {
  // TODO Wave 6A2: implement Meta Marketing API client.
  return {
    ok: false,
    reason: 'connector_stub',
    message: 'Meta Ads connector is a stub; live integration ships in Wave 6A2.',
    rowsIngested: 0,
  }
}
