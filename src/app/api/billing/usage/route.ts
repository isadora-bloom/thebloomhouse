import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { resolveBillingState } from '@/lib/services/billing/billing-state'
import { apiError } from '@/lib/api/api-error'

// ---------------------------------------------------------------------------
// GET /api/billing/usage
//
// Returns current rate-limit bucket usage for the authenticated venue
// (`items` — request-throttling buckets, unrelated to the plan) AND, as of
// W18 (Nov-plan wave 2), real usage against the venue's CAPACITY_LIMITS
// plan caps (`capacity`). Before this, CAPACITY_LIMITS was only read from
// unit tests — nowhere in the product showed a venue how close it was to
// its plan's cap. See src/lib/services/billing/capacity-enforcement.ts for
// where the same cap is enforced (honestly, non-fatally) at mint time.
//
// Response shape:
//   {
//     items: Array<{ label; used; limit; windowLabel }>            // rate limits
//     capacity: Array<{ label; used; limit: number | null; windowLabel }>  // plan caps
//   }
//
// Used by the billing page "Usage" and "Capacity" sections.
// ---------------------------------------------------------------------------

// Describes what limits are enforced per key prefix so the UI can show
// "X / limit" without querying config each time.
interface KnownLimit {
  label: string
  keyPattern: (venueId: string) => string
  /** The configured limit value shown in the UI (informational). */
  displayLimit: number
  windowLabel: string
}

// These match the limits in the consuming API routes. Keep in sync if you
// change limits in those routes.
const KNOWN_LIMITS: KnownLimit[] = [
  {
    label: 'AI queries (NLQ)',
    keyPattern: (v) => `nlq:${v}`,
    displayLimit: 50,
    windowLabel: 'per day',
  },
  {
    label: 'Sage chat messages',
    keyPattern: (v) => `sage:${v}`,
    displayLimit: 20,
    windowLabel: 'per 15 min',
  },
  {
    label: 'Auto-send emails',
    keyPattern: (v) => `auto-send:${v}`,
    displayLimit: 50,
    windowLabel: 'per day',
  },
  {
    label: 'AI insights',
    keyPattern: (v) => `insights:${v}`,
    displayLimit: 20,
    windowLabel: 'per hour',
  },
]

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { venueId } = auth
  const supabase = createServiceClient()

  // Build the set of keys we want to look up.
  const keys = KNOWN_LIMITS.map((kl) => kl.keyPattern(venueId))

  // Also fetch all keys that match 'venue:<venueId>:*' for any custom
  // per-venue buckets that don't map to a known prefix above.
  const { data: rows, error } = await supabase
    .from('rate_limit_buckets')
    .select('key, hits, updated_at')
    .in('key', keys)

  if (error) {
    return apiError(error)
  }

  const bucketMap = new Map<string, { hits: unknown[] }>(
    (rows ?? []).map((r) => [
      r.key as string,
      { hits: Array.isArray(r.hits) ? (r.hits as unknown[]) : [] },
    ])
  )

  const nowSec = Math.floor(Date.now() / 1000)

  const items = KNOWN_LIMITS.map((kl) => {
    const key = kl.keyPattern(venueId)
    const bucket = bucketMap.get(key)

    // Count hits within the window. We derive the window from the
    // displayLimit's context. For usage display we show the raw count
    // in the bucket (any recent hit), not a precise sliding window count,
    // because we don't have the windowSec here. Showing total hits in
    // the last 24h is good enough for a dashboard.
    const DISPLAY_WINDOW_SEC = 24 * 60 * 60 // 24 hours for display
    const cutoff = nowSec - DISPLAY_WINDOW_SEC
    const used = bucket
      ? bucket.hits.filter((h) => typeof h === 'number' && (h as number) > cutoff).length
      : 0

    return {
      label: kl.label,
      used,
      limit: kl.displayLimit,
      windowLabel: kl.windowLabel,
    }
  })

  // ---------------------------------------------------------------------
  // Capacity — real usage against the plan's CAPACITY_LIMITS. Reads the
  // spine (`couples`), not `weddings` — the wave-2 shared rule says no
  // new read under src/app should hit a legacy table couples/touchpoints
  // already carries the same fact for, and it does here: every mint
  // dual-writes a couples row (mirrorCoupleFromWedding). venue-scoped
  // (inquiries, active couples); venues-per-org uses orgId when present
  // (demo/org-less coordinators skip that row).
  // ---------------------------------------------------------------------
  const state = await resolveBillingState(venueId)
  const cap = state.effectiveCapacity

  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()

  const [inquiriesRes, activeCouplesRes, venuesRes] = await Promise.all([
    supabase
      .from('couples')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .is('merged_into_id', null)
      .gte('created_at', monthStart),
    supabase
      .from('couples')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .is('merged_into_id', null)
      .neq('lifecycle_state', 'ghost'),
    auth.orgId
      ? supabase
          .from('venues')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', auth.orgId)
      : Promise.resolve({ count: null, error: null } as { count: number | null; error: null }),
  ])

  const capacity: Array<{ label: string; used: number; limit: number | null; windowLabel: string }> = [
    {
      label: 'Inquiries',
      used: inquiriesRes.count ?? 0,
      limit: cap.inquiriesPerMonth,
      windowLabel: 'this month',
    },
    {
      label: 'Active couples',
      used: activeCouplesRes.count ?? 0,
      limit: cap.activeCouplesInPortal,
      windowLabel: 'in the pipeline',
    },
  ]
  if (auth.orgId) {
    capacity.push({
      label: 'Venues',
      used: venuesRes.count ?? 0,
      limit: cap.venues,
      windowLabel: 'in your org',
    })
  }

  return NextResponse.json({ items, capacity, isTrial: state.isTrial, trialEndsAt: state.trialEndsAt })
}
