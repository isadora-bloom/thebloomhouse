import { NextRequest, NextResponse } from 'next/server'
import {
  answerNaturalLanguageQuery,
  markQueryHelpful,
} from '@/lib/services/intel-brain'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { rateLimit, secondsUntil } from '@/lib/rate-limit'

// ---------------------------------------------------------------------------
// Rate limit for NLQ (more expensive than Sage chat): 10 requests per 15
// minutes per user. Persistent across cold starts via Supabase (BUG-12).
// ---------------------------------------------------------------------------

const NLQ_RATE_LIMIT = 10 // max requests per window
const NLQ_RATE_WINDOW_SEC = 15 * 60 // 15 minutes

// ---------------------------------------------------------------------------
// POST -- Answer a natural language query
//   Body: { query: string }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit by user ID (authenticated endpoint)
  const rl = await rateLimit(`nlq:${auth.userId}`, {
    limit: NLQ_RATE_LIMIT,
    windowSec: NLQ_RATE_WINDOW_SEC,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many queries. Please wait a few minutes before asking another question.' },
      {
        status: 429,
        headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) },
      }
    )
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
