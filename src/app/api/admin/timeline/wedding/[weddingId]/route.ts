/**
 * Wave 12 — couple timeline endpoint.
 *
 * GET /api/admin/timeline/wedding/[weddingId]?since=&until=&kinds=
 *
 * Pulls every chronological signal for a wedding (interactions, tours,
 * lifecycle transitions, reconstruction events, intel derives, payments,
 * contracts, reviews, attribution events, intel matches, discoveries,
 * recommendations) and returns them merged + sorted ASC by timestamp.
 *
 * Auth (mirrors /api/admin/identity/reconstruct):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path
 *   - else getPlatformAuth (coordinator UI), venueId from session, and
 *     we validate the requested wedding belongs to that venue.
 *
 * Query params:
 *   - since (ISO): lower bound
 *   - until (ISO): upper bound
 *   - kinds (comma-list): filter to only these event kinds
 *
 * Anchor: src/lib/services/timeline/build-timeline.ts (Wave 12).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import {
  buildCoupleTimeline,
  type TimelineEventKind,
} from '@/lib/services/timeline/build-timeline'

// One timeline is a bunch of parallel reads — cap at 30s to be safe for
// large couples on slow connections.
export const maxDuration = 30

// All known kinds (kept in sync with TimelineEventKind union).
const ALL_KINDS: ReadonlyArray<TimelineEventKind> = [
  'interaction',
  'tour',
  'lifecycle_transition',
  'reconstruction',
  'intel_derive',
  'payment',
  'contract',
  'review',
  'attribution_event',
  'intel_match',
  'discovery',
  'recommendation',
]
const ALL_KINDS_SET: ReadonlySet<TimelineEventKind> = new Set(ALL_KINDS)

interface RouteCtx {
  params: Promise<{ weddingId: string }>
}

async function resolveAuth(
  req: NextRequest,
  weddingId: string,
): Promise<NextResponse | { venueId: string }> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      .from('weddings')
      .select('venue_id, merged_into_id')
      .eq('id', weddingId)
      .maybeSingle()
    if (!wedding) return notFound('wedding')
    const w = wedding as { venue_id: string; merged_into_id: string | null }
    if (w.merged_into_id) {
      return badRequest('wedding is tombstoned (merged_into_id set)')
    }
    return { venueId: w.venue_id }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()
  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id, merged_into_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) return notFound('wedding')
  const w = wedding as { venue_id: string; merged_into_id: string | null }

  // Super-admin bypass + venue check. Reuse the same pattern as
  // /api/admin/identity/reconstruct — defense in depth because the
  // service-role client below bypasses RLS.
  if (auth.role !== 'super_admin' && w.venue_id !== auth.venueId) {
    return forbidden('wedding does not belong to your venue')
  }
  if (w.merged_into_id) {
    return badRequest('wedding is tombstoned (merged_into_id set)')
  }
  return { venueId: w.venue_id }
}

function parseKinds(raw: string | null): ReadonlyArray<TimelineEventKind> | null {
  if (!raw) return null
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const valid: TimelineEventKind[] = []
  for (const p of parts) {
    if (ALL_KINDS_SET.has(p as TimelineEventKind)) {
      valid.push(p as TimelineEventKind)
    }
  }
  return valid.length > 0 ? valid : null
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const { weddingId } = await ctx.params
  if (!weddingId) return badRequest('weddingId required')

  const authResolved = await resolveAuth(req, weddingId)
  if (authResolved instanceof NextResponse) return authResolved

  const url = new URL(req.url)
  const since = url.searchParams.get('since')
  const until = url.searchParams.get('until')
  const kinds = parseKinds(url.searchParams.get('kinds'))

  // Defensive ISO validation — if either bound is provided but invalid,
  // we drop it (clients should never see a parse-error 400 just because
  // they handed us a malformed string).
  const isoOrNull = (s: string | null): string | null => {
    if (!s) return null
    const n = Date.parse(s)
    if (!Number.isFinite(n)) return null
    return new Date(n).toISOString()
  }

  const supabase = createServiceClient()
  try {
    const result = await buildCoupleTimeline({
      weddingId,
      supabase,
      since: isoOrNull(since),
      until: isoOrNull(until),
      kinds,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[timeline] build failed:', msg)
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    )
  }
}
