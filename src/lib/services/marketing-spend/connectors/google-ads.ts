/**
 * Wave 6A — Google Ads connector (STUB).
 *
 * Architecture lands here so 6A2 can fill in the API client without
 * another schema or service shape change. Returns a typed stub result
 * so callers don't break.
 *
 * TODO Wave 6A2: implement Google Ads API client.
 *   - OAuth flow (developer token + refresh token per venue)
 *   - GoogleAdsService.search() to pull campaign-level spend per day
 *   - Rate limit handling (Google returns RESOURCE_EXHAUSTED on burst)
 *   - Date-range payload from marketing_spend_jobs.payload
 *   - Map Google's "cost" (micros) to amount_cents
 *   - Forward each row to recordSpend with ingestedBy='google_ads_connector'
 */

export interface GoogleAdsSyncInput {
  venueId: string
  /** OAuth access token. Populated by the per-venue credential store
   *  in 6A2 — until then connectors return a stub error. */
  accessToken?: string
  /** Optional date range. Defaults to "yesterday only" in 6A2. */
  since?: string
  until?: string
}

export interface ConnectorStubResult {
  ok: false
  reason: 'connector_stub'
  message: string
  rowsIngested: 0
}

export type GoogleAdsSyncResult = ConnectorStubResult

export async function syncGoogleAds(
  _input: GoogleAdsSyncInput,
): Promise<GoogleAdsSyncResult> {
  // TODO Wave 6A2: implement Google Ads API client.
  return {
    ok: false,
    reason: 'connector_stub',
    message: 'Google Ads connector is a stub; live integration ships in Wave 6A2.',
    rowsIngested: 0,
  }
}
