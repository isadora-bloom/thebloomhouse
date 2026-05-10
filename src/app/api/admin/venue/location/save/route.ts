/**
 * Wave 8 — POST /api/admin/venue/location/save
 *
 * Manual save of address + derived fields. Extends the existing
 * /settings/venue-info supabase.update with explicit handling of the
 * Wave 8 derived fields (google_trends_metro, noaa_station_id, etc).
 *
 * Why a server endpoint vs the existing client-side Supabase update?
 * Two reasons:
 *   1. The Wave 8 audit fields (location_derived_at +
 *      location_derivation_source) need to be set with the correct actor +
 *      `source: 'manual'` when the operator types into the form.
 *   2. RLS allows authenticated users to UPDATE venues, but updating the
 *      jsonb audit field with the right shape is best done server-side so
 *      the client doesn't construct it.
 *
 * The existing client-side path in /settings/venue-info still works for the
 * unconfigured-by-Wave-8 fields (parking_instructions, day_of_contact, etc).
 * This endpoint is specifically for the address + derived fields.
 *
 * Auth: getPlatformAuth (coordinator UI). Demo blocked.
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

export const maxDuration = 30

interface SaveBody {
  venueId?: string
  address?: {
    address_line1?: string | null
    city?: string | null
    state?: string | null
    zip?: string | null
    latitude?: number | null
    longitude?: number | null
  }
  derived?: {
    google_trends_metro?: string | null
    noaa_station_id?: string | null
    census_fips?: string | null
    metro_msa_code?: string | null
    dc_region_proxy?: boolean | null
  }
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot save venue location')

  let body: SaveBody
  try {
    body = (await req.json()) as SaveBody
  } catch {
    return badRequest('invalid JSON body')
  }

  const venueId = body.venueId ?? auth.venueId
  if (!venueId) return badRequest('venueId required')

  const access = await assertCanAccessVenue(auth, venueId)
  if (!access.ok) return forbidden(access.reason)

  const supabase = createServiceClient()

  // Coalesce input. Empty strings convert to null (Supabase prefers NULL
  // over empty for these columns).
  function emptyToNull(s: string | null | undefined): string | null {
    if (s == null) return null
    const t = s.trim()
    return t === '' ? null : t
  }

  const updates: Record<string, unknown> = {}
  const a = body.address ?? {}
  const d = body.derived ?? {}

  // Address fields. These are the user-typed source of truth.
  if ('address_line1' in a) updates.address_line1 = emptyToNull(a.address_line1)
  if ('city' in a) updates.city = emptyToNull(a.city)
  if ('state' in a) updates.state = emptyToNull(a.state)
  if ('zip' in a) updates.zip = emptyToNull(a.zip)
  if ('latitude' in a) updates.latitude = a.latitude
  if ('longitude' in a) updates.longitude = a.longitude

  // Derived fields — operator may override what auto-derive produced.
  if ('google_trends_metro' in d) updates.google_trends_metro = emptyToNull(d.google_trends_metro)
  if ('noaa_station_id' in d) updates.noaa_station_id = emptyToNull(d.noaa_station_id)
  if ('census_fips' in d) updates.census_fips = emptyToNull(d.census_fips)
  if ('metro_msa_code' in d) updates.metro_msa_code = emptyToNull(d.metro_msa_code)
  if ('dc_region_proxy' in d) updates.dc_region_proxy = d.dc_region_proxy

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, venueId, fieldsUpdated: [] })
  }

  // Audit: manual edit. Don't overwrite location_derived_at — that's set
  // only when auto-derive runs.
  const fieldsUpdated = Object.keys(updates)
  // If derived fields were touched, mark the audit source as manual.
  const touchedDerived = Object.keys(d).some((k) =>
    ['google_trends_metro', 'noaa_station_id', 'census_fips', 'metro_msa_code', 'dc_region_proxy'].includes(k),
  )
  if (touchedDerived) {
    updates.location_derivation_source = {
      source: 'manual',
      actor: auth.userId,
      ran_at: new Date().toISOString(),
      fields_set: fieldsUpdated,
    }
  }

  try {
    const { error: updateErr } = await supabase
      .from('venues')
      .update(updates)
      .eq('id', venueId)
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, venueId, fieldsUpdated })
  } catch (err) {
    return serverError(err)
  }
}
