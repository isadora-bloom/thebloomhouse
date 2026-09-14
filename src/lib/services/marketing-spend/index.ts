/**
 * Wave 6A — marketing-spend service barrel.
 *
 * Public API for callers (admin endpoints, cron, future Wave 6B
 * rollups). Connectors are exported through a dispatcher so the route
 * code can switch on a string without importing each one.
 */

export {
  recordSpend,
  recordSpendBatch,
  isCanonicalChannel,
  CANONICAL_CHANNELS,
  type RecordSpendInput,
  type RecordSpendResult,
} from './ingest'

export {
  recordManualSpend,
  type ManualSpendInput,
} from './connectors/manual'

export {
  recordKnotFee,
  type KnotFeeInput,
} from './connectors/theknot'

export {
  syncGoogleAds,
  type GoogleAdsSyncInput,
  type GoogleAdsSyncResult,
} from './connectors/google-ads'

export {
  syncMetaAds,
  type MetaAdsSyncInput,
  type MetaAdsSyncResult,
} from './connectors/meta-ads'

export {
  syncTikTokAds,
  type TikTokAdsSyncInput,
  type TikTokAdsSyncResult,
} from './connectors/tiktok-ads'

export {
  AD_PROVIDERS,
  PROVIDER_CHANNEL,
  PROVIDER_INGESTED_BY,
  type AdProvider,
  type AdSyncResult,
  type ConnectorStatus,
  type DailyCampaignMetric,
} from './connectors/shared'

export {
  attachPersonaToAttributionEvent,
  attachPersonaToWedding,
  attachPersonaToVenue,
  enqueuePersonaOverlayRefresh,
  type PersonaOverlay,
  type AttachPersonaResult,
  type AttachPersonaToVenueResult,
} from './persona-overlay'

export { runSpendSyncSweep, type SweepResult } from './spend-sync-sweep'

import {
  syncGoogleAds,
  connectorStatus as googleAdsStatus,
} from './connectors/google-ads'
import {
  syncMetaAds,
  connectorStatus as metaAdsStatus,
} from './connectors/meta-ads'
import {
  syncTikTokAds,
  connectorStatus as tiktokAdsStatus,
} from './connectors/tiktok-ads'
import { syncRefusal, type AdSyncResult, type ConnectorStatus } from './connectors/shared'

export type ConnectorName = 'google_ads' | 'meta_ads' | 'tiktok_ads'

export interface DispatchInput {
  venueId: string
  connector: ConnectorName
  since?: string
  until?: string
  lookbackDays?: number
}

/**
 * Connector dispatcher. Routes to the right connector by name. All
 * three share the same input shape (venue + date window) and the same
 * result shape, so a caller never has to know which platform it asked.
 *
 * Tokens are deliberately NOT part of the input. Each connector reads
 * its own venue's connection row through the service client, which is
 * what keeps one venue's credential from ever being handed to another
 * venue's sync by a caller that got its arguments in the wrong order.
 */
export async function dispatchConnectorSync(
  input: DispatchInput,
): Promise<AdSyncResult> {
  const args = {
    venueId: input.venueId,
    since: input.since,
    until: input.until,
    lookbackDays: input.lookbackDays,
  }
  switch (input.connector) {
    case 'google_ads':
      return syncGoogleAds(args)
    case 'meta_ads':
      return syncMetaAds(args)
    case 'tiktok_ads':
      return syncTikTokAds(args)
    default: {
      // Exhaustiveness check — TS will fail this branch if ConnectorName
      // gets a new variant without a matching case.
      const _exhaustive: never = input.connector
      void _exhaustive
      return syncRefusal(
        'google_ads',
        'not_configured',
        `Unknown connector: ${input.connector as string}`,
      )
    }
  }
}

/**
 * Per-venue connector status for all three ad platforms at once.
 *
 * 'connected' means that venue has a live token and its spend arrives on
 * its own; 'manual' means the numbers are still typed in. The
 * reallocation page reads this to decide what to tell the coordinator
 * about where their figures came from, so the copy follows the venue
 * rather than the release.
 */
export async function adConnectorStatuses(
  venueId: string,
): Promise<Record<ConnectorName, ConnectorStatus>> {
  const [googleAds, metaAds, tiktokAds] = await Promise.all([
    googleAdsStatus(venueId),
    metaAdsStatus(venueId),
    tiktokAdsStatus(venueId),
  ])
  return { google_ads: googleAds, meta_ads: metaAds, tiktok_ads: tiktokAds }
}
