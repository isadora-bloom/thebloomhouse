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
    aiName: ((cfg as { ai_name: string | null } | null)?.ai_name) ?? 'Sage',
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
    .select('id, venue_id, source_platform, first_name, last_initial, state')
    .eq('id', args.candidate_id)
    .maybeSingle()
  if (!cand) return null
  const c = cand as { id: string; venue_id: string; source_platform: string; first_name: string | null; last_initial: string | null; state: string | null }

  const venue = await fetchVenueContext(sb, c.venue_id)
  if (!venue) return null

  const userPrompt = buildUserPrompt(args.channel, venue, {
    source_platform: c.source_platform,
    first_name: c.first_name,
    last_initial: c.last_initial,
    state: c.state,
  })

  const response = await callAI({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: args.channel === 'email' ? 400 : 200,
    temperature: 0.4,
    venueId: c.venue_id,
    taskType: 're_engagement_drafter',
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
