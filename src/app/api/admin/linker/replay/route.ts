/**
 * POST /api/admin/linker/replay
 *
 * Re-runs the Phase C Forwards Linker against past N days of signals
 * for the caller's venue (or any venue if super_admin). Useful after
 * matcher weight tweaks or a judge prompt revision — operator presses
 * "Replay last 7 days" and every existing fragment / orphan touchpoint
 * gets re-matched against the current couples graph.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4. The Tracer is the bulk
 * historical sweep; the Linker is per-event live; replay is the bridge
 * between them — re-applies live-linker semantics to already-imported
 * signals.
 *
 * What replay does
 * ----------------
 * For each touchpoint with couple_id IS NULL (orphans) and each
 * fragment in the window, reconstruct a NormalizedSignal from the
 * stored row and route through linkSignal. Idempotent on the original
 * external_id via the UNIQUE constraints — replay creates zero new
 * touchpoint rows, but it CAN promote an orphan touchpoint to a real
 * couple match via the matcher + judge if a couple has since been
 * minted that matches.
 *
 * Body
 * ----
 *   { venue_id?: string }   defaults to auth.venueId
 *   { days?: number }       default 7, max 90
 *   { channels?: string[] } default all
 *   { judge_budget?: number } default 50
 *
 * Returns
 * -------
 *   200 { summary: { touchpoints_replayed, fragments_replayed,
 *                    by_action, duration_ms } }
 *   401 unauthorized | 403 forbidden | 500 error
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  invalidateCouplesCache,
  linkSignal,
} from '@/lib/services/identity/forwards-linker'
import { newJudgeBudget } from '@/lib/services/identity/llm-judge'
import type { NormalizedSignal } from '@/lib/services/identity/sources/types'

export const maxDuration = 300

interface ReplayBody {
  venue_id?: string
  days?: number
  channels?: string[]
  judge_budget?: number
}

type ActionCount = Record<string, number>

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as ReplayBody
  const role = (auth.role ?? 'coordinator') as string
  const isSuperOrOrg =
    auth.isDemo || role === 'super_admin' || role === 'org_admin'

  const targetVenueId = body.venue_id ?? auth.venueId ?? null
  if (!targetVenueId) {
    return NextResponse.json(
      { error: 'venue_id required (no venue in auth context)' },
      { status: 400 },
    )
  }
  if (!isSuperOrOrg && targetVenueId !== auth.venueId) {
    return NextResponse.json(
      { error: 'forbidden — only super_admin / org_admin can replay other venues' },
      { status: 403 },
    )
  }

  const days = Math.max(1, Math.min(90, body.days ?? 7))
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const supabase = createServiceClient()
  const budget = newJudgeBudget(body.judge_budget ?? 50)
  const startedAt = Date.now()

  // Drop the per-process couples cache so the replay sees the latest
  // couples roster — important when operator is replaying right after
  // a merge / mint.
  invalidateCouplesCache(targetVenueId)

  const byAction: ActionCount = {}
  let touchpointsReplayed = 0
  let fragmentsReplayed = 0

  // Replay orphan touchpoints (couple_id IS NULL) — these are
  // mid-confidence rows from earlier sweeps that may now match
  // against a newly-minted couple.
  let tpQuery = supabase
    .from('touchpoints')
    .select(
      'id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload',
    )
    .eq('venue_id', targetVenueId)
    .is('couple_id', null)
    .gte('occurred_at', since)
    .limit(2000)
  if (body.channels && body.channels.length > 0) {
    tpQuery = tpQuery.in('channel', body.channels)
  }
  const { data: tpRows, error: tpErr } = await tpQuery
  if (tpErr) {
    return NextResponse.json(
      { error: 'replay_lookup_failed', detail: tpErr.message },
      { status: 500 },
    )
  }

  for (const row of (tpRows ?? []) as Array<{
    id: string
    channel: string
    signal_tier: string
    action_type: string
    external_id: string
    occurred_at: string
    raw_payload: Record<string, unknown> | null
  }>) {
    const payload = row.raw_payload ?? {}
    const signal: NormalizedSignal = {
      external_id: row.external_id,
      channel: row.channel,
      action_type: row.action_type,
      occurred_at: row.occurred_at,
      signal_tier: (row.signal_tier as NormalizedSignal['signal_tier']) ?? 'low',
      identity_hint: (payload.identity_hint as string | null) ?? null,
      primary_name: (payload.primary_name as string | null) ?? null,
      primary_email: (payload.primary_email as string | null) ?? null,
      primary_phone: (payload.primary_phone as string | null) ?? null,
      partner_name: (payload.partner_name as string | null) ?? null,
      partner_email: (payload.partner_email as string | null) ?? null,
      partner_phone: (payload.partner_phone as string | null) ?? null,
      wedding_date: (payload.wedding_date as string | null) ?? null,
      session_ip: (payload.session_ip as string | null) ?? null,
      session_fingerprint: (payload.session_fingerprint as string | null) ?? null,
      raw_payload: payload,
      legacy_wedding_id: null,
    }
    try {
      const result = await linkSignal({
        supabase,
        venueId: targetVenueId,
        signal,
        bypassCache: false,
        judgeBudget: budget,
        source: 'replay',
      })
      touchpointsReplayed += 1
      byAction[result.action] = (byAction[result.action] ?? 0) + 1
    } catch {
      // already logged inside linker
    }
  }

  // Replay fragments — most stay fragments, but a new couple may make
  // a fragment promotable to a candidate_match.
  let fragQuery = supabase
    .from('fragments')
    .select('id, channel, identity_hint, external_id, occurred_at, raw_payload')
    .eq('venue_id', targetVenueId)
    .is('promoted_to_couple_id', null)
    .gte('occurred_at', since)
    .limit(2000)
  if (body.channels && body.channels.length > 0) {
    fragQuery = fragQuery.in('channel', body.channels)
  }
  const { data: fragRows, error: fragErr } = await fragQuery
  if (fragErr) {
    return NextResponse.json(
      { error: 'replay_lookup_failed', detail: fragErr.message },
      { status: 500 },
    )
  }

  for (const row of (fragRows ?? []) as Array<{
    id: string
    channel: string
    identity_hint: string | null
    external_id: string
    occurred_at: string
    raw_payload: Record<string, unknown> | null
  }>) {
    const payload = row.raw_payload ?? {}
    const signal: NormalizedSignal = {
      external_id: row.external_id,
      channel: row.channel,
      action_type: (payload.action_type as string | null) ?? 'replay',
      occurred_at: row.occurred_at,
      signal_tier: 'low',
      identity_hint: row.identity_hint,
      primary_name: (payload.primary_name as string | null) ?? row.identity_hint,
      primary_email: (payload.primary_email as string | null) ?? null,
      primary_phone: (payload.primary_phone as string | null) ?? null,
      partner_name: (payload.partner_name as string | null) ?? null,
      partner_email: (payload.partner_email as string | null) ?? null,
      partner_phone: (payload.partner_phone as string | null) ?? null,
      wedding_date: (payload.wedding_date as string | null) ?? null,
      session_ip: (payload.session_ip as string | null) ?? null,
      session_fingerprint: (payload.session_fingerprint as string | null) ?? null,
      raw_payload: payload,
      legacy_wedding_id: null,
    }
    try {
      const result = await linkSignal({
        supabase,
        venueId: targetVenueId,
        signal,
        bypassCache: false,
        judgeBudget: budget,
        source: 'replay',
      })
      fragmentsReplayed += 1
      byAction[result.action] = (byAction[result.action] ?? 0) + 1
    } catch {
      // already logged
    }
  }

  return NextResponse.json({
    summary: {
      venue_id: targetVenueId,
      days,
      touchpoints_replayed: touchpointsReplayed,
      fragments_replayed: fragmentsReplayed,
      by_action: byAction,
      judge_budget_remaining: budget.remaining,
      duration_ms: Date.now() - startedAt,
    },
  })
}
