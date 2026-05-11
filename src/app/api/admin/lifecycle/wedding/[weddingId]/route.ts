/**
 * GET /api/admin/lifecycle/wedding/[weddingId]
 *
 * Wave 11 — returns the current lifecycle_stage + transition history.
 *
 * Auth: dual — getPlatformAuth OR CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { verifyCronAuth } from '@/lib/cron-auth'
import { createServiceClient } from '@/lib/supabase/service'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    const cron = verifyCronAuth(request, {
      jobName: 'lifecycle_wedding_read',
    })
    if (!cron.ok) {
      return NextResponse.json(
        { error: 'unauthorized' },
        { status: cron.status ?? 401 },
      )
    }
  }

  const { weddingId } = await params
  if (!weddingId) {
    return NextResponse.json({ error: 'weddingId required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: wedding, error: wErr } = await supabase
    .from('weddings')
    .select(
      'id, venue_id, status, lifecycle_stage, lifecycle_stage_set_at, ' +
        'lifecycle_transition_count, wedding_date, booked_at, lost_at, ' +
        'cancelled_at',
    )
    .eq('id', weddingId)
    .maybeSingle()

  if (wErr) {
    return NextResponse.json(
      { error: 'fetch_failed', detail: wErr.message },
      { status: 500 },
    )
  }
  if (!wedding) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Scope check: coordinator can only read their own venue.
  if (
    auth &&
    !auth.isDemo &&
    (wedding as unknown as { venue_id: string }).venue_id !== auth.venueId
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: transitions } = await supabase
    .from('lifecycle_transitions')
    .select(
      'id, from_stage, to_stage, transition_kind, reasoning, ' +
        'confidence, transitioned_at, transitioned_by',
    )
    .eq('wedding_id', weddingId)
    .order('transitioned_at', { ascending: false })
    .limit(100)

  return NextResponse.json({
    ok: true,
    wedding,
    transitions: transitions ?? [],
  })
}
