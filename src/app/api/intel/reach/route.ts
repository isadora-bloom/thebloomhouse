import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

/**
 * GET /api/intel/reach
 *
 * Returns every marketing_metric engagement_event for the caller's
 * scope, grouped by (source, metric). At venue scope this is one
 * venue; at group/company scope it spans every venue the user's
 * scope covers so totals aggregate instead of silently showing a
 * single venue's slice.
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const venueIds = await resolveScopeVenueIds()
  if (venueIds.length === 0) return NextResponse.json({ groups: [] })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('engagement_events')
    .select('metadata, created_at')
    .in('venue_id', venueIds)
    .eq('event_type', 'marketing_metric')
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type Point = { label: string; value: number }
  type Group = { source: string; metric: string; points: Point[]; total: number; latest: number | null }
  const groups = new Map<string, Group>()

  for (const row of data ?? []) {
    const md = (row.metadata ?? {}) as Record<string, unknown>
    const source = String(md.source ?? 'other')
    const metric = String(md.metric ?? 'other')
    const label = String(md.label ?? '')
    const value = Number(md.value ?? 0)
    if (!label || !Number.isFinite(value)) continue
    const key = `${source}|${metric}`
    const g = groups.get(key) ?? { source, metric, points: [], total: 0, latest: null }
    g.points.push({ label, value })
    g.total += value
    g.latest = value
    groups.set(key, g)
  }

  return NextResponse.json({
    groups: Array.from(groups.values()).sort((a, b) => b.total - a.total),
  })
}
