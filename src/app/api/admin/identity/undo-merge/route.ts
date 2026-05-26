/**
 * POST /api/admin/identity/undo-merge
 *
 * Operator clicks "Undo" on a recent merge surfaced by the
 * `/intel/identity-review` Recent-merges digest. The endpoint dispatches
 * based on which audit table the row came from:
 *
 *   source='person_merge'  → wraps the existing `undoMerge` service
 *                            (recreates the merged person with a fresh
 *                            id; child reassignments stay on the kept
 *                            person — best-effort undo, per the
 *                            destructive-vs-additive doctrine in
 *                            lib/services/identity/merge-people.ts).
 *
 *   source='couple_event'  → writes a paired reversal row into
 *                            `couple_merge_events` (event_type =
 *                            'candidate_rejected' for confirmed candidates,
 *                            'resurrection_rejected' for resurrections,
 *                            'manual_unmerge' for fragment promotions /
 *                            channel-scoped bridging / manual_merge).
 *                            For fragment_promoted specifically, the
 *                            fragment's `promoted_to_couple_id` is also
 *                            cleared so the fragment re-enters the
 *                            pending queue. For candidate_confirmed we
 *                            mark any source candidate_match row back as
 *                            'rejected'.
 *
 *                            Touchpoints reattached during the merge are
 *                            NOT walked back automatically — the
 *                            operator splits via the unmerge dialog on
 *                            /intel/couples/[id] if they need to move
 *                            specific touchpoints off.
 *
 * Body
 * ----
 *   {
 *     source: 'person_merge' | 'couple_event',
 *     audit_id: string,        // person_merges.id OR couple_merge_events.id
 *     reason?: string          // optional free-text explaining the undo
 *   }
 *
 * Returns
 * -------
 *   200 { ok: true, applied: 'person_recreated' | 'reversal_logged' | ... }
 *   400 invalid input
 *   401 / 403 auth
 *   404 audit row not found in caller's venue
 *   500 internal
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { undoMerge } from '@/lib/services/identity/merge-people'
import { invalidateCouplesCache } from '@/lib/services/identity/forwards-linker'

interface UndoBody {
  source?: 'person_merge' | 'couple_event'
  audit_id?: string
  reason?: string
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as UndoBody
  if (!body.source || !body.audit_id) {
    return NextResponse.json(
      { error: 'source + audit_id required' },
      { status: 400 },
    )
  }
  if (body.source !== 'person_merge' && body.source !== 'couple_event') {
    return NextResponse.json({ error: 'invalid source' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (body.source === 'person_merge') {
    // Scope check: the audit row must belong to the caller's venue.
    const { data: audit, error } = await supabase
      .from('person_merges')
      .select('venue_id, undone_at')
      .eq('id', body.audit_id)
      .maybeSingle()
    if (error || !audit) {
      return NextResponse.json({ error: 'audit_not_found' }, { status: 404 })
    }
    const a = audit as { venue_id: string; undone_at: string | null }
    if (a.venue_id !== auth.venueId && auth.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    if (a.undone_at) {
      return NextResponse.json(
        { error: 'already_undone', undone_at: a.undone_at },
        { status: 409 },
      )
    }

    const result = await undoMerge({
      supabase,
      venueId: a.venue_id,
      mergeId: body.audit_id,
      undoneBy: auth.userId ?? null,
    })
    return NextResponse.json({
      ok: true,
      applied: 'person_recreated',
      recreated_person_id: result.recreatedPersonId,
    })
  }

  // source === 'couple_event'
  const { data: event, error } = await supabase
    .from('couple_merge_events')
    .select(
      'id, venue_id, event_type, primary_couple_id, secondary_couple_id, rule_triggered, confidence_tier, occurred_at',
    )
    .eq('id', body.audit_id)
    .maybeSingle()
  if (error || !event) {
    return NextResponse.json({ error: 'audit_not_found' }, { status: 404 })
  }
  const e = event as {
    id: string
    venue_id: string
    event_type: string
    primary_couple_id: string | null
    secondary_couple_id: string | null
    rule_triggered: string | null
    confidence_tier: 'high' | 'medium' | 'low' | null
    occurred_at: string
  }
  if (e.venue_id !== auth.venueId && auth.role !== 'super_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Map merge-type → reversal-event type. Keep within the CHECK
  // constraint set (migration 346 line 277).
  const reversalEventType = (() => {
    if (e.event_type === 'candidate_confirmed') return 'candidate_rejected'
    if (e.event_type === 'resurrection') return 'resurrection_rejected'
    // fragment_promoted / channel_scoped_bridged / manual_merge — these
    // describe state changes the operator can only really walk back
    // by splitting touchpoints off, so we log the intent as a
    // manual_unmerge and surface a hint in the response telling the
    // operator to use the existing split flow if they need to move
    // specific touchpoints.
    return 'manual_unmerge'
  })()

  // Reverse the candidate_match row, if any, so the matcher can
  // re-propose. We tagged it as `candidate_match:<id>` in the resolve
  // route.
  let candidateMatchReverted = false
  if (
    e.event_type === 'candidate_confirmed' &&
    e.rule_triggered &&
    e.rule_triggered.startsWith('candidate_match:')
  ) {
    const matchId = e.rule_triggered.slice('candidate_match:'.length)
    const { error: revertErr } = await supabase
      .from('candidate_matches')
      .update({
        resolution: 'rejected',
        resolved_at: new Date().toISOString(),
        resolved_by_user_id: auth.userId ?? null,
        matcher_reason: `[undone] reverted ${e.id} on ${new Date().toISOString()}${
          body.reason ? ` — ${body.reason}` : ''
        }`,
      })
      .eq('id', matchId)
      .eq('venue_id', e.venue_id)
    candidateMatchReverted = !revertErr
  }

  // Un-promote the fragment for fragment_promoted events. The fragment
  // id isn't on the audit row directly; we walk back via the rule.
  let fragmentUnpromoted = false
  if (
    e.event_type === 'fragment_promoted' &&
    e.rule_triggered &&
    e.rule_triggered.startsWith('fragment:') &&
    e.primary_couple_id
  ) {
    const fragmentId = e.rule_triggered.slice('fragment:'.length)
    const { error: unpromoteErr } = await supabase
      .from('fragments')
      .update({ promoted_to_couple_id: null })
      .eq('id', fragmentId)
      .eq('venue_id', e.venue_id)
      .eq('promoted_to_couple_id', e.primary_couple_id)
    fragmentUnpromoted = !unpromoteErr
  }

  // Write the paired reversal event.
  const { error: insertErr } = await supabase
    .from('couple_merge_events')
    .insert({
      venue_id: e.venue_id,
      event_type: reversalEventType,
      primary_couple_id: e.primary_couple_id,
      secondary_couple_id: e.secondary_couple_id,
      operator_id: auth.userId ?? null,
      rule_triggered: `undo:${e.id}`,
      confidence_tier: e.confidence_tier,
      reason:
        body.reason && body.reason.trim().length > 0
          ? `operator undo: ${body.reason.trim()}`
          : `operator undo of ${e.event_type} from ${e.occurred_at}`,
    })
  if (insertErr) {
    return NextResponse.json(
      { error: 'reversal_log_failed', detail: insertErr.message },
      { status: 500 },
    )
  }

  invalidateCouplesCache(e.venue_id)

  return NextResponse.json({
    ok: true,
    applied: 'reversal_logged',
    reversal_event_type: reversalEventType,
    candidate_match_reverted: candidateMatchReverted,
    fragment_unpromoted: fragmentUnpromoted,
    hint:
      e.event_type === 'fragment_promoted' || e.event_type === 'channel_scoped_bridged' || e.event_type === 'manual_merge'
        ? 'Touchpoints reattached during the merge are not walked back automatically. If specific touchpoints need to move, use the Split dialog on the couple detail page.'
        : null,
  })
}
