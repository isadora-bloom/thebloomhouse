/**
 * GET /api/admin/identity-telemetry
 *
 * Cross-venue identity-system health for Isadora (super_admin or
 * org_admin only). Surfaces the metrics §9 mandates:
 *   - Auto-promotion rate per venue: tier=high matcher hits that
 *     went straight into a couple, as a share of total candidate
 *     proposals.
 *   - Rejection rate per venue: operator-rejected candidate_matches
 *     as a share of resolved candidates. Trend over time signals
 *     matcher over-merging.
 *   - Unmerge rate per venue: number of operator-triggered unmerges
 *     in the last 30 days. (Phase E hasn't shipped unmerge UI yet;
 *     this column will be zero until that lands.)
 *   - Open queue depth per venue: candidate_matches with
 *     resolution IS NULL.
 *   - Judge load per venue: stage='llm_judge' events in last 24h.
 *   - Last decay sweep per venue.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §9 "Telemetry the system
 * watches itself: per-venue auto-promotion rate, operator rejection
 * rate, unmerge rate. Trends trigger system alerts."
 *
 * Auth: super_admin or org_admin only. Coordinator-scoped users get
 * 403; demo cookie does NOT bypass.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

const WINDOW_DAYS = 30

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const role = (auth.role ?? 'coordinator') as string
  if (role !== 'super_admin' && role !== 'org_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient()
  const sinceWindowIso = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const since24hIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  // Venues
  const { data: venuesRow } = await supabase
    .from('venues')
    .select('id, name')
    .order('name', { ascending: true })
    .limit(200)
  const venues = ((venuesRow ?? []) as Array<{ id: string; name: string }>)

  // Candidate-matches counts (resolved + open) per venue.
  const { data: candRows } = await supabase
    .from('candidate_matches')
    .select('venue_id, resolution, confidence_tier, created_at, resolved_at')
    .gte('created_at', sinceWindowIso)
    .limit(20000)
  const candByVenue = new Map<
    string,
    {
      open: number
      confirmed: number
      rejected: number
      not_sure: number
      auto_high: number
      total: number
    }
  >()
  for (const r of (candRows ?? []) as Array<{
    venue_id: string
    resolution: string | null
    confidence_tier: string
  }>) {
    const v = candByVenue.get(r.venue_id) ?? {
      open: 0,
      confirmed: 0,
      rejected: 0,
      not_sure: 0,
      auto_high: 0,
      total: 0,
    }
    v.total += 1
    if (r.resolution === null) v.open += 1
    else if (r.resolution === 'confirmed') v.confirmed += 1
    else if (r.resolution === 'rejected') v.rejected += 1
    else if (r.resolution === 'not_sure') v.not_sure += 1
    if (r.confidence_tier === 'high') v.auto_high += 1
    candByVenue.set(r.venue_id, v)
  }

  // Judge calls (24h) per venue.
  const { data: judgeRows } = await supabase
    .from('tracer_run_events')
    .select('venue_id')
    .eq('stage', 'llm_judge')
    .gte('occurred_at', since24hIso)
    .limit(20000)
  const judgeByVenue = new Map<string, number>()
  for (const r of (judgeRows ?? []) as Array<{ venue_id: string }>) {
    judgeByVenue.set(r.venue_id, (judgeByVenue.get(r.venue_id) ?? 0) + 1)
  }

  // Decay sweep most-recent per venue.
  const { data: decayRows } = await supabase
    .from('tracer_run_events')
    .select('venue_id, occurred_at, detail')
    .eq('stage', 'decay_sweep')
    .eq('status', 'succeeded')
    .order('occurred_at', { ascending: false })
    .limit(5000)
  const decayByVenue = new Map<
    string,
    { latest: string; ghosted: number; examined: number }
  >()
  for (const r of (decayRows ?? []) as Array<{
    venue_id: string
    occurred_at: string
    detail: Record<string, unknown> | null
  }>) {
    if (decayByVenue.has(r.venue_id)) continue
    decayByVenue.set(r.venue_id, {
      latest: r.occurred_at,
      ghosted: Number((r.detail ?? {}).ghosted ?? 0),
      examined: Number((r.detail ?? {}).examined ?? 0),
    })
  }

  // couples counts per venue.
  const { data: coupleRows } = await supabase
    .from('couples')
    .select('venue_id, lifecycle_state')
    .limit(50000)
  const couplesByVenue = new Map<
    string,
    { total: number; booked: number; resolved: number; channel_scoped: number; ghost: number; agent: number }
  >()
  for (const r of (coupleRows ?? []) as Array<{ venue_id: string; lifecycle_state: string }>) {
    const v = couplesByVenue.get(r.venue_id) ?? {
      total: 0,
      booked: 0,
      resolved: 0,
      channel_scoped: 0,
      ghost: 0,
      agent: 0,
    }
    v.total += 1
    if (r.lifecycle_state === 'booked') v.booked += 1
    else if (r.lifecycle_state === 'resolved') v.resolved += 1
    else if (r.lifecycle_state === 'channel_scoped') v.channel_scoped += 1
    else if (r.lifecycle_state === 'ghost') v.ghost += 1
    else if (r.lifecycle_state === 'agent') v.agent += 1
    couplesByVenue.set(r.venue_id, v)
  }

  const rows = venues.map((v) => {
    const c = candByVenue.get(v.id)
    const couples = couplesByVenue.get(v.id) ?? {
      total: 0,
      booked: 0,
      resolved: 0,
      channel_scoped: 0,
      ghost: 0,
      agent: 0,
    }
    const totalResolved = (c?.confirmed ?? 0) + (c?.rejected ?? 0) + (c?.not_sure ?? 0)
    return {
      venue_id: v.id,
      venue_name: v.name,
      couples,
      candidates: {
        open: c?.open ?? 0,
        confirmed: c?.confirmed ?? 0,
        rejected: c?.rejected ?? 0,
        not_sure: c?.not_sure ?? 0,
        total: c?.total ?? 0,
      },
      auto_promotion_rate:
        c && c.total > 0 ? c.auto_high / c.total : 0,
      rejection_rate:
        totalResolved > 0 ? (c?.rejected ?? 0) / totalResolved : 0,
      open_queue_depth: c?.open ?? 0,
      judge_calls_24h: judgeByVenue.get(v.id) ?? 0,
      last_decay_sweep: decayByVenue.get(v.id) ?? null,
    }
  })

  // Sort: highest rejection rate first (the worry surface).
  rows.sort((a, b) => b.rejection_rate - a.rejection_rate)

  return NextResponse.json({
    window_days: WINDOW_DAYS,
    venues: rows,
  })
}
