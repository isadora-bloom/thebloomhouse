/**
 * Bloom House: SMS Draft Brain
 *
 * Haiku-tier generator for SMS drafts. Mirrors the email inquiry-brain
 * pattern (4-layer prompt) but at SMS register: 1-2 short sentences, no
 * greeting, no signature, no email-shaped scaffolding.
 *
 * Pattern 9 anchor (BLOOM-PATTERNS-ZOOM-OUT.md): voice-channel parity.
 * Today the email brain owns every "Sage drafted a reply" surface. SMS
 * auto-reply rules + sequences need their own draft generator because:
 *
 *   1. SMS reads differently. "Hi Sarah, hope this email finds you well"
 *      is absurd over text.
 *   2. Character economy matters. Multi-part SMS still works but every
 *      extra sentence shrinks the read-through rate.
 *   3. The venue's voice is the same person but at a casual register.
 *      Same warmth dial, different sentence shape.
 *
 * Doctrine: every brain module exports BRAIN_PROMPT_VERSION (per Playbook
 * OPS-21.5.1 / T1-E). Logged to api_costs.prompt_version. Haiku tier per
 * memory.md "SMS drafts use Haiku (cheap, fast) not Sonnet."
 *
 * Returns a draft body string + 0-100 confidence. Callers persist into
 * pending_sms_drafts (mig 318) for coordinator review.
 */

import { callAI } from '@/lib/ai/client'
import { UNIVERSAL_RULES } from '@/config/prompts/universal-rules'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Prompt version
// ---------------------------------------------------------------------------

/**
 * Prompt revision identifier. Bump when the system prompt structure or
 * the SMS-specific constraints change. Logged on every call.
 *
 * v1: initial. 1-2 sentence SMS register. No greeting. Match venue voice.
 *     No attachments / links flagged. Universal rules apply.
 */
export const SMS_BRAIN_PROMPT_VERSION = 'sms-brain.prompt.v1'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmsInteractionRow {
  id: string
  direction: 'inbound' | 'outbound' | null
  body_preview: string | null
  full_body: string | null
  timestamp: string | null
  from_name?: string | null
}

export type SmsDraftReason = 'auto_reply' | 'sequence' | 'manual'

export interface GenerateSmsDraftArgs {
  venueId: string
  weddingId: string | null
  /** Last N inbound + outbound SMS on this thread, oldest first. Caller
      typically passes the last 10 rows; the prompt budget can handle more
      but the marginal signal drops off quickly. */
  conversation: SmsInteractionRow[]
  /** Why the draft is being generated. Shapes the task prompt:
      - auto_reply: respond to the latest inbound now
      - sequence: time-driven nudge (sms_no_reply / sms_tour_reminder /
        sms_post_tour) where there's no fresh inbound to react to
      - manual: coordinator clicked "draft a reply" from the SMS surface */
  reason: SmsDraftReason
  /** Optional: which sequence triggered a sequence-reason draft. Surfaced
      to the model so a tour-reminder vs no-reply nudge land differently. */
  sequenceType?: string
  /** Optional forensic correlation id. */
  correlationId?: string
}

export interface GenerateSmsDraftResult {
  draft: string
  confidence: number
  promptVersion: string
  cost: number
  tokensUsed: number
}

// ---------------------------------------------------------------------------
// Venue config loader (slim. SMS register doesn't need the full email
// personality stack)
// ---------------------------------------------------------------------------

interface SmsBrainVenueConfig {
  aiName: string
  warmthLevel: number
  playfulnessLevel: number
  formalityLevel: number
  usesContractions: boolean
  usesExclamationPoints: boolean
}

async function loadVenueConfig(venueId: string): Promise<SmsBrainVenueConfig> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('venue_ai_config')
    .select(
      'ai_name, warmth_level, playfulness_level, formality_level, uses_contractions, uses_exclamation_points',
    )
    .eq('venue_id', venueId)
    .maybeSingle()

  return {
    aiName: ((data?.ai_name as string | null) ?? 'Sage').toString(),
    warmthLevel: (data?.warmth_level as number | null) ?? 7,
    playfulnessLevel: (data?.playfulness_level as number | null) ?? 5,
    formalityLevel: (data?.formality_level as number | null) ?? 4,
    usesContractions: (data?.uses_contractions as boolean | null) ?? true,
    usesExclamationPoints: (data?.uses_exclamation_points as boolean | null) ?? true,
  }
}

// ---------------------------------------------------------------------------
// Wedding context loader
// ---------------------------------------------------------------------------

interface SmsBrainWeddingContext {
  status: string | null
  hasTouredInPerson: boolean
  preferredContactChannel: string | null
  partnerNames: string[]
}

