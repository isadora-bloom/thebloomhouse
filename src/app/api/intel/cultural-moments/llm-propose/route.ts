/**
 * POST /api/intel/cultural-moments/llm-propose
 *
 * TRENDS-DIAGNOSIS Fix 3 (2026-05-09). Manual-trigger sibling of
 * /api/intel/cultural-moments/auto-propose.
 *
 * The auto-propose endpoint runs the LEGACY statistical z-score
 * detector (cultural-moments-auto-propose.ts) — search-trend spikes
 * named generically. This endpoint runs the JUDGEMENT-TIER Sonnet
 * proposer (cultural-moments-llm-propose.ts) that names actual
 * cultural events with evidence URLs and dateable windows ("Royal
 * Wedding 2026", "cottagecore Pinterest peak").
 *
 * Cron fires daily at 09:30 UTC; this endpoint exists so a
 * coordinator can run NOW without waiting for the cron — useful
 * after onboarding a venue, before a strategy review, or whenever
 * the queue feels stale.
 *
 * Two auth paths (mirrors 366ba4a — identity admin endpoints):
 *   - getPlatformAuth — coordinator session, the browser console
 *     "Run LLM proposer now" button uses this. Default scope=venue;
 *     ?scope=all requires org_admin / super_admin.
 *   - CRON_SECRET (Authorization: Bearer $CRON_SECRET) — for ops/
 *     agent-side runs that don't hold a user session. Body MUST
 *     carry { venueId, scope: 'venue' }. ?scope=all is REJECTED on
 *     the CRON_SECRET path so a leaked secret can't fan out across
 *     every tenant.
 *
 * No demo-mode bypass since this writes shared cultural_moments rows.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  autoProposeCulturalMomentsLlm,
  autoProposeCulturalMomentsLlmAllVenues,
} from '@/lib/services/insights/cultural-moments-llm-propose'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

interface SampleSummary {
  venuesProposed: number
  momentsProposed: number
  momentsDeduped: number
  errors: number
  sampleTitles: string[]
  scope: 'venue' | 'all'
}

interface CronBody {
  venueId?: string
  scope?: 'venue' | 'all'
}

export async function POST(request: NextRequest) {
  // CRON_SECRET path. Skips getPlatformAuth + plan-tier gating —
  // ops-side runs are trusted. Still enforces scope=venue + a
  // body-supplied venueId so a leaked secret can't fan out cross-
  // tenant.
  const cronAuth =
    request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    let body: CronBody = {}
    try {
      body = (await request.clone().json()) as CronBody
    } catch {
      /* tolerate empty body */
    }
    if (!body.venueId) {
      return NextResponse.json(
        { error: 'CRON_SECRET path requires venueId in body' },
        { status: 400 },
      )
    }
    // Hard-gate: scope=all is rejected on the CRON_SECRET path. A
    // leaked secret would otherwise fan out a Sonnet call per venue
    // across every tenant; the user-auth path keeps scope=all behind
    // the org_admin / super_admin role check.
    if (body.scope && body.scope !== 'venue') {
      return NextResponse.json(
        { error: 'CRON_SECRET path is restricted to scope=venue' },
        { status: 400 },
      )
    }

    const supabase = createServiceClient()
    const { data: venueRow } = await supabase
      .from('venues')
      .select('id, state')
      .eq('id', body.venueId)
      .maybeSingle()
    if (!venueRow) {
      return NextResponse.json({ error: 'venue_not_found' }, { status: 404 })
    }
    const venueState = venueRow.state
      ? (venueRow.state as string).trim().toLowerCase()
      : null

    const result = await autoProposeCulturalMomentsLlm({
      supabase,
      venueId: body.venueId,
      venueState,
    })
    const proposedTitles = result.details
      .filter((d) => d.outcome === 'proposed')
      .map((d) => d.title)

    const out: SampleSummary = {
      venuesProposed: result.proposed > 0 ? 1 : 0,
      momentsProposed: result.proposed,
      momentsDeduped: result.deduped,
      errors: result.errors,
      sampleTitles: proposedTitles.slice(0, 10),
      scope: 'venue',
    }
    return NextResponse.json(out)
  }

  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const scope = request.nextUrl.searchParams.get('scope') ?? 'venue'

  // ?scope=all is admin-gated. Pre-fix any signed-in coordinator could
  // trigger Sonnet calls platform-wide; cost-ceiling caps damage but
  // still bills.
  if (scope === 'all') {
    if (auth.role !== 'org_admin' && auth.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden_scope_all' }, { status: 403 })
    }
    const summary = await autoProposeCulturalMomentsLlmAllVenues(supabase)
    const titles: string[] = []
    for (const v of summary.perVenue) {
      for (const d of v.result.details) {
        if (d.outcome === 'proposed') titles.push(d.title)
      }
    }
    const out: SampleSummary = {
      venuesProposed: summary.perVenue.filter((v) => v.result.proposed > 0).length,
      momentsProposed: summary.proposed,
      momentsDeduped: summary.deduped,
      errors: summary.errors,
      sampleTitles: titles.slice(0, 10),
      scope: 'all',
    }
    return NextResponse.json(out)
  }

  // Default: caller's venue. We need the venue's state for the
  // regional-context block in the prompt; pull it once.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, state')
    .eq('id', auth.venueId)
    .single()
  const venueState = venueRow?.state
    ? (venueRow.state as string).trim().toLowerCase()
    : null

  const result = await autoProposeCulturalMomentsLlm({
    supabase,
    venueId: auth.venueId,
    venueState,
  })

  const proposedTitles = result.details
    .filter((d) => d.outcome === 'proposed')
    .map((d) => d.title)

  const out: SampleSummary = {
    venuesProposed: result.proposed > 0 ? 1 : 0,
    momentsProposed: result.proposed,
    momentsDeduped: result.deduped,
    errors: result.errors,
    sampleTitles: proposedTitles.slice(0, 10),
    scope: 'venue',
  }
  return NextResponse.json(out)
}
