import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  extractReviewLanguage,
  getApprovedPhrases,
  getTopPhrases,
  approvePhraseForSage,
  approvePhraseForMarketing,
} from '@/lib/services/intel/review-language'
import { refuseDemo, getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// GET — Review phrases for the venue
//   ?approved=sage|marketing  for filtered approved phrases
//   ?top=true                 for top phrases by frequency
//   Default: all phrases
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const approved = searchParams.get('approved')
    const top = searchParams.get('top') === 'true'

    // Return approved phrases filtered by context
    if (approved === 'sage' || approved === 'marketing') {
      const phrases = await getApprovedPhrases(auth.venueId, approved)
      return NextResponse.json({ phrases })
    }

    // Return top phrases by frequency
    if (top) {
      const phrases = await getTopPhrases(auth.venueId)
      return NextResponse.json({ phrases })
    }

    // Default: return all phrases for the venue
    const supabase = await createServerSupabaseClient()
    const { data: phrases, error } = await supabase
      .from('review_language')
      .select('*, venues:venue_id(name)')
      .eq('venue_id', auth.venueId)
      .order('frequency', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ phrases: phrases ?? [] })
  } catch (err) {
    console.error('[api/intel/reviews] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Extract language from a new review
//   Body: { text: string, rating?: number }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The demo identity is an anonymous visitor. It may look; it may not write.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal

  try {
    const body = await request.json()
    const { text, rating } = body

    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid review text' },
        { status: 400 }
      )
    }

    const phrases = await extractReviewLanguage(auth.venueId, text, rating)
    return NextResponse.json({ phrases })
  } catch (err) {
    console.error('[api/intel/reviews] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PATCH — Approve a phrase for a given context
//   Body: { phraseId: string, context: 'sage' | 'marketing' }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The demo identity is an anonymous visitor. It may look; it may not write.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal

  try {
    const body = await request.json()
    const { phraseId, context } = body

    if (!phraseId || typeof phraseId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid phraseId' },
        { status: 400 }
      )
    }

    if (context !== 'sage' && context !== 'marketing') {
      return NextResponse.json(
        { error: 'Invalid context. Must be "sage" or "marketing".' },
        { status: 400 }
      )
    }

    // The venue comes from the session, never the body. 2026-09-14 review,
    // item 8: pre-fix the phrase id was the only thing scoping the write.
    if (context === 'sage') {
      await approvePhraseForSage(auth.venueId, phraseId)
    } else {
      await approvePhraseForMarketing(auth.venueId, phraseId)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[api/intel/reviews] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
