/**
 * Wave 16 — single-event inquiry-intent classify endpoint.
 *
 * Mirrors /api/admin/attribution/classify-single (Wave 7B). Useful for
 * coordinator-triggered single-event inspection from the audit UI.
 *
 * POST body: { attributionEventId, force?, noLLM? }
 * GET ?attributionEventId=X — returns stored intent decision.
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
import { classifyAndPersistInquiryIntent } from '@/lib/services/attribution-roles/intent-classifier'
import { INQUIRY_INTENT_JUDGE_PROMPT_VERSION } from '@/config/prompts/inquiry-intent-judge'

export const maxDuration = 120

const CACHE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

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
    if (e.reverted_at) return badRequest('attribution_event is reverted')
    return { ctx: { isCron: true, venueId: e.venue_id } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run inquiry-intent classification')
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
    if (e.reverted_at) return badRequest('attribution_event is reverted')
  }
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function isFresh(row: { intent_classified_at: string | null }): boolean {
  if (!row.intent_classified_at) return false
  const t = Date.parse(row.intent_classified_at)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < CACHE_WINDOW_MS
}

interface StoredRow {
  id: string
  venue_id: string
  source_platform: string | null
  intent_class: string | null
  intent_class_confidence_0_100: number | null
  intent_classified_at: string | null
  intent_class_signals: unknown
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

  if (!attributionEventId) return badRequest('attributionEventId required')

  const authResolved = await resolveAuth(req, attributionEventId)
  if (authResolved instanceof NextResponse) return authResolved

  const sb = createServiceClient()

  if (!force) {
    const { data: stored } = await sb
      .from('attribution_events')
      .select(
        'id, venue_id, source_platform, intent_class, intent_class_confidence_0_100, intent_classified_at, intent_class_signals',
      )
      .eq('id', attributionEventId)
      .maybeSingle()
    const row = stored as StoredRow | null
    if (row && row.intent_class && row.intent_class !== 'unknown' && isFresh(row)) {
      return NextResponse.json({
        ok: true,
        cached: true,
        attributionEventId,
        venueId: row.venue_id,
        sourcePlatform: row.source_platform,
        intentClass: row.intent_class,
        intentConfidence: row.intent_class_confidence_0_100,
        signals: row.intent_class_signals,
        classifiedAt: row.intent_classified_at,
        promptVersion: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
      })
    }
  }

  let result
  try {
    result = await classifyAndPersistInquiryIntent(
      { attributionEventId },
      { supabase: sb, noLLM },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intent-classify-single] error:', message)
    return NextResponse.json(
      { ok: false, error: message, promptVersion: INQUIRY_INTENT_JUDGE_PROMPT_VERSION },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    cached: false,
    attributionEventId,
    intentClass: result.intentClass,
    intentConfidence: result.confidence_0_100,
    signals: result.signals,
    reasoning: result.reasoning,
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
      'id, venue_id, source_platform, intent_class, intent_class_confidence_0_100, intent_classified_at, intent_class_signals',
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
    intentClass: r.intent_class,
    intentConfidence: r.intent_class_confidence_0_100,
    signals: r.intent_class_signals,
    classifiedAt: r.intent_classified_at,
    promptVersion: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
  })
}
