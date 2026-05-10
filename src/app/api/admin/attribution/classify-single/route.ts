/**
 * Wave 7B — single-event channel-role classify endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B)
 *
 * Auth (mirrors /api/admin/identity/reconstruct):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. The endpoint
 *     looks up the event's venue from the row itself.
 *   - else getPlatformAuth (coordinator UI). The endpoint validates
 *     that the event belongs to the caller's venue.
 *
 * POST body: { attributionEventId: string, force?: boolean, noLLM?: boolean }
 *
 * force=false (default): if the event was classified within the last
 *   30 days, return the cached row (no LLM call, no DB write).
 * force=true: re-classify (may spend an LLM call when the forensic
 *   rule is ambiguous).
 *
 * GET ?attributionEventId=X — returns the stored role decision (no
 * LLM call, no DB write). Returns 404 when no row exists.
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
  classifyAndPersistAttributionEvent,
  CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
} from '@/lib/services/attribution-roles/classify'

export const maxDuration = 120

const CACHE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, mirrors drift-refresh window

interface PostBody {
  attributionEventId?: string
  force?: boolean
  noLLM?: boolean
}

interface AuthCtx {
  isCron: boolean
  venueId: string | null
}

async function resolveAuth(
  req: NextRequest,
  attributionEventId: string | null,
): Promise<{ ctx: AuthCtx } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!attributionEventId) {
      return badRequest('CRON_SECRET path requires attributionEventId')
    }
    const sb = createServiceClient()
    const { data: event } = await sb
      .from('attribution_events')
      .select('venue_id, reverted_at')
      .eq('id', attributionEventId)
      .maybeSingle()
    if (!event) return notFound('attribution_event')
    const e = event as { venue_id: string; reverted_at: string | null }
    if (e.reverted_at) {
      return badRequest('attribution_event is reverted')
    }
    return { ctx: { isCron: true, venueId: e.venue_id } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run channel-role classification')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  if (attributionEventId) {
    const sb = createServiceClient()
    const { data: event } = await sb
      .from('attribution_events')
      .select('venue_id, reverted_at')
      .eq('id', attributionEventId)
      .maybeSingle()
    if (!event) return notFound('attribution_event')
    const e = event as { venue_id: string; reverted_at: string | null }
    if (e.venue_id !== auth.venueId) {
      return forbidden('attribution_event does not belong to your venue')
    }
    if (e.reverted_at) {
      return badRequest('attribution_event is reverted')
    }
  }
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function isFresh(row: { role_classified_at: string | null }): boolean {
  if (!row.role_classified_at) return false
  const t = Date.parse(row.role_classified_at)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < CACHE_WINDOW_MS
}

interface StoredRow {
  id: string
  venue_id: string
  source_platform: string | null
  role: string | null
  role_confidence_0_100: number | null
  role_classified_at: string | null
  role_reasoning: string | null
  role_evidence: unknown
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const attributionEventId =
    typeof body.attributionEventId === 'string' ? body.attributionEventId : null
  const force = body.force === true
  const noLLM = body.noLLM === true

  if (!attributionEventId) {
    return badRequest('attributionEventId required')
  }

  const authResolved = await resolveAuth(req, attributionEventId)
  if (authResolved instanceof NextResponse) return authResolved

  const sb = createServiceClient()

  // Cache-hit path.
  if (!force) {
    const { data: stored } = await sb
      .from('attribution_events')
      .select(
        'id, venue_id, source_platform, role, role_confidence_0_100, role_classified_at, role_reasoning, role_evidence',
      )
      .eq('id', attributionEventId)
      .maybeSingle()
    const row = stored as StoredRow | null
    if (row && row.role && row.role !== 'unknown' && isFresh(row)) {
      return NextResponse.json({
        ok: true,
        cached: true,
        attributionEventId,
        venueId: row.venue_id,
        sourcePlatform: row.source_platform,
        role: row.role,
        roleConfidence: row.role_confidence_0_100,
        reasoning: row.role_reasoning,
        evidence: row.role_evidence,
        classifiedAt: row.role_classified_at,
        promptVersion: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
      })
    }
  }

  let result
  try {
    result = await classifyAndPersistAttributionEvent(
      { attributionEventId },
      { supabase: sb, noLLM },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[classify-single] error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    cached: false,
    attributionEventId,
    role: result.role,
    roleConfidence: result.role_confidence_0_100,
    reasoning: result.reasoning,
    evidence: result.evidence,
    costCents: result.cost_cents,
    promptVersion: result.prompt_version,
  })
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const attributionEventId = url.searchParams.get('attributionEventId')
  if (!attributionEventId) return badRequest('attributionEventId query param required')

  const authResolved = await resolveAuth(req, attributionEventId)
  if (authResolved instanceof NextResponse) return authResolved

  const sb = createServiceClient()
  const { data: row } = await sb
    .from('attribution_events')
    .select(
      'id, venue_id, source_platform, role, role_confidence_0_100, role_classified_at, role_reasoning, role_evidence',
    )
    .eq('id', attributionEventId)
    .maybeSingle()

  if (!row) return notFound('attribution_event')

  const r = row as StoredRow
  return NextResponse.json({
    ok: true,
    attributionEventId,
    venueId: r.venue_id,
    sourcePlatform: r.source_platform,
    role: r.role,
    roleConfidence: r.role_confidence_0_100,
    reasoning: r.role_reasoning,
    evidence: r.role_evidence,
    classifiedAt: r.role_classified_at,
    promptVersion: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
  })
}
