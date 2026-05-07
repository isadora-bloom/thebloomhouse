/**
 * POST /api/insights/risk-flags
 *
 * Batch read of cached `risk_flag` insights for a list of wedding IDs.
 * Used by inbox / leads / pipeline cards to render a single chip per
 * lead WITHOUT N+1 fetches and WITHOUT triggering generation.
 *
 * Risk-flag generation runs upstream (T3-H generator on its own
 * schedule + on-demand via /api/insights/lead/[weddingId]). This
 * endpoint is read-only — it surfaces what's already in
 * intelligence_insights, no Claude calls.
 *
 * Body: { weddingIds: string[] } — capped at MAX_BATCH (100).
 * Response: { flags: { [weddingId]: RiskSummary | null } }
 *
 * Auth: getPlatformAuth — coordinator's venueId scopes the query so
 * a coordinator can't read another venue's insights even if they
 * pass another venue's wedding IDs.
 *
 * T5-ζ.2 / ARCH-20.2.1.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, isDemoMode, isDemoVenueAllowed } from '@/lib/api/auth-helpers'
import { redact } from '@/lib/observability/redact'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

const MAX_BATCH = 100

const UUID_RE = /^[0-9a-f-]{36}$/i

interface RiskFlagPayload {
  code: string
  severity: number
  evidence: string
}

export interface RiskSummary {
  weddingId: string
  /** 0..100 composite risk score from the cached insight. */
  risk_score: number
  /** Top severity across all flags (drives the chip color). */
  top_severity: 1 | 2 | 3
  /** Short label rendered in the chip ("3 risk flags"). */
  label: string
  /** Coordinator-facing 1-sentence summary (LLM body). */
  narration: string
  /** Optional next-step suggestion. */
  action: string | null
  /** Number of flags. */
  flag_count: number
}

export async function POST(request: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  let body: { weddingIds?: unknown }
  try {
    body = (await request.json()) as { weddingIds?: unknown }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!Array.isArray(body.weddingIds)) {
    return NextResponse.json({ error: 'weddingIds must be an array' }, { status: 400 })
  }

  // Validate + dedupe + clamp.
  const seen = new Set<string>()
  const weddingIds: string[] = []
  for (const raw of body.weddingIds) {
    if (typeof raw !== 'string') continue
    if (!UUID_RE.test(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    weddingIds.push(raw)
    if (weddingIds.length >= MAX_BATCH) break
  }

  if (weddingIds.length === 0) {
    return NextResponse.json({ flags: {} })
  }

  const supabase = createServiceClient()
  const demo = await isDemoMode()

  // Resolve scoping venueId.
  let venueId: string | null = null
  if (demo) {
    venueId = request.nextUrl.searchParams.get('venueId')
    if (!venueId) {
      return NextResponse.json({ error: 'venueId required in demo' }, { status: 400 })
    }
    // Demo authz (#85, T5-followup-QQQ): the bloom_demo cookie is an
    // open bypass — any caller could pass a real production venue UUID
    // and read its cached risk-flag insights (tier-1 narrations).
    // Restrict to the Crestwood Collection's 4 venues. Mirrors the
    // /api/insights/venue and /api/insights/lead/[weddingId] pattern.
    if (!isDemoVenueAllowed(venueId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const platform = await getPlatformAuth()
    if (!platform) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    venueId = platform.venueId
  }

  // Read the cached risk_flag insights. expires_at filter: include
  // rows where expires_at IS NULL or > now() (older risk-flag persists
  // don't always set an expiry).
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('intelligence_insights')
    .select('context_id, body, action, data_points, expires_at, status')
    .eq('venue_id', venueId)
    .eq('insight_type', 'risk_flag')
    .in('context_id', weddingIds)
    .neq('status', 'expired')
    .neq('status', 'dismissed')
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)

  if (error) {
    // #86 (T5-followup-QQQ): redact error.message before stdout. Supabase
    // PostgREST errors can echo filter values (the wedding UUIDs we
    // passed) and table content from RLS messages. Defense-in-depth so
    // we don't bypass the OPS-21.3.3 tier-1-never-in-logs invariant.
    console.error('[insights/risk-flags] query failed:', redact(error.message))
    return NextResponse.json({ error: 'query_failed' }, { status: 500 })
  }

  const flags: Record<string, RiskSummary | null> = {}
  for (const wid of weddingIds) flags[wid] = null

  for (const row of data ?? []) {
    const wid = row.context_id as string | null
    if (!wid) continue
    const dp = (row.data_points ?? {}) as { flags?: RiskFlagPayload[]; risk_score?: number }
    const flagList = Array.isArray(dp.flags) ? dp.flags : []
    if (flagList.length === 0) {
      // Cached "no risk flags" row — leave as null so the chip doesn't
      // render an empty pill.
      continue
    }
    const topSeverity = flagList.reduce((m, f) => Math.max(m, f.severity ?? 0), 0)
    const sev: 1 | 2 | 3 = topSeverity >= 3 ? 3 : topSeverity >= 2 ? 2 : 1
    const riskScore = typeof dp.risk_score === 'number' ? dp.risk_score : 0
    flags[wid] = {
      weddingId: wid,
      risk_score: riskScore,
      top_severity: sev,
      label: `${flagList.length} risk flag${flagList.length === 1 ? '' : 's'}`,
      narration: (row.body as string) ?? '',
      action: (row.action as string | null) ?? null,
      flag_count: flagList.length,
    }
  }

  return NextResponse.json({ flags })
}
