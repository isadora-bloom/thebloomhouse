/**
 * Wave 19 — coordinator-triggered knowledge-gap detection on a single draft.
 *
 * POST /api/admin/knowledge-gaps/detect
 * Body: { draftId } | { weddingId } — one of the two
 *
 * Returns the detector output + how many knowledge_gaps rows were
 * created. Useful when a coordinator wants to manually re-scan a
 * historical draft.
 *
 * Auth: dual — platform auth OR CRON_SECRET (for the sweep).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  assertCanAccessVenue,
} from '@/lib/api/auth-helpers'
import { detectKnowledgeGapsFromDraft } from '@/lib/services/knowledge-gaps'

export const maxDuration = 60

interface PostBody {
  draftId?: string
  weddingId?: string
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const draftId = typeof body.draftId === 'string' ? body.draftId : null
  const weddingId = typeof body.weddingId === 'string' ? body.weddingId : null
  if (!draftId && !weddingId) {
    return badRequest('draftId or weddingId required')
  }

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  const sb = createServiceClient()

  // Resolve the draft row. Pick the most recent draft for the wedding
  // when only weddingId is supplied.
  interface DraftRow {
    id: string
    venue_id: string
    wedding_id: string | null
    interaction_id: string | null
    draft_body: string
    subject: string | null
  }
  let draftRow: DraftRow | null = null

  if (draftId) {
    const { data } = await sb
      .from('drafts')
      .select('id, venue_id, wedding_id, interaction_id, draft_body, subject')
      .eq('id', draftId)
      .maybeSingle()
    draftRow = (data as unknown) as DraftRow | null
  } else if (weddingId) {
    const { data } = await sb
      .from('drafts')
      .select('id, venue_id, wedding_id, interaction_id, draft_body, subject')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    draftRow = (data as unknown) as DraftRow | null
  }

  if (!draftRow) return notFound('draft')

  // Auth gate.
  if (!cronAuth) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot trigger knowledge-gap detection')
    const access = await assertCanAccessVenue(auth, draftRow.venue_id)
    if (!access.ok) return forbidden(access.reason)
  }

  // Resolve the inbound interaction body. drafts.interaction_id is the
  // upstream inbound that triggered the draft.
  let inboundSubject: string | null = draftRow.subject ?? null
  let inboundBody = ''
  if (draftRow.interaction_id) {
    const { data: interaction } = await sb
      .from('interactions')
      .select('subject, body')
      .eq('id', draftRow.interaction_id)
      .maybeSingle()
    if (interaction) {
      const ix = interaction as { subject: string | null; body: string | null }
      inboundSubject = ix.subject ?? inboundSubject
      inboundBody = (ix.body ?? '').slice(0, 4000)
    }
  }

  // Resolve the venue's ai_name for the detector prompt.
  let aiName = 'Sage'
  try {
    const { data: aiCfg } = await sb
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', draftRow.venue_id)
      .maybeSingle()
    if (aiCfg && typeof (aiCfg as { ai_name?: string | null }).ai_name === 'string') {
      aiName = ((aiCfg as { ai_name?: string | null }).ai_name as string) || aiName
    }
  } catch {
    // Use default.
  }

  const result = await detectKnowledgeGapsFromDraft({
    venueId: draftRow.venue_id,
    weddingId: draftRow.wedding_id,
    draftId: draftRow.id,
    aiName,
    inboundSubject,
    inboundBody,
    draftBody: draftRow.draft_body,
  })

  return NextResponse.json({
    ok: true,
    draftId: draftRow.id,
    venueId: draftRow.venue_id,
    weddingId: draftRow.wedding_id,
    skipped: result.skipped,
    skipReason: result.skipReason,
    gapsDetected: result.gaps.length,
    gapsPersisted: result.insertedGapIds.length,
    gaps: result.gaps,
    reasoning: result.reasoning,
  })
}
