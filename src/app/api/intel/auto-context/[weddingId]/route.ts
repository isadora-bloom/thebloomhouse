/**
 * Wedding-scoped auto-context note feed (migration 253).
 *
 * GET    /api/intel/auto-context/[weddingId]
 *   Returns active notes (pinned-first, then most-recent) plus a
 *   "what was learned this week" rollup of the last 7 days.
 *
 * POST   /api/intel/auto-context/[weddingId]
 *   Body: { body: string, category?: string, pinned?: boolean }
 *   Coordinator-typed note. Lands as source='coordinator_added'.
 *
 * PATCH  /api/intel/auto-context/[weddingId]
 *   Body: { id: string, action: 'pin' | 'unpin' | 'archive' | 'unarchive' }
 *   Pin/archive flips. Forensic invariant: archive sets is_active=false,
 *   never DELETE. Coordinator can unarchive by un-flipping.
 *
 * Auth: getPlatformAuth — venue-scoped. Caller may only touch their
 * venue's notes. Demo cookie can read demo-set notes via standard
 * platform-auth path.
 *
 * 2026-05-09 user mandate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

interface NoteRow {
  id: string
  body: string
  category: string | null
  source: string
  source_interaction_id: string | null
  confidence: number | null
  pinned: boolean
  is_active: boolean
  created_at: string
  archived_at: string | null
  // Wave 2D (mig 255). Forward-compatible: legacy DBs read NULL here
  // and the panel treats both columns as "no special handling".
  sensitive?: boolean | null
  expires_at?: string | null
}

async function loadWeddingForVenue(weddingId: string, venueId: string) {
  const supabase = createServiceClient()
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, venue_id, merged_into_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) return null
  if (wedding.venue_id !== venueId) return null
  return wedding as { id: string; venue_id: string; merged_into_id: string | null }
}

// ---------------------------------------------------------------------------
// GET — list active notes + 7-day rollup
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

  // Active notes — pinned-first, most-recent. Cap at 20 for the surface
  // (matches the brief's "most-recent 20 active"). Wave 2D extends the
  // select to include the mig-255 columns (sensitive, expires_at) so
  // the panel can render lock badges + the expired-archive section. We
  // fall back to the legacy shape when those columns aren't deployed
  // yet — the panel renders fine on either side of the migration.
  let activeRows: Array<Record<string, unknown>> = []
  const fullSelect =
    'id, body, category, source, source_interaction_id, confidence, ' +
    'pinned, is_active, created_at, archived_at, sensitive, expires_at'
  const fullRes = await supabase
    .from('wedding_auto_context')
    .select(fullSelect)
    .eq('wedding_id', weddingId)
    .eq('is_active', true)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(40)
  if (fullRes.error) {
    const msg = (fullRes.error as { message?: string }).message ?? ''
    if (/column .* does not exist/i.test(msg)) {
      const legacy = await supabase
        .from('wedding_auto_context')
        .select(
          'id, body, category, source, source_interaction_id, confidence, pinned, is_active, created_at, archived_at',
        )
        .eq('wedding_id', weddingId)
        .eq('is_active', true)
        .order('pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(40)
      activeRows = ((legacy.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        sensitive: false,
        expires_at: null,
      }))
    }
  } else {
    activeRows = (fullRes.data ?? []) as unknown as Array<Record<string, unknown>>
  }

  // 7-day rollup of NEW (not just active) notes added in the last week,
  // for the "What was learned this week" surface. Includes archived
  // ones in the count so the coordinator sees "AI surfaced 12 things,
  // you archived 4".
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: weekRows } = await supabase
    .from('wedding_auto_context')
    .select('id, body, category, source, is_active, created_at')
    .eq('wedding_id', weddingId)
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(50)

  // Last-enriched timestamp (cheap signal for the UI).
  const { data: lastRunRows } = await supabase
    .from('profile_enrichment_runs')
    .select('created_at, fields_updated_count, notes_added_count, trigger')
    .eq('wedding_id', weddingId)
    .order('created_at', { ascending: false })
    .limit(1)

  return NextResponse.json({
    notes: (activeRows ?? []) as unknown as NoteRow[],
    weekRollup: weekRows ?? [],
    lastEnrichedAt: lastRunRows?.[0]?.created_at ?? null,
    lastEnrichedTrigger: lastRunRows?.[0]?.trigger ?? null,
  })
}

// ---------------------------------------------------------------------------
// POST — coordinator-typed note
// ---------------------------------------------------------------------------

interface PostBody {
  body?: string
  category?: string
  pinned?: boolean
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (auth.isDemo) return forbidden('demo cannot write to auto-context')

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

  const text = (body.body ?? '').trim()
  if (!text) return badRequest('body is required')
  if (text.length > 1000) return badRequest('body must be 1000 chars or fewer')

  const category = (body.category ?? 'misc').toString().trim().slice(0, 40) || 'misc'

  const supabase = createServiceClient()
  const { data: inserted, error } = await supabase
    .from('wedding_auto_context')
    .insert({
      venue_id: auth.venueId,
      wedding_id: weddingId,
      body: text,
      category,
      source: 'coordinator_added',
      pinned: body.pinned === true,
      added_by: auth.userId,
      // Coordinator-typed notes carry no AI confidence — leave NULL.
      confidence: null,
    })
    .select('id, body, category, source, pinned, is_active, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, note: inserted })
}

// ---------------------------------------------------------------------------
// PATCH — pin / unpin / archive / unarchive
// ---------------------------------------------------------------------------

interface PatchBody {
  id?: string
  action?: 'pin' | 'unpin' | 'archive' | 'unarchive'
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (auth.isDemo) return forbidden('demo cannot modify auto-context')

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
  if (!body.action || !['pin', 'unpin', 'archive', 'unarchive'].includes(body.action)) {
    return badRequest('action must be pin | unpin | archive | unarchive')
  }

  const supabase = createServiceClient()

  // Defensive scope check — make sure the row belongs to the same
  // wedding/venue. Belt + RLS suspenders.
  const { data: row } = await supabase
    .from('wedding_auto_context')
    .select('id, venue_id, wedding_id')
    .eq('id', body.id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'note not found' }, { status: 404 })
  if (row.venue_id !== auth.venueId || row.wedding_id !== weddingId) {
    return forbidden('note not in scope')
  }

  const patch: Record<string, unknown> = {}
  switch (body.action) {
    case 'pin':
      patch.pinned = true
      break
    case 'unpin':
      patch.pinned = false
      break
    case 'archive':
      patch.is_active = false
      patch.archived_at = new Date().toISOString()
      patch.archived_by = auth.userId
      break
    case 'unarchive':
      patch.is_active = true
      patch.archived_at = null
      patch.archived_by = null
      break
  }

  const { error } = await supabase
    .from('wedding_auto_context')
    .update(patch)
    .eq('id', body.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
