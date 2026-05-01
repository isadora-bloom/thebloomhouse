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
import { getPlatformAuth, isDemoMode } from '@/lib/api/auth-helpers'
import { generateHeatNarration } from '@/lib/services/insights/heat-narration'
import { generateNegotiationState } from '@/lib/services/insights/negotiation-state'
import { generateRiskFlags } from '@/lib/services/insights/risk-flags'
import { generateDecayReEngagement } from '@/lib/services/insights/decay-re-engagement'
import { generateCohortMatch } from '@/lib/services/insights/cohort-match'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
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

  if (!demo) {
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

  // Run the 4 generators in parallel. Each one is independently
  // cache-fast-path — if the cache is fresh it returns without
  // calling Claude. Decay self-gates and returns null when the lead
  // shows no decay signal, so the panel only renders the card when
  // there's something useful to say.
  const [heat, negotiation, risk, decay, cohort] = await Promise.allSettled([
    generateHeatNarration(supabase, venueId, weddingId, force),
    generateNegotiationState(supabase, venueId, weddingId, force),
    generateRiskFlags(supabase, venueId, weddingId, force),
    generateDecayReEngagement(supabase, venueId, weddingId, force),
    generateCohortMatch(supabase, venueId, weddingId, force),
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
    errors: [
      ...(heat.status === 'rejected' ? [{ insight: 'heat', error: String(heat.reason) }] : []),
      ...(negotiation.status === 'rejected' ? [{ insight: 'negotiation', error: String(negotiation.reason) }] : []),
      ...(risk.status === 'rejected' ? [{ insight: 'risk', error: String(risk.reason) }] : []),
      ...(decay.status === 'rejected' ? [{ insight: 'decay', error: String(decay.reason) }] : []),
      ...(cohort.status === 'rejected' ? [{ insight: 'cohort', error: String(cohort.reason) }] : []),
    ],
  })
}
