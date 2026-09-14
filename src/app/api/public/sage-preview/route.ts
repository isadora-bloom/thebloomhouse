import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import { buildCouplePrompt } from '@/lib/ai/couple-prompt'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { buildChatSignoff, withChatSignoff } from '@/lib/services/brain/sage'
import { apiError } from '@/lib/api/api-error'

// ---------------------------------------------------------------------------
// POST /api/public/sage-preview — Public Sage preview chat (no auth)
// Body: { venueSlug, message }
// Returns: { response, messageCount }
// ---------------------------------------------------------------------------

/** Per-IP limit. Unchanged from GAP-H3, but the key is now derived from a
 *  header the caller cannot write — see lib/security/client-ip.ts. */
const PREVIEW_IP_LIMIT = 30
const PREVIEW_IP_WINDOW_SEC = 3600

/**
 * Per-venue limit. 2026-09-14 security review, item 6.
 *
 * The IP limit alone bounds one caller. It does nothing about a hundred
 * callers, or one caller behind a rotating proxy pool, all pointed at the
 * same venueSlug — and the bill for that lands on the venue whose slug was
 * used, not on whoever made the calls. 300 messages an hour is far more
 * preview traffic than a marketing page has ever produced and still puts a
 * ceiling on what a single venue can be made to spend in a day.
 */
const PREVIEW_VENUE_LIMIT = 300
const PREVIEW_VENUE_WINDOW_SEC = 3600

export async function POST(request: NextRequest) {
  // GAP-H3: IP-based rate limit — 30 requests per hour per IP. This endpoint
  // is unauthenticated; without a limit, scripted abuse can drain AI budget.
  const ip = clientIpForRateLimit(request)
  const rl = await checkRateLimit({
    key: `sage-preview:${ip}`,
    limit: PREVIEW_IP_LIMIT,
    windowSec: PREVIEW_IP_WINDOW_SEC,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) },
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
      .select('id, name, slug, is_demo')
      .eq('slug', venueSlug)
      .single()

    if (!venue) {
      return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
    }

    // -----------------------------------------------------------------------
    // 1a. Published-preview gate. 2026-09-14 review, item 6.
    //
    // Any slug in the venues table would previously answer here, which
    // meant a venue that had signed up an hour ago and typed nothing yet
    // had a public chat endpoint spending money in its name, answering in
    // a half-configured voice. "Published" is defined from the flag that
    // already exists rather than a new one: a demo venue (migration 048's
    // venues.is_demo, which is what the marketing site's preview points
    // at) or a venue that has finished onboarding
    // (venue_config.onboarding_completed, same migration). Anything else
    // is a 404, the same answer an unknown slug gets, because whether a
    // given venue exists is not a public fact either.
    // -----------------------------------------------------------------------

    const { data: venueConfig } = await supabase
      .from('venue_config')
      .select('onboarding_completed')
      .eq('venue_id', venue.id)
      .maybeSingle()

    const published =
      venue.is_demo === true || venueConfig?.onboarding_completed === true
    if (!published) {
      return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
    }

    // -----------------------------------------------------------------------
    // 1b. Per-venue rate limit + cost ceiling. Both are about the venue's
    // bill rather than the caller's manners, so both key on the venue and
    // both run after the slug resolves.
    // -----------------------------------------------------------------------

    const venueRl = await checkRateLimit({
      key: `sage-preview-venue:${venue.id}`,
      limit: PREVIEW_VENUE_LIMIT,
      windowSec: PREVIEW_VENUE_WINDOW_SEC,
    })
    if (!venueRl.ok) {
      return NextResponse.json(
        { error: 'This venue’s preview is busy. Try again shortly.' },
        {
          status: 429,
          headers: { 'Retry-After': String(secondsUntil(venueRl.resetAt)) },
        },
      )
    }

    const gate = await gateForBrainCall(venue.id)
    if (!gate.ok) {
      return NextResponse.json(
        {
          error:
            'The preview is paused for this venue right now. Book a tour or get in touch and a person will answer.',
        },
        { status: 429 },
      )
    }

    // -----------------------------------------------------------------------
    // 2. T5-β.1: refuse to render the preview if the venue hasn't named
    //    their AI yet. Friendlier than letting buildCouplePrompt throw —
    //    a public-facing chat speaking as "Sage" from another venue's
    //    brand is the failure mode this guard prevents.
    // -----------------------------------------------------------------------

    const { data: aiConfigCheck } = await supabase
      .from('venue_ai_config')
      .select('ai_name, ai_role')
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
    // 5. Sign-off, then return (no DB save — preview only).
    //
    // 2026-09-14 review, item 4: this returned bare model text. A
    // prospective couple on a public marketing page had no indication they
    // were talking to an AI and no route to a person — the one surface
    // where the first is a legal requirement (EU AI Act Art. 50, CA SB
    // 1001) and the second is the point of the page. No coordinator name
    // is available pre-signup, so the sign-off degrades to "the team",
    // which buildChatSignoff already handles.
    // -----------------------------------------------------------------------

    const signoff = buildChatSignoff({
      aiName: resolvedAiName,
      venueName: (venue.name as string | null)?.trim() || 'the venue',
      aiRole: (aiConfigCheck?.ai_role as string | null | undefined) ?? null,
      coordinatorName: null,
    })
    const response = withChatSignoff(aiResult.text, signoff)

    return NextResponse.json({
      response,
      messageCount: 1, // Client tracks total count
    })
  } catch (err) {
    return apiError(err)
  }
}
