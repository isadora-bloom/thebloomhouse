import { NextRequest, NextResponse } from 'next/server'
import {
  answerNaturalLanguageQuery,
  markQueryHelpful,
} from '@/lib/services/intel-brain'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// POST -- Answer a natural language query
//   Body: { query: string }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
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
  const auth = await getPlatformAuth()
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
