/**
 * Re-engagement message drafter (Phase D Tier 2 / D2.1, Stage 2).
 *
 * Generates a tailored re-engagement message for a candidate. The
 * coordinator reviews/edits before sending. Tone + length depend on
 * the channel:
 *
 *   email          — full-length intro letter from the venue's AI
 *                    concierge (Sage et al). Multi-paragraph, signed,
 *                    warm. Always available.
 *   manual_paste   — short DM-friendly snippet for Knot / IG /
 *                    Pinterest dashboards. 1-3 sentences, no
 *                    signature, no markdown.
 *
 * Privacy posture (locked 2026-04-30):
 *   - Generic platform-engagement phrasing only ("you've been
 *     looking at wedding venues") — never specific signal counts
 *     or actions ("you saved us 3 times" is forbidden).
 *   - Venue identity uses venue_ai_config.ai_name / venue.name —
 *     no hardcoded "Sage" or "Rixey".
 *   - The model is told the candidate's first_name + last_initial
 *     for personalization, never their full last_name (we don't
 *     have it most of the time anyway, and using a partial
 *     reinforces "I haven't been stalking your full identity").
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAI, CLAUDE_MODEL } from '@/lib/ai/client'
import { requireAiName } from '@/lib/ai/personality-builder'
import { loadAutoContextForWedding } from '@/lib/services/identity/auto-context-loader'

// Re-engagement drafter composes a message TO the candidate, not a
// coordinator-side analytic narration. The system prompt instructs the
// model to write FROM the venue AI to the candidate, so it stays on
// the couple-facing prompt path (Agent N's domain) per the
// coordinator-narrator unification scope. The surface enum entry in
// `coordinator-prompt.ts` is reserved for a future coordinator-side
// re-engagement narrator (e.g. "why this candidate looks worth nudging")
// rather than this candidate-facing drafter.
/** v1.1 (2026-05-09, Wave 1A): when the candidate has resolved to a
 *  wedding (`resolved_wedding_id`) and that wedding carries soft
 *  context, the drafter folds the COUPLE'S NOTES block into the
 *  system prompt. The privacy posture stays intact: the system rules
 *  still ban specific signal counts ("you saved us 3 times"), but
 *  emotional truths the system already knows about (a stressful job
 *  mention, a sick parent) shape tone — patience, slack, no urgency.
 *  Universal-rules SOFT-CONTEXT NOTES POLICY governs the verbatim
 *  rule (sensitive notes are voice-shaping only, never echoed). */
export const RE_ENGAGEMENT_DRAFTER_PROMPT_VERSION = 're-engagement-drafter.prompt.v1.1'

export type ReEngagementChannel = 'email' | 'manual_paste'

interface DraftInput {
  candidate_id: string
  channel: ReEngagementChannel
}

interface VenueContext {
  venueName: string
  aiName: string
  /** Voice signature line if the venue has one (e.g. "—Sage" or
   *  "Looking forward to hearing from you"). Falls back to a
   *  default. */
  signature: string | null
}

interface CandidateContext {
  source_platform: string
  first_name: string | null
  last_initial: string | null
  state: string | null
}

async function fetchVenueContext(sb: SupabaseClient, venueId: string): Promise<VenueContext | null> {
  const { data: ven } = await sb
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  if (!ven) return null
  const { data: cfg } = await sb
    .from('venue_ai_config')
    .select('ai_name, signature_greeting')
    .eq('venue_id', venueId)
    .maybeSingle()
  return {
    venueName: (ven as { name: string }).name,
    // Throws if venue_ai_config.ai_name is null/missing rather than
    // emitting a re-engagement message signed "Sage" from another
    // venue's AI. T5-β.1.
    aiName: requireAiName(cfg as { ai_name?: string | null } | null, venueId),
    signature: ((cfg as { signature_greeting: string | null } | null)?.signature_greeting) ?? null,
  }
}

function platformLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const SYSTEM_PROMPT = `You write short, warm re-engagement messages for wedding venue coordinators.

Rules — these are non-negotiable:
- NEVER reference specific signal counts, action counts, or behavior details.
  "You've been browsing wedding venues" is fine.
  "I noticed you saved us three times" is BANNED — it's surveillance and creepy.
- NEVER claim you watched or tracked the candidate.
- Address them by first name + last initial only (e.g. "Hi Madison B.,").
  If first_name is missing, use "Hi there,".
- The venue's AI concierge sends from the venue, but write in a way
  that feels human + warm — coordinators will edit if it sounds robotic.
- Do not promise pricing, availability, or specifics you don't have.

Channel-specific format:

  email — A 4-6 sentence email with a friendly greeting, an offer to
  share basics + answer any questions, and a closing line. End with
  the venue's signature (provided in input). NO subject line, NO
  markdown — pure email body text.

  manual_paste — A 1-3 sentence DM-style snippet sized for the
  platform's message box (Knot inbox, Instagram DM, Pinterest
  message). No signature, no greeting line — just the message body
  designed to feel like a direct human note. Keep under 350 chars.

Return ONLY the message text. No JSON, no quotes wrapping the
response, no preamble like "Here's the draft:".`

