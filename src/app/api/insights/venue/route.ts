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
import { getPlatformAuth, isDemoMode, isDemoVenueAllowed } from '@/lib/api/auth-helpers'
import { generatePricingElasticity } from '@/lib/services/insights/pricing-elasticity'
import { generateSourceMixCounterfactual } from '@/lib/services/insights/source-mix-counterfactual'
import { generateCoordinatorOverridePattern } from '@/lib/services/insights/coordinator-override-pattern'
import { generateStrengthAreaCohort } from '@/lib/services/insights/strength-area-cohort'
import { gateForBrainCall, nextUtcMidnightIso } from '@/lib/services/cost-ceiling'
import { newCorrelationId } from '@/lib/observability/logger'
import { redactError } from '@/lib/observability/redact'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

export async function GET(request: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  // Demo cookie path bypasses inside requirePlan (mirrors usePlanTier
  // which defaults to 'enterprise' for demo).
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

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
    // Demo authz (#85, T5-followup-CC): the bloom_demo cookie is an
    // open bypass — any caller could ask for venue insights on a real
    // production venue UUID and bill LLM spend (cost-ceiling caps but
    // doesn't prevent). Restrict to the Crestwood Collection's 4
    // venues.
    if (!isDemoVenueAllowed(venueId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const platform = await getPlatformAuth()
    if (!platform) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    venueId = platform.venueId
  }

  const force = request.nextUrl.searchParams.get('refresh') === '1'

  // T5-eta.3: thread a correlation id through all generators so every
  // resulting intelligence_insights row + api_costs line shares a
  // single forensic id (mirrors the lead route).
  const correlationId =
    request.nextUrl.searchParams.get('correlationId') ?? newCorrelationId()

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
    generatePricingElasticity(supabase, venueId, force, correlationId),
    generateSourceMixCounterfactual(supabase, venueId, force, correlationId),
    generateCoordinatorOverridePattern(supabase, venueId, force, correlationId),
    generateStrengthAreaCohort(supabase, venueId, force, correlationId),
  ])

  return NextResponse.json({
    venueId,
    pricing: pricing.status === 'fulfilled' ? pricing.value : null,
    sourceMix: sourceMix.status === 'fulfilled' ? sourceMix.value : null,
    coordinatorOverride: coordinatorOverride.status === 'fulfilled' ? coordinatorOverride.value : null,
    strengthArea: strengthArea.status === 'fulfilled' ? strengthArea.value : null,
    // #86 (T5-followup-CC): wrap inner-promise rejection messages with
    // redactError before serialising into the HTTP body. Stream B
    // closed the stdout PII leak; the same Anthropic-error → prompt-echo
    // shape was leaking into the response body via String(reason).
    errors: [
      ...(pricing.status === 'rejected' ? [{ insight: 'pricing', error: redactError(pricing.reason) }] : []),
      ...(sourceMix.status === 'rejected' ? [{ insight: 'sourceMix', error: redactError(sourceMix.reason) }] : []),
      ...(coordinatorOverride.status === 'rejected' ? [{ insight: 'coordinatorOverride', error: redactError(coordinatorOverride.reason) }] : []),
      ...(strengthArea.status === 'rejected' ? [{ insight: 'strengthArea', error: redactError(strengthArea.reason) }] : []),
    ],
  })
}
