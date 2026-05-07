/**
 * Bloom House: Sage Brain (Couple-Facing AI Concierge)
 *
 * Generates Sage's responses for the couple portal chat. Assembles the
 * full prompt stack:
 *   Layer 1: Universal rules
 *   Layer 2: Personality prompt (venue voice)
 *   Layer 3: Sage task prompt (couple-facing chat behavior)
 *   Layer 4: Intelligence context + KB search + wedding context
 *
 * Sage should feel like a knowledgeable, warm concierge who knows the
 * venue inside and out — not a generic chatbot.
 */

import { callAI } from '@/lib/ai/client'
import {
  buildPersonalityPrompt,
  buildSignoffBlock,
  requireAiName,
  type PersonalityData,
} from '@/lib/ai/personality-builder'
import { buildSageIntelligenceContext } from './sage-intelligence'

/** Prompt revision identifier — see PROMPTS-CHANGELOG.md / OPS-21.5.1. */
export const BRAIN_PROMPT_VERSION = 'sage-brain.prompt.v1.1'
import { searchKnowledgeBase } from './knowledge-base'
import { createServiceClient } from '@/lib/supabase/service'
import { createNotification } from '@/lib/services/admin-notifications'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { getSageTaskPrompt } from '@/config/prompts/task-prompts-sage'

// ---------------------------------------------------------------------------
// Stream EEEE: human-escalation detection + chat sign-off
// ---------------------------------------------------------------------------
//
// Email pipeline parity. The footer Sage attaches to every outbound email
// tells couples how to reach a human; the couple-portal chat needs the
// same affordance. Two pieces:
//
//   1. SAGE_HUMAN_REQUEST_PATTERN — matches the chat phrasings a couple
//      naturally uses to ask out of Sage. Mirrors the email pipeline's
//      HUMAN REQUESTED subject route, but in conversational form. Tested
//      examples that MUST match:
//        - "I'd like a human"
//        - "I'd like to talk to a human"
//        - "I'd like to speak to a person"
//        - "Talk to a person please"
//        - "Speak to a human"
//        - "Connect me with a real person"
//        - "Connect me with a coordinator"
//      And NOT match a generic message that uses "human" descriptively
//      ("This is a humane policy" / "What human size is the venue?").
//
//   2. CHAT_SIGNOFF_TEMPLATE — appended after every Sage chat response.
//      Renders the AI name + venue + role and the inline escalation
//      affordance. No mailto: link — chat can just text the magic phrase.
export const SAGE_HUMAN_REQUEST_PATTERN =
  /I'?d like (?:a |to talk to a |to speak to a )?human|talk to (?:a )?(?:person|human)|speak to (?:a )?(?:person|human)|connect me with .* (?:real person|human|coordinator)/i

/** Pure helper — returns true when a chat message asks for a human.
 *  Exported for the route to short-circuit before the LLM call (mirrors
 *  the email pipeline's humanRequested fast-path). */
export function detectChatHumanRequest(message: string | null | undefined): boolean {
  if (!message) return false
  return SAGE_HUMAN_REQUEST_PATTERN.test(message)
}

/** Build the chat sign-off + escalation reminder appended to every
 *  Sage chat response. Coordinator is optional — when missing, the
 *  reminder still works ("type 'I'd like a human' any time and the
 *  team will step in"). */
export function buildChatSignoff(opts: {
  aiName: string
  venueName: string
  aiRole?: string | null
  coordinatorName?: string | null
}): string {
  const role = (opts.aiRole && /\bAI\b/i.test(opts.aiRole) ? opts.aiRole.trim() : 'AI assistant')
  const stepIn = opts.coordinatorName && opts.coordinatorName.trim()
    ? `${opts.coordinatorName.trim()} step in`
    : 'the team step in'
  return `\n\n—\nI'm ${opts.aiName}, ${opts.venueName}'s ${role}. Type "I'd like a human" any time and I'll have ${stepIn}.`
}

/** Route a chat human-request to the coordinator. Mirrors the email
 *  pipeline's humanRequested fast-path: writes an engagement_events row
 *  + an admin_notifications row, both best-effort. The sage-conversation
 *  message rows are still the responsibility of the caller (the route),
 *  same way the email-pipeline still owns the interaction insert.
 *
 *  Returns the canned response the route should send to the couple. */
