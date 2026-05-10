/**
 * Wave 7B — bulk channel-role re-classification endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B)
 *
 * Auth (mirrors /api/admin/intel/couple-derive-bulk):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, venueId REQUIRED
 *     in body.
 *   - else getPlatformAuth (coordinator UI). venueId taken from auth;
 *     any explicit body.venueId is ignored.
 *
 * POST body:
 *   {
 *     venueId?: string,
 *     limit?: number,
 *     offset?: number,
 *     force?: boolean,
 *     mode?: 'enqueue' | 'sync',
 *     noLLM?: boolean
 *   }
 *
 * mode='enqueue' (default):
 *   - Iterates non-reverted attribution_events for the venue, ordered
 *     by role_classified_at ASC nullsFirst.
 *   - For each, calls enqueueRoleClassification (24h dedupe per event).
 *     Cron sweep picks them up over time.
 *
 * mode='sync':
 *   - Calls reclassifyVenueAttribution inline. Time-boxed at 280s.
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
import { enqueueRoleClassification } from '@/lib/services/attribution-roles/enqueue'
import { reclassifyVenueAttribution } from '@/lib/services/attribution-roles/reclassify-venue'

export const maxDuration = 300

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

interface BulkBody {
  venueId?: string
  limit?: number
  offset?: number
  force?: boolean
  mode?: 'enqueue' | 'sync'
  noLLM?: boolean
}

interface AuthCtx {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: BulkBody,
): Promise<{ ctx: AuthCtx } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    return { ctx: { isCron: true, venueId: body.venueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run bulk channel-role reclassify')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function clampOffset(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

interface AttributionEventPick {
  id: string
}

export async function POST(req: NextRequest) {
  let body: BulkBody = {}
  try {
    body = (await req.json()) as BulkBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const limit = clampLimit(body.limit ?? DEFAULT_LIMIT)
  const offset = clampOffset(body.offset ?? 0)
  const mode: 'enqueue' | 'sync' = body.mode === 'sync' ? 'sync' : 'enqueue'
  const force = body.force === true
  const noLLM = body.noLLM === true

  const sb = createServiceClient()

  // Confirm the venue exists.
  const { data: venueRow } = await sb
    .from('venues')
    .select('id')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  if (mode === 'sync') {
    const out = await reclassifyVenueAttribution({
      venueId,
      limit,
      offset,
      force,
      noLLM,
      supabase: sb,
    })
    return NextResponse.json(out)
  }

  // Enqueue mode.
  const { count: totalCount } = await sb
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .is('reverted_at', null)

  const { data: rows, error: pageErr } = await sb
    .from('attribution_events')
    .select('id')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
    .order('role_classified_at', { ascending: true, nullsFirst: true })
    .range(offset, offset + limit - 1)
  if (pageErr) {
    return NextResponse.json(
      { ok: false, error: `attribution_events page fetch failed: ${pageErr.message}` },
      { status: 500 },
    )
  }
  const events = (rows ?? []) as AttributionEventPick[]

  const result = {
    ok: true as const,
    mode,
    venueId,
    limit,
    offset,
    totalCount: totalCount ?? 0,
    processed: 0,
    enqueued: 0,
    skipped_dedupe: 0,
    failed: 0,
    hasMore: false,
    nextOffset: offset + events.length,
  }

  for (const e of events) {
    result.processed += 1
    const r = await enqueueRoleClassification({
      attributionEventId: e.id,
      venueId,
      triggerSignal: 'manual_bulk',
      supabase: sb,
    })
    if (r.skipped) {
      if (r.reason === 'dedupe_24h') result.skipped_dedupe += 1
      else result.failed += 1
    } else {
      result.enqueued += 1
    }
  }

  result.hasMore = result.totalCount > 0 && offset + events.length < result.totalCount
  return NextResponse.json(result)
}
