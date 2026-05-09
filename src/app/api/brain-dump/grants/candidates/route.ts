/**
 * GET /api/brain-dump/grants/candidates
 *
 * Bug 14 (2026-05-09). Pattern signatures are stamped on every
 * brain_dump_entries row but the intelligence "we've processed N
 * similar entries" had no surface — coordinators could not see
 * patterns they were repeatedly confirming, only patterns that had
 * already auto-graduated to standing rules.
 *
 * This endpoint surfaces the missing middle: signatures with >= 3
 * confirmed entries (last 30 days) that do NOT have an active grant.
 * The coordinator can manually offer a grant for any of these
 * patterns from /agent/brain-dump/grants without waiting for the
 * automatic 5-confirmation threshold.
 *
 * Sort: confirmed-count DESC, last-confirmed DESC. Cap at 50 rows.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

// Signatures with fewer than this many confirms aren't worth offering
// — they'd be noisy and the coordinator might offer a one-off pattern
// they only intended to file once. 3 is the same MIN threshold the
// auto-offer uses (REPEAT_THRESHOLD in graduation.ts).
const MIN_CANDIDATE_CONFIRMS = 3

interface CandidateRow {
  signature: string
  intent: string | null
  confirmedCount: number
  lastConfirmedAt: string
  routedTables: string[]
  samplePreview: string
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString()

  // Pull confirmed brain-dump entries with a non-null signature,
  // last 30 days. We aggregate in JS — Postgres aggregation would
  // be cleaner but the supabase-js client doesn't compose group-by
  // through PostgREST without an RPC. Volume is bounded (50-row
  // cap on the page; typical venues confirm <10 brain-dumps/week).
  const { data: entries, error } = await supabase
    .from('brain_dump_entries')
    .select('pattern_signature, parse_result, parse_status, routed_to, raw_input, created_at, resolved_at')
    .eq('venue_id', auth.venueId)
    .eq('parse_status', 'confirmed')
    .not('pattern_signature', 'is', null)
    .gte('created_at', cutoff)
    .order('resolved_at', { ascending: false })
    .limit(2000) // hard ceiling; bigger venues with extreme volume just see the most recent slice

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Pull every active grant signature so we can hide already-graduated
  // patterns from the candidate list. A signature with an active grant
  // is irrelevant — entries matching it auto-route, they don't appear
  // as confirmable candidates.
  const { data: grantRows } = await supabase
    .from('brain_dump_pattern_grants')
    .select('pattern_signature')
    .eq('venue_id', auth.venueId)
    .eq('is_active', true)
    .is('revoked_at', null)
  const activeSignatures = new Set<string>(
    ((grantRows ?? []) as Array<{ pattern_signature: string }>).map((r) => r.pattern_signature),
  )

  // Aggregate by pattern_signature.
  const buckets = new Map<string, {
    intent: string | null
    confirmedCount: number
    lastConfirmedAt: string
    routedTables: Set<string>
    samplePreview: string
  }>()

  for (const e of (entries ?? []) as Array<{
    pattern_signature: string | null
    parse_result: Record<string, unknown> | null
    parse_status: string
    routed_to: Array<{ table?: string; action?: string }> | null
    raw_input: string
    created_at: string
    resolved_at: string | null
  }>) {
    const sig = e.pattern_signature
    if (!sig) continue
    if (activeSignatures.has(sig)) continue

    const intent = (e.parse_result?.intent as string | undefined) ?? null
    const tables = Array.isArray(e.routed_to)
      ? e.routed_to.map((r) => r.table).filter((t): t is string => !!t)
      : []
    const ts = e.resolved_at ?? e.created_at

    const existing = buckets.get(sig)
    if (existing) {
      existing.confirmedCount += 1
      if (ts > existing.lastConfirmedAt) existing.lastConfirmedAt = ts
      for (const t of tables) existing.routedTables.add(t)
    } else {
      const set = new Set<string>()
      for (const t of tables) set.add(t)
      buckets.set(sig, {
        intent,
        confirmedCount: 1,
        lastConfirmedAt: ts,
        routedTables: set,
        samplePreview: e.raw_input.slice(0, 160),
      })
    }
  }

  // Filter + sort + cap.
  const candidates: CandidateRow[] = []
  for (const [signature, b] of buckets) {
    if (b.confirmedCount < MIN_CANDIDATE_CONFIRMS) continue
    candidates.push({
      signature,
      intent: b.intent,
      confirmedCount: b.confirmedCount,
      lastConfirmedAt: b.lastConfirmedAt,
      routedTables: Array.from(b.routedTables).slice(0, 4),
      samplePreview: b.samplePreview,
    })
  }
  candidates.sort((a, b) => {
    if (a.confirmedCount !== b.confirmedCount) return b.confirmedCount - a.confirmedCount
    return b.lastConfirmedAt.localeCompare(a.lastConfirmedAt)
  })

  return NextResponse.json({
    candidates: candidates.slice(0, 50),
    minConfirmsRequired: MIN_CANDIDATE_CONFIRMS,
  })
}
