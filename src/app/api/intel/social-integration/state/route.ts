import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import { getVenueSocialHandles } from '@/lib/services/identity/handles'
import type { HandlePlatform } from '@/lib/services/identity/sources/types'

/**
 * GET /api/intel/social-integration/state
 *
 * Returns the platform-card recency state per (platform, metric_type)
 * + per-platform configs (venue handle, recommended frequency).
 *
 * Response:
 *   {
 *     metrics: [{
 *       platform, metric_type, last_captured_at, status_color,
 *       recommended_frequency_days,
 *       total_handles, matched_count
 *     }],
 *     configs: [{platform, venue_handle, followers_url,
 *                recommended_frequency_days, is_active}]
 *   }
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const service = createServiceClient()

  try {
    const { data: configs, error: cErr } = await service
      .from('platform_configs')
      .select('platform, venue_handle, followers_url, recommended_frequency_days, is_active')
      .eq('venue_id', auth.venueId)

    if (cErr) return serverError(cErr)

    // Wave 5 W36: venue_config.social_handles (migration 403) is the
    // canonical venue-handle source now; platform_configs.venue_handle is
    // legacy. getVenueSocialHandles copies a legacy value across the first
    // time it finds venue_config empty for that platform, so this overlay
    // keeps the modal and the settings page reading the same value even
    // before that copy lands.
    const venueHandles = await getVenueSocialHandles(service, auth.venueId)
    const configsWithCanonicalHandle = (configs ?? []).map((c: {
      platform: string
      venue_handle: string | null
      followers_url: string | null
      recommended_frequency_days: number | null
      is_active: boolean
    }) => ({
      ...c,
      venue_handle: venueHandles?.[c.platform as HandlePlatform] ?? c.venue_handle,
    }))

    const { data: captures, error: capErr } = await service
      .from('social_captures')
      .select('platform, metric_type, captured_at, total_handles, matched_count')
      .eq('venue_id', auth.venueId)
      .order('captured_at', { ascending: false })

    if (capErr) return serverError(capErr)

    // Group by (platform, metric_type) -> latest captured_at.
    const latestByKey = new Map<
      string,
      {
        platform: string
        metric_type: string
        last_captured_at: string
        total_handles: number | null
        matched_count: number | null
      }
    >()

    for (const row of (captures ?? []) as Array<{
      platform: string
      metric_type: string
      captured_at: string
      total_handles: number | null
      matched_count: number | null
    }>) {
      const key = `${row.platform}::${row.metric_type}`
      if (!latestByKey.has(key)) {
        latestByKey.set(key, {
          platform: row.platform,
          metric_type: row.metric_type,
          last_captured_at: row.captured_at,
          total_handles: row.total_handles,
          matched_count: row.matched_count,
        })
      }
    }

    const configByPlatform = new Map<string, number>()
    for (const c of (configs ?? []) as Array<{
      platform: string
      recommended_frequency_days: number | null
    }>) {
      configByPlatform.set(c.platform, c.recommended_frequency_days ?? 7)
    }

    const now = Date.now()
    const metrics = Array.from(latestByKey.values()).map((m) => {
      const freq = configByPlatform.get(m.platform) ?? 7
      const ageDays =
        (now - new Date(m.last_captured_at).getTime()) / (1000 * 60 * 60 * 24)
      let status_color: 'sage' | 'amber' | 'rose'
      if (ageDays <= freq) status_color = 'sage'
      else if (ageDays <= freq * 2) status_color = 'amber'
      else status_color = 'rose'
      return {
        platform: m.platform,
        metric_type: m.metric_type,
        last_captured_at: m.last_captured_at,
        status_color,
        recommended_frequency_days: freq,
        total_handles: m.total_handles,
        matched_count: m.matched_count,
      }
    })

    return NextResponse.json({
      metrics,
      configs: configsWithCanonicalHandle,
    })
  } catch (err) {
    return serverError(err)
  }
}
