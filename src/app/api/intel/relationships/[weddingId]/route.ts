/**
 * Wedding-scoped family + relationships API (mig 255 wedding_relationships).
 *
 * Wave 2D (2026-05-09). Surfaces non-partner humans associated with a
 * wedding — mothers, planners, MOH, sibling, vendor contacts. The brief
 * mandate: family / planner / mom mentions stop landing as `partner2`.
 *
 * GET    /api/intel/relationships/[weddingId]
 *   Returns active rows grouped by relationship_role. Pinned (no pin
 *   column today, reserved for the future picker) + most-recent first.
 *
 * POST   /api/intel/relationships/[weddingId]
 *   Body: { full_name, relationship_role, detail? }
 *   Coordinator-typed addition. Lands as source='coordinator_added',
 *   confidence=null per the column comment in mig 255.
 *
 * PATCH  /api/intel/relationships/[weddingId]
 *   Body: { id, action: 'archive' | 'unarchive' }
 *   Forensic invariant — archive flips is_active=false, never DELETE.
 *
 * Auth: getPlatformAuth — venue-scoped. Demo cannot mutate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { logEvent } from '@/lib/observability/logger'

const ALLOWED_ROLES = new Set([
  'mother',
  'father',
  'mother_in_law',
  'father_in_law',
  'sibling',
  'planner',
  'maid_of_honor',
  'best_man',
  'family_friend',
  'vendor_contact',
  'other',
])

async function loadWeddingForVenue(weddingId: string, venueId: string) {
  const supabase = createServiceClient()
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) return null
  if (wedding.venue_id !== venueId) return null
  return wedding as { id: string; venue_id: string }
}

// ---------------------------------------------------------------------------
// GET — list active rows
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const { weddingId } = await params
  if (!weddingId) return badRequest('missing weddingId')

  const wedding = await loadWeddingForVenue(weddingId, auth.venueId)
  if (!wedding) return forbidden('wedding not in venue scope')

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('wedding_relationships')
    .select(
      'id, full_name, relationship_role, detail, email, phone, source, ' +
        'source_interaction_id, confidence, is_active, archived_at, ' +
        'added_by, created_at, updated_at',
    )
    .eq('wedding_id', weddingId)
    .eq('venue_id', auth.venueId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    const msg = (error as { message?: string }).message ?? ''
    // Pre-mig-255 fallback. Wave 2D ships before Phase 2 capture so
    // the table may be empty — but the migration itself should already
    // have been applied to land mig 255. If the migration hasn't shipped
    // yet, treat it as an empty list rather than a 500.
    if (/relation .* does not exist/i.test(msg) || /could not find the table/i.test(msg)) {
      return NextResponse.json({ rows: [] })
    }
    return NextResponse.json({ error: msg || 'query failed' }, { status: 500 })
  }

  return NextResponse.json({ rows: data ?? [] })
}

// ---------------------------------------------------------------------------
// POST — coordinator-typed addition
// ---------------------------------------------------------------------------

interface PostBody {
  full_name?: string
  relationship_role?: string
  detail?: string
  email?: string
  phone?: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (auth.isDemo) return forbidden('demo cannot add relationships')

  const { weddingId } = await params
  if (!weddingId) return badRequest('missing weddingId')

  const wedding = await loadWeddingForVenue(weddingId, auth.venueId)
  if (!wedding) return forbidden('wedding not in venue scope')

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return badRequest('invalid JSON body')
  }

  const fullName = (body.full_name ?? '').trim().slice(0, 200)
  if (!fullName) return badRequest('full_name is required')

  const role = (body.relationship_role ?? '').trim()
  if (!ALLOWED_ROLES.has(role)) {
    return badRequest('relationship_role must be one of: ' + Array.from(ALLOWED_ROLES).join(', '))
  }

  const detail = body.detail ? body.detail.trim().slice(0, 200) : null
  const email = body.email ? body.email.trim().slice(0, 200) : null
  const phone = body.phone ? body.phone.trim().slice(0, 60) : null

  const supabase = createServiceClient()
  const { data: inserted, error } = await supabase
    .from('wedding_relationships')
    .insert({
      venue_id: auth.venueId,
      wedding_id: weddingId,
      full_name: fullName,
      relationship_role: role,
      detail,
      email,
      phone,
      source: 'coordinator_added',
      confidence: null,
      added_by: auth.userId,
    })
    .select(
      'id, full_name, relationship_role, detail, email, phone, source, ' +
        'confidence, is_active, created_at',
    )
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  logEvent({
    level: 'info',
    msg: 'identity.relationship_added',
    venueId: auth.venueId,
    actor: `user:${auth.userId}`,
    event_type: 'identity.relationship_added',
    outcome: 'ok',
    data: {
      wedding_id: weddingId,
      role,
    },
  })

  return NextResponse.json({ ok: true, row: inserted })
}

// ---------------------------------------------------------------------------
// PATCH — archive / unarchive
// ---------------------------------------------------------------------------

interface PatchBody {
  id?: string
  action?: 'archive' | 'unarchive'
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (auth.isDemo) return forbidden('demo cannot modify relationships')

  const { weddingId } = await params
  if (!weddingId) return badRequest('missing weddingId')

  const wedding = await loadWeddingForVenue(weddingId, auth.venueId)
  if (!wedding) return forbidden('wedding not in venue scope')

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return badRequest('invalid JSON body')
  }
  if (!body.id) return badRequest('id is required')
  if (!body.action || !['archive', 'unarchive'].includes(body.action)) {
    return badRequest('action must be archive | unarchive')
  }

  const supabase = createServiceClient()
  const { data: row } = await supabase
    .from('wedding_relationships')
    .select('id, venue_id, wedding_id')
    .eq('id', body.id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'row not found' }, { status: 404 })
  if (row.venue_id !== auth.venueId || row.wedding_id !== weddingId) {
    return forbidden('row not in scope')
  }

  const patch: Record<string, unknown> =
    body.action === 'archive'
      ? {
          is_active: false,
          archived_at: new Date().toISOString(),
          archived_by: auth.userId,
        }
      : {
          is_active: true,
          archived_at: null,
          archived_by: null,
        }

  const { error } = await supabase
    .from('wedding_relationships')
    .update(patch)
    .eq('id', body.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
