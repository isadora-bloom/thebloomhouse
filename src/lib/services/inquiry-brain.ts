/**
 * Bloom House: Inquiry Brain
 *
 * Generates draft responses for new inquiries and inquiry replies.
 * Uses the 4-layer personality engine:
 *   Layer 1: Universal rules (all venues)
 *   Layer 2: Personality prompt (venue-specific voice)
 *   Layer 3: Task prompt (what to do with this email)
 *   Layer 4: Context (knowledge base, availability, extracted data)
 *
 * Responsibilities:
 * - Generate first-response drafts for new inquiries
 * - Generate reply drafts for ongoing inquiry conversations
 * - Generate follow-up emails (3-day, 7-day, final)
 */

import { callAI } from '@/lib/ai/client'
import { buildPersonalityPrompt, type PersonalityData } from '@/lib/ai/personality-builder'
import { resolveSageIdentity, renderOpenerConstraints } from '@/lib/services/sage-identity'
import { selectPhrase } from '@/lib/ai/phrase-selector'
import { createServiceClient } from '@/lib/supabase/service'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { getTaskPrompt } from '@/config/prompts/task-prompts-inquiry'
import { searchKnowledgeBase } from '@/lib/services/knowledge-base'
import { buildSageIntelligenceContext } from '@/lib/services/sage-intelligence'
import { getApprovedPhrases } from '@/lib/services/review-language'
import { getLearningContext, getVoicePreferences } from '@/lib/services/learning'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InquiryDraftOptions {
  venueId: string
  contactEmail: string
  inquiry: {
    from: string
    subject: string
    body: string
  }
  extractedData: {
    questions: string[]
    eventDate?: string
    guestCount?: number
  }
  taskType?: string
  /**
   * Inquiry source (detected by the form-relay parsers or defaulted to
   * 'direct'). Surfaced to the model so first-touch replies can acknowledge
   * the specific discovery channel (The Knot, WeddingWire, HCTG, Zola, the
   * venue's own website) rather than answering every couple identically.
   * Values: 'the_knot' | 'wedding_wire' | 'here_comes_the_guide' | 'zola'
   *       | 'website' | 'direct' | (legacy) any other free-form string
   */
  source?: string
}

export interface FollowUpOptions {
  venueId: string
  contactEmail: string
  weddingId: string
  daysSinceLastContact: number
}

export interface DraftResult {
  draft: string
  confidence: number
  tokensUsed: number
  cost: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load the full personality data from the database for a venue.
 * Assembles venue_ai_config, venue info, USPs, seasonal content,
 * and voice preferences into the PersonalityData shape.
 */
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
      .single(),
    supabase
      .from('venue_config')
      .select('business_name, coordinator_name, coordinator_email, coordinator_phone, calendly_link')
      .eq('venue_id', venueId)
      .single(),
    supabase
      .from('venue_usps')
      .select('usp_text')
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    supabase
      .from('venue_seasonal_content')
      .select('season, imagery, phrases')
      .eq('venue_id', venueId),
    supabase
      .from('voice_preferences')
      .select('preference_type, content, score')
      .eq('venue_id', venueId),
  ])

  const aiConfig = aiConfigResult.data ?? {}
  const venue = venueResult.data
  const venueConfig = venueConfigResult.data
  const usps = (uspsResult.data ?? []).map((r) => r.usp_text as string)

  // Build seasonal content map
  const seasonal: Record<string, { imagery?: string[]; phrases?: string[] }> = {}
  for (const row of seasonalResult.data ?? []) {
    const s = row.season as string
    seasonal[s] = {
      imagery: row.imagery ? [row.imagery as string] : undefined,
      phrases: (row.phrases as string[]) ?? undefined,
    }
  }

  // Build voice preferences
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

  // Build sign-off
  const aiName = (aiConfig.ai_name as string) ?? 'Sage'
  const aiEmoji = (aiConfig.ai_emoji as string) ?? ''
  const venueName = (venue?.name as string) ?? 'the venue'
  const signoff = `${aiEmoji ? aiEmoji + ' ' : ''}${aiName}\n${venueName}`

  return {
    config: aiConfig,
    venue: {
      name: venueName,
    },
    venue_config: {
      business_name: (venueConfig?.business_name as string) ?? undefined,
      coordinator_phone: (venueConfig?.coordinator_phone as string) ?? undefined,
      coordinator_email: (venueConfig?.coordinator_email as string) ?? undefined,
    },
    owner_name: (aiConfig.owner_name as string) ?? (venueConfig?.coordinator_name as string) ?? undefined,
    usps,
    seasonal,
    signoff,
    voice_preferences:
      bannedPhrases.length > 0 || approvedPhrases.length > 0 || Object.keys(dimensions).length > 0
        ? { banned_phrases: bannedPhrases, approved_phrases: approvedPhrases, dimensions }
        : undefined,
  }
}

