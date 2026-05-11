/**
 * Wave 19 — dismiss a knowledge_gaps row as noise.
 *
 * POST /api/admin/knowledge-gaps/[id]/dismiss
 * Body: { reason: string }
 *
 * Dismissed gaps stay in the audit log (dismissed_at + dismissed_reason)
 * so re-detection doesn't reopen them.
 *
 * Auth: getPlatformAuth, venue-scoped.
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
import { dismissKnowledgeGap } from '@/lib/services/knowledge-gaps'

interface PostBody {
  reason?: string
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot dismiss knowledge gaps')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const { id } = await context.params
  if (!id) return badRequest('id required')

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return badRequest('reason required')

  const sb = createServiceClient()
  const { data: gap } = await sb
    .from('knowledge_gaps')
    .select('venue_id')
    .eq('id', id)
    .maybeSingle()
  if (!gap) return notFound('knowledge_gap')
  if ((gap as { venue_id: string }).venue_id !== auth.venueId) {
    return forbidden('knowledge_gap does not belong to your venue')
  }

  try {
    await dismissKnowledgeGap({
      venueId: auth.venueId,
      knowledgeGapId: id,
      reason,
      operatorId: auth.userId ?? null,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
