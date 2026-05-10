/**
 * Wave 8 — GET /api/admin/venue/location/preview?venueId=X
 *
 * Returns what auto-derivation WOULD produce given the venue's current
 * address fields, WITHOUT writing anything. Operator can preview before
 * clicking "Apply" on the venue-info form.
 *
 * Auth: getPlatformAuth (coordinator UI). Demo allowed (read-only).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  forbidden,
  serverError,
  assertCanAccessVenue,
} from '@/lib/api/auth-helpers'
import {
  deriveLocationFromAddress,
  type AddressInput,
} from '@/lib/services/external-signals-config/derive-from-address'

export const maxDuration = 30

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const url = new URL(req.url)
  const venueId = url.searchParams.get('venueId') ?? auth.venueId
  if (!venueId) return badRequest('venueId required')

  const access = await assertCanAccessVenue(auth, venueId)
  if (!access.ok) return forbidden(access.reason)

  const supabase = createServiceClient()
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
  // mig 271 added the new columns. Mirrors auto-derive route.
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
    return NextResponse.json({
      ok: true,
      venueId,
      currentValues: {
        google_trends_metro: v.google_trends_metro,
        noaa_station_id: v.noaa_station_id,
        census_fips: v.census_fips,
        metro_msa_code: v.metro_msa_code,
        dc_region_proxy: v.dc_region_proxy,
        latitude: v.latitude,
        longitude: v.longitude,
      },
      preview: result,
      diffs: diffPreview(v, result),
    })
  } catch (err) {
    return serverError(err)
  }
}

function diffPreview(
  current: {
    google_trends_metro: string | null
    noaa_station_id: string | null
    census_fips: string | null
    metro_msa_code: string | null
    dc_region_proxy: boolean | null
    latitude: number | null
    longitude: number | null
  },
  preview: {
    google_trends_metro: string | null
    noaa_station_id: string | null
    census_fips: string | null
    metro_msa_code: string | null
    dc_region_proxy: boolean | null
    latitude: number | null
    longitude: number | null
  },
): Array<{ field: string; current: unknown; proposed: unknown; willWrite: boolean }> {
  const fields = [
    'google_trends_metro',
    'noaa_station_id',
    'census_fips',
    'metro_msa_code',
    'dc_region_proxy',
    'latitude',
    'longitude',
  ] as const
  return fields.map((f) => {
    const c = current[f]
    const p = preview[f]
    return {
      field: f,
      current: c,
      proposed: p,
      // willWrite under default (no force): only when current is null AND proposed exists.
      willWrite: c == null && p != null,
    }
  })
}
