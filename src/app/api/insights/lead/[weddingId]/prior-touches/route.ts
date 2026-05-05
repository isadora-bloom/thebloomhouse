/**
 * GET /api/insights/lead/[weddingId]/prior-touches
 *
 * Wedding-scoped facade over /api/agent/inbox/prior-touches/[personId].
 *
 * Why exist: the inbox already has a person-scoped endpoint, but the
 * lead detail panel only knows the wedding id. Rather than duplicate
 * the prior-touches query logic on the wedding side, this resolves
 * the wedding's primary partner (partner1, fallback partner2) and
 * forwards to the same getPriorTouches service. Same numbers as the
 * inbox chip — no parallel implementation.
 *
 * Auth + scope mirror the parent /api/insights/lead/[weddingId]
 * endpoint exactly so coordinators with cross-venue access still get
 * the lookup. Demo mode bypasses auth checks.
 *
 * T5-γ.4 / Playbook ARCH-INSIGHTS.4.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, isDemoMode, isDemoVenueAllowed } from '@/lib/api/auth-helpers'
import { getPriorTouches } from '@/lib/services/prior-touches'
import { redactError } from '@/lib/observability/redact'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const { weddingId } = await params
  if (!weddingId || !/^[0-9a-f-]{36}$/i.test(weddingId)) {
    return NextResponse.json({ error: 'invalid_wedding_id' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const demo = await isDemoMode()

  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) {
    return NextResponse.json({ error: 'wedding_not_found' }, { status: 404 })
  }
  const venueId = wedding.venue_id as string

  if (demo) {
    // Demo-mode authz (#85, T5-followup-QQQ): the bloom_demo cookie is
    // an open bypass on this route. Any caller could ask for prior
    // touches on any wedding by UUID and read tier-1 data on real
    // production venues. Restrict demo callers to the Crestwood
    // Collection's 4 venues; the wedding's owning venue must be in the
    // allowlist. Mirrors the parent /api/insights/lead/[weddingId]
    // route's pattern.
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

  // Resolve the wedding's primary partner. Prefer partner1, fall back
  // to partner2, then any person on the wedding. People without a
  // role still count — better to surface "1 prior touch" off the
  // first available person than 404 because role wasn't assigned.
  const { data: people } = await supabase
    .from('people')
    .select('id, role')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)

  const peopleRows = (people ?? []) as Array<{ id: string; role: string | null }>
  const primary =
    peopleRows.find((p) => p.role === 'partner1')
    ?? peopleRows.find((p) => p.role === 'partner2')
    ?? peopleRows[0]
    ?? null

  if (!primary) {
    // No people yet — return an empty cold-style summary so the panel
    // can still render "No prior touches" honestly (matches the inbox
    // INV-8.5.5 contract for "we looked, found nothing").
    return NextResponse.json({
      personId: '',
      warmth: 'cold',
      touches: [],
      counts: { tangential: 0, interactions: 0, tours: 0 },
    })
  }

  try {
    const summary = await getPriorTouches({
      supabase,
      venueId,
      personId: primary.id,
    })
    return NextResponse.json(summary)
  } catch (err) {
    // #86 (T5-followup-QQQ): redact PII from both the stdout log AND
    // the response body. getPriorTouches → Supabase / downstream errors
    // can echo couple emails, phone numbers, and quoted message text.
    // Wrap with redactError before serialising to either sink.
    console.error('[insights/prior-touches] lookup failed:', redactError(err))
    return NextResponse.json(
      { error: redactError(err) },
      { status: 500 }
    )
  }
}