/**
 * Check if a specific date is available at the venue.
 * Returns availability info and nearby alternative dates if booked.
 */
async function checkDateAvailability(
  venueId: string,
  dateStr: string
): Promise<{ available: boolean; alternatives: string[] }> {
  const supabase = createServiceClient()

  // Parse the date — if it's vague (e.g. "Fall 2026"), skip availability check
  const parsed = Date.parse(dateStr)
  if (isNaN(parsed)) {
    return { available: true, alternatives: [] }
  }

  const targetDate = new Date(parsed)
  const dateOnly = targetDate.toISOString().split('T')[0]

  // Check the full weekend (Friday through Sunday)
  const dayOfWeek = targetDate.getDay()
  const friday = new Date(targetDate)
  friday.setDate(friday.getDate() - ((dayOfWeek + 2) % 7))
  const sunday = new Date(friday)
  sunday.setDate(sunday.getDate() + 2)

  const fridayStr = friday.toISOString().split('T')[0]
  const sundayStr = sunday.toISOString().split('T')[0]

  // venue_availability is the source of truth for date status.
  // A date counts as unavailable when: status in ('booked','blocked') OR
  // booked_count has reached max_events (cap hit). Coordinator-held dates
  // ('hold') also block Sage from promising availability — see Task 12.
  const { data: availRows } = await supabase
    .from('venue_availability')
    .select('date, status, booked_count, max_events')
    .eq('venue_id', venueId)
    .gte('date', fridayStr)
    .lte('date', sundayStr)

  const isDateUnavailable = (row: { status: string; booked_count: number; max_events: number }) =>
    row.status === 'booked' ||
    row.status === 'blocked' ||
    row.status === 'hold' ||
    row.booked_count >= row.max_events

  const isBooked = (availRows ?? []).some(
    (d) => d.date === dateOnly && isDateUnavailable(d as {
      status: string; booked_count: number; max_events: number
    })
  )

  if (!isBooked) {
    return { available: true, alternatives: [] }
  }

  // Find nearby available weekends (2 weeks before and after)
  const searchStart = new Date(targetDate)
  searchStart.setDate(searchStart.getDate() - 14)
  const searchEnd = new Date(targetDate)
  searchEnd.setDate(searchEnd.getDate() + 14)

  const { data: nearbyBlocked } = await supabase
    .from('venue_availability')
    .select('date, status, booked_count, max_events')
    .eq('venue_id', venueId)
    .gte('date', searchStart.toISOString().split('T')[0])
    .lte('date', searchEnd.toISOString().split('T')[0])

  const bookedSet = new Set(
    (nearbyBlocked ?? [])
      .filter((d) =>
        isDateUnavailable(d as { status: string; booked_count: number; max_events: number })
      )
      .map((d) => d.date as string)
  )

  // Suggest nearby Saturdays that aren't booked
  const alternatives: string[] = []
  for (let offset = -14; offset <= 14; offset += 7) {
    if (offset === 0) continue
    const alt = new Date(targetDate)
    alt.setDate(alt.getDate() + offset)
    // Find the Saturday of that week
    const altDay = alt.getDay()
    alt.setDate(alt.getDate() + (6 - altDay))
    const altStr = alt.toISOString().split('T')[0]
    if (!bookedSet.has(altStr)) {
      alternatives.push(altStr)
    }
  }

  return { available: false, alternatives: alternatives.slice(0, 3) }
}

