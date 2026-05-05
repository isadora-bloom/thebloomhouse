import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { generateSageResponse, detectChatHumanRequest, routeChatToHuman } from '@/lib/services/sage-brain'
import { extractPlanningDecisions, savePlanningNotes, extractAndSaveAINotes } from '@/lib/services/planning-extraction'
import { createNotification } from '@/lib/services/admin-notifications'
import { runEscalationCheck } from '@/lib/services/escalation-detector'
import { checkEscalationForVenue } from '@/config/escalation-keywords'
import { callAIVision, CLAUDE_MODEL } from '@/lib/ai/client'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import { getCoupleAuth, getPlatformAuth, isDemoMode } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Rate limit: 20 requests per 15 minutes per wedding (falls back to venue or
// 'anonymous'). Persistent across cold starts via Supabase (BUG-12).
// ---------------------------------------------------------------------------

const SAGE_RATE_LIMIT = 20 // max requests per window
const SAGE_RATE_WINDOW_SEC = 15 * 60 // 15 minutes

// ---------------------------------------------------------------------------
// POST — Sage portal chat
// Body: { venueId, weddingId, message, fileUrl?, fileContext? }
// Returns: { response, confidence, conversationId }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { venueId, weddingId, message, fileUrl, fileContext } = body

    if (!venueId || !message) {
      return NextResponse.json(
        { error: 'venueId and message are required' },
        { status: 400 }
      )
    }

    // -----------------------------------------------------------------------
    // AUTHZ (BUG-09A fix): verify the caller actually has access to the
    // venueId + weddingId they are claiming in the body. Previously the
    // endpoint trusted body values, which let any authenticated user read
    // any wedding's sage_conversations history.
    // -----------------------------------------------------------------------
    const demo = await isDemoMode()
    if (!demo) {
      // Try couple auth first (most common caller). Couples may only chat
      // about their own wedding at their own venue.
      const couple = await getCoupleAuth()
      if (couple) {
        if (couple.venueId !== venueId) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        if (weddingId && couple.weddingId !== weddingId) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
      } else {
        // Fall back to platform auth. Coordinators may test Sage against any
        // wedding at their own venue, but not a different venue.
        const platform = await getPlatformAuth()
        if (!platform) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (platform.venueId !== venueId) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        if (weddingId) {
          // Verify wedding belongs to this venue before letting the
          // coordinator read its history.
          const svc = createServiceClient()
          const { data: w } = await svc
            .from('weddings')
            .select('venue_id')
            .eq('id', weddingId)
            .maybeSingle()
          if (!w || w.venue_id !== venueId) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
          }
        }
      }
    }

    // Rate limit by wedding ID (or venue ID for non-wedding queries)
    const rateLimitId = weddingId || venueId || 'anonymous'
    const rl = await checkRateLimit({
      key: `sage:${rateLimitId}`,
      limit: SAGE_RATE_LIMIT,
      windowSec: SAGE_RATE_WINDOW_SEC,
    })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a few minutes before sending another message.' },
        {
          status: 429,
          headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) },
        }
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
    // 3. Build file context if a file URL or pre-extracted text was provided
    // -----------------------------------------------------------------------

    let resolvedFileContext = fileContext || ''

    if (fileUrl && !resolvedFileContext) {
      // Attempt to extract text from the uploaded file
      try {
        const supabase = createServiceClient()

        // Determine if image or PDF based on URL extension
        const urlLower = fileUrl.toLowerCase()
        const isImage = /\.(jpg|jpeg|png|webp)/.test(urlLower)
        const isPdf = /\.pdf/.test(urlLower)

        if (isImage) {
          // Download and convert to base64 for vision analysis
          const response = await fetch(fileUrl)
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer()
            const base64 = Buffer.from(arrayBuffer).toString('base64')
            const contentType = response.headers.get('content-type') || 'image/jpeg'
            const mediaType = (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)
              ? contentType
              : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

            const extractResult = await callAIVision({
              systemPrompt: 'You are a document text extraction specialist. Extract ALL text from this document image. Preserve formatting, structure, and details.',
              userPrompt: 'Extract the complete text from this image. Include all text, headings, fine print, dates, and amounts.',
              imageBase64: base64,
              mediaType,
              maxTokens: 4000,
              venueId,
              taskType: 'sage_file_extraction_vision',
            })
            resolvedFileContext = extractResult.text
          }
        } else if (isPdf) {
          // Download PDF and try to extract text
          const response = await fetch(fileUrl)
          if (response.ok) {
            const blob = await response.blob()
            const text = await blob.text()
            if (text && text.length > 50 && !text.includes('%PDF')) {
              resolvedFileContext = text
            } else {
              // PDF binary — note limitation
              resolvedFileContext = `[PDF file uploaded: The file appears to be a binary PDF. Direct text extraction is limited. The user may need to share specific sections as images for full analysis.]`
            }
          }
        }
      } catch (err) {
        console.warn('[api/portal/sage] File context extraction failed (non-blocking):', err)
      }
    }

    // -----------------------------------------------------------------------
    // 3-pre. Stream EEEE: human-escalation request. Mirrors the email
    // pipeline's "HUMAN REQUESTED in subject" fast-path. If the couple
    // explicitly asks for a human, we don't run the LLM at all — we
    // log the user message, fire engagement_event + admin_notification
    // via routeChatToHuman, save a canned acknowledgement, and return.
    // No tokens burned, no chance of Sage talking past the request.
    // -----------------------------------------------------------------------
    if (detectChatHumanRequest(message)) {
      // Persist the user's request so the conversation history stays
      // accurate.
      await supabase.from('sage_conversations').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        role: 'user',
        content: message,
        confidence_score: null,
        flagged_uncertain: true,
      })

      const cannedResponse = await routeChatToHuman({
        venueId,
        weddingId: weddingId || null,
        message,
      })

      const { data: cannedSageMsg } = await supabase
        .from('sage_conversations')
        .insert({
          venue_id: venueId,
          wedding_id: weddingId || null,
          role: 'assistant',
          content: cannedResponse,
          model_used: null,
          tokens_used: 0,
          cost: 0,
          confidence_score: 100,
          flagged_uncertain: true,
        })
        .select('id')
        .single()

      return NextResponse.json({
        response: cannedResponse,
        confidence: 100,
        conversationId: cannedSageMsg?.id || null,
        humanRequested: true,
      })
    }

    // -----------------------------------------------------------------------
    // 3a. Forbidden-topic pre-classification (B-20 / T1-J).
    // Pre-fix the route was generate-then-assess: Sage answered first
    // and the escalation scan ran AFTER, on the *user* message, in a
    // fire-and-forget. That meant on a forbidden-topic ask we'd burn
    // tokens generating an answer Sage shouldn't be giving (legal,
    // refund, vendor disputes, per-venue prohibitions) and then alert
    // the coordinator after the couple already received Sage's reply.
    //
    // Now: check the inbound against the merged global +
    // venue_forbidden_topics list BEFORE generateSageResponse. On
    // match: skip generation entirely, save the user message, drop a
    // sage_uncertain_queue row with reason='forbidden_topic', notify
    // the coordinator, and return a canned escalation response. The
    // coordinator answers manually via the queue UI.
    // -----------------------------------------------------------------------
    const forbidden = await checkEscalationForVenue(message, venueId)
    if (forbidden.shouldEscalate && forbidden.matchedKeyword) {
      // Save the user message so the conversation history stays correct.
      await supabase.from('sage_conversations').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        role: 'user',
        content: message,
        confidence_score: null,
        flagged_uncertain: true,
      })

      const cannedResponse =
        `That's an important question, and I want to make sure you get the right answer. ` +
        `I've flagged this for your coordinator to handle directly — they'll be in touch shortly.`

      const { data: cannedSageMsg } = await supabase
        .from('sage_conversations')
        .insert({
          venue_id: venueId,
          wedding_id: weddingId || null,
          role: 'assistant',
          content: cannedResponse,
          model_used: null,
          tokens_used: 0,
          cost: 0,
          confidence_score: 0,
          flagged_uncertain: true,
        })
        .select('id')
        .single()

      await supabase.from('sage_uncertain_queue').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        conversation_id: cannedSageMsg?.id ?? null,
        question: message,
        sage_answer: cannedResponse,
        confidence_score: 0,
        reason: 'forbidden_topic',
      })

      try {
        await createNotification({
          venueId,
          weddingId: weddingId || undefined,
          type: 'sage_uncertain',
          title: `Forbidden topic flagged: "${forbidden.matchedKeyword}"`,
          body:
            `Sage skipped generation because the message hit the forbidden-topic list ` +
            `(matched "${forbidden.matchedKeyword}"). Excerpt: ` +
            `"${message.slice(0, 160)}${message.length > 160 ? '…' : ''}"`,
        })
      } catch (err) {
        console.warn('[api/portal/sage] notification failed (non-blocking):', err)
      }

      return NextResponse.json({
        response: cannedResponse,
        confidence: 0,
        conversationId: cannedSageMsg?.id || null,
        forbiddenTopic: forbidden.matchedKeyword,
      })
    }

    // -----------------------------------------------------------------------
    // 4. Generate response via sage-brain (all 4 prompt layers + KB + context)
    // -----------------------------------------------------------------------

    const sageResult = await generateSageResponse({
      venueId,
      weddingId: weddingId || venueId, // fallback for non-wedding queries
      message,
      conversationHistory,
      fileContext: resolvedFileContext || undefined,
    })

    const { confidence, aiName, coupleFirstName } = sageResult

    // -----------------------------------------------------------------------
    // 5. Apply confidence-based response modifications
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
    // 6. Save messages to database
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

    // Escalation scan on the couple's message — fire-and-forget so a notif
    // failure can't break the chat. Only scans user content; the assistant
    // reply is never scanned to avoid Sage's own paraphrases tripping it.
    void runEscalationCheck({
      text: message,
      venueId,
      weddingId: weddingId || null,
      sourceType: 'sage_conversation',
    })

    // Extract and save planning decisions
    if (weddingId) {
      // Layer 1: Regex extraction (fast, synchronous)
      try {
        const planningNotes = extractPlanningDecisions(venueId, weddingId, message)
        if (planningNotes.length > 0) {
          await savePlanningNotes(venueId, weddingId, planningNotes)
        }
      } catch (err) {
        console.warn('[api/portal/sage] Regex planning extraction failed (non-blocking):', err)
      }

      // Layer 2: AI extraction (richer, fire-and-forget — don't block the response)
      extractAndSaveAINotes(venueId, weddingId, message).catch((err) =>
        console.warn('[api/portal/sage] AI planning extraction failed (non-blocking):', err)
      )
    }

    // Save Sage response
    const { data: sageMsg } = await supabase
      .from('sage_conversations')
      .insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        role: 'assistant',
        content: finalResponse,
        model_used: CLAUDE_MODEL,
        tokens_used: sageResult.tokensUsed,
        cost: sageResult.cost,
        confidence_score: confidence,
        flagged_uncertain: confidence < 80,
      })
      .select('id')
      .single()

    // -----------------------------------------------------------------------
    // 7. If uncertain, add to queue + alert venue staff
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
    // 8. Return response
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
