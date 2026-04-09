/**
 * Bloom House: Client Brain
 *
 * Generates draft responses for BOOKED clients. Similar structure to
 * inquiry brain but with critical differences:
 *   - NO sales language
 *   - NO tour invitations
 *   - NO pricing discussion
 *   - Focus on service, planning, and logistics
 *
 * Uses the same 4-layer personality engine but with client-specific
 * task prompts (Layer 3) from task-prompts-client.
 */

import { callAI } from '@/lib/ai/client'
import { buildPersonalityPrompt, type PersonalityData } from '@/lib/ai/personality-builder'
import { selectPhrase } from '@/lib/ai/phrase-selector'
import { createServiceClient } from '@/lib/supabase/service'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { CLIENT_RULES, getClientTaskPrompt } from '@/config/prompts/task-prompts-client'
import { searchKnowledgeBase } from '@/lib/services/knowledge-base'
import { buildSageIntelligenceContext } from '@/lib/services/sage-intelligence'
import { getApprovedPhrases } from '@/lib/services/review-language'
import { getLearningContext, getVoicePreferences } from '@/lib/services/learning'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClientDraftOptions {
  venueId: string
  contactEmail: string
  weddingId: string
  message: {
    from: string
    subject: string
    body: string
  }
  taskType: string
}

