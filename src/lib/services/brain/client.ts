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
import { detectKbEcho } from '@/lib/security/kb-echo-guard'
import { dedupePeopleByName } from '@/lib/utils/couple-name'
import {
  buildPersonalityPrompt,
  buildSignoffBlock,
  requireAiName,
  type PersonalityData,
} from '@/lib/ai/personality-builder'
import { selectPhrase } from '@/lib/ai/phrase-selector'

/** Prompt revision identifier — see PROMPTS-CHANGELOG.md / OPS-21.5.1.
 *  v1.2 (2026-05-09, Wave 1A): inline `wedding_auto_context` reader
 *  migrated to the canonical `loadAutoContextForWedding` loader so all
 *  brains share one formatter. The "do NOT quote verbatim" inline
 *  instruction was removed — universal-rules SOFT-CONTEXT NOTES POLICY
 *  now carries the rule for every brain that emits the COUPLE'S NOTES
 *  block.
 *  v1.3 (2026-05-09, Wave 4 Phase 3): client-brain folds the forensic
 *  couple_identity_profile into the system prompt. Adds a COUPLE
 *  PROFILE block carrying emotional_truths (sensitive items voice-
 *  shaping only — verbatim evidence_quote NEVER echoed in the draft),
 *  occupations, residence, family_dynamics, vendor_preferences, and
 *  decision_dynamics so Sage drafts feel known. */
export const BRAIN_PROMPT_VERSION = 'client-brain.prompt.v1.3'
import { createServiceClient } from '@/lib/supabase/service'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { CLIENT_RULES, getClientTaskPrompt } from '@/config/prompts/task-prompts-client'
import { searchKnowledgeBase } from '@/lib/services/knowledge-base'
import { buildSageIntelligenceContext } from '@/lib/services/intel/sage-intelligence'
import { getApprovedPhrases } from '@/lib/services/intel/review-language'
import { getLearningContext, getVoicePreferences } from '@/lib/services/learning'
import { VOICE_TRAINING_MIN_SAMPLES } from '@/lib/services/brain/inquiry'
import { loadAutoContextForWedding } from '@/lib/services/identity/auto-context-loader'
import { getStoredCoupleIdentityProfile } from '@/lib/services/identity/reconstruct'
import { buildCoupleProfileBlock } from '@/lib/services/identity/profile-prompt-block'
import { logEvent } from '@/lib/observability/logger'

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
  /**
   * The Gmail address that received this client message (looked up from
   * interactions.gmail_connection_id → gmail_connections.email_address).
   * Sage can reference the inbox when relevant for multi-Gmail venues.
   */
  receivedAtAddress?: string
  /** Correlation id from upstream caller (T1-G). */
  correlationId?: string
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

// Module-level personality cache — keyed by venueId. Venue config and voice
// settings change only when the coordinator updates their profile, so a
// 5-minute TTL eliminates the 6 parallel Supabase queries that loadPersonalityData
// fires on every client draft generation without meaningful staleness risk.
const personalityCache = new Map<string, { data: PersonalityData; expiresAt: number }>()

