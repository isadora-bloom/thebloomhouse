import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { generateSageResponse } from '@/lib/services/sage-brain'
import { extractPlanningDecisions, savePlanningNotes, extractAndSaveAINotes } from '@/lib/services/planning-extraction'
import { createNotification } from '@/lib/services/admin-notifications'
import { callAIVision } from '@/lib/ai/client'
import { rateLimit, secondsUntil } from '@/lib/rate-limit'
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
    const rl = await rateLimit(`sage:${rateLimitId}`, {
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
        model_used: 'claude-sonnet-4-20250514',
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
