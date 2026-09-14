/**
 * Canonical reader endpoint — getCohortFunnel, one venue at a time.
 *
 * /agent/analytics used to compute a median reply time for itself out of
 * `interactions`, pairing each inbound with the next outbound on the
 * same Gmail thread. `getCohortFunnel` already answers that question off
 * the spine, with a sample size attached, and /intel reads it. Two
 * answers to one question is the thing W2 exists to end, so the page now
 * calls this.
 *
 * Deliberately NOT scope-merged. `src/lib/intel/adapters/scope-merge.ts`
 * merges counts and feeds and refuses to merge ratios, for the reason
 * written at the top of that file: a median of medians is not a median.
 * So this route answers for ONE venue — the caller's own venue — and a
 * group or company view has to pick a venue rather than be handed an
 * average that means nothing.
 *
 * GET → { ok, venueId, funnel }
 */

import { NextRequest, NextResponse } from 'next/server'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { getPlatformAuth, unauthorized, badRequest } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { getCohortFunnel } from '@/lib/intel/canonical'

export const maxDuration = 120

/** Optional lower bound, in days, so a huge venue does not load its
 *  whole history to draw one tile. */
const MAX_SINCE_DAYS = 365 * 6

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  // The venue the caller asked for, but only if it is one they can
  // already see. `resolveScopeVenueIds` validates the group and the org
  // before it returns anything, so this cannot be used to read across a
  // tenant boundary.
  const url = new URL(req.url)
  const requested = url.searchParams.get('venueId')
  const allowed = await resolveScopeVenueIds()
  const venueId = requested && allowed.includes(requested) ? requested : allowed[0]
  if (!venueId) return badRequest('caller has no venue in scope')

  let since: string | null = null
  const sinceDaysRaw = url.searchParams.get('sinceDays')
  if (sinceDaysRaw) {
    const n = Number(sinceDaysRaw)
    if (Number.isFinite(n) && n > 0) {
      const days = Math.min(Math.floor(n), MAX_SINCE_DAYS)
      since = new Date(Date.now() - days * 86_400_000).toISOString()
    }
  }

  try {
    const funnel = await getCohortFunnel(venueId, since ? { period: { from: since, to: new Date().toISOString() } } : {})
    return NextResponse.json({ ok: true, venueId, funnel })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intel/canonical/cohort-funnel] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
