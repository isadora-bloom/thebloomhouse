/**
 * Bloom House: Personality Builder (Layer 2)
 * Generates the venue-specific personality prompt from database config.
 *
 * Ported from bloom-agent backend/services/personality_builder.py
 */

import { DEFAULT_SEASONAL_CONTENT } from '@/config/phrase-library'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonalityConfig {
  ai_name?: string
  ai_emoji?: string
  ai_email?: string
  owner_name?: string
  owner_title?: string
  warmth_level?: number
  formality_level?: number
  playfulness_level?: number
  brevity_level?: number
  enthusiasm_level?: number
  uses_contractions?: boolean
  uses_exclamation_points?: boolean
  emoji_level?: string
  phrase_style?: string
  follow_up_style?: string
  max_follow_ups?: number
  escalation_style?: string
  sales_approach?: string
  vibe?: string
  signature_expressions?: string[]
  signature_greeting?: string | null
  signature_closer?: string | null
  tour_booking_link?: string
  pricing_calculator_link?: string
  // Sage identity (migration 059). Optional here because this type is also
  // used before those columns were added; resolveSageIdentity() fills in
  // defaults when these come back null/undefined.
  ai_role?: string
  ai_purposes?: string[]
  ai_custom_purpose?: string | null
  ai_opener_shape?: string
}

export interface VenueInfo {
  name?: string
}

export interface VenueConfig {
  business_name?: string
  coordinator_phone?: string
  coordinator_email?: string
}

export interface SeasonalContent {
  imagery?: string[]
  phrases?: string[]
}

export interface VoicePreferences {
  banned_phrases: string[]
  approved_phrases: string[]
  dimensions: Record<string, number>
}

export interface ReviewVocabulary {
  phrases: string[]
}

export interface PersonalityData {
  config: PersonalityConfig
  venue: VenueInfo
  venue_config: VenueConfig
  owner_name?: string
  usps: string[]
  seasonal: Record<string, SeasonalContent>
  signoff: string
  faqs?: Array<{ question: string; answer: string; category: string }>
  voice_preferences?: VoicePreferences
  review_vocabulary?: ReviewVocabulary
}

// ---------------------------------------------------------------------------
// Defaults (DEFAULT_SEASONAL_CONTENT imported from @/config/phrase-library)
// ---------------------------------------------------------------------------

const DEFAULT_PERSONALITY: PersonalityConfig = {
  ai_name: 'Sage',
  ai_emoji: '',
  ai_email: 'sage@hawthornemanor.com',
  owner_name: 'Isadora',
  owner_title: 'Owner',
  warmth_level: 7,
  formality_level: 4,
  playfulness_level: 5,
  brevity_level: 6,
  enthusiasm_level: 6,
  uses_contractions: true,
  uses_exclamation_points: true,
  emoji_level: 'signoff_only',
  phrase_style: 'warm',
  follow_up_style: 'moderate',
  max_follow_ups: 2,
  escalation_style: 'soft_offer',
  sales_approach: 'consultative',
  vibe: 'romantic_timeless',
  signature_expressions: [],
  signature_greeting: null,
  signature_closer: null,
}

// ---------------------------------------------------------------------------
// Description maps
// ---------------------------------------------------------------------------

const WARMTH_DESCRIPTIONS: Record<number, string> = {
  10: 'extremely warm and effusive',
  9: 'very warm and friendly',
  8: 'warm and welcoming',
  7: 'friendly and approachable',
  6: 'pleasant and helpful',
  5: 'neutral and professional',
  4: 'polite and businesslike',
  3: 'reserved',
  2: 'formal',
  1: 'very formal and distant',
}

const FORMALITY_DESCRIPTIONS: Record<number, string> = {
  10: 'very formal and refined',
  9: 'formal and elegant',
  8: 'professional and polished',
  7: 'business professional',
  6: 'conversational but professional',
  5: 'conversational',
  4: 'casual and relaxed',
  3: 'informal',
  2: 'very casual',
  1: 'extremely casual',
}

