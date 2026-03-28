import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import { buildPersonalityPrompt, type PersonalityData } from '@/lib/ai/personality-builder'
import { buildSageIntelligenceContext } from '@/lib/services/sage-intelligence'
import { extractPlanningDecisions, savePlanningNotes } from '@/lib/services/planning-extraction'

// ---------------------------------------------------------------------------
// POST — Sage portal chat
// Body: { venueId, weddingId, message }
// Returns: { response, confidence, conversationId }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { venueId, weddingId, message } = body

    if (!venueId || !message) {
      return NextResponse.json(
        { error: 'venueId and message are required' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // -----------------------------------------------------------------------
    // 1. Load venue personality config
    // -----------------------------------------------------------------------

    const { data: venue } = await supabase
      .from('venues')
      .select('id, name, slug')
      .eq('id', venueId)
      .single()

    if (!venue) {
      return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
    }

    const { data: aiConfig } = await supabase
      .from('venue_ai_config')
      .select('*')
      .eq('venue_id', venueId)
      .single()

    const { data: venueConfig } = await supabase
      .from('venue_config')
      .select('*')
      .eq('venue_id', venueId)
      .single()

    // -----------------------------------------------------------------------
    // 2. Load context: USPs, seasonal, knowledge base, wedding info
    // -----------------------------------------------------------------------

    const [uspsResult, seasonalResult, kbResult, weddingResult, historyResult] = await Promise.all([
      supabase
        .from('venue_usps')
        .select('usp_text')
        .eq('venue_id', venueId)
        .eq('is_active', true)
        .order('sort_order'),
      supabase
        .from('venue_seasonal_content')
        .select('season, imagery, phrases')
        .eq('venue_id', venueId),
      supabase
        .from('knowledge_base')
        .select('question, answer, category, keywords')
        .eq('venue_id', venueId)
        .eq('is_active', true),
      weddingId
        ? supabase
            .from('weddings')
            .select('*, people(*)')
            .eq('id', weddingId)
            .single()
        : Promise.resolve({ data: null }),
      // Recent conversation history (last 20 messages)
      weddingId
        ? supabase
            .from('sage_conversations')
            .select('role, content')
            .eq('wedding_id', weddingId)
            .order('created_at', { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [] }),
    ])

    const usps = (uspsResult.data || []).map((u) => u.usp_text)
    const seasonal: Record<string, { imagery?: string[]; phrases?: string[] }> = {}
    for (const s of seasonalResult.data || []) {
      seasonal[s.season] = {
        imagery: s.imagery ? [s.imagery] : [],
        phrases: s.phrases || [],
      }
    }

    const kbEntries = kbResult.data || []
    const wedding = weddingResult.data
    const conversationHistory = (historyResult.data || []).reverse()

    // -----------------------------------------------------------------------
    // 3. Search knowledge base for relevant answers
    // -----------------------------------------------------------------------

    const messageLower = message.toLowerCase()
    const relevantKB = kbEntries.filter((entry) => {
      const questionMatch = entry.question.toLowerCase().includes(messageLower) ||
        messageLower.includes(entry.question.toLowerCase().slice(0, 20))
      const keywordMatch = (entry.keywords || []).some((kw: string) =>
        messageLower.includes(kw.toLowerCase())
      )
      const categoryMatch = entry.category &&
        messageLower.includes(entry.category.toLowerCase())
      return questionMatch || keywordMatch || categoryMatch
    })

    // -----------------------------------------------------------------------
    // 4. Build Sage system prompt for portal context
    // -----------------------------------------------------------------------

    const personalityData: PersonalityData = {
      config: aiConfig || {},
      venue: { name: venue.name },
      venue_config: venueConfig || {},
      usps,
      seasonal,
      signoff: '',
    }

    const personalityPrompt = buildPersonalityPrompt(personalityData)
    const aiName = aiConfig?.ai_name || 'Sage'

    // Build wedding context
    let weddingContext = ''
    if (wedding) {
      const people = (wedding.people || []) as Array<{
        first_name: string
        last_name: string
        role: string
      }>
      const partners = people.filter(
        (p) => p.role === 'partner1' || p.role === 'partner2'
      )
      const coupleNames = partners.map((p) => p.first_name).join(' & ') || 'the couple'

      weddingContext = `
## CURRENT COUPLE CONTEXT
- Couple: ${coupleNames}
- Wedding date: ${wedding.wedding_date || 'Not set'}
- Estimated guests: ${wedding.guest_count_estimate || 'Not specified'}
- Status: ${wedding.status}
`
    }

    // Build KB context
    let kbContext = ''
    if (relevantKB.length > 0) {
      kbContext = `
## RELEVANT KNOWLEDGE BASE ENTRIES
Use these verified answers when relevant:

${relevantKB.map((kb) => `Q: ${kb.question}\nA: ${kb.answer}`).join('\n\n')}
`
    }

    // Build conversation history context
    let historyContext = ''
    if (conversationHistory.length > 0) {
      historyContext = `
## RECENT CONVERSATION
${conversationHistory.map((m) => `${m.role === 'user' ? 'Couple' : aiName}: ${m.content}`).join('\n')}
`
    }

    // -----------------------------------------------------------------------
    // 4b. Load intelligence context (trends, weather, reviews, anomalies)
    // -----------------------------------------------------------------------

    let intelligenceContext = ''
    try {
      intelligenceContext = await buildSageIntelligenceContext(venueId)
    } catch (err) {
      console.warn('[api/portal/sage] Intelligence context unavailable:', err)
    }

    const systemPrompt = `${personalityPrompt}

---

## PORTAL CONCIERGE MODE

You are responding to a couple through their wedding planning portal (not email).
Keep responses conversational, warm, and helpful. This is a chat interface, so:
- Keep messages concise (2-4 paragraphs max)
- Be friendly and personal
- Use the couple's names when natural
- If you don't know something, say so honestly and mention you'll flag it for the coordinator
- Never fabricate venue details, pricing, or availability
- You are an AI assistant and should be transparent about that if asked
${weddingContext}
${kbContext}
${intelligenceContext}
${historyContext}
`

    // -----------------------------------------------------------------------
    // 5. Call AI
    // -----------------------------------------------------------------------

    const aiResult = await callAI({
      systemPrompt,
      userPrompt: message,
      maxTokens: 1000,
      temperature: 0.4,
      venueId,
      taskType: 'portal_sage_chat',
    })

    // -----------------------------------------------------------------------
    // 6. Assess confidence
    // -----------------------------------------------------------------------

    // Confidence is higher when KB has relevant entries
    let confidence = 85 // default: Sage is generally confident

    if (relevantKB.length > 0) {
      confidence = 95 // KB has a direct answer
    } else {
      // Check if the response contains hedging language
      const hedges = [
        "i'm not sure",
        "i'll need to check",
        "let me flag",
        "i don't have",
        "your coordinator",
        "i'll have",
        "check with",
        "confirm with",
      ]
      const responseLower = aiResult.text.toLowerCase()
      const hedgeCount = hedges.filter((h) => responseLower.includes(h)).length
      if (hedgeCount >= 2) {
        confidence = 50
      } else if (hedgeCount === 1) {
        confidence = 65
      }
    }

    // -----------------------------------------------------------------------
    // 7. Save messages to database
    // -----------------------------------------------------------------------

    // Save user message
    await supabase.from('sage_conversations').insert({
      venue_id: venueId,
      wedding_id: weddingId || null,
      role: 'user',
      content: message,
      confidence_score: null,
      flagged_uncertain: false,
    })

    // Extract and save planning decisions (non-blocking)
    if (weddingId) {
      try {
        const planningNotes = extractPlanningDecisions(venueId, weddingId, message)
        if (planningNotes.length > 0) {
          await savePlanningNotes(venueId, weddingId, planningNotes)
        }
      } catch (err) {
        console.warn('[api/portal/sage] Planning extraction failed (non-blocking):', err)
      }
    }

    // Save Sage response
    const { data: sageMsg } = await supabase
      .from('sage_conversations')
      .insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        role: 'assistant',
        content: aiResult.text,
        model_used: 'claude-sonnet-4-20250514',
        tokens_used: aiResult.inputTokens + aiResult.outputTokens,
        cost: aiResult.cost,
        confidence_score: confidence,
        flagged_uncertain: confidence < 70,
      })
      .select('id')
      .single()

    // -----------------------------------------------------------------------
    // 8. If low confidence, add to uncertain queue
    // -----------------------------------------------------------------------

    if (confidence < 70 && sageMsg) {
      await supabase.from('sage_uncertain_queue').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        conversation_id: sageMsg.id,
        question: message,
        sage_answer: aiResult.text,
        confidence_score: confidence,
      })
    }

    // -----------------------------------------------------------------------
    // 9. Return response
    // -----------------------------------------------------------------------

    return NextResponse.json({
      response: aiResult.text,
      confidence,
      conversationId: sageMsg?.id || null,
    })
  } catch (err) {
    console.error('[api/portal/sage] POST error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
