/**
 * POST /api/admin/weddings/[weddingId]/override-field
 *
 * Pattern 10 - operator override channel for the wedding-scoped auto-derived
 * fields (heat_score, persona_label, first_touch). Companion to migration 312
 * and the sticky-state route (migration 306 / sticky-state/route.ts).
 *
 * Body:
 *   {
 *     "field": "heat_score" | "persona_label" | "first_touch",
 *     "value": number | string | null | { attribution_event_id: string },
 *     "note":  string?
 *   }
 *
 * Semantics per field:
 *   heat_score:
 *     - value: integer 0..100  -> sets heat_score_override_value + _by + _at.
 *     - value: null            -> clears all three columns (releases override).
 *     - recalculateHeatScore (heat-mapping.ts) early-returns when _at is set,
 *       so the override is read-canonical without a separate read path.
 *
 *   persona_label:
 *     - value: non-empty string (<=60 chars) -> writes persona_label + _by + _at.
 *     - value: null            -> clears all three (falls back to cohort label).
 *
 *   first_touch:
 *     - value: { attribution_event_id: uuid } -> promotes that attribution_events
 *       row to is_first_touch=true and demotes all other rows for the wedding to
 *       false. Stamps weddings.first_touch_overridden_by/_at as audit.
 *     - value: null            -> clears the wedding-scoped audit pair (the
 *       attribution_events.is_first_touch state is left as-is; the next bucket
 *       recompute trigger will re-derive from earliest signal_date).
 *
 * Audit: every write inserts a wedding_lifecycle_events row
 *   { signal: 'override:<field>', detected_by: 'coordinator', reason: note }.
 *
 * Auth: getPlatformAuth - operator-only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

type Field = 'heat_score' | 'persona_label' | 'first_touch'
const FIELDS: ReadonlyArray<Field> = ['heat_score', 'persona_label', 'first_touch']

interface Body {
  field?: string
  value?: unknown
  note?: string
}

interface FirstTouchValue {
  attribution_event_id: string
}

function isFirstTouchValue(v: unknown): v is FirstTouchValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { attribution_event_id?: unknown }).attribution_event_id === 'string'
  )
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { weddingId } = await params

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const field = body.field
  if (!field || !FIELDS.includes(field as Field)) {
    return NextResponse.json(
      { error: 'invalid_field', valid: FIELDS },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const venueId = (wedding as { venue_id: string }).venue_id
  if (!auth.isDemo && venueId !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { updated_at: now }
  // String label of the applied value for the lifecycle-events row. We
  // never log the operator's freeform note here; the reason column carries
  // that. This is just the structured change ("heat_score=72", "cleared").
  let appliedValueLabel: string = String(body.value)

  if (field === 'heat_score') {
    if (body.value === null) {
      patch.heat_score_override_value = null
      patch.heat_score_overridden_by = null
      patch.heat_score_overridden_at = null
      appliedValueLabel = 'cleared'
    } else {
      const n = Number(body.value)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) {
        return NextResponse.json(
          { error: 'invalid_value', detail: 'heat_score must be integer 0..100 or null' },
          { status: 400 },
        )
      }
      patch.heat_score_override_value = n
      patch.heat_score_overridden_by = auth.userId
      patch.heat_score_overridden_at = now
      appliedValueLabel = String(n)
    }
  } else if (field === 'persona_label') {
    if (body.value === null) {
      patch.persona_label = null
      patch.persona_label_overridden_by = null
      patch.persona_label_overridden_at = null
      appliedValueLabel = 'cleared'
    } else if (typeof body.value === 'string') {
      const trimmed = body.value.trim()
      if (trimmed.length === 0 || trimmed.length > 60) {
        return NextResponse.json(
          { error: 'invalid_value', detail: 'persona_label must be 1..60 chars or null' },
          { status: 400 },
        )
      }
      patch.persona_label = trimmed
      patch.persona_label_overridden_by = auth.userId
      patch.persona_label_overridden_at = now
      appliedValueLabel = trimmed
    } else {
      return NextResponse.json(
        { error: 'invalid_value', detail: 'persona_label must be string or null' },
        { status: 400 },
      )
    }
  } else if (field === 'first_touch') {
    if (body.value === null) {
      patch.first_touch_overridden_by = null
      patch.first_touch_overridden_at = null
      appliedValueLabel = 'cleared'
    } else if (isFirstTouchValue(body.value)) {
      const targetId = body.value.attribution_event_id
      // Verify the target row exists and belongs to this wedding before
      // touching anything; otherwise we'd demote all rows and then fail
      // to promote, leaving the wedding with no first-touch row.
      const { data: target } = await supabase
        .from('attribution_events')
        .select('id, wedding_id')
        .eq('id', targetId)
        .maybeSingle()
      if (!target || (target as { wedding_id: string }).wedding_id !== weddingId) {
        return NextResponse.json(
          { error: 'invalid_value', detail: 'attribution_event_id not found on this wedding' },
          { status: 400 },
        )
      }

      // Demote everyone else, then promote the chosen row. Two writes
      // (no boolean swap) so a future first-touch column rename is a
      // mechanical refactor.
      const { error: demoteErr } = await supabase
        .from('attribution_events')
        .update({ is_first_touch: false })
        .eq('wedding_id', weddingId)
        .neq('id', targetId)
      if (demoteErr) {
        return NextResponse.json(
          { error: 'demote_failed', detail: demoteErr.message },
          { status: 500 },
        )
      }
      const { error: promoteErr } = await supabase
        .from('attribution_events')
        .update({ is_first_touch: true })
        .eq('id', targetId)
      if (promoteErr) {
        return NextResponse.json(
          { error: 'promote_failed', detail: promoteErr.message },
          { status: 500 },
        )
      }

      patch.first_touch_overridden_by = auth.userId
      patch.first_touch_overridden_at = now
      appliedValueLabel = `attribution_event_id=${targetId}`
    } else {
      return NextResponse.json(
        { error: 'invalid_value', detail: 'first_touch value must be null or { attribution_event_id }' },
        { status: 400 },
      )
    }
  }

  const { error: updErr } = await supabase
    .from('weddings')
    .update(patch)
    .eq('id', weddingId)
  if (updErr) {
    return NextResponse.json(
      { error: 'update_failed', detail: updErr.message },
      { status: 500 },
    )
  }

  // Audit row. wedding_lifecycle_events shape: signal NOT NULL,
  // detected_by NOT NULL CHECK ('ai'|'pipeline'|'coordinator'|'webhook'
  // |'cron'|'backfill'). Verified against migration 246.
  await supabase.from('wedding_lifecycle_events').insert({
    wedding_id: weddingId,
    venue_id: venueId,
    signal: `override:${field}=${appliedValueLabel}`,
    detected_by: 'coordinator',
    reason: body.note?.slice(0, 500) ?? null,
  })

  return NextResponse.json({ ok: true, field, applied: patch })
}
