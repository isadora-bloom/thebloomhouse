import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { createServiceClient } from '@/lib/supabase/service'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// GET — Fetch intelligence insights for the current venue
// Query params: limit, offset, type, category, priority, status
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const limit = Math.min(Number(sp.get('limit') || '25'), 100)
  const offset = Number(sp.get('offset') || '0')
  const insightType = sp.get('type')
  const category = sp.get('category')
  const priority = sp.get('priority')
  const status = sp.get('status') // 'active' (default) = new+seen, or specific status

  const venueIds = await resolveScopeVenueIds()
  if (venueIds.length === 0) {
    return NextResponse.json({
      insights: [],
      total: 0,
      stats: { new_count: 0, acted_on_this_month: 0, dismissed_this_month: 0 },
    })
  }

  const supabase = createServiceClient()

  let query = supabase
    .from('intelligence_insights')
    .select('*', { count: 'exact' })
    .in('venue_id', venueIds)

  // Status filter — default shows active (new + seen), not expired
  if (status === 'acted_on') {
    query = query.eq('status', 'acted_on')
  } else if (status === 'dismissed') {
    query = query.eq('status', 'dismissed')
  } else {
    // Active: new or seen, not expired
    query = query.in('status', ['new', 'seen'])
    query = query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
  }

  if (insightType) query = query.eq('insight_type', insightType)
  if (category) query = query.eq('category', category)
  if (priority) query = query.eq('priority', priority)

  // Order: critical first, then by creation
  query = query
    .order('priority', { ascending: true }) // alphabetical: critical < high < low < medium — we'll sort client-side too
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const { data, count, error } = await query

  if (error) {
    console.error('Insights fetch error:', error)
    return NextResponse.json({ error: 'Failed to fetch insights' }, { status: 500 })
  }

  // Sort by priority rank (DB alphabetical doesn't match our priority order)
  const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  const sorted = (data ?? []).sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 99
    const pb = PRIORITY_RANK[b.priority] ?? 99
    if (pa !== pb) return pa - pb
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  // Also fetch counts for the stats bar
  const [newCount, actedCount, dismissedCount] = await Promise.all([
    supabase
      .from('intelligence_insights')
      .select('id', { count: 'exact', head: true })
      .in('venue_id', venueIds)
      .eq('status', 'new')
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
    supabase
      .from('intelligence_insights')
      .select('id', { count: 'exact', head: true })
      .in('venue_id', venueIds)
      .eq('status', 'acted_on')
      .gte('acted_on_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
    supabase
      .from('intelligence_insights')
      .select('id', { count: 'exact', head: true })
      .in('venue_id', venueIds)
      .eq('status', 'dismissed')
      .gte('dismissed_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
  ])

  return NextResponse.json({
    insights: sorted,
    total: count ?? 0,
    stats: {
      new_count: newCount.count ?? 0,
      acted_on_this_month: actedCount.count ?? 0,
      dismissed_this_month: dismissedCount.count ?? 0,
    },
  })
}