// ---------------------------------------------------------------------------
// Build personality prompt
// ---------------------------------------------------------------------------

export function buildPersonalityPrompt(data: PersonalityData): string {
  const config: PersonalityConfig = { ...DEFAULT_PERSONALITY, ...data.config }
  const venue = data.venue ?? {}
  const venueConfig = data.venue_config ?? {}
  const usps = data.usps ?? []
  const seasonal = data.seasonal ?? {}
  const signoff = data.signoff ?? ''
  const voicePrefs = data.voice_preferences
  const reviewVocab = data.review_vocabulary

  // Extract values with defaults
  const aiName = config.ai_name ?? 'Sage'
  const aiEmoji = config.ai_emoji ?? ''
  const aiEmail = config.ai_email ?? ''

  const venueName = venue.name ?? venueConfig.business_name ?? 'the venue'
  const website = ''
  const phone = venueConfig.coordinator_phone ?? ''

  const ownerName = config.owner_name ?? 'the owner'
  const ownerTitle = config.owner_title ?? 'Owner'

  // Personality dimensions
  const warmth = config.warmth_level ?? 6
  const formality = config.formality_level ?? 5
  const brevity = config.brevity_level ?? 6
  const enthusiasm = config.enthusiasm_level ?? 5

  // Style settings
  const usesContractions = config.uses_contractions ?? true
  const usesExclamations = config.uses_exclamation_points ?? true
  const emojiLevel = config.emoji_level ?? 'signoff_only'
  const phraseStyle = config.phrase_style ?? 'warm'

  // Description lookups
  const warmthDesc = WARMTH_DESCRIPTIONS[warmth] ?? 'friendly'
  const formalityDesc = FORMALITY_DESCRIPTIONS[formality] ?? 'conversational'

  // Energy description
  const energyDesc =
    enthusiasm >= 7
      ? "High enthusiasm - you're genuinely excited!"
      : enthusiasm >= 4
        ? 'Calm and grounded - warm but not over the top'
        : 'Understated and composed'

  // Brevity description
  const brevityDesc =
    brevity >= 7
      ? 'Keep it concise - say more with less'
      : brevity >= 4
        ? 'Balanced - thorough but not overwhelming'
        : 'Feel free to elaborate when it adds warmth'

  // Contraction rule
  const contractionRule = usesContractions
    ? "Use contractions freely (we'd, you'll, it's)"
    : 'Avoid contractions for a more formal tone'

  // Exclamation rule
  const exclamationRule = usesExclamations
    ? 'Use exclamation points naturally to convey warmth!'
    : 'Convey warmth through word choice, not punctuation'

  // Tour booking link (lives on venue_ai_config, not venue_config)
  const tourLink = config.tour_booking_link ?? ''

  // Pricing calculator link (lives on venue_ai_config, not venue_config)
  const pricingLink = config.pricing_calculator_link ?? ''

  // -----------------------------------------------------------------------
  // Build prompt sections
  // -----------------------------------------------------------------------

  let prompt = `
## YOUR IDENTITY: ${aiName} ${aiEmoji}

You are **${aiName}**, the AI digital concierge for **${venueName}**.
`

  if (aiEmail) {
    prompt += `Your email address is: ${aiEmail}\n`
  }

  prompt += `
You work alongside **${ownerName}** (${ownerTitle}) to ensure every couple gets timely, helpful responses.

**CRITICAL:** You are an AI and you must ALWAYS be transparent about this. Never hide your AI nature. Gently acknowledge it in your first email to each couple.

---

## YOUR VOICE & PERSONALITY

**Tone:** ${warmthDesc}, ${formalityDesc}
**Energy:** ${energyDesc}
**Brevity:** ${brevityDesc}

**Style Rules:**
- ${contractionRule}
- ${exclamationRule}
- Emoji usage: ${emojiLevel.replace(/_/g, ' ')}
- Phrase style preference: **${phraseStyle}**
`

  // Signature expressions
  const signatureExpressions = config.signature_expressions ?? []
  if (signatureExpressions.length > 0) {
    prompt += `**Signature expressions:** ${JSON.stringify(signatureExpressions)}\n`
  }

  if (config.signature_greeting) {
    prompt += `**Your go-to greeting:** "${config.signature_greeting}"\n`
  }
  // Greeting flexibility: vary openers based on context
  prompt += `**Greeting flexibility:** When you know the client's first name, open with it naturally (e.g., "Hi Sarah!", "Hey Michael!"). When you don't know their name, rotate between warm openers like "${config.signature_greeting || 'Hi there'}," "Hey!", or "Hello!" — don't always use the exact same greeting. Be warm and natural, not robotic.\n`
  if (config.signature_closer) {
    prompt += `**Your typical closer:** "${config.signature_closer}"\n`
  }

  // Voice preferences from training games
  if (voicePrefs) {
    if (voicePrefs.banned_phrases.length > 0) {
      prompt += `\n**NEVER use these phrases:** ${voicePrefs.banned_phrases.join(', ')}\n`
    }
    if (voicePrefs.approved_phrases.length > 0) {
      prompt += `**Preferred phrases:** ${voicePrefs.approved_phrases.join(', ')}\n`
    }
    if (Object.keys(voicePrefs.dimensions).length > 0) {
      prompt += `**Trained dimensions:** ${JSON.stringify(voicePrefs.dimensions)}\n`
    }
  }

  // Review vocabulary
  if (reviewVocab && reviewVocab.phrases.length > 0) {
    prompt += `\n**Approved review phrases (use naturally):** ${reviewVocab.phrases.join('; ')}\n`
  }

  prompt += `
---

## VENUE INFORMATION

**Venue:** ${venueName}
**Website:** ${website}
**Phone:** ${phone}
**Owner/Contact:** ${ownerName} (${ownerTitle})

**Tour Booking Link:** ${tourLink || '[NOT SET]'}
**Pricing Calculator Link:** ${pricingLink || '[NOT SET]'}
`

  prompt += `
---

## USPs (Use 2-3 per email, rotate them, weave naturally - never list)
`

  if (usps.length > 0) {
    usps.forEach((usp, i) => {
      prompt += `${i + 1}. ${usp}\n`
    })
  } else {
    prompt += '(No USPs configured - ask venue to add them)\n'
  }

  prompt += `
---

## SEASONAL LANGUAGE
`

  const seasons: Array<'spring' | 'summer' | 'fall' | 'winter'> = ['spring', 'summer', 'fall', 'winter']
  // Coerce imagery/phrases into string arrays — the DB stores imagery as text
  // and phrases as text[], but callers (or bad seed data) may pass strings.
  const toStringArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v as string[]
    if (typeof v === 'string' && v.length > 0) return [v]
    return []
  }
  for (const season of seasons) {
    const seasonData = seasonal[season] ?? DEFAULT_SEASONAL_CONTENT[season] ?? {}
    const imagery = toStringArray(seasonData.imagery)
    const phrases = toStringArray(seasonData.phrases)

    prompt += `
**${season.toUpperCase()}:**
- Imagery: ${imagery.length > 0 ? imagery.slice(0, 5).join(', ') : 'Use defaults'}
- Phrases: ${phrases.length > 0 ? phrases.slice(0, 3).join('; ') : 'Use defaults'}
`
  }

  prompt += `
---

## SIGN-OFF TEMPLATE

Use this sign-off at the end of every email:

${signoff}

---

## BEHAVIOR SETTINGS

**Follow-up style:** ${config.follow_up_style ?? 'moderate'}
**Max follow-ups:** ${config.max_follow_ups ?? 2}
**Escalation style:** ${config.escalation_style ?? 'soft_offer'}
**Sales approach:** ${config.sales_approach ?? 'consultative'}
`

  return prompt
}
