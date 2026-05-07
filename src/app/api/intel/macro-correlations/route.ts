/**
 * GET /api/intel/macro-correlations
 *
 * Returns the LLM-narrated cross-limb correlation list for the
 * authenticated coordinator's venue. Powers /intel/macro-correlations
 * page (T5-θ.1, USP #4 demo surface).
 *
 * Behaviour:
 *   - Default: read existing narration rows from intelligence_insights
 *     (insight_type='correlation_narration'). Cache hit, no LLM call.
 *   - ?refresh=true: trigger generation for any un-narrated correlation
 *     rows from the last 14 days. Gated by cost-ceiling
 *     (gateForBrainCall) — paused venues return their existing cached
 *     narrations + a 200 with `paused: true` flag.
 *   - ?force=true: bypass cache and re-narrate. Coordinator-only
 *     escape hatch; always cost-gated.
 *
 * Plan gate: requires 'intelligence' tier (matches /api/intel/insights).
 *
 * Auth: getPlatformAuth. Demo mode bypass works since the seeded demo
 * has correlation rows in Crestwood's intelligence_insights table.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  generateCorrelationNarrationsForVenue,
  listExistingNarrations,
} from '@/lib/services/insights/correlation-narration'
import { gateForBrainCall, nextUtcMidnightIso } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'solo')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const refresh = sp.get('refresh') === 'true'
  const force = sp.get('force') === 'true'

  const supabase = createServiceClient()

  try {
    // Always start by listing existing narrations — that's the cache
    // layer. The page renders these immediately even when refresh=true
    // (the LLM call may add more, but we don't block the response on it
    // when the cache already has rows).
    const existing = await listExistingNarrations(supabase, auth.venueId)

    // No refresh requested — serve cached only.
    if (!refresh && !force) {
      return NextResponse.json({
        narrations: existing,
        paused: false,
        generated: false,
      })
    }

    // Refresh requested. Cost-ceiling check at the route boundary
    // (defense in depth — the service also gates per-call). When the
    // venue is paused, return the existing cache + a paused flag the
    // UI can render as a banner.
    const gate = await gateForBrainCall(auth.venueId)
    if (!gate.ok) {
      return NextResponse.json({
        narrations: existing,
        paused: true,
        pausedReason: gate.reason,
        resumesAt: nextUtcMidnightIso(),
        generated: false,
      })
    }

    // Generate. Gracefully degrade — if the generator throws, we still
    // return the existing cache.
    let generated: Array<{ id: string }> = []
    try {
      const fresh = await generateCorrelationNarrationsForVenue(
        supabase,
        auth.venueId,
        force,
      )
      generated = fresh.map((n) => ({ id: n.id }))
    } catch (err) {
      console.error(
        '[/api/intel/macro-correlations] generate failed:',
        redactError(err),
      )
    }

    // Re-read the list — generated rows now exist in the cache, and
    // listExistingNarrations is the canonical "what's surfaceable"
    // sort (by surface_priority).
    const updated = await listExistingNarrations(supabase, auth.venueId)

    return NextResponse.json({
      narrations: updated,
      paused: false,
      generated: true,
      generatedCount: generated.length,
    })
  } catch (err) {
    console.error(
      '[/api/intel/macro-correlations] unexpected:',
      redactError(err),
    )
    return NextResponse.json(
      { error: 'Failed to load macro correlations' },
      { status: 500 },
    )
  }
}
