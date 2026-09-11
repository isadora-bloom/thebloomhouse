import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import { parseInstagramFollowersText } from '@/lib/services/social/parsers/instagram-followers'
import { linkSocialEngagements } from '@/lib/services/identity/replay/social'

/**
 * POST /api/intel/social-integration/capture
 *
 * Captures one snapshot of operator-pasted social data, then routes every
 * parsed handle through `linkSignal` so it lands on the identity spine.
 * V1 only supports (platform=instagram, metric_type=new_followers);
 * other combos return 422.
 *
 * Wave 3 (HANDLE-IDENTITY-SPEC.md §4): this route used to call
 * `matchEngagementsForCapture`, which bound handles straight to the
 * legacy `people` table by trigram name similarity and by "the email
 * local part contains the handle". Both were guesses and both auto-bound
 * strangers. They are gone. What comes back now is a spine outcome per
 * handle: attached to a couple, minted as a new one, a candidate in
 * review, or a fragment waiting for an identity.
 *
 * Body:
 *   {
 *     platform: 'instagram' | 'tiktok' | 'facebook' | 'pinterest',
 *     metric_type: string,
 *     source_text: string
 *   }
 *
 * Response (200):
 *   {
 *     captureId, total, processed, skipped, skipped_reasons,
 *     attached, minted, candidates, fragments, duplicates,
 *     matched, unmatched,
 *     samples: [{handle, display_name, couple_id, couple_name,
 *                outcome, occurred_at, match_status}]
 *   }
 */
export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }

  const platform = typeof body.platform === 'string' ? body.platform : ''
  const metricType = typeof body.metric_type === 'string' ? body.metric_type : ''
  const sourceText = typeof body.source_text === 'string' ? body.source_text : ''

  if (!platform || !metricType) {
    return badRequest('platform + metric_type required')
  }
  if (!['instagram', 'tiktok', 'facebook', 'pinterest'].includes(platform)) {
    return badRequest('unknown platform')
  }

  // V1 gate: only instagram + new_followers is functional.
  if (!(platform === 'instagram' && metricType === 'new_followers')) {
    return NextResponse.json(
      {
        error: 'metric_not_supported',
        message: `Capture for ${platform}/${metricType} is not yet supported in V1.`,
      },
      { status: 422 },
    )
  }

  if (!sourceText.trim()) {
    return badRequest('source_text required for text-paste capture')
  }

  const service = createServiceClient()

  try {
    // 1. Parse the paste.
    const parsed = parseInstagramFollowersText(sourceText)
    const parseResult = {
      parsed_count: parsed.length,
      unique_count: parsed.length, // parser already dedups
      parser_version: 'instagram-followers/v1',
      errors: [] as string[],
    }

    // 2. Insert social_captures row.
    const { data: capture, error: capErr } = await service
      .from('social_captures')
      .insert({
        venue_id: auth.venueId,
        platform,
        metric_type: metricType,
        captured_by: auth.isDemo ? null : auth.userId,
        source_text: sourceText,
        parse_result: parseResult,
        total_handles: parsed.length,
        matched_count: 0,
        unmatched_count: 0,
      })
      .select('id, captured_at')
      .single()

    if (capErr || !capture) {
      return serverError(capErr ?? new Error('failed to insert capture'))
    }

    // 3. Insert social_engagements rows. A follower list carries no
    //    per-row timestamp, so engagement_at starts as the capture time,
    //    which is a ceiling: the follow happened at or before it. Where a
    //    capture surface DOES show a relative age (the screenshot vision
    //    path), the signal builder back-derives the real instant from it
    //    and the ceiling is never used.
    const engagementRows = parsed.map((p) => ({
      venue_id: auth.venueId,
      social_capture_id: capture.id,
      platform,
      metric_type: metricType,
      handle: p.handle,
      display_name: p.display_name,
      engagement_at: capture.captured_at,
      match_status: 'pending' as const,
    }))

    if (engagementRows.length > 0) {
      const { error: engErr } = await service
        .from('social_engagements')
        .insert(engagementRows)
      if (engErr) {
        return serverError(engErr)
      }
    }

    // 4. Route every row through linkSignal and write the spine outcome
    //    back onto it.
    const linked = await linkSocialEngagements({
      supabase: service,
      venueId: auth.venueId,
      captureId: capture.id,
      source: 'social_capture',
    })

    return NextResponse.json({
      captureId: capture.id,
      total: parsed.length,
      processed: linked.processed,
      skipped: linked.skipped,
      skipped_reasons: linked.skipped_reasons,
      attached: linked.outcomes.attached,
      minted: linked.outcomes.minted,
      candidates: linked.outcomes.candidate_medium + linked.outcomes.candidate_low,
      fragments: linked.outcomes.fragment,
      duplicates: linked.outcomes.duplicate,
      matched: linked.matched,
      unmatched: linked.unmatched,
      samples: linked.samples,
      errors: linked.errors,
    })
  } catch (err) {
    return serverError(err)
  }
}
