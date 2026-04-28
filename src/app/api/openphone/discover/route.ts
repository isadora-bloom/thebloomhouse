/**
 * POST /api/openphone/discover
 *
 * Calls OpenPhone's /phone-numbers endpoint with the venue's stored API
 * key and persists the discovered numbers on
 * openphone_connections.phone_numbers. Used by the settings UI as both
 * a "Test connection" check and a one-time number-discovery step.
 *
 * Returns the merged list of phone numbers (preserving any existing
 * `enabled=false` toggles from a previous discovery).
 */

import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { discoverPhoneNumbers } from '@/lib/services/openphone'

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const phoneNumbers = await discoverPhoneNumbers(auth.venueId)
    return NextResponse.json({ success: true, phoneNumbers })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[api/openphone/discover] error:', err)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
