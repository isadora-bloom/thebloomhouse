/**
 * Wave 19 — edit / deactivate a single knowledge_captures row.
 *
 * PATCH /api/admin/knowledge-gaps/captures/[id]
 *   Body: { question?, answer?, tags?, appliesUntil?, active? }
 *
 * DELETE /api/admin/knowledge-gaps/captures/[id]  → soft-delete (active=false)
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

interface PatchBody {
  question?: string
  answer?: string
  tags?: unknown
  appliesUntil?: string | null
  active?: boolean
  confidence?: number
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot edit knowledge captures')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const { id } = await context.params
  if (!id) return badRequest('id required')

  let body: PatchBody = {}
  try {
    body = (await req.json()) as PatchBody
  } catch {
    body = {}
  }

  const sb = createServiceClient()
  const { data: row } = await sb
    .from('knowledge_captures')
    .select('venue_id')
    .eq('id', id)
    .maybeSingle()
  if (!row) return notFound('knowledge_capture')
  if ((row as { venue_id: string }).venue_id !== auth.venueId) {
    return forbidden('knowledge_capture does not belong to your venue')
  }

  const patch: Record<string, unknown> = {}
  if (typeof body.question === 'string' && body.question.trim().length > 0) {
    patch.question = body.question.trim()
  }
  if (typeof body.answer === 'string' && body.answer.trim().length > 0) {
    patch.answer = body.answer.trim()
  }
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags.filter((t) => typeof t === 'string')
  }
  if (body.appliesUntil === null) {
    patch.applies_until = null
  } else if (typeof body.appliesUntil === 'string') {
    patch.applies_until = body.appliesUntil.length > 0 ? body.appliesUntil : null
  }
  if (typeof body.active === 'boolean') {
    patch.active = body.active
  }
  if (typeof body.confidence === 'number' && Number.isFinite(body.confidence)) {
    patch.confidence_0_100 = Math.max(0, Math.min(100, Math.round(body.confidence)))
  }

  if (Object.keys(patch).length === 0) {
    return badRequest('no editable fields supplied')
  }

  const { error } = await sb
    .from('knowledge_captures')
    .update(patch)
    .eq('id', id)
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot delete knowledge captures')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const { id } = await context.params
  if (!id) return badRequest('id required')

  const sb = createServiceClient()
  const { data: row } = await sb
    .from('knowledge_captures')
    .select('venue_id')
    .eq('id', id)
    .maybeSingle()
  if (!row) return notFound('knowledge_capture')
  if ((row as { venue_id: string }).venue_id !== auth.venueId) {
    return forbidden('knowledge_capture does not belong to your venue')
  }

  // Soft-delete: active=false. Preserves the row for audit and lets a
  // coordinator restore it.
  const { error } = await sb
    .from('knowledge_captures')
    .update({ active: false })
    .eq('id', id)
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
