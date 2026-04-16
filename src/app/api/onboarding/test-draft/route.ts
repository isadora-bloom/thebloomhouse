import { NextRequest, NextResponse } from 'next/server'
import { callAI } from '@/lib/ai/client'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// POST — Generate a test draft using the venue's personality settings + KB
//   Body: {
//     venueName: string,
//     personality: { warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level },
//     faqs: Array<{ question: string, answer: string }>,
//     mockInquiry: string,
//   }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { venueName, personality, faqs, mockInquiry } = body

    if (!mockInquiry || typeof mockInquiry !== 'string') {
      return NextResponse.json(
        { error: 'Missing mockInquiry in request body' },
        { status: 400 }
      )
    }

    // Build a lightweight personality prompt from the onboarding settings
    const warmth = personality?.warmth_level ?? 7
    const formality = personality?.formality_level ?? 4
    const playfulness = personality?.playfulness_level ?? 5
    const brevity = personality?.brevity_level ?? 6
    const enthusiasm = personality?.enthusiasm_level ?? 6

    const warmthDesc =
      warmth >= 8 ? 'very warm and friendly' :
      warmth >= 6 ? 'friendly and approachable' :
      warmth >= 4 ? 'pleasant and professional' :
      'reserved and formal'

    const formalityDesc =
      formality >= 8 ? 'formal and elegant' :
      formality >= 6 ? 'professional and polished' :
      formality >= 4 ? 'conversational but professional' :
      'casual and relaxed'

    const energyDesc =
      enthusiasm >= 7 ? 'High enthusiasm — genuinely excited' :
      enthusiasm >= 4 ? 'Calm and grounded — warm but not over the top' :
      'Understated and composed'

    const brevityDesc =
      brevity >= 7 ? 'Keep it concise' :
      brevity >= 4 ? 'Balanced — thorough but not overwhelming' :
      'Elaborate when it adds warmth'

    const playDesc =
      playfulness >= 7 ? 'Playful and fun — feel free to be lighthearted' :
      playfulness >= 4 ? 'Warm with gentle humor when appropriate' :
      'Straightforward and professional'

    // Build KB context
    const kbContext = (faqs ?? [])
      .filter((f: { question: string; answer: string }) => f.question?.trim() && f.answer?.trim())
      .map((f: { question: string; answer: string }) => `Q: ${f.question}\nA: ${f.answer}`)
      .join('\n\n')

    const systemPrompt = `You are an AI assistant for "${venueName || 'this wedding venue'}". You draft email responses to inquiries.

## YOUR VOICE
- Tone: ${warmthDesc}, ${formalityDesc}
- Energy: ${energyDesc}
- Brevity: ${brevityDesc}
- Style: ${playDesc}

## RULES
- Write a natural email response to the inquiry below
- Be helpful and answer any questions you can from the knowledge base
- Keep it to 1-3 short paragraphs
- If you don't know something, offer to find out
- Sign off warmly

${kbContext ? `## KNOWLEDGE BASE\n${kbContext}` : ''}`

    const result = await callAI({
      systemPrompt,
      userPrompt: `Please draft a response to this inquiry:\n\n${mockInquiry}`,
      maxTokens: 800,
      temperature: 0.6,
      venueId: auth.venueId,
      taskType: 'onboarding_test_draft',
    })

    return NextResponse.json({ draft: result.text })
  } catch (err) {
    console.error('[api/onboarding/test-draft] POST error:', err)
    return NextResponse.json({ error: 'Failed to generate test draft' }, { status: 500 })
  }
}
