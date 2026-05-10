/**
 * Wave 6A — spend-sync-sweep service.
 *
 * Anchor docs:
 *   - bloom-wave4-5-6-master-plan.md (6A: daily sweep dispatches each
 *     venue's enabled connectors)
 *
 * What this service does
 * ----------------------
 * Iterate venues with venue_config.spend_auto_sync_enabled = true and
 * call each configured connector. For Wave 6A this is mostly a no-op
 * because every connector returns `connector_stub`. The skeleton lands
 * now so 6A2 can fill in real connectors without changing the cron
 * dispatch shape.
 *
 * Cron registration: NOT in this file. Cron registration must land in
 * src/app/api/cron/route.ts (job string 'spend_sync_sweep') and
 * vercel.json — both files are owned by the reconciliation stream
 * during Wave 6A's parallel run. See feedback_parallel_stream_safety.md
 * for why we don't touch them from inside a parallel agent.
 *
 * TODO Wave 6A reconciliation: register the cron.
 *   1. Add 'spend_sync_sweep' to VALID_JOBS in src/app/api/cron/route.ts
 *   2. Add a case 'spend_sync_sweep': return runSpendSyncSweep()
 *   3. Add a vercel.json cron entry — daily at 6:15am UTC suggested
 *      (after Phase B sweep at 4:45am, well clear of identity drift sweeps).
 */

import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'
import { syncGoogleAds } from './connectors/google-ads'
import { syncMetaAds } from './connectors/meta-ads'
import { syncTikTokAds } from './connectors/tiktok-ads'

interface SweepVenueRow {
  venue_id: string
}

export interface SweepResult {
  ok: true
  venuesScanned: number
  connectorsCalled: number
  connectorsStubbed: number
  errors: number
}

/**
 * Daily sweep entrypoint. Walks venues opted in via
 * venue_config.spend_auto_sync_enabled and dispatches each connector.
 * Stubbed connectors just no-op; the cron run still records that we
 * tried (for connector-health dashboards in 6A2).
 */
export async function runSpendSyncSweep(): Promise<SweepResult> {
  const supabase = createServiceClient()
  const result: SweepResult = {
    ok: true,
    venuesScanned: 0,
    connectorsCalled: 0,
    connectorsStubbed: 0,
    errors: 0,
  }

  const { data, error } = await supabase
    .from('venue_config')
    .select('venue_id')
    .eq('spend_auto_sync_enabled', true)

  if (error) {
    logEvent({
      level: 'warn',
      msg: 'spend_sync_sweep.lookup_failed',
      event_type: 'cron.run',
      outcome: 'fail',
      data: { error: error.message },
    })
    result.errors += 1
    return result
  }

  const rows = (data ?? []) as SweepVenueRow[]
  result.venuesScanned = rows.length

  for (const row of rows) {
    const venueId = row.venue_id

    // Each connector is independent. Errors don't cascade — log and
    // continue so a single broken connector doesn't kill the sweep.
    const connectors = [
      { name: 'google_ads', run: () => syncGoogleAds({ venueId }) },
      { name: 'meta_ads', run: () => syncMetaAds({ venueId }) },
      { name: 'tiktok_ads', run: () => syncTikTokAds({ venueId }) },
    ]

    for (const c of connectors) {
      result.connectorsCalled += 1
      try {
        const r = await c.run()
        if (r.ok === false && r.reason === 'connector_stub') {
          result.connectorsStubbed += 1
        }
      } catch (err) {
        result.errors += 1
        logEvent({
          level: 'warn',
          msg: 'spend_sync_sweep.connector_threw',
          event_type: 'cron.run',
          outcome: 'fail',
          venueId,
          data: {
            connector: c.name,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }

  logEvent({
    level: 'info',
    msg: 'spend_sync_sweep.complete',
    event_type: 'cron.run',
    outcome: 'ok',
    data: result as unknown as Record<string, unknown>,
  })

  return result
}
