/**
 * Day-3 readiness check (T5-followup-Y / Pattern I closure).
 *
 * GET /api/onboarding/day3-readiness
 *   → { ready, pricingRowCount, importedWeddingCount, ... }
 *
 * Used by the /onboarding/project page to surface a "Day 3 ready to
 * advance" hint once pricing_history has >= 5 manual rows AND weddings
 * has >= 1 imported_medium row.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { evaluateDay3Readiness } from '@/lib/services/onboarding/project'

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const supabase = createServiceClient()
  const result = await evaluateDay3Readiness(supabase, auth.venueId)
  return NextResponse.json(result)
}
