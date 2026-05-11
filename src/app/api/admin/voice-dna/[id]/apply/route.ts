/**
 * Wave 20 — voice-DNA apply endpoint.
 *
 * POST /api/admin/voice-dna/[id]/apply
 * body: { fields: ('banned_phrases'|'approved_phrases'|'tone_descriptors'|'voice_principles')[],
 *         itemIndexes?: Partial<Record<Field, number[]>> }
 *
 * Auth: getPlatformAuth (coordinator UI). The derivation's venue_id
 * is loaded from the row and cleared via assertCanAccessVenue — so an
 * org_admin can apply any derivation in their org.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { applyDerivation, APPLYABLE_FIELDS, type ApplyableField } from '@/lib/services/voice-dna/apply'

export const maxDuration = 60

interface ApplyBody {
  fields?: string[]
  itemIndexes?: Record<string, number[]>
}

function validateFields(raw: unknown): ApplyableField[] | null {
  if (!Array.isArray(raw)) return null
  const valid = new Set<string>(APPLYABLE_FIELDS as readonly string[])
  const out: ApplyableField[] = []
  for (const v of raw) {
    if (typeof v === 'string' && valid.has(v)) {
      out.push(v as ApplyableField)
    }
  }
  return out
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot apply voice DNA')

  const { id } = await context.params
  if (!id || typeof id !== 'string') return badRequest('derivation id required')

  let body: ApplyBody = {}
  try {
    body = (await req.json()) as ApplyBody
  } catch {
    body = {}
  }

  const fields = validateFields(body.fields ?? APPLYABLE_FIELDS)
  if (!fields || fields.length === 0) {
    return badRequest('fields must be a non-empty array of valid field names')
  }

  // Load derivation row for venue gate.
  const sb = createServiceClient()
  const { data: row, error: loadErr } = await sb
    .from('voice_dna_derivations')
    .select('id, venue_id')
    .eq('id', id)
    .maybeSingle()
  if (loadErr) {
    return NextResponse.json({ ok: false, error: loadErr.message }, { status: 500 })
  }
  if (!row) return notFound('derivation')
  const venueId = (row as { venue_id: string }).venue_id
  const access = await assertCanAccessVenue(auth, venueId)
  if (!access.ok) return forbidden(access.reason)

  // Validate itemIndexes if present.
  const itemIndexes: Partial<Record<ApplyableField, number[]>> = {}
  if (body.itemIndexes && typeof body.itemIndexes === 'object') {
    for (const f of fields) {
      const raw = body.itemIndexes[f]
      if (Array.isArray(raw)) {
        const filtered = raw.filter((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
        if (filtered.length > 0) itemIndexes[f] = filtered
      }
    }
  }

  const result = await applyDerivation({
    derivationId: id,
    fields,
    itemIndexes,
    userId: auth.userId,
    supabase: sb,
  })

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404
      : result.reason === 'already_applied' ? 409
        : result.reason === 'already_dismissed' ? 409
          : result.reason === 'no_fields' ? 400
            : 500
    return NextResponse.json(result, { status })
  }
  return NextResponse.json(result)
}
