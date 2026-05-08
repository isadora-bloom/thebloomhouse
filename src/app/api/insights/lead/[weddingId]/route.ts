/**
 * GET /api/insights/lead/[weddingId]
 *
 * Returns the 3 lead-level T3 insights (heat narration, negotiation
 * state, risk flags) for a wedding. The /agent/leads list view + the
 * lead detail page both consume this rather than duplicating fetch
 * logic across multiple components.
 *
 * The endpoint is read-mostly (cache-fast-path is used by the
 * generator services); writes only happen when a generator computes
 * a fresh narration. POST below forces regeneration when the
 * coordinator clicks "Refresh insights" on the lead detail.
 *
 * Auth: getPlatformAuth — coordinator must be signed in to the
 * venue the wedding belongs to.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, isDemoMode, isDemoVenueAllowed } from '@/lib/api/auth-helpers'
import { generateHeatNarration } from '@/lib/services/insights/heat-narration'
import { generateNegotiationState } from '@/lib/services/insights/negotiation-state'
import { generateRiskFlags } from '@/lib/services/insights/risk-flags'
import { generateDecayReEngagement } from '@/lib/services/insights/decay-re-engagement'
import { generateCohortMatch } from '@/lib/services/insights/cohort-match'
import { gateForBrainCall, nextUtcMidnightIso } from '@/lib/services/cost-ceiling'
import { newCorrelationId } from '@/lib/observability/logger'
import { redactError } from '@/lib/observability/redact'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  // Demo cookie path bypasses inside requirePlan (mirrors usePlanTier).
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const { weddingId } = await params
  if (!weddingId || !/^[0-9a-f-]{36}$/i.test(weddingId)) {
    return NextResponse.json({ error: 'invalid_wedding_id' }, { status: 400 })
  }

  // AUTHZ — verify the coordinator owns the wedding's venue. Demo
  // mode bypasses auth checks (matches the pattern in /api/portal/sage).
  const supabase = createServiceClient()
  const demo = await isDemoMode()

  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id, status')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) {
    return NextResponse.json({ error: 'wedding_not_found' }, { status: 404 })
  }
  const venueId = wedding.venue_id as string

  if (demo) {
    // Demo-mode authz (#85, T5-followup-CC): the bloom_demo cookie is
    // an open bypass on this route. Any caller could ask for insights
    // on any wedding by UUID and trigger LLM spend on real production
    // venues — the cost-ceiling caps damage but still bills. Restrict
    // demo callers to the Crestwood Collection's 4 venues; the
    // wedding's owning venue must be in the allowlist.
    if (!isDemoVenueAllowed(venueId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const platform = await getPlatformAuth()
    if (!platform) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (platform.venueId !== venueId) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  // Force regeneration when ?refresh=1.
  const force = request.nextUrl.searchParams.get('refresh') === '1'

  // T5-eta.3: thread a correlation_id through every generator so the
  // 4 insights, their api_costs rows, and any persisted intelligence_
  // insights row all carry the same id. Client (LeadInsightsPanel)
  // mints one per Refresh click and passes via ?correlationId=. Fall
  // back to a server-minted id when caller didn't supply one.
  const correlationId =
    request.nextUrl.searchParams.get('correlationId') ?? newCorrelationId()

  // Cost-ceiling gate (T5-α.2): if the venue has tripped its daily
  // ceiling and autonomous behavior is paused, refuse the
  // user-initiated insight generation request entirely. Pre-fix a
  // coordinator hammering Refresh on a paused venue could fire 5
  // Sonnet calls per click — the ceiling became a notification, not
  // a budget cap. OPS-21.4.3.
  //
  // 429 with resume_at hint so client banner can render
  // "auto-resumes at <next UTC midnight>". The flag actually clears
  // via clearStaleAutonomousPauses cron + spend-under-ceiling check;
  // the hint is plausible-earliest, not guaranteed.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'autonomous_paused', resume_at: nextUtcMidnightIso() },
      { status: 429 },
    )
  }

  // Tier-C #129 — record this tier-1 read on the audit trail. Lead
  // insights touch interactions/people/wedding bodies; a coordinator
  // exfiltrating couple-level intel would show as a burst of these
  // entries. Fire-and-forget; failure logs but doesn't block.
  if (!demo) {
    const { logRead } = await import('@/lib/services/activity-logger')
    const platformAuth = await getPlatformAuth()
    if (platformAuth) {
      void logRead({
        venueId,
        weddingId,
        userId: platformAuth.userId,
        resource: 'lead_insights',
        mode: 'view',
        rowCount: 1,
        details: { force, correlationId },
      })
    }
  }

  // Run the 4 generators in parallel. Each one is independently
  // cache-fast-path — if the cache is fresh it returns without
  // calling Claude. Decay self-gates and returns null when the lead
  // shows no decay signal, so the panel only renders the card when
  // there's something useful to say.
  // T5-eta.3: each generator gets the same correlationId so all 5
  // intelligence_insights rows + their api_costs lines share a single
  // forensic id.
  const [heat, negotiation, risk, decay, cohort] = await Promise.allSettled([
    generateHeatNarration(supabase, venueId, weddingId, force, correlationId),
    generateNegotiationState(supabase, venueId, weddingId, force, correlationId),
    generateRiskFlags(supabase, venueId, weddingId, force, correlationId),
    generateDecayReEngagement(supabase, venueId, weddingId, force, correlationId),
    generateCohortMatch(supabase, venueId, weddingId, force, correlationId),
  ])

  return NextResponse.json({
    weddingId,
    venueId,
    status: wedding.status,
    heat: heat.status === 'fulfilled' ? heat.value : null,
    negotiation: negotiation.status === 'fulfilled' ? negotiation.value : null,
    risk: risk.status === 'fulfilled' ? risk.value : null,
    decay: decay.status === 'fulfilled' ? decay.value : null,
    cohort: cohort.status === 'fulfilled' ? cohort.value : null,
    // #86 (T5-followup-CC): Stream B closed the stdout PII leak via
    // redactError, but the same raw reason strings were re-leaked into
    // the HTTP body via String(promise.reason). Anthropic 4xx responses
    // can echo the prompt content (couple emails, tour notes), so this
    // path silently exfiltrated tier-1 data on every brain failure.
    // redactError strips the same shapes the logger redacts.
    errors: [
      ...(heat.status === 'rejected' ? [{ insight: 'heat', error: redactError(heat.reason) }] : []),
      ...(negotiation.status === 'rejected' ? [{ insight: 'negotiation', error: redactError(negotiation.reason) }] : []),
      ...(risk.status === 'rejected' ? [{ insight: 'risk', error: redactError(risk.reason) }] : []),
      ...(decay.status === 'rejected' ? [{ insight: 'decay', error: redactError(decay.reason) }] : []),
      ...(cohort.status === 'rejected' ? [{ insight: 'cohort', error: redactError(cohort.reason) }] : []),
    ],
  })
}
