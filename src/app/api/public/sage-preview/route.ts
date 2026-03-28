import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// POST /api/public/sage-preview — Public Sage preview chat (no auth)
// Body: { venueSlug, message }
// Returns: { response, messageCount }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
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
    // 2. Load venue personality config + basic info only
    // -----------------------------------------------------------------------

    const [aiConfigResult, venueConfigResult, uspsResult] = await Promise.all([
      supabase
        .from('venue_ai_config')
        .select('ai_name, ai_emoji, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level, uses_contractions, uses_exclamation_points, emoji_level, phrase_style, vibe, signature_expressions, signature_greeting')
        .eq('venue_id', venue.id)
        .single(),
      supabase
        .from('venue_config')
        .select('website_url, phone_number, tour_booking_url, primary_color')
        .eq('venue_id', venue.id)
        .single(),
      supabase
        .from('venue_usps')
        .select('usp_text')
        .eq('venue_id', venue.id)
        .eq('is_active', true)
        .order('sort_order')
        .limit(5),
    ])

    const aiConfig = aiConfigResult.data
    const venueConfig = venueConfigResult.data
    const usps = (uspsResult.data || []).map((u) => u.usp_text)
    const aiName = aiConfig?.ai_name || 'Sage'
    const aiEmoji = aiConfig?.ai_emoji || ''

    // -----------------------------------------------------------------------
    // 3. Build simplified preview system prompt
    // -----------------------------------------------------------------------

    const warmthDesc = aiConfig?.warmth_level && aiConfig.warmth_level >= 7
      ? 'warm and friendly'
      : aiConfig?.warmth_level && aiConfig.warmth_level >= 4
        ? 'pleasant and helpful'
        : 'professional'

    const uspsSection = usps.length > 0
      ? `\n## ABOUT THE VENUE\n${usps.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n`
      : ''

    const systemPrompt = `## YOUR IDENTITY: ${aiName} ${aiEmoji}

You are **${aiName}**, the AI wedding planning assistant for **${venue.name}**.
You are helping a prospective couple learn about the venue through a preview chat.

## YOUR VOICE
- Tone: ${warmthDesc}
- Keep responses concise: 2-3 sentences maximum
- Be genuinely helpful within your limited scope
${aiConfig?.uses_contractions !== false ? '- Use contractions naturally' : '- Avoid contractions'}
${aiConfig?.uses_exclamation_points !== false ? '- Use exclamation points sparingly to convey warmth' : '- Keep punctuation understated'}

## WHAT YOU CAN DO
- Answer general questions about the venue using the info below
- Share what makes this venue special (USPs)
- Give a warm, inviting sense of the venue experience
- Encourage them to book a tour or sign up for more details
${uspsSection}
## VENUE BASICS
- Name: ${venue.name}
${venueConfig?.website_url ? `- Website: ${venueConfig.website_url}` : ''}
${venueConfig?.phone_number ? `- Phone: ${venueConfig.phone_number}` : ''}
${venueConfig?.tour_booking_url ? `- Book a tour: ${venueConfig.tour_booking_url}` : ''}

## WHAT YOU CANNOT DO
- You do NOT have access to specific pricing, availability, or detailed policies
- You cannot look up dates or check availability
- You cannot provide quotes or detailed cost breakdowns
- If asked about these, kindly explain you are a preview assistant and encourage them to book a tour or sign up for full access

## IMPORTANT RULES
- You are transparent about being an AI assistant
- Never fabricate details you do not have
- If unsure, say so honestly and point them to booking a tour
- This is a preview — gently encourage signing up or booking a tour for the full experience`

    // -----------------------------------------------------------------------
    // 4. Call AI
    // -----------------------------------------------------------------------

    const aiResult = await callAI({
      systemPrompt,
      userPrompt: message.trim(),
      maxTokens: 300,
      temperature: 0.4,
      venueId: venue.id,
      taskType: 'sage_preview_chat',
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
