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
  attachPersonaToAttributionEvent,
  attachPersonaToWedding,
  attachPersonaToVenue,
  enqueuePersonaOverlayRefresh,
  type PersonaOverlay,
  type AttachPersonaResult,
  type AttachPersonaToVenueResult,
} from './persona-overlay'

export { runSpendSyncSweep, type SweepResult } from './spend-sync-sweep'

import { syncGoogleAds } from './connectors/google-ads'
import { syncMetaAds } from './connectors/meta-ads'
import { syncTikTokAds } from './connectors/tiktok-ads'

export type ConnectorName = 'google_ads' | 'meta_ads' | 'tiktok_ads'

export interface DispatchInput {
  venueId: string
  connector: ConnectorName
  accessToken?: string
  since?: string
  until?: string
}

/**
 * Connector dispatcher. Routes to the right stub (or, in 6A2, real)
 * connector function based on the connector name. All connectors share
 * the same input shape (venueId + access token + date range).
 */
export async function dispatchConnectorSync(input: DispatchInput) {
  switch (input.connector) {
    case 'google_ads':
      return syncGoogleAds({
        venueId: input.venueId,
        accessToken: input.accessToken,
        since: input.since,
        until: input.until,
      })
    case 'meta_ads':
      return syncMetaAds({
        venueId: input.venueId,
        accessToken: input.accessToken,
        since: input.since,
        until: input.until,
      })
    case 'tiktok_ads':
      return syncTikTokAds({
        venueId: input.venueId,
        accessToken: input.accessToken,
        since: input.since,
        until: input.until,
      })
    default: {
      // Exhaustiveness check — TS will fail this branch if ConnectorName
      // gets a new variant without a matching case.
      const _exhaustive: never = input.connector
      void _exhaustive
      return {
        ok: false as const,
        reason: 'unknown_connector' as const,
        message: `Unknown connector: ${input.connector as string}`,
        rowsIngested: 0 as const,
      }
    }
  }
}
