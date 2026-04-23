import { NextRequest, NextResponse } from 'next/server'
import {
  getActiveAlerts,
  runAnomalyDetection,
  acknowledgeAlert,
} from '@/lib/services/anomaly-detection'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// GET /api/intel/anomalies
//
// Default behaviour (no query params): returns unacknowledged alerts for the
// caller's venue, wrapped as { alerts }. This matches what the dashboard
// header and briefings have always consumed, so existing callers are not
// touched.
//
// Extended (Phase 6 Task 57): pass query params to power /intel/anomalies:
//   scope    = 'venue' | 'group' | 'company'   default 'venue'
//   groupId  = uuid                            required when scope='group'
//   status   = 'open' | 'acknowledged' | 'all' default 'all' when scope set
//
// When any of those params are present the response shape is unchanged
// ({ alerts }), but the rows include venues.name so the page can render a
// venue chip at group/company scope.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = request.nextUrl.searchParams
  const scope = sp.get('scope') as 'venue' | 'group' | 'company' | null
  const groupId = sp.get('groupId')
  const statusParam = (sp.get('status') || 'all') as 'open' | 'acknowledged' | 'all'

  // Legacy path: no query params → unacknowledged alerts for the caller's venue.
  if (!scope) {
    try {
      const alerts = await getActiveAlerts(auth.venueId)
      return NextResponse.json({ alerts })
    } catch (err) {
      console.error('[api/intel/anomalies] GET error:', err)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // Extended path: scope-aware.
  if (scope !== 'venue' && scope !== 'group' && scope !== 'company') {
    return NextResponse.json(
      { error: 'scope must be "venue", "group", or "company"' },
      { status: 400 }
    )
  }
  if (scope === 'group' && !groupId) {
    return NextResponse.json(
      { error: 'groupId is required when scope=group' },
      { status: 400 }
    )
  }

  const service = createServiceClient()

  // ----- Resolve in-scope venue IDs --------------------------------------
  let venueIds: string[] = []
  if (scope === 'venue') {
    venueIds = [auth.venueId]
  } else if (scope === 'group') {
    const { data: group } = await service
      .from('venue_groups')
      .select('id, org_id')
      .eq('id', groupId as string)
      .maybeSingle()
    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }
    if (auth.orgId && group.org_id && group.org_id !== auth.orgId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { data: members } = await service
      .from('venue_group_members')
      .select('venue_id')
      .eq('group_id', groupId as string)
    venueIds = (members ?? []).map((m) => m.venue_id as string)
  } else {
    // company scope
    if (!auth.orgId) {
      return NextResponse.json(
        { error: 'No org associated with this account' },
        { status: 400 }
      )
    }
    const { data: venues } = await service
      .from('venues')
      .select('id')
      .eq('org_id', auth.orgId)
    venueIds = (venues ?? []).map((v) => v.id as string)
  }

  if (venueIds.length === 0) {
    return NextResponse.json({ alerts: [] })
  }

  let query = service
    .from('anomaly_alerts')
    .select('*, venues:venue_id(name)')
    .in('venue_id', venueIds)
    .order('created_at', { ascending: false })

  if (statusParam === 'open') query = query.eq('acknowledged', false)
  else if (statusParam === 'acknowledged') query = query.eq('acknowledged', true)

  const { data, error } = await query
  if (error) {
    console.error('[api/intel/anomalies] scoped GET error:', error.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({ alerts: data ?? [] })
}

// ---------------------------------------------------------------------------
// POST: Run anomaly detection manually
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const alerts = await runAnomalyDetection(auth.venueId)
    return NextResponse.json({ alerts })
  } catch (err) {
    console.error('[api/intel/anomalies] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PATCH: Acknowledge an alert
//   Body: { alertId: string }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { alertId } = body

    if (!alertId || typeof alertId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid alertId' },
        { status: 400 }
      )
    }

    const success = await acknowledgeAlert(alertId, auth.userId)

    if (!success) {
      return NextResponse.json(
        { error: 'Failed to acknowledge alert' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[api/intel/anomalies] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
