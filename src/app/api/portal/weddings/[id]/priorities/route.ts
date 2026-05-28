import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

/**
 * Coordinator-only API for managing a couple's section priorities.
 *
 * Couples cannot self-flag — the only write surface is this endpoint,
 * gated by platform auth. The supabase service-client bypasses RLS
 * so the wedding_priorities couple-write policy stays absent.
 *
 * GET    — list current priorities for the wedding
 * POST   — replace the priority set { items: [{ section_slug, sort_order?, note? }] }
 * DELETE — remove a single priority by section_slug
 */

interface Params {
  params: Promise<{ id: string }>
}

async function authorise(weddingId: string) {
  const auth = await getPlatformAuth()
  if (!auth) return { error: unauthorized(), auth: null }

  const supabase = createServiceClient()
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .eq('id', weddingId)
    .maybeSingle()

  if (!wedding) {
    return { error: NextResponse.json({ error: 'Wedding not found' }, { status: 404 }), auth: null }
  }

  // Coordinator must belong to the wedding's venue. Org-admins and
  // super-admins pass through automatically when their venueId
  // matches (rare cross-venue access goes via super_admin).
  if (auth.venueId !== wedding.venue_id && auth.role !== 'super_admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }), auth: null }
  }

  return { error: null, auth, supabase, venueId: wedding.venue_id as string }
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Params) {
  const { id: weddingId } = await params
  try {
    const result = await authorise(weddingId)
    if (result.error) return result.error
    const { supabase } = result

    const { data, error } = await supabase!
      .from('wedding_priorities')
      .select('id, section_slug, sort_order, note, created_at, updated_at')
      .eq('wedding_id', weddingId)
      .order('sort_order', { ascending: true })

    if (error) throw error
    return NextResponse.json({ priorities: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — replace the whole set
// Body: { items: [{ section_slug: string, sort_order?: number, note?: string|null }] }
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: weddingId } = await params
  try {
    const result = await authorise(weddingId)
    if (result.error) return result.error
    const { auth, supabase, venueId } = result

    const body = await req.json().catch(() => null)
    if (!body || !Array.isArray(body.items)) return badRequest('items array is required')

    // Sanitise + cap. 8 priorities max — coordinators shouldn't flag
    // the whole sidebar; the whole point is "what to work on next".
    const SLUG_RE = /^[a-z0-9-]{1,40}$/
    const items = (body.items as Array<{ section_slug?: unknown; sort_order?: unknown; note?: unknown }>)
      .map((raw, idx) => {
        const slug = typeof raw.section_slug === 'string' ? raw.section_slug.trim() : ''
        if (!SLUG_RE.test(slug)) return null
        const sortOrder = typeof raw.sort_order === 'number' && Number.isFinite(raw.sort_order)
          ? Math.trunc(raw.sort_order)
          : idx
        const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) || null : null
        return { section_slug: slug, sort_order: sortOrder, note }
      })
      .filter((v): v is { section_slug: string; sort_order: number; note: string | null } => v !== null)
      .slice(0, 8)

    // Dedupe by slug (last occurrence wins via Map)
    const dedup = new Map<string, typeof items[number]>()
    for (const i of items) dedup.set(i.section_slug, i)
    const finalItems = [...dedup.values()]

    // Replace strategy: wipe existing, insert new. Wrapped in a single
    // transaction would be ideal but supabase-js doesn't expose one
    // from the JS client. The race window between delete and insert
    // is narrow (sub-second). If a couple-side read lands mid-window
    // they see an empty list briefly — acceptable.
    const { error: delErr } = await supabase!
      .from('wedding_priorities')
      .delete()
      .eq('wedding_id', weddingId)
    if (delErr) throw delErr

    if (finalItems.length === 0) {
      return NextResponse.json({ priorities: [] })
    }

    const rows = finalItems.map((i) => ({
      venue_id: venueId,
      wedding_id: weddingId,
      section_slug: i.section_slug,
      sort_order: i.sort_order,
      note: i.note,
      created_by: auth!.userId,
      updated_at: new Date().toISOString(),
    }))

    const { data, error: insErr } = await supabase!
      .from('wedding_priorities')
      .insert(rows)
      .select('id, section_slug, sort_order, note, created_at, updated_at')

    if (insErr) throw insErr
    return NextResponse.json({ priorities: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// DELETE — remove one priority by section_slug
// Body: { section_slug: string }
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id: weddingId } = await params
  try {
    const result = await authorise(weddingId)
    if (result.error) return result.error
    const { supabase } = result

    const body = await req.json().catch(() => null)
    const slug = body && typeof body.section_slug === 'string' ? body.section_slug.trim() : ''
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) return badRequest('section_slug is required')

    const { error } = await supabase!
      .from('wedding_priorities')
      .delete()
      .eq('wedding_id', weddingId)
      .eq('section_slug', slug)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
