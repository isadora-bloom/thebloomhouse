import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  answerNaturalLanguageQuery,
  markQueryHelpful,
} from '@/lib/services/intel-brain'

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function getAuthVenue() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('venue_id')
    .eq('id', user.id)
    .single()

  return profile?.venue_id
    ? { userId: user.id, venueId: profile.venue_id as string }
    : null
}

// ---------------------------------------------------------------------------
// POST -- Answer a natural language query
//   Body: { query: string }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { query } = body

    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid query' },
        { status: 400 }
      )
    }

    const result = await answerNaturalLanguageQuery(
      auth.venueId,
      auth.userId,
      query.trim()
    )

    return NextResponse.json({
      response: result.response,
      queryId: result.queryId,
      tokensUsed: result.tokensUsed,
      cost: result.cost,
    })
  } catch (err) {
    console.error('[api/intel/nlq] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PATCH -- Mark a query as helpful or not
//   Body: { queryId: string, helpful: boolean }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { queryId, helpful } = body

    if (!queryId || typeof queryId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid queryId' },
        { status: 400 }
      )
    }

    if (typeof helpful !== 'boolean') {
      return NextResponse.json(
        { error: 'Missing or invalid helpful flag' },
        { status: 400 }
      )
    }

    await markQueryHelpful(queryId, helpful)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[api/intel/nlq] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
