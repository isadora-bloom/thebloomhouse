/**
 * Wave 19 — Knowledge capture endpoint.
 *
 * POST /api/admin/knowledge-gaps/capture
 *
 * Body shape:
 *   {
 *     knowledgeGapId?: string,
 *     question: string,
 *     answer: string,
 *     tags?: string[],
 *     appliesUntil?: string (ISO timestamp),
 *     sourceKind?: 'operator_input' | 'inferred_from_past_email' | 'venue_doc',
 *     confidence?: number,  // 0-100; defaults to 100 for operator_input
 *   }
 *
 * Returns: { ok: true, captureId: string, reused: boolean }
 *
 * Auth: dual — platform auth OR CRON_SECRET (for backfill cron, when
 * the inferred-from-past-email path lands).
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — captures are
 *     authoritative)
 *   - memory/feedback_deep_fix_vs_bandaid.md Pattern 8
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { captureKnowledge } from '@/lib/services/knowledge-gaps'
import {
  KNOWLEDGE_GAP_CATEGORIES,
  type KnowledgeGapCategory,
} from '@/lib/services/knowledge-gaps/categories'

interface PostBody {
  knowledgeGapId?: string
  question?: string
  answer?: string
  /** Category — required for new captures so we never write 'other' by default. */
  category?: string
  tags?: unknown
  appliesUntil?: string
  sourceKind?: string
  confidence?: number
  /** Cron-only: venueId is required when CRON_SECRET is used. */
  venueId?: string
}

const ALLOWED_SOURCE_KINDS = new Set([
  'operator_input',
  'inferred_from_past_email',
  'venue_doc',
])

// Mig 298 added a CHECK constraint on knowledge_gaps.category with this
// enum. ALLOWED_CATEGORIES mirrors it so a bad value 400s here instead
// of surfacing as a postgres CHECK violation downstream.
const ALLOWED_CATEGORIES = new Set<string>(KNOWLEDGE_GAP_CATEGORIES)

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const question = typeof body.question === 'string' ? body.question.trim() : ''
  const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
  if (!question) return badRequest('question required')
  if (!answer) return badRequest('answer required')

  // Category is required for new captures. Re-capturing against an
  // existing gap inherits the gap's category, so allow null only when
  // knowledgeGapId is set — the service layer reads it from the gap row.
  const rawCategory = typeof body.category === 'string' ? body.category.trim() : ''
  const hasGap = typeof body.knowledgeGapId === 'string' && body.knowledgeGapId.length > 0
  if (!rawCategory && !hasGap) {
    return badRequest(
      `category required (one of ${[...ALLOWED_CATEGORIES].join(', ')})`,
    )
  }
  if (rawCategory && !ALLOWED_CATEGORIES.has(rawCategory)) {
    return badRequest(
      `category must be one of ${[...ALLOWED_CATEGORIES].join(', ')}`,
    )
  }
  // Hold a typed reference for downstream use (currently unused by the
  // service; reserved for the next iteration when capture-route can
  // create knowledge_gaps rows directly).
  void (rawCategory as KnowledgeGapCategory)

  const sourceKind =
    typeof body.sourceKind === 'string' && ALLOWED_SOURCE_KINDS.has(body.sourceKind)
      ? (body.sourceKind as 'operator_input' | 'inferred_from_past_email' | 'venue_doc')
      : 'operator_input'

  // ---- Dual auth: cron OR platform ----
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string
  let operatorId: string | null = null

  if (cronAuth) {
    const supplied = typeof body.venueId === 'string' ? body.venueId : null
    if (!supplied) return badRequest('venueId required when CRON_SECRET is used')
    venueId = supplied
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot write knowledge captures')
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
    operatorId = auth.userId ?? null
  }

  const knowledgeGapId =
    typeof body.knowledgeGapId === 'string' ? body.knowledgeGapId : null

  // If a gap is supplied, defense-in-depth: ensure it belongs to the
  // caller's venue. Service-client bypasses RLS so we check explicitly.
  if (knowledgeGapId) {
    const sb = createServiceClient()
    const { data: gap } = await sb
      .from('knowledge_gaps')
      .select('venue_id')
      .eq('id', knowledgeGapId)
      .maybeSingle()
    if (!gap) return badRequest('knowledgeGapId not found')
    if ((gap as { venue_id: string }).venue_id !== venueId) {
      return forbidden('knowledgeGapId does not belong to your venue')
    }
  }

  const tagsRaw = body.tags
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === 'string')
    : []

  const appliesUntil =
    typeof body.appliesUntil === 'string' && body.appliesUntil.length > 0
      ? body.appliesUntil
      : null

  const confidence =
    typeof body.confidence === 'number' && Number.isFinite(body.confidence)
      ? body.confidence
      : sourceKind === 'operator_input'
        ? 100
        : 70

  try {
    const result = await captureKnowledge({
      venueId,
      knowledgeGapId,
      question,
      answer,
      tags,
      appliesUntil,
      sourceKind,
      confidence,
      operatorId,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
