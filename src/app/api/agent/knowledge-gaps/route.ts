import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List knowledge gaps for venue
//   ?status=open|resolved  (default: all)
//   Order by frequency desc
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const supabase = createServiceClient()

    let query = supabase
      .from('knowledge_gaps')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('frequency', { ascending: false })

    if (status === 'open' || status === 'resolved') {
      query = query.eq('status', status)
    }

    const { data, error } = await query

    if (error) throw error
    return NextResponse.json({ gaps: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Add knowledge gap resolution to knowledge base
//   ?action=add_to_kb  Body: { id }
//   Reads the gap, creates a knowledge_base entry, marks gap resolved
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const body = await request.json()
    const supabase = createServiceClient()

    if (searchParams.get('action') !== 'add_to_kb') {
      return badRequest('Unknown action. Use ?action=add_to_kb')
    }

    const { id } = body
    if (!id || typeof id !== 'string') {
      return badRequest('Missing or invalid id')
    }

    // Fetch the gap
    const { data: gap, error: gapError } = await supabase
      .from('knowledge_gaps')
      .select('*')
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .single()

    if (gapError || !gap) {
      return badRequest('Knowledge gap not found')
    }

    if (!gap.resolution) {
      return badRequest('Gap has no resolution to add to knowledge base')
    }

    // Create knowledge base entry
    const { error: kbError } = await supabase
      .from('knowledge_base')
      .insert({
        venue_id: auth.venueId,
        category: gap.category ?? 'general',
        question: gap.question,
        answer: gap.resolution,
        is_active: true,
      })

    if (kbError) throw kbError

    // Mark gap as resolved
    const { data: updated, error: updateError } = await supabase
      .from('knowledge_gaps')
      .update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (updateError) throw updateError

    return NextResponse.json({ success: true, gap: updated })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Resolve a knowledge gap
//   Body: { id, resolution }
//   Sets status='resolved', resolution, resolved_at=now()
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id, resolution } = body

    if (!id || typeof id !== 'string') {
      return badRequest('Missing or invalid id')
    }
    if (!resolution || typeof resolution !== 'string') {
      return badRequest('Missing or invalid resolution')
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('knowledge_gaps')
      .update({
        status: 'resolved',
        resolution,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ gap: data })
  } catch (err) {
    return serverError(err)
  }
}