export async function loadPersonalityDataCached(venueId: string): Promise<PersonalityData> {
  const cached = personalityCache.get(venueId)
  if (cached && Date.now() < cached.expiresAt) return cached.data

  const data = await loadPersonalityData(venueId)

  // Evict stale entries when the cache grows large (>200 venues) to prevent
  // unbounded memory growth in long-running serverless instances.
  if (personalityCache.size > 200) {
    const now = Date.now()
    for (const [k, v] of personalityCache) {
      if (now > v.expiresAt) personalityCache.delete(k)
    }
  }
  personalityCache.set(venueId, { data, expiresAt: Date.now() + 5 * 60 * 1000 })
  return data
}

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

  // Build sign-off. ai_name is required — throw if venue_ai_config is
  // missing rather than silently signing as Sage. T5-β.1.
  //
  // T5-Rixey-FFF (migration 195): structured signoff block built from
  // venue config, replacing the prior two-line concatenation that left
  // Claude to invent the role title / tagline / website / phone line.
  const aiName = requireAiName(aiConfig as { ai_name?: string | null }, venueId)
  const aiEmoji = (aiConfig.ai_emoji as string) ?? ''
  const venueName = (venue?.name as string) ?? 'the venue'
  const signoff = buildSignoffBlock({
    aiName,
    aiEmoji,
    aiRoleTitle: (aiConfig.ai_role_title as string | null) ?? null,
    venueName,
    signatureTagline: (aiConfig.signature_tagline as string | null) ?? null,
    signatureWebsite: (aiConfig.signature_website as string | null) ?? null,
    signaturePhone:
      ((aiConfig.signature_phone as string | null) ?? null) ||
      ((venueConfig?.coordinator_phone as string | null) ?? null),
    signatureCloser: (aiConfig.signature_closer as string | null) ?? null,
    signatureTextCapable: (aiConfig.signature_text_capable as boolean | null) ?? false,
  })

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
    .select('wedding_date, guest_count_estimate, status, source, booking_value, notes, sage_context_notes')
    .eq('id', weddingId)
    .single()

  if (!wedding) return ''

  const parts: string[] = []
  if (wedding.wedding_date) parts.push(`Wedding date: ${wedding.wedding_date}`)
  if (wedding.guest_count_estimate) parts.push(`Guest count: ${wedding.guest_count_estimate}`)
  if (wedding.status) parts.push(`Status: ${wedding.status}`)
  if (wedding.notes) parts.push(`Notes: ${(wedding.notes as string).slice(0, 500)}`)

  // Coordinator observations from the brain-dump feature (Phase 2.5 Task
  // 28). Last 14 days, newest first. These are the unspoken signals the
  // coordinator would have mentioned on a call — weather anxiety, seating
  // stress, family dynamics. Sage should acknowledge them without naming
  // the coordinator as the source.
  const rawNotes = wedding.sage_context_notes as Array<{
    body?: string
    added_at?: string
    source?: string
  }> | null
  if (Array.isArray(rawNotes) && rawNotes.length > 0) {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
    const recent = rawNotes
      .filter((n) => {
        const t = n.added_at ? new Date(n.added_at).getTime() : 0
        return t >= cutoff && typeof n.body === 'string' && n.body.trim().length > 0
      })
      .slice(-5)
      .reverse()
    if (recent.length > 0) {
      const body = recent.map((n) => `- ${(n.body as string).trim()}`).join('\n')
      parts.push(`Coordinator notes (recent, confidential — do not quote verbatim):\n${body}`)
    }
  }

  // Continuous-enrichment auto-context (migration 253). Soft-context the
  // AI extracted from emails / brain-dumps / tour transcripts: life
  // mentions, mood, vendor prefs, dietary, cultural significance.
  // Wave 1A (2026-05-09): migrated to the canonical loader so the
  // COUPLE'S NOTES block matches every other brain and the universal
  // SOFT-CONTEXT NOTES POLICY governs the verbatim-quote rule. The
  // inline "do NOT quote verbatim" hint is gone — universal rule now
  // carries it.
  try {
    const { brainBlock } = await loadAutoContextForWedding(supabase, weddingId)
    if (brainBlock) {
      parts.push(brainBlock)
    }
  } catch {
    // Best-effort. The auto-context is enrichment, not gate-quality
    // signal — failing to load it must not block draft generation.
  }

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
    // T5-Rixey-EEE Bug 1 (defense-in-depth): dedupe by name so AI
    // grounding doesn't see the same human twice (Knot proxy + real
    // Gmail).
    const names = dedupePeopleByName(people).map((p) => {
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
  const { venueId, contactEmail, weddingId, message, taskType, receivedAtAddress, correlationId } = options

  // Load personality (Layer 1 + 2)
  const personalityData = await loadPersonalityDataCached(venueId)
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

  // Surface which Gmail inbox received this message so Sage can reference
  // the correct address when relevant (multi-Gmail venues).
  if (receivedAtAddress) {
    contextBlock += `\n\n## INBOX CONTEXT:\nThis message was received at: ${receivedAtAddress}`
  }

  if (weddingContext) {
    contextBlock += `\n\n## WEDDING DETAILS:\n${weddingContext}`
  }

  contextBlock += kbContext

  // Intelligence enrichment: add venue intel context (trends, weather, demand, review language)
  // Wrapped in try/catch so enrichment failures never block draft generation.
  // Resolve partner1 person_id on this wedding so prior-touchpoint warmth
  // flows into the prompt for returning-client drafts.
  let personId: string | null = null
  try {
    const supabase = createServiceClient()
    const { data: partners } = await supabase
      .from('people')
      .select('id, role')
      .eq('wedding_id', weddingId)
      .in('role', ['partner1', 'partner2'])
    if (partners && partners.length > 0) {
      const partner1 = partners.find((p) => p.role === 'partner1')
      personId = (partner1?.id ?? partners[0].id) as string
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

    // Voice-training threshold — see VOICE_TRAINING_MIN_SAMPLES in
    // inquiry-brain.ts. With <5 trained samples the bias is noise, so
    // we skip the auto-learned feedback and log a structured event.
    // Coordinator-curated banned/approved phrases still inject.
    const goodSampleCount = learningContext.goodExamples.length
    if (goodSampleCount >= VOICE_TRAINING_MIN_SAMPLES) {
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
    } else {
      logEvent({
        level: 'info',
        msg: 'voice_training_below_threshold',
        venueId,
        event_type: 'sage.voice_training',
        outcome: 'skip',
        data: {
          surface: 'client_brain.reply',
          samples: goodSampleCount,
          threshold: VOICE_TRAINING_MIN_SAMPLES,
        },
      })
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

  // Wave 4 Phase 3: load the forensic couple_identity_profile and
  // fold a COUPLE PROFILE block into the system prompt. Best-effort:
  // any failure leaves coupleProfileBlock null and the brain still
  // drafts a competent reply from the existing context. Sensitive
  // emotional truths are voice-shaping only; the formatter omits
  // verbatim sensitive evidence_quote.
  let coupleProfileBlock: string | null = null
  try {
    const stored = await getStoredCoupleIdentityProfile(weddingId)
    coupleProfileBlock = buildCoupleProfileBlock(stored?.profile ?? null, {
      surface: 'coordinator',
    })
  } catch {
    // Forensic profile is enrichment, not a gate. Failure must not
    // block draft generation.
  }

  // Assemble the full system prompt (Layer 1 + Client Rules + Layer 2 + Layer 3 + couple profile + learning)
  const profileSection = coupleProfileBlock ? `\n\n${coupleProfileBlock}` : ''
  const systemPrompt = `${UNIVERSAL_RULES}\n\n${CLIENT_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${profileSection}${learningBlock}`

  const result = await callAI({
    systemPrompt,
    userPrompt: contextBlock,
    maxTokens: 1200,
    temperature: 0.3,
    venueId,
    taskType: `client_${taskType}`,
    promptVersion: BRAIN_PROMPT_VERSION,
    correlationId,
  })

  // KB-echo guard (Tier-B #87). Soft check — see kb-echo-guard.ts for the
  // detection rules. Same wiring as inquiry-brain. Returns matched=false on
  // empty KB so this is safe to run unconditionally.
  if (kbResults.length > 0) {
    const echo = detectKbEcho(result.text, kbResults.slice(0, 5))
    if (echo.matched) {
      logEvent({
        level: 'warn',
        msg: 'client-brain draft echoes KB verbatim',
        venueId,
        correlationId: correlationId ?? null,
        actor: 'system',
        event_type: 'kb_echo_detected',
        // Soft signal, not a failure. 'ok' keeps it out of error
        // dashboards that filter on outcome='fail' for real failures.
        outcome: 'ok',
        data: {
          longest_match_words: echo.longestMatchWords,
          kb_entry_index: echo.kbEntryIndex,
          sample_snippet: echo.sampleSnippet,
          brain: 'client',
          task_type: taskType,
        },
      })
    }
  }

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
  const personalityData = await loadPersonalityDataCached(venueId)
  const personalityPrompt = buildPersonalityPrompt(personalityData)
  const phraseStyle = (personalityData.config.phrase_style as string) ?? 'warm'

  const venueName = personalityData.venue.name ?? 'the venue'
  const ownerName = personalityData.owner_name ?? 'the team'
  const aiName = requireAiName(
    personalityData.config as { ai_name?: string | null },
    venueId
  )

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

    // Voice-training threshold — see VOICE_TRAINING_MIN_SAMPLES in
    // inquiry-brain.ts. Same gating logic as the reply path above.
    const goodSampleCount = learningContext.goodExamples.length
    if (goodSampleCount >= VOICE_TRAINING_MIN_SAMPLES) {
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
    } else {
      logEvent({
        level: 'info',
        msg: 'voice_training_below_threshold',
        venueId,
        event_type: 'sage.voice_training',
        outcome: 'skip',
        data: {
          surface: 'client_brain.onboarding',
          samples: goodSampleCount,
          threshold: VOICE_TRAINING_MIN_SAMPLES,
        },
      })
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

  // Wave 4 Phase 3: same forensic-profile fold as the reply path. The
  // onboarding email lands the moment a couple books, so the profile
  // is at its richest — every reconstructed signal up to booking
  // shapes the warmth of the welcome.
  let onboardingProfileBlock: string | null = null
  try {
    const stored = await getStoredCoupleIdentityProfile(weddingId)
    onboardingProfileBlock = buildCoupleProfileBlock(stored?.profile ?? null, {
      surface: 'coordinator',
    })
  } catch {
    // Forensic profile is enrichment, not a gate.
  }

  const onboardingProfileSection = onboardingProfileBlock
    ? `\n\n${onboardingProfileBlock}`
    : ''
  const systemPrompt = `${UNIVERSAL_RULES}\n\n${CLIENT_RULES}\n\n${personalityPrompt}\n\n${taskPrompt}${onboardingProfileSection}${learningBlock}`

  const result = await callAI({
    systemPrompt,
    userPrompt: contextBlock,
    maxTokens: 1200,
    temperature: 0.4,
    venueId,
    taskType: 'client_onboarding',
    promptVersion: BRAIN_PROMPT_VERSION,
  })

  // Onboarding emails are well-structured, high confidence
  return {
    draft: result.text,
    confidence: 90,
    tokensUsed: result.inputTokens + result.outputTokens,
    cost: result.cost,
  }
}
