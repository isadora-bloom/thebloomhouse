import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/portal/kb
// Table: knowledge_base (id, venue_id, category, question, answer, keywords,
//        priority, is_active, created_at, updated_at)
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)

    const category = searchParams.get('category')
    const search = searchParams.get('search')
    const active = searchParams.get('active')

    let query = supabase
      .from('knowledge_base')
      .select('*')
      .eq('venue_id', auth.venueId)

    if (category) {
      query = query.eq('category', category)
    }

    if (active === 'true') {
      query = query.eq('is_active', true)
    } else if (active === 'false') {
      query = query.eq('is_active', false)
    }

    if (search) {
      query = query.or(`question.ilike.%${search}%,answer.ilike.%${search}%`)
    }

    query = query
      .order('priority', { ascending: false })
      .order('category', { ascending: true })

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ data: data ?? [] })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST ----
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { category, question, answer, keywords, priority, is_active } = body

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return badRequest('question is required')
    }
    if (!answer || typeof answer !== 'string' || answer.trim().length === 0) {
      return badRequest('answer is required')
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('knowledge_base')
      .insert({
        venue_id: auth.venueId,
        category: category ?? null,
        question: question.trim(),
        answer: answer.trim(),
        keywords: keywords ?? [],
        priority: priority ?? 0,
        is_active: is_active ?? true,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    return serverError(error)
  }
}

// ---- PATCH ----
export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id, ...fields } = body as Record<string, unknown>
    if (!id || typeof id !== 'string') return badRequest('id is required')

    const allowed = ['category', 'question', 'answer', 'keywords', 'priority', 'is_active'] as const
    const updates: Record<string, unknown> = {}

    for (const key of allowed) {
      if (key in fields) {
        updates[key] = fields[key]
      }
    }

    if (Object.keys(updates).length === 0) {
      return badRequest('No valid fields to update')
    }

    updates.updated_at = new Date().toISOString()

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('knowledge_base')
      .update(updates)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (error) {
    return serverError(error)
  }
}

// ---- DELETE ----
export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query parameter is required')

    const supabase = createServiceClient()

    const { error } = await supabase
      .from('knowledge_base')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (error) {
    return serverError(error)
  }
}
