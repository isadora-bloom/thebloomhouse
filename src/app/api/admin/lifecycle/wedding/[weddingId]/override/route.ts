/**
 * POST /api/admin/lifecycle/wedding/[weddingId]/override
 *
 * Wave 11 — operator override. Records a transition with
 * transition_kind='operator_override' and writes the new stage to the
 * wedding row. The next sweep MAY re-classify if evidence strongly
 * contradicts, but the override carries an audit trail showing
 * coordinator intent.
 *
 * Body: { stage: <LifecycleStage>, note?: string }
 *
 * Auth: getPlatformAuth only (NOT cron — operator overrides require a
 * named coordinator).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  ALL_LIFECYCLE_STAGES,
  type LifecycleStage,
} from '@/lib/services/lifecycle/state-machine'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { weddingId } = await params

  let body: { stage?: string; note?: string }
  try {
    body = (await request.json()) as { stage?: string; note?: string }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.stage) {
    return NextResponse.json({ error: 'stage required' }, { status: 400 })
  }
  if (
    !ALL_LIFECYCLE_STAGES.includes(body.stage as LifecycleStage)
  ) {
    return NextResponse.json(
      {
        error: 'invalid_stage',
        valid: ALL_LIFECYCLE_STAGES,
      },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  // Scope check.
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, venue_id, lifecycle_stage, lifecycle_transition_count')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (
    !auth.isDemo &&
    (wedding as { venue_id: string }).venue_id !== auth.venueId
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const fromStage =
    ((wedding as { lifecycle_stage: LifecycleStage | null })
      .lifecycle_stage) ?? null
  const toStage = body.stage as LifecycleStage
  const note = body.note?.slice(0, 1000) ?? null

  // Audit row first.
  const { data: inserted, error: insErr } = await supabase
    .from('lifecycle_transitions')
    .insert({
      wedding_id: weddingId,
      venue_id: (wedding as { venue_id: string }).venue_id,
      from_stage: fromStage,
      to_stage: toStage,
      transition_kind: 'operator_override',
      evidence: { note, override_by: auth.userId, source: 'admin_endpoint' },
      reasoning: note ?? 'operator override',
      confidence: 100,
      transitioned_by: auth.userId,
    })
    .select('id')
    .single()
  if (insErr || !inserted) {
    return NextResponse.json(
      { error: 'audit_insert_failed', detail: insErr?.message },
      { status: 500 },
    )
  }

  const now = new Date().toISOString()
  const curCount =
    ((wedding as { lifecycle_transition_count?: number })
      .lifecycle_transition_count) ?? 0
  await supabase
    .from('weddings')
    .update({
      lifecycle_stage: toStage,
      lifecycle_stage_set_at: now,
      lifecycle_transition_count: curCount + 1,
      updated_at: now,
    })
    .eq('id', weddingId)

  return NextResponse.json({
    ok: true,
    from: fromStage,
    to: toStage,
    transition_id: (inserted as { id: string }).id,
  })
}
