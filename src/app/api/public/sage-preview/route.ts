import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import { buildCouplePrompt } from '@/lib/ai/couple-prompt'
import { checkRateLimit } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'

// ---------------------------------------------------------------------------
// POST /api/public/sage-preview — Public Sage preview chat (no auth)
// Body: { venueSlug, message }
// Returns: { response, messageCount }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // GAP-H3: IP-based rate limit — 30 requests per hour per IP. This endpoint
  // is unauthenticated; without a limit, scripted abuse can drain AI budget.
  const ip = clientIpForRateLimit(request)
  const rl = await checkRateLimit({
    key: `sage-preview:${ip}`,
    limit: 30,
    windowSec: 3600,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: {
          'Retry-After': String(
            Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000),
          ),
        },
      },
    )
  }

  try {
    const body = await request.json()
    const { venueSlug, message } = body

    if (!venueSlug || typeof venueSlug !== 'string') {
      return NextResponse.json(
        { error: 'venueSlug is required' },
        { status: 400 }
      )
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json(
        { error: 'message is required' },
        { status: 400 }
      )
    }

    if (message.trim().length > 500) {
      return NextResponse.json(
        { error: 'Message too long (max 500 characters)' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // -----------------------------------------------------------------------
    // 1. Look up venue by slug (public — no auth needed)
    // -----------------------------------------------------------------------

    const { data: venue } = await supabase
      .from('venues')
      .select('id, name, slug')
      .eq('slug', venueSlug)
      .single()

    if (!venue) {
      return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
    }

    // -----------------------------------------------------------------------
    // 2. T5-β.1: refuse to render the preview if the venue hasn't named
    //    their AI yet. Friendlier than letting buildCouplePrompt throw —
    //    a public-facing chat speaking as "Sage" from another venue's
    //    brand is the failure mode this guard prevents.
    // -----------------------------------------------------------------------

    const { data: aiConfigCheck } = await supabase
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venue.id)
      .single()
    const resolvedAiName = (aiConfigCheck?.ai_name as string | null | undefined)?.trim()
    if (!resolvedAiName) {
      return NextResponse.json(
        {
          error:
            'This venue has not configured an AI assistant name yet. Try again after onboarding.',
        },
        { status: 400 }
      )
    }

    // -----------------------------------------------------------------------
    // 3. Build the preview prompt via the canonical couple-facing
    //    assembler. No weddingId (public, pre-signup) so the prompt is
    //    venue-voice + UNIVERSAL_RULES + COUPLE_RULES + preview task
    //    framing. The assembler picks up the venue's USPs, sign-off,
    //    voice prefs, and tour booking links from venue_ai_config —
    //    pre-fix this preview rebuilt those inline and skipped
    //    UNIVERSAL_RULES entirely.
    // -----------------------------------------------------------------------

    const built = await buildCouplePrompt({
      venueId: venue.id,
      weddingId: null,
      fileContext: null,
      task: 'preview',
      taskInstructions:
        'Answer the prospective couple in 2-3 sentences. You do not have specific pricing, availability, or detailed policy data. For those, gently encourage booking a tour or signing up for full access.',
    })

    // -----------------------------------------------------------------------
    // 4. Call AI
    // -----------------------------------------------------------------------

    const aiResult = await callAI({
      systemPrompt: built.systemPrompt,
      userPrompt: message.trim(),
      maxTokens: 300,
      temperature: 0.4,
      venueId: venue.id,
      taskType: 'sage_preview_chat',
      contentTier: built.contentTier,
      promptVersion: built.promptVersion,
    })

    // -----------------------------------------------------------------------
    // 5. Return response (no DB save — preview only)
    // -----------------------------------------------------------------------

    return NextResponse.json({
      response: aiResult.text,
      messageCount: 1, // Client tracks total count
    })
  } catch (err) {
    console.error('[api/public/sage-preview] POST error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
