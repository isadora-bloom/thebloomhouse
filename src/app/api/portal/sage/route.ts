import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { generateSageResponse } from '@/lib/services/sage-brain'
import { extractPlanningDecisions, savePlanningNotes } from '@/lib/services/planning-extraction'
import { createNotification } from '@/lib/services/admin-notifications'

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
    // 1. Validate venue exists
    // -----------------------------------------------------------------------

    const { data: venue } = await supabase
      .from('venues')
      .select('id')
      .eq('id', venueId)
      .single()

    if (!venue) {
      return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
    }

    // -----------------------------------------------------------------------
    // 2. Load recent conversation history
    // -----------------------------------------------------------------------

    const { data: historyRows } = weddingId
      ? await supabase
          .from('sage_conversations')
          .select('role, content')
          .eq('wedding_id', weddingId)
          .order('created_at', { ascending: false })
          .limit(20)
      : { data: [] as { role: string; content: string }[] }

    const conversationHistory = (historyRows || []).reverse()

    // -----------------------------------------------------------------------
    // 3. Generate response via sage-brain (all 4 prompt layers + KB + context)
    // -----------------------------------------------------------------------

    const sageResult = await generateSageResponse({
      venueId,
      weddingId: weddingId || venueId, // fallback for non-wedding queries
      message,
      conversationHistory,
    })

    const { confidence, aiName, coupleFirstName } = sageResult

    // -----------------------------------------------------------------------
    // 4. Apply confidence-based response modifications
    // -----------------------------------------------------------------------
    // Confidence tiers:
    //   >=80: Sage responds normally
    //   50-79: Sage responds with caveat + triggers alert for venue staff
    //   <50: Sage gives warm non-answer + triggers alert

    let finalResponse = sageResult.response

    if (confidence < 50) {
      // Very uncertain — don't guess, give a warm non-answer
      const greeting = coupleFirstName ? `Hi ${coupleFirstName}!` : 'Hi there!'
      finalResponse = `${greeting} That's a great question. I want to make sure I give you the right answer, so let me check with your coordinator and get back to you on this. I'll make sure they see your question right away!`
    } else if (confidence < 80) {
      // Somewhat uncertain — respond but add a caveat
      if (!finalResponse.toLowerCase().includes('confirm') && !finalResponse.toLowerCase().includes('check with')) {
        finalResponse += '\n\nI want to make sure this is exactly right, so I\'ve flagged this for your coordinator to confirm. They\'ll follow up if anything needs updating!'
      }
    }

    // -----------------------------------------------------------------------
    // 5. Save messages to database
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
        content: finalResponse,
        model_used: 'claude-sonnet-4-20250514',
        tokens_used: sageResult.tokensUsed,
        cost: sageResult.cost,
        confidence_score: confidence,
        flagged_uncertain: confidence < 80,
      })
      .select('id')
      .single()

    // -----------------------------------------------------------------------
    // 6. If uncertain, add to queue + alert venue staff
    // -----------------------------------------------------------------------

    if (confidence < 80 && sageMsg) {
      // Add to uncertain queue for coordinator review
      await supabase.from('sage_uncertain_queue').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        conversation_id: sageMsg.id,
        question: message,
        sage_answer: finalResponse,
        confidence_score: confidence,
      })

      // Create admin notification so venue staff knows to check
      const tierLabel = confidence < 50 ? 'low confidence' : 'needs confirmation'
      try {
        await createNotification({
          venueId,
          weddingId: weddingId || undefined,
          type: 'sage_uncertain',
          title: `${aiName} flagged a question (${tierLabel})`,
          body: `"${message.slice(0, 120)}${message.length > 120 ? '...' : ''}" — Confidence: ${confidence}%. Check the Sage Queue to review and respond.`,
        })
      } catch (err) {
        console.warn('[api/portal/sage] Failed to create notification (non-blocking):', err)
      }
    }

    // -----------------------------------------------------------------------
    // 7. Return response
    // -----------------------------------------------------------------------

    return NextResponse.json({
      response: finalResponse,
      confidence,
      conversationId: sageMsg?.id || null,
    })
  } catch (err) {
    // Log the full error (with stack) so failures aren't opaque in Vercel logs
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error('[api/portal/sage] POST error:', message)
    if (stack) console.error('[api/portal/sage] stack:', stack)
    return NextResponse.json(
      {
        error: 'Internal server error',
        // Surface the message in non-production to aid debugging
        ...(process.env.NODE_ENV !== 'production' ? { detail: message } : {}),
      },
      { status: 500 }
    )
  }
}
