import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  serverError,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * GET /api/portal/marketing-channels
 *
 * Wave 6E support endpoint. Returns the venue's marketing channels
 * for use in pickers (e.g. the agency engagement form's managed-
 * channels selector). Mirrors the existing
 * /portal/marketing-channels-config page's client-side query but
 * runs server-side so other surfaces can consume it without each
 * one duplicating the supabase call.
 */
export async function GET(_request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const service = createServiceClient()
  try {
    const { data, error } = await service
      .from('marketing_channels')
      .select('id, key, label, category, is_active')
      .eq('venue_id', auth.venueId)
      .is('deleted_at', null)
      .order('label', { ascending: true })

    if (error) return serverError(error)
    return NextResponse.json({ channels: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}
