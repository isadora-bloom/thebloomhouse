import { NextRequest, NextResponse } from 'next/server'
import { writeOrLog } from '@/lib/db/write-or-log'
import { cookies } from 'next/headers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  generateSageResponse,
  detectChatHumanRequest,
  routeChatToHuman,
  appendChatSignoff,
} from '@/lib/services/brain/sage'
import { extractPlanningDecisions, savePlanningNotes, extractAndSaveAINotes } from '@/lib/services/intel/planning-extraction'
import { createNotification } from '@/lib/services/admin-notifications'
import { runEscalationCheck } from '@/lib/services/email/escalation-detector'
import { checkEscalationForVenue } from '@/config/escalation-keywords'
import { callAIVision, CLAUDE_MODEL, AIUnavailableError, COUPLE_AI_UNAVAILABLE_MESSAGE } from '@/lib/ai/client'
import { buildCouplePrompt } from '@/lib/ai/couple-prompt'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import {
  getCoupleAuth,
  getPlatformAuth,
  isDemoVenueAllowed,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { verifyDemoToken, DEMO_TOKEN_COOKIE, DEMO_VENUE_ID as DEMO_VENUE_CONSTANT } from '@/lib/services/demo-token'
import { createLogger } from '@/lib/observability/logger'

// ---------------------------------------------------------------------------
// Rate limit: 20 requests per 15 minutes per wedding (falls back to venue or
// 'anonymous'). Persistent across cold starts via Supabase (BUG-12).
// ---------------------------------------------------------------------------

const SAGE_RATE_LIMIT = 20 // max requests per window
const SAGE_RATE_WINDOW_SEC = 15 * 60 // 15 minutes

// ---------------------------------------------------------------------------
// Input caps (2026-09-14 security review, item 1)
// ---------------------------------------------------------------------------
//
// MAX_MESSAGE_CHARS — the couple's message went into the prompt uncapped.
// A single request could therefore carry a book, which is a token-cost
// incident and also the cheapest way to push the venue's own rules out of
// the model's attention. The public preview caps at 500 because it is
// unauthenticated and answers in two sentences; the portal chat is
// authenticated, rate-limited to 20 messages per 15 minutes, and couples
// legitimately paste a paragraph of a policy they are asking about. 4,000
// characters is roughly a page of prose, about 1k tokens, and leaves the
// prompt floor in comfortable proportion. Over the cap is a 400 that says
// the number, not a silent truncation: a couple whose question was cut in
// half would get an answer to a question they did not ask.
const MAX_MESSAGE_CHARS = 4000

// MAX_FILE_CONTEXT_CHARS — cap on the SERVER-DERIVED document text before
// it reaches the prompt. Matches the cap buildFileContextBlock already
// applies in couple-prompt.ts, so both couple-facing file surfaces stop at
// the same place.
const MAX_FILE_CONTEXT_CHARS = 12000

// ---------------------------------------------------------------------------
// POST — Sage portal chat
// Body: { venueId, weddingId, message, fileUrl?, contractId?, currentSection? }
// Returns: { response, confidence, conversationId }
//
// `fileContext` is NOT accepted. It used to be: the client posted document
// text and the route interpolated it into the system prompt raw and
// uncapped, which meant anyone who could reach this endpoint could write
// directly into Sage's instructions for their own wedding. Document text
// is now derived server-side, either from a contract row the couple owns
// (contractId) or by extracting the file they just uploaded (fileUrl).
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
    // Sage couple-portal chat is gated at the 'intelligence' tier
    // (sage + couple_portal features in plan-tiers.ts). Venues on
    // starter cannot expose Sage to their couples. Demo cookie path
    // bypasses inside requirePlan. requirePlan resolves the venueId
    // from user_profiles which works for the couple role too.
    const plan = await requirePlan(request, 'pre_opening')
    if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

    const body = await request.json()
    // venueId is resolved below — body value is only trusted for authenticated
    // (non-demo) callers. Demo callers have their venueId bound to the signed
    // token payload so a starter-tier coordinator cannot pass their real venue.
    const { weddingId, message, fileUrl, contractId, currentSection } = body

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'venueId and message are required' },
        { status: 400 }
      )
    }

    if (message.length > MAX_MESSAGE_CHARS) {
      return NextResponse.json(
        {
          error: `Message too long (max ${MAX_MESSAGE_CHARS} characters). Send the part you want help with, or upload the document instead.`,
        },
        { status: 400 }
      )
    }

    // Loud about the removal rather than quietly ignoring it: an old
    // client still posting fileContext would otherwise look like it was
    // working while Sage saw nothing of the document.
    if (body.fileContext !== undefined) {
      console.warn(
        '[api/portal/sage] ignoring client-supplied fileContext — document text is derived server-side from contractId or fileUrl',
      )
    }

    // -----------------------------------------------------------------------
    // Demo venueId binding: extract from the HMAC-verified token. Ignoring
    // body.venueId in demo mode prevents a starter-tier coordinator from
    // passing their real venueId and getting free Intelligence-tier Sage.
    // -----------------------------------------------------------------------
    const cookieStore = await cookies()
    const demoTokenResult = verifyDemoToken(cookieStore.get(DEMO_TOKEN_COOKIE)?.value)
    const demo = demoTokenResult.ok

    const venueId: string = demoTokenResult.ok
      ? demoTokenResult.payload.demo_venue_id
      : (body.venueId as string | undefined) ?? ''

    if (!venueId) {
      return NextResponse.json(
        { error: 'venueId and message are required' },
        { status: 400 }
      )
    }

    // Belt-and-suspenders: demo sessions may only access Crestwood demo venues.
    // The token payload already pins the venueId server-side; this guard covers
    // any future token migration where payload.venueId is not Hawthorne.
    if (demo && venueId !== DEMO_VENUE_CONSTANT) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // -----------------------------------------------------------------------
    // AUTHZ (BUG-09A fix): verify the caller actually has access to the
    // venueId + weddingId they are claiming in the body. Previously the
    // endpoint trusted body values, which let any authenticated user read
    // any wedding's sage_conversations history.
    // -----------------------------------------------------------------------
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
        // A demo session is allowed here — talking to Sage is what the
        // demo is for — but only against a Crestwood venue. Anything else
        // is a real venue's knowledge base and a real venue's LLM spend.
        if (platform.isDemo) {
          if (!isDemoVenueAllowed(venueId)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
          }
        } else if (platform.venueId !== venueId) {
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

    // Rate limit by wedding ID (or venue ID for non-wedding queries).
    // GAP M1: if weddingId is absent the key falls back to venueId,
    // which is shared across ALL weddings for that venue. Log a warning
    // so the fallback is visible in Vercel logs rather than silent.
    if (!weddingId) {
      const log = createLogger({ venueId, actor: 'sage.rate_limit' })
      log.warn('sage.rate-limit.venue-fallback', {
        event_type: 'sage.rate_limit',
        outcome: 'skip',
        data: { reason: 'no weddingId — rate limit key is venue-scoped, shared across all weddings', venueId },
      })
    }
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

    // Everything in this variable is read out of the database or extracted
    // from a file by this server. Nothing the caller wrote reaches it.
    let resolvedFileContext = ''

    // -----------------------------------------------------------------------
    // 3a. contractId — the couple is asking about a contract already stored
    // against their wedding. Pre-fix the client posted the extracted text
    // itself and the route trusted it. Now the client sends only the id and
    // the text comes from the row, scoped by BOTH venue and wedding, so a
    // couple cannot name another couple's contract and cannot name one at
    // another venue even if they somehow learned its id.
    // -----------------------------------------------------------------------
    if (typeof contractId === 'string' && contractId.trim() && weddingId) {
      const { data: contractRow } = await supabase
        .from('contracts')
        .select('filename, extracted_text')
        .eq('id', contractId.trim())
        .eq('venue_id', venueId)
        .eq('wedding_id', weddingId)
        .maybeSingle()

      const extracted = (contractRow?.extracted_text as string | null) ?? ''
      if (extracted.trim()) {
        resolvedFileContext =
          `CONTRACT: "${contractRow?.filename ?? 'uploaded document'}"\n\n` +
          `EXTRACTED TEXT:\n${extracted}`
      }
    }

    // SSRF defense for couple-supplied fileUrl. Scope the allowlist to
    // the Supabase Storage CDN of this project (derived from the env
    // URL), so a malicious couple cannot point Sage at internal /
    // metadata / arbitrary external services. Per 2026-05-06 audit
    // Lens 8.
    //
    // 2026-05-06 round-2 audit caught a redirect bypass: pre-fix the
    // initial assertSafeUrl ran but the actual fetch followed redirects
    // automatically — a signed Storage URL 302'ing to attacker-host
    // would still be fetched. Fixed by routing through safeFetch (which
    // validates EVERY hop). The Storage allowlist is preserved across
    // hops, so any 3xx leaving the allowlisted host is rejected.
    //
    // 2026-09-14 review, item 1: the host allowlist proved the URL pointed
    // at our own Storage, but not at a file belonging to THIS couple. The
    // couple chat uploader writes to `contracts/<weddingId>/chat/...`, so
    // requiring that prefix in the path is a straight ownership check, and
    // it costs one string comparison. Without a weddingId there is no
    // prefix to check against and no file to be owned, so the extraction
    // is skipped entirely.
    const fileUrlOwnedByCouple = (() => {
      if (typeof fileUrl !== 'string' || !fileUrl) return false
      if (!weddingId) return false
      try {
        return new URL(fileUrl).pathname.includes(`/contracts/${weddingId}/`)
      } catch {
        return false
      }
    })()

    if (fileUrl && !fileUrlOwnedByCouple) {
      console.warn(
        '[api/portal/sage] rejected fileUrl that does not sit under this wedding’s storage prefix',
      )
    }

    if (fileUrlOwnedByCouple && !resolvedFileContext) {
      // Attempt to extract text from the uploaded file
      try {
        const { safeFetch, UnsafeUrlError } = await import('@/lib/security/safe-fetch')
        const supabaseHost = (() => {
          try {
            const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
            return u.hostname
          } catch {
            return ''
          }
        })()
        const fileUrlAllowlist = supabaseHost ? [supabaseHost] : ['supabase.co']

        // Determine if image or PDF based on URL extension
        const urlLower = fileUrl.toLowerCase()
        const isImage = /\.(jpg|jpeg|png|webp)/.test(urlLower)
        const isPdf = /\.pdf/.test(urlLower)

        const safeFetchFile = async () => {
          try {
            return await safeFetch(fileUrl, {}, { hostAllowlist: fileUrlAllowlist })
          } catch (err) {
            if (err instanceof UnsafeUrlError) {
              console.warn('[api/portal/sage] rejected unsafe fileUrl:', err.reason)
              return null
            }
            throw err
          }
        }

        if (isImage) {
          const response = await safeFetchFile()
          if (response && response.ok) {
            const arrayBuffer = await response.arrayBuffer()
            const base64 = Buffer.from(arrayBuffer).toString('base64')
            const contentType = response.headers.get('content-type') || 'image/jpeg'
            const mediaType = (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)
              ? contentType
              : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

            const filePrompt = await buildCouplePrompt({
              venueId,
              weddingId: weddingId || null,
              fileContext: null,
              task: 'file_extraction',
              taskInstructions:
                'Extract ALL text from the image exactly as it appears. Preserve formatting, structure, and details. Return only the extracted text. No commentary.',
            })

            const extractResult = await callAIVision({
              systemPrompt: filePrompt.systemPrompt,
              userPrompt: 'Extract the complete text from this image. Include all text, headings, fine print, dates, and amounts.',
              imageBase64: base64,
              mediaType,
              maxTokens: 4000,
              venueId,
              taskType: 'sage_file_extraction_vision',
              contentTier: filePrompt.contentTier,
              promptVersion: filePrompt.promptVersion,
            })
            resolvedFileContext = extractResult.text
          }
        } else if (isPdf) {
          const response = await safeFetchFile()
          if (response && response.ok) {
            const blob = await response.blob()
            const text = await blob.text()
            if (text && text.length > 50 && !text.includes('%PDF')) {
              resolvedFileContext = text
            } else {
              resolvedFileContext = `[PDF file uploaded: The file appears to be a binary PDF. Direct text extraction is limited. The user may need to share specific sections as images for full analysis.]`
            }
          }
        }
      } catch (err) {
        console.warn('[api/portal/sage] File context extraction failed (non-blocking):', err)
      }
    }

    // A scanned contract can run to tens of thousands of characters. Cap
    // here rather than downstream so the size of what reaches the prompt is
    // decided at the trust boundary, where the text stops being a file and
    // starts being context.
    if (resolvedFileContext.length > MAX_FILE_CONTEXT_CHARS) {
      resolvedFileContext =
        `${resolvedFileContext.slice(0, MAX_FILE_CONTEXT_CHARS)}\n\n` +
        '[Truncated for length. The full document is still stored.]'
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
      await writeOrLog(supabase.from('sage_conversations').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        role: 'user',
        content: message,
        confidence_score: null,
        flagged_uncertain: true,
      }), { op: 'sage_conversations.insert', venueId })

      // Sign-off chokepoint (item 4). Every branch that returns a reply
      // signs it here, before the row is written, so what is stored is
      // what the couple saw.
      const cannedResponse = await appendChatSignoff(
        await routeChatToHuman({
          venueId,
          weddingId: weddingId || null,
          message,
        }),
        venueId,
      )

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
      await writeOrLog(supabase.from('sage_conversations').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        role: 'user',
        content: message,
        confidence_score: null,
        flagged_uncertain: true,
      }), { op: 'sage_conversations.insert', venueId })

      // Sign-off chokepoint (item 4).
      const cannedResponse = await appendChatSignoff(
        `That's an important question, and I want to make sure you get the right answer. ` +
          `I've flagged this for your coordinator to handle directly — they'll be in touch shortly.`,
        venueId,
      )

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

      await writeOrLog(supabase.from('sage_uncertain_queue').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        conversation_id: cannedSageMsg?.id ?? null,
        question: message,
        sage_answer: cannedResponse,
        confidence_score: 0,
        reason: 'forbidden_topic',
      }), { op: 'sage_uncertain_queue.insert', venueId })

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
          // Finding 3 (November plan W10): pulse-aggregator's type-based
          // fallback treats 'sage_uncertain' as 'high', but that fallback
          // only fires when the stored priority column is NULL. This
          // call previously left priority unset, so createNotification's
          // 'normal' default landed it as 'medium' on /pulse — a coordinator
          // skimming by priority would see this below genuinely medium
          // items. Set explicitly so a forbidden-topic block reads as
          // high-priority, matching its actual urgency.
          priority: 'high',
        })
      } catch (err) {
        console.warn('[api/portal/sage] notification failed (non-blocking):', err)
      }

      // Finding 3 (November plan W10): the pitch deck promises "a Sage
      // chat turning tense triggers a Pulse flag" — that's runEscalationCheck
      // below, at step 6, which fires an admin_notifications row with
      // type='escalation', priority='urgent' (resolves to Pulse 'critical').
      // But step 6 never runs for THIS message: it calls
      // checkEscalationForVenue(message, venueId) — the exact same
      // matcher, on the exact same text, as `forbidden` above — so any
      // message that reaches this branch would also match at step 6,
      // except we've already returned before getting there. The result
      // was that every tense/urgent/legal keyword hit (frustrated,
      // disappointed, terrible, lawyer, refund, urgent, ...) only ever
      // produced the 'sage_uncertain' notification above, never the
      // 'escalation' one — the promised critical Pulse flag was
      // unreachable for Sage-portal chat. Firing it here restores that
      // path without touching Sage's answer to the couple (the canned
      // response above is unchanged): both notifications land, dedup'd
      // independently by type, so a coordinator sees the topic was
      // withheld (sage_uncertain) AND that it was a tense/urgent match
      // (escalation, higher priority).
      void runEscalationCheck({
        text: message,
        venueId,
        weddingId: weddingId || null,
        sourceType: 'sage_conversation',
      })

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

    // Sanitize currentSection — accept only a short slug, never trust
    // the body blindly. The brain looks it up against the static
    // registry, so an unknown slug just degrades to "no section context".
    const safeSection =
      typeof currentSection === 'string' && /^[a-z0-9-]{1,40}$/.test(currentSection)
        ? currentSection
        : null

    let sageResult: Awaited<ReturnType<typeof generateSageResponse>>
    try {
      sageResult = await generateSageResponse({
        venueId,
        weddingId: weddingId || venueId, // fallback for non-wedding queries
        message,
        conversationHistory,
        fileContext: resolvedFileContext || undefined,
        currentSection: safeSection,
      })
    } catch (err) {
      // Total AI outage (both providers down / fallback disabled). Never
      // let this reach the couple as a raw 500 — save the user's message,
      // reply in a warm in-voice tone, drop it in the coordinator's
      // uncertain queue and page them via a notification, then return the
      // warm reply as a normal Sage turn (200) so the UI renders it in the
      // chat rather than as an error toast.
      if (!(err instanceof AIUnavailableError)) throw err
      console.error('[api/portal/sage] AI unavailable:', err.stage, err.message)

      // Sign-off chokepoint (item 4). The outage reply is the branch that
      // most needs the escalation line: the couple is being told nothing
      // useful and has to be told how to reach a person.
      const outageResponse = await appendChatSignoff(
        COUPLE_AI_UNAVAILABLE_MESSAGE,
        venueId,
      )

      await writeOrLog(supabase.from('sage_conversations').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        role: 'user',
        content: message,
        confidence_score: null,
        flagged_uncertain: true,
      }), { op: 'sage_conversations.insert', venueId })

      const { data: downMsg } = await supabase
        .from('sage_conversations')
        .insert({
          venue_id: venueId,
          wedding_id: weddingId || null,
          role: 'assistant',
          content: outageResponse,
          model_used: null,
          tokens_used: 0,
          cost: 0,
          confidence_score: 0,
          flagged_uncertain: true,
        })
        .select('id')
        .single()

      await writeOrLog(supabase.from('sage_uncertain_queue').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        conversation_id: downMsg?.id ?? null,
        question: message,
        sage_answer: outageResponse,
        confidence_score: 0,
        reason: 'ai_unavailable',
      }), { op: 'sage_uncertain_queue.insert', venueId })

      try {
        await createNotification({
          venueId,
          weddingId: weddingId || undefined,
          type: 'sage_uncertain',
          title: 'Sage could not answer — AI provider outage',
          body:
            `Both the primary and fallback AI providers were unavailable, so Sage gave the couple a ` +
            `holding reply instead of an answer. The question is in the Sage Queue for you to answer ` +
            `directly: "${message.slice(0, 160)}${message.length > 160 ? '…' : ''}"`,
          // Finding 3: explicit priority, see the forbidden-topic call above.
          priority: 'high',
        })
      } catch (notifyErr) {
        console.warn('[api/portal/sage] outage notification failed (non-blocking):', notifyErr)
      }

      return NextResponse.json({
        response: outageResponse,
        confidence: 0,
        conversationId: downMsg?.id || null,
        aiUnavailable: true,
      })
    }

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

    // Sign-off chokepoint (item 4). AFTER the confidence rewrites, not
    // before: the low-confidence branch above throws the generated text
    // away entirely, and the medium-confidence branch appends to it. Both
    // used to leave the sign-off either gone or stranded mid-message.
    finalResponse = await appendChatSignoff(finalResponse, venueId)

    // -----------------------------------------------------------------------
    // 6. Save messages to database
    // -----------------------------------------------------------------------

    // Save user message
    await writeOrLog(supabase.from('sage_conversations').insert({
      venue_id: venueId,
      wedding_id: weddingId || null,
      role: 'user',
      content: message,
      confidence_score: null,
      flagged_uncertain: false,
    }), { op: 'sage_conversations.insert', venueId })

    // Escalation scan on the couple's message — fire-and-forget so a notif
    // failure can't break the chat. Only scans user content; the assistant
    // reply is never scanned to avoid Sage's own paraphrases tripping it.
    //
    // Note (finding 3, November plan W10): this only actually fires for a
    // message that reached generation, i.e. did NOT match at the step-3a
    // forbidden-topic check — and that check calls the identical
    // checkEscalationForVenue(message, venueId) on the identical text, so
    // by construction nothing that would trip this scan gets past step 3a
    // to reach here. The forbidden-topic branch above now fires this same
    // check directly (see the comment there) so the escalation path isn't
    // silently unreachable. This call stays as the correct behaviour for
    // callers where no such pre-check exists.
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
      //
      // ---- S4a, 2026-09-14 ingestion audit item 7 (only change in this file) ----
      // `message` is couple-typed text and the extraction writes rows the
      // coordinator reads, so it used to be a path where a chat message
      // could author its own planning notes. The untrusted-content
      // wrapping and the venueId attribution both now live inside
      // extractPlanningNotesAI (services/intel/planning-extraction.ts), so
      // this call site needs no argument change — the note is here so the
      // next reader does not re-add wrapping at the wrong layer. Notes
      // produced this way carry status 'ai_extracted' and the coordinator
      // surface shows them as unconfirmed.
      // --------------------------------------------------------------------
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
      await writeOrLog(supabase.from('sage_uncertain_queue').insert({
        venue_id: venueId,
        wedding_id: weddingId || null,
        conversation_id: sageMsg.id,
        question: message,
        sage_answer: finalResponse,
        confidence_score: confidence,
      }), { op: 'sage_uncertain_queue.insert', venueId })

      // Create admin notification so venue staff knows to check
      const tierLabel = confidence < 50 ? 'low confidence' : 'needs confirmation'
      try {
        await createNotification({
          venueId,
          weddingId: weddingId || undefined,
          type: 'sage_uncertain',
          title: `${aiName} flagged a question (${tierLabel})`,
          body: `"${message.slice(0, 120)}${message.length > 120 ? '...' : ''}" — Confidence: ${confidence}%. Check the Sage Queue to review and respond.`,
          // Finding 3: explicit priority, see the forbidden-topic call above.
          priority: 'high',
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