export interface OnboardingEmailOptions {
  venueId: string
  contactEmail: string
  weddingId: string
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
 * Same as inquiry-brain but shared here to keep files self-contained.
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
 * Load wedding details for context in client responses.
 */
async function loadWeddingContext(weddingId: string): Promise<string> {
  const supabase = createServiceClient()

  const { data: wedding } = await supabase
    .from('weddings')
    .select('wedding_date, guest_count_estimate, status, source, booking_value, notes')
    .eq('id', weddingId)
    .single()

  if (!wedding) return ''

  const parts: string[] = []
  if (wedding.wedding_date) parts.push(`Wedding date: ${wedding.wedding_date}`)
  if (wedding.guest_count_estimate) parts.push(`Guest count: ${wedding.guest_count_estimate}`)
  if (wedding.status) parts.push(`Status: ${wedding.status}`)
  if (wedding.notes) parts.push(`Notes: ${(wedding.notes as string).slice(0, 500)}`)

  // Check how close the wedding is
  if (wedding.wedding_date) {
    const weddingDate = new Date(wedding.wedding_date as string)
    const now = new Date()
    const daysUntil = Math.ceil((weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

    if (daysUntil <= 0) {
      parts.push('** WEDDING DAY OR PAST **')
    } else if (daysUntil <= 7) {
      parts.push(`** WEDDING IS IN ${daysUntil} DAYS — day-of mode **`)
    } else if (daysUntil <= 30) {
      parts.push(`** WEDDING IS IN ${daysUntil} DAYS — final details mode **`)
    } else {
      parts.push(`Days until wedding: ${daysUntil}`)
    }
  }

  // Get the people associated with this wedding
  const { data: people } = await supabase
    .from('people')
    .select('first_name, last_name, role')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2'])

  if (people && people.length > 0) {
    const names = people.map((p) => {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ')
      return `${name} (${p.role})`
    })
    parts.push(`Couple: ${names.join(' & ')}`)
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// generateClientDraft
// ---------------------------------------------------------------------------

/**
 * Generate a draft response to a booked client's message.
 *
 * taskType determines the Layer 3 prompt:
 * - 'client_reply': General reply to a client message
 * - 'client_onboarding': Welcome/onboarding (use generateOnboardingEmail instead)
 * - 'client_vendor': Vendor question/recommendation
 * - 'client_timeline': Timeline and logistics question
 * - 'client_final_details': Final details (wedding within 30 days)
 * - 'client_day_of': Day-of communication
 */
export async function generateClientDraft(
  options: ClientDraftOptions
): Promise<DraftResult> {
  const { venueId, contactEmail, weddingId, message, taskType } = options

  // Load personality (Layer 1 + 2)
  const personalityData = await loadPersonalityData(venueId)
  const personalityPrompt = buildPersonalityPrompt(personalityData)

  // Get task prompt (Layer 3) — client version
  const taskPrompt = getClientTaskPrompt(taskType)

  // Build context (Layer 4)

  // Wedding details
  const weddingContext = await loadWeddingContext(weddingId)

  // Search KB for relevant info based on the message
  let kbContext = ''
  const searchQuery = `${message.subject} ${message.body.slice(0, 300)}`
  const kbResults = await searchKnowledgeBase(venueId, searchQuery)

  if (kbResults.length > 0) {
    const kbLines = kbResults.slice(0, 5).map(
      (entry) => `Q: ${entry.question}\nA: ${entry.answer}`
    )
    kbContext = `\n\n## KNOWLEDGE BASE (Use these for accurate answers):\n\n${kbLines.join('\n\n')}`
  }

  // Build the context block
  let contextBlock = `\n\n## CLIENT'S EMAIL:\n\nFrom: ${message.from}\nSubject: ${message.subject}\n\n${message.body.slice(0, 3000)}`

  if (weddingContext) {
    contextBlock += `\n\n## WEDDING DETAILS:\n${weddingContext}`
  }

  contextBlock += kbContext

  // Intelligence enrichment: add venue intel context (trends, weather, demand, review language)
  // Wrapped in try/catch so enrichment failures never block draft generation.
  try {
    const intelContext = await buildSageIntelligenceContext(venueId)
    if (intelContext) {
      contextBlock += `\n\n${intelContext}`
    }
  } catch {
    // Intelligence context is enrichment, not critical
  }

  // Add approved review phrases for natural language
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

  // Add learning context from past feedback (approved drafts, rejections, edits)
  let learningBlock = ''
  try {
    const [learningContext, voicePrefs] = await Promise.all([
      getLearningContext(venueId, 'client'),
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

  // Assemble the full system prompt (Layer 1 + Client Rules + Layer 2 + Layer 3 + learning)
  const systemPrompt = `${UNIVERSAL_RULES}\n\n${CLIENT_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${learningBlock}`

  const result = await callAI({
    systemPrompt,
    userPrompt: contextBlock,
    maxTokens: 1200,
    temperature: 0.3,
    venueId,
    taskType: `client_${taskType}`,
  })

  // Confidence for client responses is generally high (we know who they are)
  let confidence = 80
  if (weddingContext) confidence += 5
  if (kbContext) confidence += 5
  confidence = Math.min(95, confidence)

  return {
    draft: result.text,
    confidence,
    tokensUsed: result.inputTokens + result.outputTokens,
    cost: result.cost,
  }
}

// ---------------------------------------------------------------------------
// generateOnboardingEmail
// ---------------------------------------------------------------------------

/**
 * Generate a welcome/onboarding email for a newly booked couple.
 *
 * Includes:
 * - Celebration and congratulations
 * - Next steps in the planning process
 * - Introduction to the coordinator
 * - How to get in touch with questions
 * - Sets expectations for the planning journey
 */
export async function generateOnboardingEmail(
  options: OnboardingEmailOptions
): Promise<DraftResult> {
  const { venueId, contactEmail, weddingId } = options

  const supabase = createServiceClient()

  // Load personality
  const personalityData = await loadPersonalityData(venueId)
  const personalityPrompt = buildPersonalityPrompt(personalityData)
  const phraseStyle = (personalityData.config.phrase_style as string) ?? 'warm'

  const venueName = personalityData.venue.name ?? 'the venue'
  const ownerName = personalityData.owner_name ?? 'the team'
  const aiName = (personalityData.config.ai_name as string) ?? 'Sage'

  // Get task prompt for onboarding
  const taskPrompt = getClientTaskPrompt('client_onboarding')

  // Load wedding details
  const weddingContext = await loadWeddingContext(weddingId)

  // Load venue config for coordinator info
  const { data: venueConfig } = await supabase
    .from('venue_config')
    .select('coordinator_name, coordinator_email, coordinator_phone')
    .eq('venue_id', venueId)
    .single()

  // Select a warm closing phrase
  const closingPhrase = await selectPhrase({
    venueId,
    contactEmail,
    category: 'closing_warmth',
    style: phraseStyle,
    templateVars: {
      venue_name: venueName,
      owner_name: ownerName,
      ai_name: aiName,
    },
  })

  // Build context
  let contextBlock = `\n\n## ONBOARDING CONTEXT:\n\nThis couple has JUST BOOKED. Generate a warm welcome/onboarding email.`

  if (weddingContext) {
    contextBlock += `\n\n## WEDDING DETAILS:\n${weddingContext}`
  }

  // Coordinator info
  if (venueConfig) {
    contextBlock += '\n\n## COORDINATOR INFO:'
    if (venueConfig.coordinator_name) {
      contextBlock += `\nCoordinator: ${venueConfig.coordinator_name}`
    }
    if (venueConfig.coordinator_email) {
      contextBlock += `\nEmail: ${venueConfig.coordinator_email}`
    }
    if (venueConfig.coordinator_phone) {
      contextBlock += `\nPhone: ${venueConfig.coordinator_phone}`
    }
  }

  if (closingPhrase) {
    contextBlock += `\n\n## SELECTED CLOSING (weave this in naturally):\n"${closingPhrase}"`
  }

  // Add learning context from past feedback
  let learningBlock = ''
  try {
    const [learningContext, voicePrefs] = await Promise.all([
      getLearningContext(venueId, 'client'),
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

  const systemPrompt = `${UNIVERSAL_RULES}\n\n${CLIENT_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${learningBlock}`

  const result = await callAI({
    systemPrompt,
    userPrompt: contextBlock,
    maxTokens: 1200,
    temperature: 0.4,
    venueId,
    taskType: 'client_onboarding',
  })

  // Onboarding emails are well-structured, high confidence
  return {
    draft: result.text,
    confidence: 90,
    tokensUsed: result.inputTokens + result.outputTokens,
    cost: result.cost,
  }
}