export async function routeChatToHuman(opts: {
  venueId: string
  weddingId: string | null
  message: string
  conversationId?: string | null
  aiName?: string | null
}): Promise<string> {
  const supabase = createServiceClient()
  const aiName = opts.aiName?.trim() || 'I'

  try {
    // engagement_events — direction='inbound', points=0 (this is not a
    // heat signal). Best-effort. Bare insert (not heat-mapping batch)
    // because we don't want to recalculate heat scores for a chat
    // escalation.
    const ePayload: Record<string, unknown> = {
      venue_id: opts.venueId,
      wedding_id: opts.weddingId,
      event_type: 'human_requested',
      direction: 'inbound',
      points: 0,
      occurred_at: new Date().toISOString(),
      metadata: {
        via: 'sage_chat',
        message_excerpt: opts.message.slice(0, 240),
        conversation_id: opts.conversationId ?? null,
      },
    }
    await supabase.from('engagement_events').insert(ePayload)
  } catch (err) {
    console.warn('[sage-brain] human_requested engagement_event insert failed:', err)
  }

  try {
    await createNotification({
      venueId: opts.venueId,
      weddingId: opts.weddingId ?? undefined,
      type: 'human_requested',
      title: `Human requested in ${aiName} chat`,
      body: JSON.stringify({
        weddingId: opts.weddingId,
        conversationId: opts.conversationId ?? null,
        excerpt: opts.message.slice(0, 240),
        via: 'sage_chat',
      }),
    })
  } catch (err) {
    console.warn('[sage-brain] human_requested notification failed:', err)
  }

  // Canned response. Stays warm, names the next step explicitly so the
  // couple knows the message landed somewhere a human will see.
  return (
    `Got it — I'm flagging this for your coordinator right now. ` +
    `They'll see your message shortly and follow up directly. ` +
    `In the meantime feel free to share any context that'd help them respond faster.`
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SageResponseOptions {
  venueId: string
  weddingId: string
  message: string
  conversationHistory: Array<{ role: string; content: string }>
  taskType?: string
  /** Optional file context (extracted text or description) injected into the prompt */
  fileContext?: string
}

export interface SageResponse {
  response: string
  confidence: number
  tokensUsed: number
  cost: number
  /** Whether the knowledge base had relevant matches */
  kbMatch: boolean
  /** The AI assistant name configured for this venue (e.g. "Sage") */
  aiName: string
  /** First name of partner_1, if available */
  coupleFirstName: string | null
}

interface WeddingContext {
  coupleName: string
  partnerName: string | null
  eventDate: string | null
  guestCount: number | null
  venueName: string
  status: string
  timelineItems: number
  budgetTotal: number | null
  budgetSpent: number | null
  checklistTotal: number
  checklistComplete: number
}

// ---------------------------------------------------------------------------
// Wedding context loader
// ---------------------------------------------------------------------------

/**
 * Loads wedding details, timeline items, budget summary, guest count,
 * and checklist progress for use as Sage context.
 */
export async function getWeddingContext(weddingId: string): Promise<WeddingContext | null> {
  const supabase = createServiceClient()

  // Load wedding + venue (using actual schema column names)
  const { data: wedding, error: weddingError } = await supabase
    .from('weddings')
    .select(`
      id,
      status,
      wedding_date,
      guest_count_estimate,
      venue_id,
      venues ( name )
    `)
    .eq('id', weddingId)
    .maybeSingle()

  if (weddingError || !wedding) return null

  // Load primary contacts (partner1 + partner2)
  const { data: people } = await supabase
    .from('people')
    .select('first_name, last_name, role')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2'])
    .order('role', { ascending: true })
    .limit(2)

  const partner1 = people?.find((p) => p.role === 'partner1') ?? people?.[0]
  const partner2 = people?.find((p) => p.role === 'partner2') ?? people?.[1]

  // Load wedding budget config (total_budget lives on wedding_config, not weddings)
  const { data: weddingConfig } = await supabase
    .from('wedding_config')
    .select('total_budget')
    .eq('wedding_id', weddingId)
    .maybeSingle()

  // Load timeline count
  const { count: timelineCount } = await supabase
    .from('timeline')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)

  // Load budget summary from budget_items (not the dead `budget` table)
  const { data: budgetItems } = await supabase
    .from('budget_items')
    .select('budgeted, paid')
    .eq('wedding_id', weddingId)

  let budgetSpent = 0
  if (budgetItems) {
    for (const item of budgetItems) {
      budgetSpent += (item.paid as number) ?? 0
    }
  }

  // Load checklist progress (checklist_items table, not timeline)
  const { count: checklistTotal } = await supabase
    .from('checklist_items')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)

  const { count: checklistComplete } = await supabase
    .from('checklist_items')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .eq('is_completed', true)

  const venueName =
    (wedding.venues as unknown as { name: string } | null)?.name ?? 'the venue'

  return {
    coupleName: partner1
      ? `${partner1.first_name} ${partner1.last_name}`
      : 'the couple',
    partnerName: partner2
      ? `${partner2.first_name} ${partner2.last_name}`
      : null,
    eventDate: wedding.wedding_date as string | null,
    guestCount: wedding.guest_count_estimate as number | null,
    venueName,
    status: wedding.status as string,
    timelineItems: timelineCount ?? 0,
    budgetTotal: (weddingConfig?.total_budget as number | null) ?? null,
    budgetSpent: budgetSpent > 0 ? budgetSpent : null,
    checklistTotal: checklistTotal ?? 0,
    checklistComplete: checklistComplete ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Confidence assessment
// ---------------------------------------------------------------------------

/**
 * Returns 0-100 confidence score.
 * - High (80-100): KB directly answers the question
 * - Medium (50-79): General venue knowledge applies
 * - Low (0-49): Hedging language detected or no KB match
 */
export function assessConfidence(response: string, kbMatch: boolean): number {
  const lower = response.toLowerCase()

  // Hedging language reduces confidence
  const hedgingPhrases = [
    "i'm not entirely sure",
    "i'm not sure",
    'i believe',
    'i think',
    'you may want to check',
    'you might want to ask',
    'i would recommend checking with',
    "i'd suggest reaching out",
    "i don't have that specific",
    'not certain',
    'double check',
    'double-check',
    'confirm with',
  ]

  let hedgingCount = 0
  for (const phrase of hedgingPhrases) {
    if (lower.includes(phrase)) hedgingCount++
  }

  if (kbMatch && hedgingCount === 0) return 95
  if (kbMatch && hedgingCount === 1) return 80
  if (kbMatch) return 65
  if (hedgingCount === 0) return 70
  if (hedgingCount === 1) return 50
  if (hedgingCount === 2) return 35
  return 20
}

// ---------------------------------------------------------------------------
// Personality loader
// ---------------------------------------------------------------------------

async function loadPersonalityData(venueId: string): Promise<PersonalityData> {
  const supabase = createServiceClient()

  const [
    aiConfigResult,
    venueResult,
    venueConfigResult,
    uspsResult,
    seasonalResult,
    voicePrefsResult,
  ] = await Promise.all([
    supabase
      .from('venue_ai_config')
      .select('*')
      .eq('venue_id', venueId)
      .single(),
    supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .maybeSingle(),
    supabase
      .from('venue_config')
      .select('coordinator_phone, coordinator_email, business_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
    supabase
      .from('venue_usps')
      .select('usp_text')
      .eq('venue_id', venueId)
      .order('sort_order', { ascending: true }),
    supabase
      .from('venue_seasonal_content')
      .select('season, imagery, phrases')
      .eq('venue_id', venueId),
    // Voice training outputs (banned/approved phrases + dimension scores).
    // Inquiry-brain has always loaded these; portal-brain silently skipped
    // them until now, so coordinators' voice training never reached the
    // couple-facing Sage and personality drifted across the two paths.
    supabase
      .from('voice_preferences')
      .select('preference_type, content, score')
      .eq('venue_id', venueId),
  ])

  const config = (aiConfigResult.data as Record<string, unknown>) ?? {}
  const venue = venueResult.data ?? {}
  const venueConfig = venueConfigResult.data ?? {}
  const usps = (uspsResult.data ?? []).map((u) => u.usp_text as string)

  const seasonal: Record<string, { imagery?: string[]; phrases?: string[] }> = {}
  for (const row of seasonalResult.data ?? []) {
    // `imagery` is stored as text (single string) in the DB; normalize to array.
    // `phrases` is stored as text[] and comes back as an array already.
    const rawImagery = row.imagery as unknown
    const imageryArr: string[] = Array.isArray(rawImagery)
      ? (rawImagery as string[])
      : typeof rawImagery === 'string' && rawImagery.length > 0
        ? [rawImagery]
        : []
    const rawPhrases = row.phrases as unknown
    const phrasesArr: string[] = Array.isArray(rawPhrases)
      ? (rawPhrases as string[])
      : typeof rawPhrases === 'string' && rawPhrases.length > 0
        ? [rawPhrases]
        : []
    seasonal[row.season as string] = {
      imagery: imageryArr,
      phrases: phrasesArr,
    }
  }

  // Parse voice_preferences the same way inquiry-brain does so
  // buildPersonalityPrompt receives a matching shape and produces
  // consistent voice guidance across inquiry-, client-, and portal-Sage.
  const bannedPhrases: string[] = []
  const approvedPhrases: string[] = []
  const dimensions: Record<string, number> = {}
  for (const pref of voicePrefsResult.data ?? []) {
    const type = pref.preference_type as string
    const content = pref.content as string
    const score = (pref.score as number) ?? 0
    if (type === 'banned_phrase') bannedPhrases.push(content)
    else if (type === 'approved_phrase') approvedPhrases.push(content)
    else if (type === 'dimension') dimensions[content] = score
  }

  // T5-Rixey-FFF: portal-Sage chat sign-off uses the same structured
  // builder as the email brains so a couple seeing Sage's "About me"
  // panel or any rare email-shaped output never gets a hallucinated
  // role title or tagline. The aiName here is best-effort
  // (`config.ai_name as string` may be undefined for rows pre-162) —
  // we tolerate it because portal-Sage isn't an outbound email path
  // and never assembles into RFC822, so a missing aiName degrades the
  // signoff to '<venue>' rather than throwing.
  const aiName = ((config.ai_name as string | undefined)?.trim()) || 'your AI assistant'
  const aiEmoji = ((config.ai_emoji as string | undefined) ?? '')
  const venueName = ((venue as { name?: string }).name as string | undefined) ?? 'the venue'
  const structuredSignoff = buildSignoffBlock({
    aiName,
    aiEmoji,
    aiRoleTitle: (config.ai_role_title as string | null) ?? null,
    venueName,
    signatureTagline: (config.signature_tagline as string | null) ?? null,
    signatureWebsite: (config.signature_website as string | null) ?? null,
    signaturePhone:
      ((config.signature_phone as string | null) ?? null) ||
      (((venueConfig as { coordinator_phone?: string | null }).coordinator_phone as string | null) ?? null),
    signatureCloser: (config.signature_closer as string | null) ?? null,
    signatureTextCapable: (config.signature_text_capable as boolean | null) ?? false,
  })

  return {
    config: config as PersonalityData['config'],
    venue: venue as PersonalityData['venue'],
    venue_config: venueConfig as PersonalityData['venue_config'],
    usps,
    seasonal,
    signoff: structuredSignoff,
    voice_preferences:
      bannedPhrases.length > 0 || approvedPhrases.length > 0 || Object.keys(dimensions).length > 0
        ? { banned_phrases: bannedPhrases, approved_phrases: approvedPhrases, dimensions }
        : undefined,
  }
}

// ---------------------------------------------------------------------------
// Main response generator
// ---------------------------------------------------------------------------

/**
 * Builds the full Sage prompt and generates a response:
 *   - Layer 1: Universal rules
 *   - Layer 2: Personality (venue voice)
 *   - Layer 3: Sage task prompt
 *   - Layer 4: Intelligence context + KB results + wedding context
 */
export async function generateSageResponse(
  options: SageResponseOptions
): Promise<SageResponse> {
  const { venueId, weddingId, message, conversationHistory, taskType, fileContext } = options

  // Load all context in parallel
  const [personalityData, intelligenceContext, kbResults, weddingContext] =
    await Promise.all([
      loadPersonalityData(venueId),
      buildSageIntelligenceContext(venueId),
      searchKnowledgeBase(venueId, message),
      getWeddingContext(weddingId),
    ])

  // Build prompt layers. Extract aiName up-front so the task prompt's
  // {AI_NAME} substitution honors the venue's configured name. Pre-fix
  // task-prompts-sage hardcoded "Sage" in TASK_WELCOME, so every venue
  // welcomed couples as if they were Rixey — INV-4.4-A violation.
  // T5-β.1: ai_name is required — throw rather than default to "Sage".
  const aiNameForTask = requireAiName(
    personalityData.config as { ai_name?: string | null },
    venueId
  )
  const personalityPrompt = buildPersonalityPrompt(personalityData)
  const taskPrompt = getSageTaskPrompt(taskType ?? 'couple_question', aiNameForTask)

  // Format KB results for context
  let kbContext = ''
  const kbMatch = kbResults.length > 0
  if (kbMatch) {
    const topResults = kbResults.slice(0, 5)
    const kbLines = topResults.map(
      (entry) => `Q: ${entry.question}\nA: ${entry.answer}`
    )
    kbContext = `\n--- KNOWLEDGE BASE MATCHES ---\nUse these answers when relevant. Cite them naturally, don't say "according to our KB".\n\n${kbLines.join('\n\n')}\n--- END KB ---\n`
  }

  // Format wedding context
  let weddingBlock = ''
  if (weddingContext) {
    const parts: string[] = []
    parts.push(`Couple: ${weddingContext.coupleName}`)
    if (weddingContext.partnerName) {
      parts.push(`Partner: ${weddingContext.partnerName}`)
    }
    if (weddingContext.eventDate) {
      parts.push(`Wedding date: ${weddingContext.eventDate}`)
    }
    if (weddingContext.guestCount) {
      parts.push(`Guest count: ${weddingContext.guestCount}`)
    }
    parts.push(`Status: ${weddingContext.status}`)
    parts.push(`Venue: ${weddingContext.venueName}`)

    if (weddingContext.timelineItems > 0) {
      parts.push(`Timeline items: ${weddingContext.timelineItems}`)
    }
    if (weddingContext.budgetTotal) {
      const spent = weddingContext.budgetSpent
        ? ` ($${weddingContext.budgetSpent.toLocaleString()} spent)`
        : ''
      parts.push(`Budget: $${weddingContext.budgetTotal.toLocaleString()}${spent}`)
    }
    if (weddingContext.checklistTotal > 0) {
      parts.push(
        `Checklist: ${weddingContext.checklistComplete}/${weddingContext.checklistTotal} complete`
      )
    }

    weddingBlock = `\n--- WEDDING CONTEXT ---\n${parts.join('\n')}\n--- END WEDDING CONTEXT ---\n`
  }

  // Build file context block (for uploaded files or contract text)
  let fileContextBlock = ''
  if (fileContext) {
    fileContextBlock = `\n--- ATTACHED FILE CONTEXT ---\nThe user has attached a file or is asking about a specific contract. Here is the content:\n\n${fileContext}\n\nAnswer questions about this file in the context of their wedding planning. Be specific about dates, amounts, and terms you find in the document.\n--- END FILE CONTEXT ---\n`
  }

  // Assemble full system prompt
  const systemPrompt = [
    UNIVERSAL_RULES,
    personalityPrompt,
    taskPrompt,
    weddingBlock,
    kbContext,
    intelligenceContext,
    fileContextBlock,
  ]
    .filter(Boolean)
    .join('\n\n')

  // Build messages array with conversation history. The assistant role
  // label MUST use the venue's configured ai_name — feeding the literal
  // "Sage:" into the transcript would brand-leak across venues (T5-β.3).
  //
  // Prompt-injection containment (audit Lens 8 #3): every couple-
  // authored message is sanitized for role-prefix spoofing and system-
  // tag injection. The current message is wrapped in explicit markers
  // so the model has a hard boundary between trusted instructions and
  // untrusted user data. Assistant turns are NOT sanitized (they're
  // model output, already trusted).
  const { sanitizeUserContent, wrapUntrustedContent, containsInjectionAttempt } =
    await import('@/lib/security/prompt-sanitize')

  // Track sanitizer telemetry across the whole transcript so a single
  // log line per request surfaces what was stripped vs detected.
  // Round-3 + round-4 audits flagged that rolePrefixStripped /
  // systemTagStripped were computed but never consumed.
  let anyRolePrefixStripped = false
  let anySystemTagStripped = false

  const messages = conversationHistory
    .map((msg) => {
      if (msg.role === 'user') {
        const sanitized = sanitizeUserContent(msg.content)
        if (sanitized.rolePrefixStripped) anyRolePrefixStripped = true
        if (sanitized.systemTagStripped) anySystemTagStripped = true
        return `Couple: ${sanitized.content}`
      }
      return `${aiNameForTask}: ${msg.content}`
    })
    .join('\n\n')

  const wrappedCurrent = wrapUntrustedContent(message, 'couple_message').wrapped
  // Run sanitize on the current message too so the telemetry covers it.
  const currentSanitized = sanitizeUserContent(message)
  if (currentSanitized.rolePrefixStripped) anyRolePrefixStripped = true
  if (currentSanitized.systemTagStripped) anySystemTagStripped = true

  const userPrompt = messages
    ? `${messages}\n\nCouple just sent the following message:\n${wrappedCurrent}`
    : `Couple just sent the following message:\n${wrappedCurrent}`

  // Log telemetry — strip events at WARN, injection attempts at WARN.
  // Don't block; wrapping contains attacks. False positives don't
  // affect chat output.
  const injectionDetected = containsInjectionAttempt(message)
  if (injectionDetected || anyRolePrefixStripped || anySystemTagStripped) {
    console.warn('[sage-brain] prompt-sanitize signals on couple message', {
      venueId,
      length: message.length,
      injectionDetected,
      rolePrefixStripped: anyRolePrefixStripped,
      systemTagStripped: anySystemTagStripped,
    })
  }

  // Generate response. Tier 1: sage-brain's intelligence context can
  // include family-context Sage notes (sage_context_notes records
  // health, finances, family dynamics) and the wedding's planning
  // state (vendors, budget, dates). All tier-1 PII per Playbook
  // 21.3.1. OpenAI fallback uses store:false; api_costs records the
  // tier tag for the ZDR audit. OPS-21.3.5.
  const result = await callAI({
    systemPrompt,
    userPrompt,
    maxTokens: 1500,
    temperature: 0.4,
    venueId,
    taskType: taskType ?? 'sage_chat',
    contentTier: 1,
    promptVersion: BRAIN_PROMPT_VERSION,
  })

  const confidence = assessConfidence(result.text, kbMatch)

  // Stream EEEE: chat-surface parity with the email footer. Every
  // response Sage gives in the couple portal ends with the same
  // sign-off + escalation reminder as the email disclosure. Idempotent
  // — if the model accidentally added the marker phrase already
  // (extremely rare but cheap to guard), don't double-append.
  const cfg = personalityData.config as {
    ai_role?: string | null
  }
  const venueName = (personalityData.venue as { name?: string | null }).name?.trim() || 'the venue'
  const coordinatorName =
    (personalityData.venue_config as { coordinator_name?: string | null }).coordinator_name ?? null
  const signoff = buildChatSignoff({
    aiName: aiNameForTask,
    venueName,
    aiRole: cfg.ai_role ?? null,
    coordinatorName,
  })
  const responseWithSignoff = result.text.includes('Type "I\'d like a human"')
    ? result.text
    : `${result.text.trimEnd()}${signoff}`

  return {
    response: responseWithSignoff,
    confidence,
    tokensUsed: result.inputTokens + result.outputTokens,
    cost: result.cost,
    kbMatch,
    // Reuses aiNameForTask extracted up-front so the SageResponse name
    // matches what the task prompt was built with. requireAiName
    // throws on empty so this is always non-null. T5-β.1.
    aiName: aiNameForTask,
    coupleFirstName: weddingContext?.coupleName?.split(' ')[0] ?? null,
  }
}
