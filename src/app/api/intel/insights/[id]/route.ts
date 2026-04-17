import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { recordInsightAction } from '@/lib/services/insight-tracking'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// PATCH — Update insight status (seen, acted_on, dismissed)
// Body: { status: 'seen' | 'acted_on' | 'dismissed', note?: string }
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const plan = await requirePlan(req, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await req.json()
  const { status, note } = body as { status: string; note?: string }

  const validStatuses = ['seen', 'acted_on', 'dismissed']
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Build the update payload
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }

  if (status === 'seen') {
    update.seen_at = new Date().toISOString()
  } else if (status === 'acted_on') {
    update.acted_on_at = new Date().toISOString()
    // Store the note in data_points if provided
    if (note) {
      // Fetch current data_points to merge
      const { data: existing } = await supabase
        .from('intelligence_insights')
        .select('data_points')
        .eq('id', id)
        .eq('venue_id', auth.venueId)
        .single()
      const currentData = (existing?.data_points as Record<string, unknown>) ?? {}
      update.data_points = { ...currentData, action_note: note, action_taken_by: auth.userId }
    }
  } else if (status === 'dismissed') {
    update.dismissed_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('intelligence_insights')
    .update(update)
    .eq('id', id)
    .eq('venue_id', auth.venueId)
    .select()
    .single()

  if (error) {
    console.error('Insight update error:', error)
    return NextResponse.json({ error: 'Failed to update insight' }, { status: 500 })
  }

  if (!data) {
    return NextResponse.json({ error: 'Insight not found' }, { status: 404 })
  }

  // When marking as acted_on, capture baseline for outcome tracking
  if (status === 'acted_on') {
    const actionDescription = note || 'Action taken (no description provided)'
    try {
      const outcome = await recordInsightAction(id, auth.venueId, actionDescription)
      if (outcome) {
        return NextResponse.json({ insight: data, outcome })
      }
    } catch (err) {
      // Log but don't fail the main request
      console.error('[insights/[id]] Outcome tracking failed:', err)
    }
  }

  return NextResponse.json({ insight: data })
}