/**
 * Determine the season from a date string for seasonal language.
 */
function getSeasonFromDate(dateStr?: string): string {
  if (!dateStr) return 'unknown'

  const parsed = Date.parse(dateStr)
  if (isNaN(parsed)) {
    const lower = dateStr.toLowerCase()
    if (lower.includes('spring')) return 'spring'
    if (lower.includes('summer')) return 'summer'
    if (lower.includes('fall') || lower.includes('autumn')) return 'fall'
    if (lower.includes('winter')) return 'winter'
    return 'unknown'
  }

  const month = new Date(parsed).getMonth()
  if (month >= 2 && month <= 4) return 'spring'
  if (month >= 5 && month <= 7) return 'summer'
  if (month >= 8 && month <= 10) return 'fall'
  return 'winter'
}

// ---------------------------------------------------------------------------
// generateInquiryDraft
// ---------------------------------------------------------------------------

/**
 * Generate a draft response for a new inquiry or inquiry reply.
 *
 * Steps:
 * 1. Build personality prompt from venue_ai_config (Layer 1 + 2)
 * 2. Search knowledge base for relevant answers to detected questions
 * 3. Check date availability if event date provided
 * 4. Select a fresh greeting phrase (anti-duplication)
 * 5. Combine with task prompt (Layer 3)
 * 6. Call AI to generate the draft
 */
