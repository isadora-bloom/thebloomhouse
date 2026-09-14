/**
 * GET /api/insights/lead/[weddingId]/prior-touches
 *
 * "Has this couple touched us before, and how often?" — for the lead
 * detail panel, which only knows a wedding id.
 *
 * W64: this used to read `weddings` for the tenant, then `people` for a
 * partner row, then hand that person id to the person-keyed
 * `getPriorTouches`, which re-joined `interactions` and
 * `tangential_signals`. Three tables deep to answer a question the spine
 * ribbon already holds in one: every signal a couple sends lands on
 * `touchpoints` as it arrives, bound to the couple by the linker.
 *
 * So the route now does two spine reads and no legacy ones:
 *   1. `loadCoupleKeyForWedding` — maps the wedding id onto the couple
 *      AND is the tenancy check, because the row only comes back for a
 *      venue the caller holds.
 *   2. `loadCouplePriorTouches` — the ribbon, outbound excluded.
 *
 * It also fixes a quiet under-count. A signal that arrived before the
 * couple had a `people` row carried no `matched_person_id`, so the old
 * reader never saw it and the panel said "no prior touches" about a
 * couple with several.
 *
 * Demo mode is still allow-listed to the Crestwood venues, and the
 * venue now comes from the caller's own auth rather than from the row
 * being asked about, so an unauthenticated caller cannot use a wedding
 * UUID to discover which venue owns it.
 *
 * T5-γ.4 / Playbook ARCH-INSIGHTS.4.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, isDemoMode, isDemoVenueAllowed } from '@/lib/api/auth-helpers'
import { loadCoupleKeyForWedding } from '@/lib/intel/readers/couple-key'
import { loadCouplePriorTouches } from '@/lib/intel/readers/prior-touches'
import { redactError } from '@/lib/observability/redact'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

/** "We looked and found nothing" — distinct from "we did not look".
 *  INV-8.5.5. */
function emptySummary(coupleId: string) {
  return {
    coupleId,
    warmth: 'cold' as const,
    touches: [],
    counts: { inbound: 0, unstamped: 0, tours: 0 },
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const { weddingId } = await params
  if (!weddingId || !/^[0-9a-f-]{36}$/i.test(weddingId)) {
    return NextResponse.json({ error: 'invalid_wedding_id' }, { status: 400 })
  }

  const demo = await isDemoMode()

  // Venue comes from the caller, not from the row. A caller who cannot
  // name a venue cannot ask.
  let venueId: string | null = null
  if (demo) {
    const platform = await getPlatformAuth()
    venueId = platform?.venueId ?? null
    // Demo-mode authz (#85, T5-followup-QQQ): the bloom_demo cookie is an
    // open bypass, so demo callers stay inside the Crestwood Collection.
    if (!venueId || !isDemoVenueAllowed(venueId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const platform = await getPlatformAuth()
    if (!platform) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    venueId = platform.venueId
    if (!venueId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient()

  try {
    const couple = await loadCoupleKeyForWedding(supabase, venueId, weddingId)
    if (!couple) {
      // Either the venue does not own it or the spine has not minted a
      // couple for it yet. Both are "nothing to show", not an error the
      // panel should render as a failure.
      return NextResponse.json(emptySummary(''))
    }

    const summary = await loadCouplePriorTouches(supabase, venueId, couple.coupleId, {
      sourceWeddingId: couple.sourceWeddingId,
    })
    return NextResponse.json(summary)
  } catch (err) {
    // #86 (T5-followup-QQQ): redact PII from both the stdout log AND the
    // response body. Downstream errors can echo couple emails, phone
    // numbers and quoted message text.
    console.error('[insights/prior-touches] lookup failed:', redactError(err))
    return NextResponse.json({ error: redactError(err) }, { status: 500 })
  }
}
