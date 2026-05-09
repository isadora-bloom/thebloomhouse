import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * POST /api/intel/sources/dismiss
 *
 * Stamps tracked_sources.last_dismissed_at = now() so the freshness
 * cron suppresses reminders for 14 days. Coordinator action when they
 * want to acknowledge "yes I know, I'll get to it later" without
 * actually un-tracking the source.
 *
 * Body: { source_key: string }
 */
export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { source_key?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const sourceKey = (body.source_key ?? '').trim()
  if (!sourceKey) {
    return NextResponse.json({ error: 'source_key is required' }, { status: 400 })
  }

  const sb = createServiceClient()
  const { error } = await sb
    .from('tracked_sources')
    .update({ last_dismissed_at: new Date().toISOString() })
    .eq('venue_id', auth.venueId)
    .eq('source_key', sourceKey)
    .eq('graveyard', false)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
