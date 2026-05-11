/**
 * POST /api/admin/weddings/[id]/ai-opt-out
 *
 * Toggles the sticky `weddings.ai_opted_out` flag (mig 303). When set to
 * true, the pipeline skips drafting for any future inbound on this
 * wedding. When set to false, Sage resumes drafting from the next
 * inbound.
 *
 * Body: { optedOut: boolean, reason?: string }
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — operators clear AI
 *     opt-out when the couple says "ok actually go ahead")
 *   - src/lib/services/email/draft-skip-gates.ts (the gate this controls)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

interface PostBody {
  optedOut?: boolean
  reason?: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot toggle AI opt-out')

  const { id: weddingId } = await params
  if (!weddingId) return badRequest('wedding id required')

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  if (typeof body.optedOut !== 'boolean') {
    return badRequest('optedOut (boolean) required')
  }

  const supabase = createServiceClient()

  // Venue-scope check: the wedding must belong to a venue the operator
  // can access.
  const { data: wedding, error: weddingErr } = await supabase
    .from('weddings')
    .select('id, venue_id, ai_opted_out')
    .eq('id', weddingId)
    .maybeSingle()
  if (weddingErr || !wedding) {
    return NextResponse.json({ error: 'wedding not found' }, { status: 404 })
  }
  if (wedding.venue_id !== auth.venueId) {
    return forbidden('wedding not in your venue')
  }

  if (body.optedOut === true) {
    const { markWeddingAiOptedOut } = await import(
      '@/lib/services/email/draft-skip-gates'
    )
    const result = await markWeddingAiOptedOut({
      supabase,
      weddingId,
      reason: body.reason?.trim() || 'operator_set',
    })
    return NextResponse.json({
      ok: true,
      optedOut: true,
      updated: result.updated,
      draftsCancelled: result.draftsCancelled,
    })
  }

  // optedOut = false: clear the flag. Drafts already rejected stay
  // rejected (the operator can manually re-open or compose a new draft
  // for the next inbound). The pipeline picks up the cleared flag on
  // the next email it processes for this wedding.
  const { error: updErr } = await supabase
    .from('weddings')
    .update({
      ai_opted_out: false,
      ai_opted_out_at: null,
      ai_opted_out_reason: null,
    })
    .eq('id', weddingId)
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }
  return NextResponse.json({
    ok: true,
    optedOut: false,
  })
}
