/**
 * Daily ad-spend sweep.
 *
 * Runs inside the existing `spend_sync_sweep` cron case, which the daily
 * loop dispatcher already calls. No new cron entry: the schedule budget
 * is full and ratcheted, and this work belongs on a tick that already
 * exists.
 *
 * WHAT CHANGED IN W54
 * ===================
 * The sweep used to walk venues with `venue_config.spend_auto_sync_enabled`
 * and call three connectors that all returned a stub. Two things are
 * different now.
 *
 * First, the connectors are real, so a venue that has granted access
 * gets its daily spend, impressions, clicks and conversions per campaign
 * written into `marketing_spend_records` next to the rows the manual
 * form writes.
 *
 * Second, the venue list is a union rather than one flag. A coordinator
 * who connects an ad account on the settings page has said what they
 * want plainly enough; making them also find a checkbox elsewhere before
 * anything arrives is the kind of gap where a venue sits for a month
 * wondering why the numbers never appeared. So a venue is swept if it
 * has the flag set OR it has a connected row on any of the three
 * platforms.
 *
 * A connector whose venue has no live token returns 'not_connected' and
 * costs one cheap read. That is the honest no-op: the run still records
 * that it asked.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'
import { syncGoogleAds } from './connectors/google-ads'
import { syncMetaAds } from './connectors/meta-ads'
import { syncTikTokAds } from './connectors/tiktok-ads'
import { PROVIDER_TABLE, type AdProvider } from './connectors/shared'

export interface SweepResult {
  ok: true
  venuesScanned: number
  connectorsCalled: number
  /** Venue has no live token for that platform. Not an error. */
  connectorsNotConnected: number
  rowsInserted: number
  rowsUpdated: number
  errors: number
}

export interface SweepOptions {
  /** How many days back to ask each platform for. Defaults to three, so
   *  a day that was restated after it closed still gets corrected. */
  lookbackDays?: number
  /** Sweep a single venue instead of every eligible one. */
  venueId?: string
}

/**
 * Venues to sweep: the auto-sync flag, plus anyone with a connected ad
 * account on any platform.
 */
async function eligibleVenueIds(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<{ ids: string[]; errors: number }> {
  const ids = new Set<string>()
  let errors = 0

  const { data: flagged, error: flagErr } = await supabase
    .from('venue_config')
    .select('venue_id')
    .eq('spend_auto_sync_enabled', true)

  if (flagErr) {
    errors += 1
    logEvent({
      level: 'warn',
      msg: 'spend_sync_sweep.lookup_failed',
      event_type: 'cron.run',
      outcome: 'fail',
      data: { error: flagErr.message },
    })
  } else {
    for (const row of (flagged ?? []) as Array<{ venue_id: string }>) {
      if (row.venue_id) ids.add(row.venue_id)
    }
  }

  for (const provider of Object.keys(PROVIDER_TABLE) as AdProvider[]) {
    const { data, error } = await supabase
      .from(PROVIDER_TABLE[provider])
      .select('venue_id')
      .eq('status', 'connected')
    if (error) {
      // A table that is not there yet (migration 407 or 310 still owed
      // on this database) is not a failure of the sweep. Note it and
      // carry on with the platforms that do exist.
      logEvent({
        level: 'info',
        msg: 'spend_sync_sweep.connection_table_unavailable',
        event_type: 'cron.run',
        outcome: 'ok',
        data: { provider, error: error.message },
      })
      continue
    }
    for (const row of (data ?? []) as Array<{ venue_id: string }>) {
      if (row.venue_id) ids.add(row.venue_id)
    }
  }

  return { ids: [...ids], errors }
}

export async function runSpendSyncSweep(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const supabase = createServiceClient()
  const result: SweepResult = {
    ok: true,
    venuesScanned: 0,
    connectorsCalled: 0,
    connectorsNotConnected: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    errors: 0,
  }

  let venueIds: string[]
  if (opts.venueId) {
    venueIds = [opts.venueId]
  } else {
    const eligible = await eligibleVenueIds(supabase)
    venueIds = eligible.ids
    result.errors += eligible.errors
  }

  result.venuesScanned = venueIds.length
  const lookbackDays = opts.lookbackDays ?? 3

  for (const venueId of venueIds) {
    // Each connector is independent. Errors do not cascade. Log and
    // continue so a single broken platform doesn't kill the sweep.
    const connectors = [
      {
        name: 'google_ads',
        run: () => syncGoogleAds({ venueId, lookbackDays }),
      },
      { name: 'meta_ads', run: () => syncMetaAds({ venueId, lookbackDays }) },
      {
        name: 'tiktok_ads',
        run: () => syncTikTokAds({ venueId, lookbackDays }),
      },
    ]

    for (const c of connectors) {
      result.connectorsCalled += 1
      try {
        const r = await c.run()
        result.rowsInserted += r.rowsInserted
        result.rowsUpdated += r.rowsUpdated
        if (!r.ok && (r.reason === 'not_connected' || r.reason === 'not_configured')) {
          result.connectorsNotConnected += 1
          continue
        }
        if (!r.ok) {
          result.errors += 1
          logEvent({
            level: 'warn',
            msg: 'spend_sync_sweep.connector_refused',
            event_type: 'cron.run',
            outcome: 'fail',
            venueId,
            data: { connector: c.name, reason: r.reason, message: r.message },
          })
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