function buildUserPrompt(channel: ReEngagementChannel, venue: VenueContext, cand: CandidateContext): string {
  const parts: string[] = []
  parts.push(`CHANNEL: ${channel}`)
  parts.push(`VENUE: ${venue.venueName}`)
  parts.push(`AI_CONCIERGE_NAME: ${venue.aiName}`)
  if (venue.signature) parts.push(`VENUE_SIGNATURE: ${venue.signature}`)
  parts.push(`PLATFORM_THE_CANDIDATE_USED: ${platformLabel(cand.source_platform)}`)
  if (cand.first_name) parts.push(`CANDIDATE_FIRST_NAME: ${cand.first_name}`)
  if (cand.last_initial) parts.push(`CANDIDATE_LAST_INITIAL: ${cand.last_initial.toUpperCase()}`)
  if (cand.state) parts.push(`CANDIDATE_STATE: ${cand.state.toUpperCase()}`)
  parts.push('')
  parts.push(`Write the ${channel === 'email' ? 'email body' : 'DM snippet'}.`)
  return parts.join('\n')
}

export async function draftReEngagementMessage(
  sb: SupabaseClient,
  args: DraftInput,
): Promise<{ draft_text: string; model: string; platform: string } | null> {
  const { data: cand } = await sb
    .from('candidate_identities')
    .select('id, venue_id, source_platform, first_name, last_initial, state, resolved_wedding_id')
    .eq('id', args.candidate_id)
    .maybeSingle()
  if (!cand) return null
  const c = cand as {
    id: string
    venue_id: string
    source_platform: string
    first_name: string | null
    last_initial: string | null
    state: string | null
    resolved_wedding_id: string | null
  }

  const venue = await fetchVenueContext(sb, c.venue_id)
  if (!venue) return null

  // Wave 1A (2026-05-09): when this candidate has resolved to a
  // wedding, fold soft-context into the system prompt. Re-engagement
  // is high-stakes — the candidate has gone silent. A note like
  // "stressful job interview last week" or "juggling a sick parent"
  // reframes the silence as life-context, not disinterest, and
  // shapes the drafter's tone toward patience instead of urgency.
  // Privacy posture (frozen 2026-04-30) stays intact: signal-count
  // bans are still in SYSTEM_PROMPT below; soft-context only widens
  // the patience window and tone, never widens the disclosure
  // surface. brainBlock=null when nothing eligible — skip cleanly.
  let coupleNotesBlock: string | null = null
  if (c.resolved_wedding_id) {
    try {
      const { brainBlock } = await loadAutoContextForWedding(
        sb,
        c.resolved_wedding_id,
      )
      coupleNotesBlock = brainBlock
    } catch {
      // Soft-context failure must never block the re-engagement draft.
    }
  }

  // TIER 6++ (2026-05-14). Venue climate context for the current month.
  // When the candidate is being nudged about an upcoming season, the
  // drafter can lean on real venue numbers ("April here typically averages
  // 68°F daytime") rather than generic regional phrasing. Fire-and-forget.
  let climateBlock: string | null = null
  try {
    const { getVenueClimateContext } = await import(
      '@/lib/services/intel/climate-context'
    )
    const climate = await getVenueClimateContext(c.venue_id, {
      month: new Date().getUTCMonth() + 1,
    })
    if (climate.available && climate.promptBlock) {
      climateBlock = climate.promptBlock
    }
  } catch {
    // Climate enrichment is optional; never block re-engagement.
  }

  const systemPromptParts: string[] = [SYSTEM_PROMPT]
  if (coupleNotesBlock) {
    systemPromptParts.push(coupleNotesBlock)
    systemPromptParts.push(
      "Soft-context handling for the COUPLE'S NOTES above: use them ONLY to shape tone toward patience and slack. Never quote them verbatim. Never reference sensitive notes (health, grief, family conflict, financial stress) by content. Never imply you tracked the candidate or know the specific event. The signal-count and surveillance-feel rules above remain absolute.",
    )
  }
  if (climateBlock) {
    systemPromptParts.push(`VENUE CLIMATE RECORD:\n${climateBlock}`)
    systemPromptParts.push(
      'Use the climate record sparingly — only when it naturally fits the message (e.g. inviting them back for a season-specific tour). Never list raw numbers; the operator voice is warm, not meteorological.',
    )
  }
  const systemPrompt = systemPromptParts.join('\n\n')

  const userPrompt = buildUserPrompt(args.channel, venue, {
    source_platform: c.source_platform,
    first_name: c.first_name,
    last_initial: c.last_initial,
    state: c.state,
  })

  const response = await callAI({
    systemPrompt,
    userPrompt,
    maxTokens: args.channel === 'email' ? 400 : 200,
    temperature: 0.4,
    venueId: c.venue_id,
    taskType: 're_engagement_drafter',
    promptVersion: RE_ENGAGEMENT_DRAFTER_PROMPT_VERSION,
  })

  const text = (response.text ?? '').trim()
  if (!text) return null

  // Persist the exact CLAUDE_MODEL the AI client used so the audit
  // trail stays in lockstep with the actual model. Pre-fix this stored
  // 'claude-sonnet' (no version, no date), which silently drifted
  // every time we bumped Sonnet generations and made the audit lie.
  // OPS-21.5.2.
  return {
    draft_text: text,
    model: CLAUDE_MODEL,
    platform: c.source_platform,
  }
}
