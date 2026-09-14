/**
 * POST /api/intel/reviews/solicit-gap-backfill
 *
 * TIER 7c (2026-05-14). Operator-triggered backfill of the
 * solicitation gap: enqueues review_solicit_jobs for every booked
 * wedding in the 7-30 days post-event window that has no
 * review_solicit_requests row yet. Mirrors what the daily cron does;
 * lets the operator close the gap immediately rather than wait until
 * tomorrow's 12:00 UTC run.
 */

import { NextRequest, NextResponse } from 'next/server'
import { refuseDemo, getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import { enqueueReviewSolicit } from '@/lib/services/reviews/solicit'
import { loadCouplesByWeddingDate } from '@/lib/intel/readers/couple-by-wedding'
import { redactError } from '@/lib/observability/redact'
import { apiError } from '@/lib/api/api-error'

export async function POST(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // The demo identity is an anonymous visitor. It may look; it may not write.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal

  try {
    const supabase = createServiceClient()
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)

    // W66: "whose wedding has just happened" is asked of the spine.
    // couples.lifecycle_state carries booked and completed (migration
    // 365), so the window is the same one, read off the identity row
    // rather than the legacy status column.
    const postEventCouples = await loadCouplesByWeddingDate(
      supabase,
      auth.venueId,
      thirtyDaysAgo,
      sevenDaysAgo,
    )
    const weddingIds = postEventCouples
      .map((c) => c.weddingId)
      .filter((id): id is string => Boolean(id))
    if (weddingIds.length === 0) {
      return NextResponse.json({ ok: true, enqueued: 0, skipped: 0 })
    }

    const { data: existingReqs } = await supabase
      .from('review_solicit_requests')
      .select('wedding_id')
      .in('wedding_id', weddingIds)
    const solicited = new Set(
      ((existingReqs ?? []) as Array<{ wedding_id: string }>).map((s) => s.wedding_id),
    )

    let enqueued = 0
    let skipped = 0
    for (const wid of weddingIds) {
      if (solicited.has(wid)) {
        skipped++
        continue
      }
      try {
        const result = await enqueueReviewSolicit({
          weddingId: wid,
          venueId: auth.venueId,
          triggerSignal: 'operator_gap_backfill',
          supabase,
        })
        if (result.skipped) skipped++
        else enqueued++
      } catch (err) {
        console.warn('[solicit-gap-backfill] enqueue failed:', redactError(err))
        skipped++
      }
    }

    return NextResponse.json({ ok: true, enqueued, skipped })
  } catch (err) {
    return apiError(err)
  }
}
