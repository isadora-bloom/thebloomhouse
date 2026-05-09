import { NextRequest, NextResponse } from 'next/server'
import { callAI } from '@/lib/ai/client'
import { buildCouplePrompt } from '@/lib/ai/couple-prompt'
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

  // Tier-C #128 — per-user rate limit. test-draft fires callAI on every
  // tweak of the personality sliders; tighter than steady-state APIs
  // because the UI invokes it interactively.
  const { checkRateLimit, secondsUntil } = await import('@/lib/rate-limit')
  const rl = await checkRateLimit({
    key: `onboarding-test-draft:${auth.userId}`,
    limit: 20,
    windowSec: 60,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many test drafts — wait a few seconds before trying again' },
      {
        status: 429,
        headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) },
      },
    )
  }

  try {
    const body = await request.json()
    const { personality, faqs, mockInquiry } = body

    if (!mockInquiry || typeof mockInquiry !== 'string') {
      return NextResponse.json(
        { error: 'Missing mockInquiry in request body' },
        { status: 400 }
      )
    }

    // In-flight dial values from the wizard form. These may differ from
    // the saved venue_ai_config row when the coordinator is mid-tweak;
    // we layer them on top of the saved personality as a "PREVIEW
    // OVERRIDES" block so the test draft reflects what the wizard
    // currently shows. The saved row still drives ai_name, sign-off,
    // banned phrases, USPs, etc.
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
      enthusiasm >= 7 ? 'High enthusiasm, genuinely excited' :
      enthusiasm >= 4 ? 'Calm and grounded, warm but not over the top' :
      'Understated and composed'

    const brevityDesc =
      brevity >= 7 ? 'Keep it concise' :
      brevity >= 4 ? 'Balanced, thorough but not overwhelming' :
      'Elaborate when it adds warmth'

    const playDesc =
      playfulness >= 7 ? 'Playful and fun, feel free to be lighthearted' :
      playfulness >= 4 ? 'Warm with gentle humor when appropriate' :
      'Straightforward and professional'

    // KB context from in-flight FAQs the coordinator is editing.
    const kbContext = (faqs ?? [])
      .filter((f: { question: string; answer: string }) => f.question?.trim() && f.answer?.trim())
      .map((f: { question: string; answer: string }) => `Q: ${f.question}\nA: ${f.answer}`)
      .join('\n\n')

    const taskInstructions = [
      'Draft a natural email response to the inquiry below. 1-3 short paragraphs. Sign off warmly.',
      '',
      '### PREVIEW DIAL OVERRIDES (in-flight wizard values)',
      `- Tone: ${warmthDesc}, ${formalityDesc}`,
      `- Energy: ${energyDesc}`,
      `- Brevity: ${brevityDesc}`,
      `- Style: ${playDesc}`,
      kbContext ? `\n### IN-FLIGHT KNOWLEDGE BASE\n${kbContext}` : '',
    ].filter(Boolean).join('\n')

    const built = await buildCouplePrompt({
      venueId: auth.venueId,
      weddingId: null,
      fileContext: null,
      task: 'onboarding_test_draft',
      taskInstructions,
    })

    const result = await callAI({
      systemPrompt: built.systemPrompt,
      userPrompt: `Please draft a response to this inquiry:\n\n${mockInquiry}`,
      maxTokens: 800,
      temperature: 0.6,
      venueId: auth.venueId,
      taskType: 'onboarding_test_draft',
      contentTier: built.contentTier,
      promptVersion: built.promptVersion,
    })

    return NextResponse.json({ draft: result.text })
  } catch (err) {
    console.error('[api/onboarding/test-draft] POST error:', err)
    return NextResponse.json({ error: 'Failed to generate test draft' }, { status: 500 })
  }
}
