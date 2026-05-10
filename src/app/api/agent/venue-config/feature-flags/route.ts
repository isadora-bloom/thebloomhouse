/**
 * GET /api/agent/venue-config/feature-flags
 *
 * Wave 4 Phase 3 read endpoint. Returns the caller venue's
 * `venue_config.feature_flags` blob so client components can gate
 * sensitive-content reveal toggles on per-venue opt-in.
 *
 * Specifically the ReconstructedIdentityPanel reads
 * `flags.reveal_sensitive_themes`. Other surfaces may follow.
 *
 * Auth: getPlatformAuth — venue-scoped. Demo cookie is allowed
 * (read-only, returns the demo venue's flags).
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) {
    return NextResponse.json({ flags: {} })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_config')
    .select('feature_flags')
    .eq('venue_id', auth.venueId)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ flags: {}, error: error.message }, { status: 200 })
  }

  const raw = (data as { feature_flags?: Record<string, unknown> } | null)
    ?.feature_flags
  return NextResponse.json({ flags: raw ?? {} })
}