async function loadWeddingContext(
  weddingId: string | null,
): Promise<SmsBrainWeddingContext> {
  if (!weddingId) {
    return {
      status: null,
      hasTouredInPerson: false,
      preferredContactChannel: null,
      partnerNames: [],
    }
  }
  const supabase = createServiceClient()
  // weddings.has_toured_in_person added by mig 306 (sticky-state pattern).
  // Partner names live on people (role='partner1' / 'partner2'); we pull
  // them from the people rows joined to the wedding.
  const { data: w } = await supabase
    .from('weddings')
    .select('status, has_toured_in_person')
    .eq('id', weddingId)
    .maybeSingle()

  let preferredContactChannel: string | null = null
  const names: string[] = []
  try {
    const { data: peopleRows } = await supabase
      .from('people')
      .select('first_name, role, preferred_contact_channel')
      .eq('wedding_id', weddingId)
      .in('role', ['partner1', 'partner2'])

    for (const row of (peopleRows ?? []) as Array<{
      first_name: string | null
      role: string | null
      preferred_contact_channel: string | null
    }>) {
      if (row.first_name && row.first_name.trim()) names.push(row.first_name.trim())
      if (!preferredContactChannel && row.preferred_contact_channel) {
        preferredContactChannel = row.preferred_contact_channel
      }
    }
  } catch {
    // Column / table shape mismatch on older deploys. degrade silently.
  }

  return {
    status: (w?.status as string | null) ?? null,
    hasTouredInPerson: (w?.has_toured_in_person as boolean | null) ?? false,
    preferredContactChannel,
    partnerNames: names,
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildSmsPersonalityBlock(cfg: SmsBrainVenueConfig): string {
  // Dial language that mirrors the email personality builder shape, but at
  // SMS register. Keep terse so the Haiku budget stays mostly on the
  // conversation context.
  const warmthLabel =
    cfg.warmthLevel >= 8 ? 'very warm' :
    cfg.warmthLevel >= 6 ? 'warm' :
    cfg.warmthLevel >= 4 ? 'neutral' : 'reserved'
  const playLabel =
    cfg.playfulnessLevel >= 7 ? 'playful' :
    cfg.playfulnessLevel >= 4 ? 'occasionally playful' : 'measured'
  const formalLabel =
    cfg.formalityLevel >= 7 ? 'formal' :
    cfg.formalityLevel >= 4 ? 'professional but relaxed' : 'casual'

  return [
    `You are ${cfg.aiName}, the venue's assistant.`,
    `Voice: ${warmthLabel}, ${playLabel}, ${formalLabel}.`,
    cfg.usesContractions ? 'Use contractions.' : 'Avoid contractions.',
    cfg.usesExclamationPoints
      ? 'Light exclamation points are fine.'
      : 'No exclamation points.',
  ].join('\n')
}

function buildSmsTaskBlock(
  reason: SmsDraftReason,
  sequenceType: string | undefined,
  context: SmsBrainWeddingContext,
): string {
  const tourLine = context.hasTouredInPerson
    ? 'The couple has already toured the venue in person. Do not invite them to tour again unless they ask.'
    : 'The couple has not yet toured in person.'

  const statusLine = context.status
    ? `Wedding status: ${context.status}.`
    : 'No wedding record yet (cold prospect).'

  const partnerLine =
    context.partnerNames.length > 0
      ? `You may address them as: ${context.partnerNames.join(' and ')}.`
      : 'You do not know the couple\'s names yet. Do not invent them.'

  let reasonLine = ''
  if (reason === 'auto_reply') {
    reasonLine =
      'Task: respond to the most recent inbound SMS. Acknowledge what they said, answer briefly if possible, or hand off to a coordinator if the question is operational.'
  } else if (reason === 'sequence') {
    if (sequenceType === 'sms_tour_reminder') {
      reasonLine =
        'Task: send a friendly reminder about their upcoming tour. Keep it natural, not transactional.'
    } else if (sequenceType === 'sms_post_tour') {
      reasonLine =
        'Task: thank them for their tour and ask one light follow-up question (what they thought, any questions they have). Do not pitch.'
    } else if (sequenceType === 'sms_no_reply') {
      reasonLine =
        'Task: nudge gently. They have not replied since the last venue message. One short sentence, no pressure.'
    } else {
      reasonLine = 'Task: send a brief, contextually appropriate follow-up SMS.'
    }
  } else {
    reasonLine =
      'Task: draft an SMS the coordinator can use as a starting point for replying to this thread.'
  }

  return [reasonLine, statusLine, tourLine, partnerLine].join('\n')
}

// SMS-specific constraints layered on top of UNIVERSAL_RULES.
const SMS_CONSTRAINTS = `## SMS CONSTRAINTS

- Output 1 or 2 short sentences. Never more than 2.
- No greeting like "Hi" or "Hello [name]". SMS doesn't open that way.
- No closing signature, no "Best", no "Talk soon".
- Do not use em dashes anywhere.
- Do not reference attachments. Text is the medium.
- If you include a link, do not say "click below" or "follow the link" because the recipient sees the URL inline.
- If the question is operational and you do not know the answer with high confidence, hand off ("I'll have someone get back to you shortly") rather than inventing.
- Match the venue voice but at a casual, fast register.
- Do not invent prices, dates, headcounts, or addresses.

## CONFIDENCE OUTPUT FORMAT

End your response with a single line in this exact format:
[confidence:NN]
where NN is an integer 0-100 representing how confident you are this draft fits the thread without further coordinator edits. 0 = the coordinator will rewrite it; 100 = ready to send as-is.
The coordinator surface strips this marker before display.`

function buildUserPrompt(
  conversation: SmsInteractionRow[],
  reason: SmsDraftReason,
  sequenceType: string | undefined,
): string {
  const lines: string[] = []
  lines.push('## CONVERSATION (oldest first)')
  if (conversation.length === 0) {
    lines.push('(no prior SMS on this thread)')
  } else {
    for (const row of conversation) {
      const dir = row.direction === 'outbound' ? 'VENUE' : 'COUPLE'
      const ts = row.timestamp ? ` [${row.timestamp}]` : ''
      const body = (row.full_body ?? row.body_preview ?? '').toString().trim()
      if (!body) continue
      lines.push(`${dir}${ts}: ${body}`)
    }
  }
  lines.push('')
  lines.push('## REQUEST')
  if (reason === 'auto_reply') {
    lines.push('Draft a reply to the most recent COUPLE message.')
  } else if (reason === 'sequence') {
    lines.push(
      `Draft a sequence-driven SMS (sequence type: ${sequenceType ?? 'unspecified'}). There is no fresh inbound to react to; the trigger is time-based.`,
    )
  } else {
    lines.push('Draft a manual SMS the coordinator requested.')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

const CONFIDENCE_RE = /\[confidence:(\d{1,3})\]\s*$/i

function parseDraftAndConfidence(text: string): { draft: string; confidence: number } {
  const trimmed = text.trim()
  const match = trimmed.match(CONFIDENCE_RE)
  if (match) {
    const conf = Math.max(0, Math.min(100, parseInt(match[1], 10)))
    const draft = trimmed.replace(CONFIDENCE_RE, '').trim()
    return { draft, confidence: conf }
  }
  // Defensive: no confidence marker. Fall back to a mid-low confidence so
  // the coordinator surface flags for review (and so a future audit can
  // spot prompt-format drift).
  return { draft: trimmed, confidence: 50 }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate an SMS draft.
 *
 * Returns { draft, confidence } so the caller can persist into
 * pending_sms_drafts with the confidence rating. Cost + tokens are
 * surfaced for audit.
 *
 * Wired into:
 *   - SMS auto-reply rules (W1) via tryGenerateSmsAutoReply (next to this
 *     file). fires from the openphone.ts persist path
 *   - SMS sequences (W2) via sms/sequences.ts. fires from cron
 */
export async function generateSmsDraft(
  args: GenerateSmsDraftArgs,
): Promise<GenerateSmsDraftResult> {
  const { venueId, weddingId, conversation, reason, sequenceType, correlationId } = args

  const [cfg, context] = await Promise.all([
    loadVenueConfig(venueId),
    loadWeddingContext(weddingId),
  ])

  const systemPrompt = [
    UNIVERSAL_RULES,
    '',
    buildSmsPersonalityBlock(cfg),
    '',
    buildSmsTaskBlock(reason, sequenceType, context),
    '',
    SMS_CONSTRAINTS,
  ].join('\n')

  // Trim conversation to last 10 rows in case caller passed more. SMS
  // bodies are short so 10 rows is plenty.
  const trimmed = conversation.slice(-10)
  const userPrompt = buildUserPrompt(trimmed, reason, sequenceType)

  const ai = await callAI({
    systemPrompt,
    userPrompt,
    // SMS drafts are short. 200 tokens is plenty for 2 sentences +
    // confidence marker.
    maxTokens: 200,
    temperature: 0.4,
    venueId,
    taskType: 'sms_draft',
    tier: 'haiku',
    // SMS carries couple PII; tier 2 default.
    contentTier: 2,
    promptVersion: SMS_BRAIN_PROMPT_VERSION,
    correlationId,
  })

  const { draft, confidence } = parseDraftAndConfidence(ai.text)

  return {
    draft,
    confidence,
    promptVersion: SMS_BRAIN_PROMPT_VERSION,
    cost: ai.cost,
    tokensUsed: ai.inputTokens + ai.outputTokens,
  }
}
