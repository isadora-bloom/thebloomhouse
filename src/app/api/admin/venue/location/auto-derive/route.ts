/**
 * Wave 8 — POST /api/admin/venue/location/auto-derive
 *
 * Derives external-signal config (google_trends_metro, noaa_station_id,
 * census_fips, metro_msa_code, dc_region_proxy, lat/lng) from the venue's
 * existing address fields and writes the derivation back to `venues`.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required in body.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * Body: { venueId?: string, forceOverwrite?: boolean }
 *
 * forceOverwrite=false (default): only fills currently-null fields. Manual
 * edits are sacred — operator can override on the venue-info form and we
 * won't silently rewrite their value.
 *
 * forceOverwrite=true: rewrites every derived field. Used when address
 * fundamentals changed and operator explicitly clicks "re-derive everything".
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  serverError,
  assertCanAccessVenue,
} from '@/lib/api/auth-helpers'
import {
  deriveLocationFromAddress,
  type AddressInput,
} from '@/lib/services/external-signals-config/derive-from-address'

export const maxDuration = 30

export async function POST(req: NextRequest) {
  let body: { venueId?: string; forceOverwrite?: boolean }
  try {
    body = (await req.json()) as { venueId?: string; forceOverwrite?: boolean }
  } catch {
    body = {}
  }

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string
  let derivationActor: 'ops_cron' | 'coordinator_manual'

  if (cronAuth) {
    if (!body.venueId) {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    venueId = body.venueId
    derivationActor = 'ops_cron'
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot run auto-derive')
    const target = body.venueId ?? auth.venueId
    if (!target) return badRequest('no venueId resolved')
    const access = await assertCanAccessVenue(auth, target)
    if (!access.ok) return forbidden(access.reason)
    venueId = target
    derivationActor = 'coordinator_manual'
  }

  const supabase = createServiceClient()

  // Load current venue address.
  const { data: venue, error: loadErr } = await supabase
    .from('venues')
    .select(
      'address_line1, city, state, zip, latitude, longitude, ' +
        'google_trends_metro, noaa_station_id, census_fips, metro_msa_code, dc_region_proxy',
    )
    .eq('id', venueId)
    .maybeSingle()

  if (loadErr || !venue) {
    return NextResponse.json(
      { error: `Venue not found: ${loadErr?.message ?? 'no row'}` },
      { status: 404 },
    )
  }

  // Cast through unknown — Supabase types haven't been regenerated since
  // mig 271 added the new columns (census_fips, metro_msa_code, etc).
  const v = venue as unknown as {
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
  }

  const address: AddressInput = {
    line1: v.address_line1,
    city: v.city,
    state: v.state,
    zip: v.zip,
    latitude: v.latitude,
    longitude: v.longitude,
  }

  try {
    const result = await deriveLocationFromAddress({ venueId, address })

    const force = body.forceOverwrite === true
    const updates: Record<string, unknown> = {}
    const fieldsWritten: string[] = []

    function maybeWrite<K extends string>(
      column: K,
      currentValue: unknown,
      newValue: unknown,
    ) {
      if (newValue == null) return
      if (force || currentValue == null) {
        updates[column] = newValue
        fieldsWritten.push(column)
      }
    }

    maybeWrite('google_trends_metro', v.google_trends_metro, result.google_trends_metro)
    maybeWrite('noaa_station_id', v.noaa_station_id, result.noaa_station_id)
    maybeWrite('census_fips', v.census_fips, result.census_fips)
    maybeWrite('metro_msa_code', v.metro_msa_code, result.metro_msa_code)
    maybeWrite('dc_region_proxy', v.dc_region_proxy, result.dc_region_proxy)
    maybeWrite('latitude', v.latitude, result.latitude)
    maybeWrite('longitude', v.longitude, result.longitude)

    if (fieldsWritten.length > 0) {
      updates.location_derived_at = new Date().toISOString()
      updates.location_derivation_source = {
        source: derivationActor,
        force,
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
        .eq('id', venueId)

      if (updateErr) {
        return NextResponse.json(
          { error: `Update failed: ${updateErr.message}`, derivation: result },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({
      ok: true,
      venueId,
      derivation: result,
      fieldsWritten,
      force,
    })
  } catch (err) {
    return serverError(err)
  }
}
