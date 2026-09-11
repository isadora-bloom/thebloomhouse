import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  notFound,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import { describeSocialOutcome } from '@/lib/services/identity/replay/social'

/**
 * GET /api/intel/social-integration/captures/[captureId]
 *
 * Returns one capture and its engagements, each carrying the spine
 * outcome: the couple it attached to, or the fact that it is a fragment
 * awaiting identity or a candidate in review.
 *
 * Wave 3 (HANDLE-IDENTITY-SPEC.md §4): names come from `couples`, not
 * from `people`. The legacy `matched_person_id` is deprecated and is no
 * longer read here; pre-wave-3 rows show as unbound until the replay
 * runs over them.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ captureId: string }> },
) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const { captureId } = await context.params
  if (!captureId) return notFound('capture')

  const service = createServiceClient()

  try {
    const { data: capture, error: cErr } = await service
      .from('social_captures')
      .select(
        'id, venue_id, platform, metric_type, captured_at, captured_by, total_handles, matched_count, unmatched_count, parse_result',
      )
      .eq('id', captureId)
      .maybeSingle()

    if (cErr) return serverError(cErr)
    if (!capture) return notFound('capture')
    if (capture.venue_id !== auth.venueId) return notFound('capture')

    const { data: engagements, error: eErr } = await service
      .from('social_engagements')
      .select(
        'id, handle, display_name, engagement_at, match_status, couple_id, match_method, match_confidence, matched_at',
      )
      .eq('social_capture_id', captureId)
      .order('created_at', { ascending: true })

    if (eErr) return serverError(eErr)

    type EngagementRow = {
      id: string
      handle: string
      display_name: string | null
      engagement_at: string | null
      match_status: string
      couple_id: string | null
      match_method: string | null
      match_confidence: number | null
      matched_at: string | null
    }
    const rows = (engagements ?? []) as EngagementRow[]

    // Hydrate couple names from the spine in one query.
    const coupleIds = Array.from(
      new Set(rows.map((e) => e.couple_id).filter((id): id is string => Boolean(id))),
    )

    type CoupleSnippet = {
      id: string
      primary_contact_name: string | null
      partner_contact_name: string | null
      lifecycle_state: string | null
    }
    let couples: CoupleSnippet[] = []
    if (coupleIds.length > 0) {
      const { data: cData } = await service
        .from('couples')
        .select('id, primary_contact_name, partner_contact_name, lifecycle_state')
        .in('id', coupleIds)
      couples = (cData ?? []) as CoupleSnippet[]
    }
    const coupleById = new Map(couples.map((c) => [c.id, c]))

    const hydrated = rows.map((e) => {
      const couple = e.couple_id ? coupleById.get(e.couple_id) : null
      const coupleName = couple
        ? [couple.primary_contact_name, couple.partner_contact_name].filter(Boolean).join(' & ') || null
        : null
      return {
        ...e,
        couple_name: coupleName,
        lifecycle_state: couple?.lifecycle_state ?? null,
        spine_outcome: describeSocialOutcome(e.match_status, e.match_method, coupleName),
      }
    })

    return NextResponse.json({
      capture,
      engagements: hydrated,
    })
  } catch (err) {
    return serverError(err)
  }
}
