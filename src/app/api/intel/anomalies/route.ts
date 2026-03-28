import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  getActiveAlerts,
  runAnomalyDetection,
  acknowledgeAlert,
} from '@/lib/services/anomaly-detection'

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function getAuthVenue() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('venue_id')
    .eq('id', user.id)
    .single()

  return profile?.venue_id
    ? { userId: user.id, venueId: profile.venue_id as string }
    : null
}

// ---------------------------------------------------------------------------
// GET — Active (unacknowledged) anomaly alerts
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const alerts = await getActiveAlerts(auth.venueId)
    return NextResponse.json({ alerts })
  } catch (err) {
    console.error('[api/intel/anomalies] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Run anomaly detection manually
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getAuthVenue()
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
// PATCH — Acknowledge an alert
//   Body: { alertId: string }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getAuthVenue()
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
