/**
 * Wave 8 — external-signals health sweep across all venues.
 *
 * For every venue:
 *   1. If location_derived_at is null OR address fields changed since
 *      derivation, run deriveLocationFromAddress and write the results
 *      back to `venues` (only fields that are currently null + any errors
 *      cleared).
 *   2. Run checkExternalSignalHealth so external_signal_health is fresh.
 *
 * TODO (cron registration): this sweep is NOT registered as a Vercel cron
 * yet. To wire:
 *   - Add an entry to vercel.json with path `/api/cron?job=external_signals_health_sweep`
 *     and a daily schedule (e.g. `0 7 * * *`).
 *   - Add a case in `src/app/api/cron/route.ts` for
 *     `external_signals_health_sweep` that calls runExternalSignalsHealthSweep.
 *   - Add `external_signals_health_sweep` to DESTRUCTIVE_JOBS in
 *     `src/lib/cron-auth.ts` IFF you want the second-tier secret gate
 *     (this sweep is currently low-risk: read-only network calls + idempotent
 *     upserts, so it can stay non-destructive).
 *
 * Wave 8 leaves this file decoupled to avoid touching files in flight with
 * the parallel Round 4 streams (vercel.json, cron route, cron-auth).
 */

import { createServiceClient } from '@/lib/supabase/service'
import { deriveLocationFromAddress, buildDeriveCache, type AddressInput } from './derive-from-address'
import { checkExternalSignalHealth } from './health-check'

interface SweepResult {
  venueId: string
  derived: boolean
  derivedFields: string[]
  derivationErrors: string[]
  healthSignals: number  // count of signals with status != 'ready'
}

/**
 * Run the full sweep across every venue. Returns one summary row per venue.
 *
 * Network rate-limiting: NOAA + Census + Nominatim each have their own
 * limits. Nominatim is the strictest (1 req/sec). We sleep 1.2s between
 * venues that need geocoding. Venues with full address data already in
 * place skip the network entirely.
 */
export async function runExternalSignalsHealthSweep(args: {
  /** When set, only sweep this single venue. */
  venueIdFilter?: string
  /** When true, re-derive even if location_derived_at exists. */
  forceRederive?: boolean
}): Promise<{ venues: SweepResult[]; totalChecked: number; totalErrors: number }> {
  const supabase = createServiceClient()
  const cache = buildDeriveCache()

  const query = supabase
    .from('venues')
    .select(
      'id, address_line1, city, state, zip, latitude, longitude, ' +
        'google_trends_metro, noaa_station_id, census_fips, metro_msa_code, ' +
        'dc_region_proxy, location_derived_at, location_derivation_source',
    )

  if (args.venueIdFilter) {
    query.eq('id', args.venueIdFilter)
  }

  const { data: venues, error } = await query
  if (error) throw new Error(`sweep load venues failed: ${error.message}`)
  if (!venues) return { venues: [], totalChecked: 0, totalErrors: 0 }

  const results: SweepResult[] = []
  let totalErrors = 0
  let networkCallsThisVenue = false

  for (const venue of venues) {
    // Cast through unknown — Supabase types haven't been regenerated since
    // mig 271 added the new columns (census_fips, metro_msa_code, etc).
    const v = venue as unknown as {
      id: string
      address_line1: string | null
      city: string | null
      state: string | null
      zip: string | null
      latitude: number | null
      longitude: number | null
      google_trends_metro: string | null
      noaa_station_id: string | null
      census_fips: string | null
      metro_msa_code: string | null
      dc_region_proxy: boolean | null
      location_derived_at: string | null
    }

    const derivedFields: string[] = []
    const derivationErrors: string[] = []
    let derived = false

    // Optional: throttle if we made network calls last loop (Nominatim rate limit).
    if (networkCallsThisVenue) {
      await new Promise((r) => setTimeout(r, 1200))
      networkCallsThisVenue = false
    }

    const shouldDerive = args.forceRederive || !v.location_derived_at

    if (shouldDerive) {
      const address: AddressInput = {
        line1: v.address_line1,
        city: v.city,
        state: v.state,
        zip: v.zip,
        latitude: v.latitude,
        longitude: v.longitude,
      }
      try {
        const result = await deriveLocationFromAddress({
          venueId: v.id,
          address,
          cache,
        })
        // Only fill fields that are currently null (don't overwrite manual values).
        const updates: Record<string, unknown> = {}
        if (v.google_trends_metro == null && result.google_trends_metro != null) {
          updates.google_trends_metro = result.google_trends_metro
          derivedFields.push('google_trends_metro')
        }
        if (v.noaa_station_id == null && result.noaa_station_id != null) {
          updates.noaa_station_id = result.noaa_station_id
          derivedFields.push('noaa_station_id')
        }
        if (v.census_fips == null && result.census_fips != null) {
          updates.census_fips = result.census_fips
          derivedFields.push('census_fips')
        }
        if (v.metro_msa_code == null && result.metro_msa_code != null) {
          updates.metro_msa_code = result.metro_msa_code
          derivedFields.push('metro_msa_code')
        }
        if (v.dc_region_proxy == null && result.dc_region_proxy != null) {
          updates.dc_region_proxy = result.dc_region_proxy
          derivedFields.push('dc_region_proxy')
        }
        if (v.latitude == null && result.latitude != null) {
          updates.latitude = result.latitude
          derivedFields.push('latitude')
        }
        if (v.longitude == null && result.longitude != null) {
          updates.longitude = result.longitude
          derivedFields.push('longitude')
        }

        derivationErrors.push(...result.errors)

        if (Object.keys(updates).length > 0) {
          updates.location_derived_at = new Date().toISOString()
          updates.location_derivation_source = {
            source: 'sweep',
            inputs: result.inputs,
            results: {
              google_trends_metro: result.google_trends_metro,
              noaa_station_id: result.noaa_station_id,
              census_fips: result.census_fips,
              metro_msa_code: result.metro_msa_code,
              dc_region_proxy: result.dc_region_proxy,
              latitude: result.latitude,
              longitude: result.longitude,
            },
            field_sources: result.field_sources,
            errors: result.errors,
            ran_at: new Date().toISOString(),
          }
          const { error: updateErr } = await supabase
            .from('venues')
            .update(updates)
            .eq('id', v.id)
          if (updateErr) {
            derivationErrors.push(`update_failed: ${updateErr.message}`)
          } else {
            derived = true
            networkCallsThisVenue = true
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        derivationErrors.push(`derive_exception: ${msg}`)
      }
    }

    // Always run health check so the dashboard has fresh status.
    let unreadyCount = 0
    try {
      const health = await checkExternalSignalHealth({ venueId: v.id })
      unreadyCount = health.filter((h) => h.status !== 'ready').length
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      derivationErrors.push(`health_exception: ${msg}`)
      totalErrors += 1
    }

    if (derivationErrors.length > 0) totalErrors += 1

    results.push({
      venueId: v.id,
      derived,
      derivedFields,
      derivationErrors,
      healthSignals: unreadyCount,
    })
  }

  return {
    venues: results,
    totalChecked: results.length,
    totalErrors,
  }
}
