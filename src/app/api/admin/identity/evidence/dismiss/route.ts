/**
 * Wave 15 — per-evidence operator override endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator override > inferred state; audit
 *     row preserved via active=false, never hard-deleted)
 *   - bloom-wave4-identity-reconstruction.md (override applied BEFORE
 *     the prompt is built; reconstruct + timeline both consume)
 *
 * POST /api/admin/identity/evidence/dismiss
 *
 * Body shape:
 *   {
 *     weddingId: string,
 *     evidenceKind: 'review' | 'interaction' | 'calendar' | 'contract' |
 *                   'payment' | 'handle' | 'tangential_signal' |
 *                   'attribution_event' | 'tour' | 'profile_field',
 *     evidenceRef: { table: string, id: string, field_path?: string },
 *     overrideAction: 'dismiss' | 'unlink' | 'correct_value',
 *     correctionValue?: unknown,    // when overrideAction='correct_value'
 *     reason?: string,
 *   }
 *
 * Returns: { ok: true, overrideId: string }
 *
 * Idempotency: a (wedding_id, evidence_kind, evidence_ref.table,
 * evidence_ref.id) pair gets ONE row. Re-dismissing flips active=true.
 *
 * Auth: getPlatformAuth, venue-scoped. Demo cannot write overrides
 * (forensic audit operations require a real account).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'

interface PostBody {
  weddingId?: string
  evidenceKind?: string
  evidenceRef?: {
    table?: string
    id?: string
    field_path?: string
  }
  overrideAction?: string
  correctionValue?: unknown
  reason?: string
}

const ALLOWED_EVIDENCE_KINDS = new Set([
  'review',
  'interaction',
  'calendar',
  'contract',
  'payment',
  'handle',
  'tangential_signal',
  'attribution_event',
  'tour',
  'profile_field',
])

const ALLOWED_ACTIONS = new Set(['dismiss', 'unlink', 'correct_value'])

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot write evidence overrides')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const weddingId = typeof body.weddingId === 'string' ? body.weddingId : null
  const evidenceKind = typeof body.evidenceKind === 'string' ? body.evidenceKind : null
  const overrideAction =
    typeof body.overrideAction === 'string' ? body.overrideAction : null
  const ref = body.evidenceRef ?? null
  const reason = typeof body.reason === 'string' ? body.reason : null
  const correctionValue = body.correctionValue ?? null

  if (!weddingId) return badRequest('weddingId required')
  if (!evidenceKind || !ALLOWED_EVIDENCE_KINDS.has(evidenceKind)) {
    return badRequest(`evidenceKind must be one of: ${Array.from(ALLOWED_EVIDENCE_KINDS).join(', ')}`)
  }
  if (!overrideAction || !ALLOWED_ACTIONS.has(overrideAction)) {
    return badRequest(`overrideAction must be one of: ${Array.from(ALLOWED_ACTIONS).join(', ')}`)
  }
  if (!ref || typeof ref.table !== 'string' || typeof ref.id !== 'string') {
    return badRequest('evidenceRef.table and evidenceRef.id are required')
  }
  if (overrideAction === 'correct_value' && correctionValue === null) {
    return badRequest('correctionValue required when overrideAction=correct_value')
  }

  const supabase = createServiceClient()

  // Verify wedding belongs to the caller's venue (defense in depth).
  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id, merged_into_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) return notFound('wedding')
  const w = wedding as { venue_id: string; merged_into_id: string | null }
  if (w.venue_id !== auth.venueId) {
    return forbidden('wedding does not belong to your venue')
  }
  if (w.merged_into_id) {
    return badRequest('wedding is tombstoned (merged_into_id set)')
  }

  // Idempotency: SELECT by (wedding_id, evidence_kind, table, id) first.
  // If a row exists (even if active=false), flip active=true and refresh
  // the override_action / correction_value / reason. Otherwise insert.
  const refTable = ref.table
  const refId = ref.id
  const refFieldPath = typeof ref.field_path === 'string' ? ref.field_path : null

  // PostgREST jsonb match: use .contains for { table, id } fragment.
  const { data: existing } = await supabase
    .from('evidence_overrides')
    .select('id, active, override_action, correction_value, reason')
    .eq('wedding_id', weddingId)
    .eq('evidence_kind', evidenceKind)
    .contains('evidence_ref', { table: refTable, id: refId })
    .limit(1)
    .maybeSingle()

  if (existing) {
    const ex = existing as {
      id: string
      active: boolean
      override_action: string
    }
    const { error: updErr } = await supabase
      .from('evidence_overrides')
      .update({
        active: true,
        override_action: overrideAction,
        correction_value:
          overrideAction === 'correct_value' ? correctionValue : null,
        reason,
        created_by: auth.userId,
      })
      .eq('id', ex.id)
    if (updErr) {
      return NextResponse.json(
        { ok: false, error: `update failed: ${updErr.message}` },
        { status: 500 },
      )
    }
    return NextResponse.json({ ok: true, overrideId: ex.id, reused: true })
  }

  const insertRow = {
    venue_id: auth.venueId,
    wedding_id: weddingId,
    evidence_kind: evidenceKind,
    evidence_ref: {
      table: refTable,
      id: refId,
      ...(refFieldPath ? { field_path: refFieldPath } : {}),
    },
    override_action: overrideAction,
    correction_value:
      overrideAction === 'correct_value' ? correctionValue : null,
    reason,
    created_by: auth.userId,
    active: true,
  }

  const { data: ins, error: insErr } = await supabase
    .from('evidence_overrides')
    .insert(insertRow)
    .select('id')
    .single()
  if (insErr || !ins) {
    return NextResponse.json(
      { ok: false, error: `insert failed: ${insErr?.message ?? 'no row returned'}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    overrideId: (ins as { id: string }).id,
    reused: false,
  })
}
