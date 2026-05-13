/**
 * POST /api/admin/calendly/cache-host-uri
 *
 * Resolves and caches the Calendly host URIs (tokens.user +
 * tokens.organization) on venue_config for one venue, or every venue
 * with a stored access_token + missing URIs.
 *
 * Why this exists
 * ---------------
 * The Calendly webhook handler (`src/app/api/webhooks/calendly/route.ts`)
 * routes incoming bookings by matching `payload.scheduled_event
 * .event_memberships[*].user` against `venue_config.calendly_tokens
 * .user`. Historically the settings page only persisted `access_token`,
 * so `tokens.user` was empty and the webhook's path-A routing dropped
 * cold bookings.
 *
 * Three triggers for this endpoint:
 *
 *   1. Settings page calls POST {"venueId":<uuid>} after a token save
 *      so URIs are cached before the first cold booking arrives.
 *   2. Operator calls POST {"backfill":"all"} once after deploy to
 *      migrate existing venues that already had access_tokens stored.
 *   3. Future cron / scheduled health-check can hit `backfill:all`
 *      periodically.
 *
 * Request body:
 *   { venueId?: string, backfill?: 'all' }
 *
 *   - venueId: single-venue mode. Cache for one venue only.
 *   - backfill: 'all' walks every venue_config row where calendly_tokens
 *     has an access_token but is missing `user` or `organization`.
 *
 * Auth: getPlatformAuth — coordinator/admin only. Backfill-all also
 * requires venue scope or super_admin.
 *
 * Response:
 *   { ok: true, results: [{ venueId, status: 'cached'|'already'|'failed',
 *     reason?: string }] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

interface CalendlyTokens {
  access_token?: string
  refresh_token?: string
  expires_at?: string | number
  organization?: string
  user?: string
}

interface CalendlyUserMe {
  resource: {
    uri: string
    current_organization: string
  }
}

interface CachingResult {
  venueId: string
  status: 'cached' | 'already_cached' | 'no_token' | 'failed'
  reason?: string
}

async function fetchUserMe(accessToken: string): Promise<CalendlyUserMe | null> {
  const res = await fetch('https://api.calendly.com/users/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    throw new Error(`Calendly /users/me returned ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as CalendlyUserMe
}

async function cacheForVenue(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
): Promise<CachingResult> {
  const { data, error } = await supabase
    .from('venue_config')
    .select('calendly_tokens')
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) {
    return { venueId, status: 'failed', reason: `read failed: ${error.message}` }
  }
  const tokens = (data?.calendly_tokens ?? null) as CalendlyTokens | null
  if (!tokens?.access_token) {
    return { venueId, status: 'no_token' }
  }
  if (tokens.user && tokens.organization) {
    return { venueId, status: 'already_cached' }
  }
  let me: CalendlyUserMe | null
  try {
    me = await fetchUserMe(tokens.access_token)
  } catch (err) {
    return {
      venueId,
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  if (!me) return { venueId, status: 'failed', reason: 'no payload' }
  const updated: CalendlyTokens = {
    ...tokens,
    user: tokens.user ?? me.resource.uri,
    organization: tokens.organization ?? me.resource.current_organization,
  }
  const { error: updateErr } = await supabase
    .from('venue_config')
    .update({ calendly_tokens: updated, updated_at: new Date().toISOString() })
    .eq('venue_id', venueId)
  if (updateErr) {
    return { venueId, status: 'failed', reason: `update failed: ${updateErr.message}` }
  }
  return { venueId, status: 'cached' }
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: { venueId?: string; backfill?: string } = {}
  try {
    body = await request.json()
  } catch {
    // empty body is acceptable; treat as single-venue mode against the
    // caller's own venue if it can be inferred from auth.
  }

  const supabase = createServiceClient()

  // Mode 1 — single venue. Either explicit venueId from the body or
  // the caller's auth venue (used by the settings page after a save).
  const singleVenueId = body.venueId ?? auth.venueId ?? null
  if (singleVenueId && body.backfill !== 'all') {
    // Authorize: the caller must have access to this venue. Super-admin
    // and demo bypass this check.
    if (
      auth.venueId
      && singleVenueId !== auth.venueId
      && auth.role !== 'super_admin'
    ) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const result = await cacheForVenue(supabase, singleVenueId)
    return NextResponse.json({ ok: result.status !== 'failed', results: [result] })
  }

  // Mode 2 — backfill all. Walks every venue_config with a stored
  // access_token + missing user/organization URIs. Super-admin only.
  if (body.backfill !== 'all') {
    return NextResponse.json(
      { error: 'expected venueId or backfill=all' },
      { status: 400 },
    )
  }
  if (auth.role !== 'super_admin') {
    return NextResponse.json({ error: 'super_admin required for backfill' }, { status: 403 })
  }

  // Pull every venue with a token. Filtering missing-uri in JS because
  // jsonb null/missing semantics through PostgREST are awkward.
  const { data: rows, error } = await supabase
    .from('venue_config')
    .select('venue_id, calendly_tokens')
    .not('calendly_tokens', 'is', null)
    .limit(1000)
  if (error) {
    return NextResponse.json(
      { error: `lookup failed: ${error.message}` },
      { status: 500 },
    )
  }

  const candidates = (rows ?? []).filter((row) => {
    const t = row.calendly_tokens as CalendlyTokens | null
    return !!t?.access_token && (!t.user || !t.organization)
  })

  const results: CachingResult[] = []
  for (const row of candidates) {
    // Serial (not parallel) so we don't fan-out 100 Calendly API calls
    // at once and trip rate limits. /users/me is fast — sub-second per
    // venue. 100 venues = ~30s.
    results.push(await cacheForVenue(supabase, row.venue_id as string))
  }

  const cached = results.filter((r) => r.status === 'cached').length
  const failed = results.filter((r) => r.status === 'failed').length
  return NextResponse.json({
    ok: failed === 0,
    cached,
    failed,
    scanned: candidates.length,
    results,
  })
}
