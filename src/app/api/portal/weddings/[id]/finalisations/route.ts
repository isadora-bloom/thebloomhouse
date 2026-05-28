import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

/**
 * Coordinator-only API for managing per-section staff sign-off.
 *
 * 2026-05-26. Pairs with the couple-side MarkSectionCompleteBar and
 * sidebar dots. Schema (mig 009) already supports two roles signing
 * off on each section (couple_signed_off, staff_signed_off). This
 * endpoint surfaces the staff column, which had no UI before.
 *
 * GET  — list every finalisation row for the wedding
 * POST — toggle a single section's staff_signed_off
 *
 * Couples never hit this endpoint; their own toggle lives on the
 * couple-side MarkSectionCompleteBar via the browser supabase client.
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
      .from('section_finalisations')
      .select('id, section_name, couple_signed_off, couple_signed_off_at, staff_signed_off, staff_signed_off_at, staff_signed_off_by')
      .eq('wedding_id', weddingId)

    if (error) throw error
    return NextResponse.json({ finalisations: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — toggle staff sign-off for a single section
// Body: { section_name: string, staff_signed_off: boolean }
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Params) {
  const { id: weddingId } = await params
  try {
    const result = await authorise(weddingId)
    if (result.error) return result.error
    const { auth, supabase, venueId } = result

    const body = await req.json().catch(() => null)
    const sectionName = body && typeof body.section_name === 'string' ? body.section_name.trim() : ''
    const desiredState = body?.staff_signed_off === true

    // Same regex couples use; matches section_finalisations.section_name
    // free-text in mig 009 but tighter so a malicious payload can't
    // jam a 10k-char string in.
    if (!/^[a-z0-9_-]{1,60}$/.test(sectionName)) {
      return badRequest('section_name is required and must match [a-z0-9_-]{1,60}')
    }

    const nowIso = new Date().toISOString()

    // Upsert keyed by (wedding_id, section_name) thanks to mig 372.
    // If the row exists (couple may have signed off first), we only
    // touch the staff_* columns. If it doesn't exist, we create with
    // staff fields set and couple fields null.
    const { data, error } = await supabase!
      .from('section_finalisations')
      .upsert(
        {
          venue_id: venueId,
          wedding_id: weddingId,
          section_name: sectionName,
          staff_signed_off: desiredState,
          staff_signed_off_at: desiredState ? nowIso : null,
          staff_signed_off_by: desiredState ? auth!.userId : null,
        },
        { onConflict: 'wedding_id,section_name' }
      )
      .select('id, section_name, couple_signed_off, couple_signed_off_at, staff_signed_off, staff_signed_off_at, staff_signed_off_by')
      .single()

    if (error) throw error
    return NextResponse.json({ finalisation: data })
  } catch (err) {
    return serverError(err)
  }
}
