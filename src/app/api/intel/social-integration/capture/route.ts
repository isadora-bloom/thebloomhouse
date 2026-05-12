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
import { matchEngagementsForCapture } from '@/lib/services/social/match-engagements'

/**
 * POST /api/intel/social-integration/capture
 *
 * Captures one snapshot of operator-pasted social data + runs the
 * matcher inline. V1 only supports (platform=instagram,
 * metric_type=new_followers) -- other combos return 422.
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
 *     captureId, total, matched, unmatched,
 *     surfaced_pre_inquiry,
 *     matchedSamples: [{handle, couple_name, wedding_id,
 *                      is_pre_inquiry, engagement_at, inquiry_date}]
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

    // 3. Insert social_engagements rows. The follower-list metric has
    //    no per-engagement timestamp on Instagram; we treat the capture
    //    time as the engagement_at upper bound. The "before-inquiry"
    //    calculation in the matcher uses this; if inquiry_date is
    //    in the past relative to captured_at the engagement still
    //    counts as pre-inquiry only when captured_at < inquiry_date.
    //    Reality: most follower captures are AFTER inquiry, so this
    //    metric mainly surfaces matches; the pre-inquiry signal is
    //    high-value when we backfill against historical follower lists.
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

    // 4. Run the matcher inline.
    const matchResult = await matchEngagementsForCapture(capture.id, service)

    return NextResponse.json({
      captureId: capture.id,
      total: parsed.length,
      matched: matchResult.matched,
      unmatched: matchResult.unmatched,
      surfaced_pre_inquiry: matchResult.surfaced_pre_inquiry,
      matchedSamples: matchResult.matchedSamples,
    })
  } catch (err) {
    return serverError(err)
  }
}
