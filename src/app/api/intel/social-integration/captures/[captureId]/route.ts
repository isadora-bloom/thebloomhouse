import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  notFound,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * GET /api/intel/social-integration/captures/[captureId]
 *
 * Returns one capture + its engagements with matched-person joins.
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
        'id, handle, display_name, engagement_at, match_status, matched_person_id, match_method, match_confidence, matched_at',
      )
      .eq('social_capture_id', captureId)
      .order('created_at', { ascending: true })

    if (eErr) return serverError(eErr)

    // Hydrate matched-person snippets in one query.
    const matchedIds = (engagements ?? [])
      .map((e) => e.matched_person_id)
      .filter((id): id is string => Boolean(id))

    type PersonSnippet = {
      id: string
      first_name: string | null
      last_name: string | null
      wedding_id: string | null
    }
    let people: PersonSnippet[] = []
    if (matchedIds.length > 0) {
      const { data: pData } = await service
        .from('people')
        .select('id, first_name, last_name, wedding_id')
        .in('id', matchedIds)
      people = (pData ?? []) as PersonSnippet[]
    }
    const personById = new Map(people.map((p) => [p.id, p]))

    const hydrated = (engagements ?? []).map((e) => {
      const person = e.matched_person_id ? personById.get(e.matched_person_id) : null
      return {
        ...e,
        couple_name: person
          ? [person.first_name, person.last_name].filter(Boolean).join(' ') || null
          : null,
        wedding_id: person?.wedding_id ?? null,
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