export async function generateInquiryDraft(
  options: InquiryDraftOptions
): Promise<DraftResult> {
  const {
    venueId,
    contactEmail,
    inquiry,
    extractedData,
    taskType = 'new_inquiry',
    source,
  } = options

  // Step 1: Load personality data and build Layer 1 + 2 prompt
  const personalityData = await loadPersonalityData(venueId)
  const personalityPrompt = buildPersonalityPrompt(personalityData)
  const phraseStyle = (personalityData.config.phrase_style as string) ?? 'warm'

  // Step 2: Search knowledge base for answers to detected questions
  let kbContext = ''
  if (extractedData.questions.length > 0) {
    const searchQuery = extractedData.questions.join(' ')
    const kbResults = await searchKnowledgeBase(venueId, searchQuery)

    if (kbResults.length > 0) {
      const kbLines = kbResults.slice(0, 5).map(
        (entry) => `Q: ${entry.question}\nA: ${entry.answer}`
      )
      kbContext = `\n\n## KNOWLEDGE BASE (Use these to answer their questions accurately):\n\n${kbLines.join('\n\n')}`
    }
  }

  // Step 3: Check date availability
  let availabilityContext = ''
  if (extractedData.eventDate) {
    const availability = await checkDateAvailability(venueId, extractedData.eventDate)

    if (availability.available) {
      availabilityContext = `\n\n## DATE AVAILABILITY:\nThe requested date (${extractedData.eventDate}) is AVAILABLE.`
    } else {
      const altText = availability.alternatives.length > 0
        ? `\nAlternative available dates: ${availability.alternatives.join(', ')}`
        : ''
      availabilityContext = `\n\n## DATE AVAILABILITY:\nThe requested date (${extractedData.eventDate}) is BOOKED.${altText}`
    }
  }

  // Step 4: Select a fresh greeting phrase (anti-duplication)
  const venueName = personalityData.venue.name ?? 'the venue'
  const ownerName = personalityData.owner_name ?? 'the team'
  const aiName = (personalityData.config.ai_name as string) ?? 'Sage'

  const templateVars = {
    venue_name: venueName,
    owner_name: ownerName,
    ai_name: aiName,
  }

  const greeting = taskType === 'new_inquiry'
    ? await selectPhrase({
        venueId,
        contactEmail,
        category: 'ai_introduction',
        style: phraseStyle,
        templateVars,
      })
    : ''

  // Step 5: Build the task prompt (Layer 3)
  const taskPrompt = getTaskPrompt(taskType)

  // Step 6: Build context block (Layer 4)
  const season = getSeasonFromDate(extractedData.eventDate)
  let contextBlock = `\n\n## INCOMING EMAIL:\n\nFrom: ${inquiry.from}\nSubject: ${inquiry.subject}\n\n${inquiry.body.slice(0, 3000)}`

  contextBlock += `\n\n## EXTRACTED DATA:\n- Questions detected: ${extractedData.questions.length > 0 ? extractedData.questions.join('; ') : 'None specific'}`
  if (extractedData.eventDate) contextBlock += `\n- Event date: ${extractedData.eventDate}`
  if (extractedData.guestCount) contextBlock += `\n- Guest count: ${extractedData.guestCount}`
  if (season !== 'unknown') contextBlock += `\n- Season: ${season}`

  // Source-specific personalisation. Form relays strip context from the
  // lead — the couple's original message on The Knot isn't in the email we
  // receive, so we shouldn't pretend it was a direct note. Each channel
  // gets a short guidance line so first-touch replies feel channel-aware
  // without parroting a template ("Thanks for reaching out via...").
  if (source) {
    const sourceLabel =
      source === 'the_knot' ? 'The Knot'
      : source === 'wedding_wire' || source === 'weddingwire' ? 'WeddingWire'
      : source === 'here_comes_the_guide' ? 'Here Comes The Guide'
      : source === 'zola' ? 'Zola'
      : source === 'website' ? "the venue's website pricing calculator"
      : source === 'venue_calculator' ? "the venue's pricing calculator"
      : source === 'direct' ? 'a direct email (not a form relay)'
      : source
    contextBlock += `\n- Inquiry source: ${sourceLabel}`

    const sourceGuidance =
      source === 'the_knot' || source === 'wedding_wire' || source === 'weddingwire' || source === 'here_comes_the_guide' || source === 'zola'
        ? `This is a marketplace relay — the couple filled out a short form on ${sourceLabel} and we only see the structured fields, not a personal note. Do NOT respond as if they sent a detailed message; acknowledge the channel lightly if it fits naturally, answer what the fields reveal, and invite them to share more.`
        : source === 'website'
          ? `This came through the venue's own pricing calculator, so the couple has already seen public pricing and engaged enough to hand over contact details. Treat them as warmer than a cold inquiry and reference the calculator context only if it feels natural.`
          : source === 'direct'
            ? `This is a direct email, not a form relay. The couple wrote to us personally — respond to what they actually said in the body above.`
            : null

    if (sourceGuidance) {
      contextBlock += `\n\n## SOURCE GUIDANCE:\n${sourceGuidance}`
    }
  }

  if (greeting) {
    contextBlock += `\n\n## SELECTED GREETING (use this as your AI introduction):\n"${greeting}"`
  }

  // First-touch openers only: inject the per-venue Sage identity constraints
  // (role label, purposes, structural shape). These are CONSTRAINTS, not a
  // template — Claude writes a fresh sentence per couple so no two couples
  // at the same venue get the same opener skeleton.
  if (taskType === 'new_inquiry') {
    const identity = resolveSageIdentity({
      ai_name: personalityData.config.ai_name as string | null,
      ai_role: personalityData.config.ai_role as import('@/lib/supabase/types').SageRole | null,
      ai_purposes: personalityData.config.ai_purposes as string[] | null,
      ai_custom_purpose: personalityData.config.ai_custom_purpose as string | null,
      ai_opener_shape: personalityData.config.ai_opener_shape as import('@/lib/supabase/types').SageOpenerShape | null,
      venue_name: venueName,
    })
    contextBlock += `\n\n${renderOpenerConstraints(identity)}`
  }

  contextBlock += kbContext
  contextBlock += availabilityContext

  // Step 6b: Add intelligence context (trends, weather, demand, review language)
  // Resolve partner1 person_id from the contact email so prior-touchpoint
  // warmth lookups can fire. Best-effort — failure falls back to cold.
  let personId: string | null = null
  try {
    const supabase = createServiceClient()
    const { data: personRows } = await supabase
      .from('people')
      .select('id, role')
      .eq('venue_id', venueId)
      .eq('email', contactEmail.toLowerCase())
      .limit(5)
    if (personRows && personRows.length > 0) {
      const partner1 = personRows.find((p) => p.role === 'partner1')
      personId = (partner1?.id ?? personRows[0].id) as string
    }
  } catch {
    // Warmth enrichment is optional — keep personId null on failure.
  }

  try {
    const intelContext = await buildSageIntelligenceContext(venueId, personId)
    if (intelContext) {
      contextBlock += `\n\n${intelContext}`
    }
  } catch {
    // Intelligence context is enrichment, not critical
  }

  // Step 6c: Add approved review phrases for natural language
  try {
    const reviewPhrases = await getApprovedPhrases(venueId, 'sage')
    const themes = Object.keys(reviewPhrases)
    if (themes.length > 0) {
      const samplePhrases = themes
        .slice(0, 5)
        .flatMap((theme) => reviewPhrases[theme].slice(0, 2).map((p) => `"${p.phrase}"`))
      contextBlock += `\n\n## REAL COUPLE LANGUAGE (weave naturally — these are from actual reviews):\n${samplePhrases.join(', ')}`
    }
  } catch {
    // Review phrases are enrichment, not critical
  }

  // Step 7: Add learning context from past feedback (approved drafts, rejections, edits)
  let learningBlock = ''
  try {
    const [learningContext, voicePrefs] = await Promise.all([
      getLearningContext(venueId, 'inquiry'),
      getVoicePreferences(venueId),
    ])

    const sections: string[] = []

    if (learningContext.goodExamples.length > 0) {
      const examples = learningContext.goodExamples
        .map((ex) => `Subject: ${ex.subject}\n${ex.body.slice(0, 400)}`)
        .join('\n---\n')
      sections.push(`### Approved Draft Examples\nThese drafts were approved by the coordinator. Follow their tone and structure:\n${examples}`)
    }

    if (learningContext.rejectionReasons.length > 0) {
      const reasons = learningContext.rejectionReasons.map((r) => `- ${r}`).join('\n')
      sections.push(`### Patterns to Avoid\nThese are reasons drafts were rejected. Do NOT repeat these mistakes:\n${reasons}`)
    }

    if (learningContext.editPatterns.length > 0) {
      const patterns = learningContext.editPatterns
        .map((p) => `Original: "${p.original.slice(0, 200)}"\nCorrected to: "${p.edited.slice(0, 200)}"`)
        .join('\n---\n')
      sections.push(`### Common Corrections\nThe coordinator typically makes these kinds of edits. Incorporate them upfront:\n${patterns}`)
    }

    if (voicePrefs.bannedPhrases.length > 0) {
      sections.push(`### Banned Phrases\nNEVER use these phrases: ${voicePrefs.bannedPhrases.join(', ')}`)
    }

    if (voicePrefs.approvedPhrases.length > 0) {
      sections.push(`### Approved Phrases\nFeel free to use these phrases naturally: ${voicePrefs.approvedPhrases.join(', ')}`)
    }

    if (sections.length > 0) {
      learningBlock = `\n\n## LEARNING FROM PAST FEEDBACK\n${sections.join('\n\n')}`
    }
  } catch {
    // Learning context is enrichment, not critical
  }

  // Assemble the full system prompt (Layer 1 + 2 + 3 + learning)
  const systemPrompt = `${UNIVERSAL_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${learningBlock}`

  // Call AI
  const result = await callAI({
    systemPrompt,
    userPrompt: contextBlock,
    maxTokens: 1500,
    temperature: 0.4,
    venueId,
    taskType: `inquiry_${taskType}`,
  })

  // Calculate confidence based on data completeness
  let confidence = 75
  if (extractedData.eventDate) confidence += 5
  if (extractedData.guestCount) confidence += 5
  if (extractedData.questions.length > 0) confidence += 5
  if (kbContext) confidence += 5
  if (availabilityContext) confidence += 5
  confidence = Math.min(95, confidence)

  return {
    draft: result.text,
    confidence,
    tokensUsed: result.inputTokens + result.outputTokens,
    cost: result.cost,
  }
}

