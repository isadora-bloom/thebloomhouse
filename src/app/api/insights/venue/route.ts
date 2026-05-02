/**
 * GET /api/insights/venue
 *
 * Venue-scoped T3 insights aggregator. Currently runs T3-F (pricing
 * elasticity). T3-G (source-mix counterfactual) and T3-I (long-tail
 * strategic) will join the Promise.allSettled fan-out.
 *
 * Auth: getPlatformAuth — coordinator must be signed in. Demo mode
 * bypasses (matches the lead-scoped endpoint's pattern).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, isDemoMode } from '@/lib/api/auth-helpers'
import { generatePricingElasticity } from '@/lib/services/insights/pricing-elasticity'
import { generateSourceMixCounterfactual } from '@/lib/services/insights/source-mix-counterfactual'
import { generateCoordinatorOverridePattern } from '@/lib/services/insights/coordinator-override-pattern'
import { generateStrengthAreaCohort } from '@/lib/services/insights/strength-area-cohort'
import { gateForBrainCall, nextUtcMidnightIso } from '@/lib/services/cost-ceiling'

export async function GET(request: NextRequest) {
  const supabase = createServiceClient()
  const demo = await isDemoMode()

  let venueId: string | null = null
  if (demo) {
    // In demo, derive venueId from query param so the demo can call
    // for any of the Crestwood venues.
    venueId = request.nextUrl.searchParams.get('venueId')
    if (!venueId) {
      return NextResponse.json({ error: 'venueId required in demo' }, { status: 400 })
    }
  } else {
    const platform = await getPlatformAuth()
    if (!platform) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    venueId = platform.venueId
  }

  const force = request.nextUrl.searchParams.get('refresh') === '1'

  // Cost-ceiling gate (T5-α.2): same 429 short-circuit as the
  // lead-scoped endpoint. See lead/[weddingId]/route.ts for the
  // rationale.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'autonomous_paused', resume_at: nextUtcMidnightIso() },
      { status: 429 },
    )
  }

  const [pricing, sourceMix, coordinatorOverride, strengthArea] = await Promise.allSettled([
    generatePricingElasticity(supabase, venueId, force),
    generateSourceMixCounterfactual(supabase, venueId, force),
    generateCoordinatorOverridePattern(supabase, venueId, force),
    generateStrengthAreaCohort(supabase, venueId, force),
  ])

  return NextResponse.json({
    venueId,
    pricing: pricing.status === 'fulfilled' ? pricing.value : null,
    sourceMix: sourceMix.status === 'fulfilled' ? sourceMix.value : null,
    coordinatorOverride: coordinatorOverride.status === 'fulfilled' ? coordinatorOverride.value : null,
    strengthArea: strengthArea.status === 'fulfilled' ? strengthArea.value : null,
    errors: [
      ...(pricing.status === 'rejected' ? [{ insight: 'pricing', error: String(pricing.reason) }] : []),
      ...(sourceMix.status === 'rejected' ? [{ insight: 'sourceMix', error: String(sourceMix.reason) }] : []),
      ...(coordinatorOverride.status === 'rejected' ? [{ insight: 'coordinatorOverride', error: String(coordinatorOverride.reason) }] : []),
      ...(strengthArea.status === 'rejected' ? [{ insight: 'strengthArea', error: String(strengthArea.reason) }] : []),
    ],
  })
}
