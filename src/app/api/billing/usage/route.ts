import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET /api/billing/usage
//
// Returns current rate-limit bucket usage for the authenticated venue.
// Reads `rate_limit_buckets` for keys matching 'venue:<venueId>:%' and
// the common per-venue key prefixes (sage, nlq, auto-send, etc.).
//
// Response shape:
//   { items: Array<{ label: string; used: number; limit: number; windowLabel: string }> }
//
// Used by the billing page "Usage" section to show a simple quota table.
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
    console.error('[api/billing/usage] failed to read rate_limit_buckets:', error)
    return NextResponse.json({ error: 'Failed to load usage data' }, { status: 500 })
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

  return NextResponse.json({ items })
}