// ---------------------------------------------------------------------------
// generateFollowUp
// ---------------------------------------------------------------------------

/**
 * Generate a follow-up email for an inquiry that hasn't responded.
 *
 * Adjusts tone based on days elapsed:
 * - 3 days: Gentle check-in (follow_up_3_day)
 * - 7 days: Warmer, adds value (follow_up_3_day with warmer tone)
 * - 14+ days: Final follow-up (follow_up_final)
 */
export async function generateFollowUp(
  options: FollowUpOptions
): Promise<DraftResult> {
  const { venueId, contactEmail, weddingId, daysSinceLastContact } = options

  const supabase = createServiceClient()

  // Load personality
  const personalityData = await loadPersonalityData(venueId)
  const personalityPrompt = buildPersonalityPrompt(personalityData)
  const phraseStyle = (personalityData.config.phrase_style as string) ?? 'warm'

  const venueName = personalityData.venue.name ?? 'the venue'
  const ownerName = personalityData.owner_name ?? 'the team'
  const aiName = (personalityData.config.ai_name as string) ?? 'Sage'

  const templateVars = {
    venue_name: venueName,
    owner_name: ownerName,
    ai_name: aiName,
  }

  // Determine follow-up tier and select appropriate task prompt + phrase
  let taskType: string
  let phraseCategory: string

  if (daysSinceLastContact >= 14) {
    taskType = 'follow_up_final'
    phraseCategory = 'final_follow_up'
  } else {
    taskType = 'follow_up_3_day'
    phraseCategory = 'follow_up_opener'
  }

  const taskPrompt = getTaskPrompt(taskType)

  // Select a fresh follow-up opener phrase
  const openerPhrase = await selectPhrase({
    venueId,
    contactEmail,
    category: phraseCategory,
    style: phraseStyle,
    templateVars,
  })

  // Get wedding context for personalization. Includes brain-dump context
  // notes (Task 28) so Sage's follow-ups reference what the coordinator
  // has observed since the last email.
  const { data: wedding } = await supabase
    .from('weddings')
    .select('wedding_date, guest_count_estimate, source, status, sage_context_notes')
    .eq('id', weddingId)
    .single()

  // Get the last interaction for context
  const { data: lastInteraction } = await supabase
    .from('interactions')
    .select('subject, body_preview, direction')
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: false })
    .limit(1)
    .single()

  // Build context
  let contextBlock = `\n\n## FOLLOW-UP CONTEXT:\n- Days since last contact: ${daysSinceLastContact}`
  if (daysSinceLastContact >= 14) {
    contextBlock += '\n- This is the FINAL follow-up. Be warm and leave the door open.'
  } else if (daysSinceLastContact >= 7) {
    contextBlock += '\n- This is a second check-in. Be warmer, add a new piece of value.'
  } else {
    contextBlock += '\n- This is a gentle first check-in. Keep it light.'
  }

  if (wedding) {
    if (wedding.wedding_date) contextBlock += `\n- Wedding date: ${wedding.wedding_date}`
    if (wedding.guest_count_estimate) contextBlock += `\n- Guest count: ${wedding.guest_count_estimate}`
    if (wedding.source) contextBlock += `\n- Source: ${wedding.source}`

    // Coordinator brain-dump notes (last 14 days). Acknowledge without
    // quoting — these are back-channel observations, not talking points.
    const notes = wedding.sage_context_notes as Array<{
      body?: string
      added_at?: string
    }> | null
    if (Array.isArray(notes) && notes.length > 0) {
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
      const recent = notes
        .filter((n) => {
          const t = n.added_at ? new Date(n.added_at).getTime() : 0
          return t >= cutoff && typeof n.body === 'string' && n.body.trim().length > 0
        })
        .slice(-3)
        .reverse()
      if (recent.length > 0) {
        contextBlock += `\n\nCoordinator notes (confidential — reflect in tone, don't quote):`
        for (const n of recent) {
          contextBlock += `\n- ${(n.body as string).trim()}`
        }
      }
    }
  }

  if (lastInteraction) {
    contextBlock += `\n\n## LAST EMAIL:\nSubject: ${lastInteraction.subject ?? '(no subject)'}\nDirection: ${lastInteraction.direction}\nPreview: ${(lastInteraction.body_preview as string)?.slice(0, 300) ?? ''}`
  }

  if (openerPhrase) {
    contextBlock += `\n\n## SELECTED OPENER (use this to start your email):\n"${openerPhrase}"`
  }

  // Add learning context from past feedback
  let learningBlock = ''
  try {
    const [learningContext, voicePrefs] = await Promise.all([
      getLearningContext(venueId, 'inquiry'),
      getVoicePreferences(venueId),
    ])

    const sections: string[] = []

    if (learningContext.goodExamples.length > 0) {
      const examples = learningContext.goodExamples
        .map((ex) => `Subject: ${ex.subject}\n${ex.body.slice(0, 400)}`)
        .join('\n---\n')
      sections.push(`### Approved Draft Examples\n${examples}`)
    }

    if (learningContext.rejectionReasons.length > 0) {
      const reasons = learningContext.rejectionReasons.map((r) => `- ${r}`).join('\n')
      sections.push(`### Patterns to Avoid\n${reasons}`)
    }

    if (learningContext.editPatterns.length > 0) {
      const patterns = learningContext.editPatterns
        .map((p) => `Original: "${p.original.slice(0, 200)}"\nCorrected to: "${p.edited.slice(0, 200)}"`)
        .join('\n---\n')
      sections.push(`### Common Corrections\n${patterns}`)
    }

    if (voicePrefs.bannedPhrases.length > 0) {
      sections.push(`### Banned Phrases\nNEVER use: ${voicePrefs.bannedPhrases.join(', ')}`)
    }

    if (voicePrefs.approvedPhrases.length > 0) {
      sections.push(`### Approved Phrases\nUse naturally: ${voicePrefs.approvedPhrases.join(', ')}`)
    }

    if (sections.length > 0) {
      learningBlock = `\n\n## LEARNING FROM PAST FEEDBACK\n${sections.join('\n\n')}`
    }
  } catch {
    // Learning context is enrichment, not critical
  }

  const systemPrompt = `${UNIVERSAL_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${learningBlock}`

  const result = await callAI({
    systemPrompt,
    userPrompt: contextBlock,
    maxTokens: 800,
    temperature: 0.4,
    venueId,
    taskType: `follow_up_${daysSinceLastContact >= 14 ? 'final' : daysSinceLastContact >= 7 ? '7day' : '3day'}`,
  })

  // Follow-ups are fairly templated, confidence is generally high
  const confidence = daysSinceLastContact >= 14 ? 85 : 90

  return {
    draft: result.text,
    confidence,
    tokensUsed: result.inputTokens + result.outputTokens,
    cost: result.cost,
  }
}
