/**
 * D6 — couple-ribbon context for Sage (Tier 8 / Appendix C §C.5).
 *
 * Single entry point that loads a couple's full identity-first context —
 * the spine row, the ordered touchpoint ribbon, progression events,
 * and (when available) the Wave 4 forensic identity profile — into a
 * typed bundle. Operator-facing brains (NLQ, per-couple narrators)
 * fold it into the system prompt so Sage can quote the ribbon directly
 * rather than guess.
 *
 * Why a separate module from the existing identity helpers:
 *   - The Wave 4 `couple_identity_profile` table is keyed on wedding_id
 *     and is a forensic reconstruction snapshot, not the spine. D6's
 *     couple-context is keyed on couple_id and reads the live spine
 *     (couples + touchpoints + couple_progression_events). It rolls in
 *     the Wave 4 profile when one exists for the linked wedding, but
 *     does not require it.
 *   - The spine read is what every battery question about a specific
 *     couple needs (Q5 transparency, Q19 evidence list, Q34 workflow
 *     chain). Centralising it here keeps every operator surface
 *     consistent about what "this couple's context" means.
 *
 * Multi-venue safe: takes (supabase, coupleId). The venueId is read off
 * the couple row, not the caller, so a spoofed couple_id from a foreign
 * venue would still surface in its own tenant's context only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CoupleContextRibbonEntry {
  id: string
  channel: string
  actionType: string
  occurredAt: string
  direction: 'inbound' | 'outbound' | 'unknown'
  signalTier: string
  /** First 240 chars of human-readable text from raw_payload when
   *  present — subject + body preview joined. Surface uses this to
   *  quote actual ribbon content in operator answers. */
  textPreview: string | null
}

export interface CoupleContextProgressionEntry {
  eventType: string
  occurredAt: string
}

export interface CoupleContext {
  coupleId: string
  venueId: string
  primaryContactName: string | null
  lifecycleState: string
  channelScope: string | null
  weddingDate: string | null
  heatScore: number | null
  createdAt: string
  /** Linked legacy wedding id (when the couple was mirrored from / is
   *  attached to a `weddings` row). Lets the Wave 4 forensic profile
   *  join through. */
  weddingId: string | null
  ribbon: CoupleContextRibbonEntry[]
  progression: CoupleContextProgressionEntry[]
  /** Wave 4 forensic profile when reconstructed for the linked wedding.
   *  Free-form JSON; the prompt block emits only voice-shaping fields
   *  and never quotes sensitive evidence verbatim (privacy doctrine —
   *  see profile-prompt-block.ts). */
  forensicProfile: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface RawCoupleRow {
  id: string
  venue_id: string
  lifecycle_state: string
  channel_scope: string | null
  wedding_date: string | null
  heat_score: number | null
  created_at: string
  primary_contact_name: string | null
  /** Mirror-link to the legacy weddings row, when one exists. Created
   *  by mirror-couple.ts; null for couples minted directly by the
   *  Tracer on a non-wedding signal. Canonical column is
   *  `source_wedding_id` (migration 346). */
  source_wedding_id?: string | null
}

interface RawTouchpointRow {
  id: string
  channel: string
  action_type: string
  occurred_at: string
  signal_tier: string
  raw_payload: Record<string, unknown> | null
}

interface RawProgressionRow {
  event_type: string
  occurred_at: string
}

function deriveDirection(
  actionType: string,
  raw: Record<string, unknown> | null,
): 'inbound' | 'outbound' | 'unknown' {
  if (actionType === 'venue_sent') return 'outbound'
  if (actionType === 'reply') return 'inbound'
  if (raw && typeof raw.direction === 'string') {
    const d = raw.direction.toLowerCase()
    if (d === 'inbound') return 'inbound'
    if (d === 'outbound') return 'outbound'
  }
  // Couple-originated channel signals (tour_booked, channel_engagement,
  // review_posted) are inbound by construction.
  if (
    actionType.startsWith('tour_') ||
    actionType.startsWith('channel_') ||
    actionType.startsWith('review_') ||
    actionType === 'booked'
  )
    return 'inbound'
  return 'unknown'
}

function extractTextPreview(
  raw: Record<string, unknown> | null,
): string | null {
  if (!raw) return null
  const candidates: string[] = []
  for (const key of ['subject', 'body_preview', 'body', 'full_body', 'text']) {
    const v = raw[key]
    if (typeof v === 'string' && v.trim().length > 0) candidates.push(v.trim())
  }
  if (candidates.length === 0) return null
  const joined = candidates.join(' · ').replace(/\s+/g, ' ').trim()
  return joined.length > 240 ? joined.slice(0, 237) + '…' : joined
}

/**
 * Load the full couple-context bundle for a single couple. Returns null
 * when the couple does not exist (or the caller has no RLS access).
 */
export async function loadCoupleContext(
  supabase: SupabaseClient,
  coupleId: string,
): Promise<CoupleContext | null> {
  const { data: coupleRow } = await supabase
    .from('couples')
    .select(
      'id, venue_id, lifecycle_state, channel_scope, wedding_date, heat_score, created_at, primary_contact_name, source_wedding_id',
    )
    .eq('id', coupleId)
    .maybeSingle<RawCoupleRow>()
  if (!coupleRow) return null

  // Touchpoints: full ribbon, occurred_at ASC. PostgREST page cap is
  // 1000 — a couple with >1000 touchpoints is vanishingly rare and the
  // overflow would be the very tail anyway; cap and let the surface
  // note the truncation if it ever fires.
  const { data: tps } = await supabase
    .from('touchpoints')
    .select('id, channel, action_type, occurred_at, signal_tier, raw_payload')
    .eq('couple_id', coupleId)
    .order('occurred_at', { ascending: true })
    .limit(1000)
  const ribbon: CoupleContextRibbonEntry[] = (
    (tps ?? []) as RawTouchpointRow[]
  ).map((t) => ({
    id: t.id,
    channel: t.channel,
    actionType: t.action_type,
    occurredAt: t.occurred_at,
    direction: deriveDirection(t.action_type, t.raw_payload),
    signalTier: t.signal_tier,
    textPreview: extractTextPreview(t.raw_payload),
  }))

  // Progression: appended after touchpoints in chronological order at
  // the surface; left as a separate stream because progression events
  // are state-change facts (booked, tour_attended, lost) the model
  // should treat as anchors, not as messages.
  const { data: progs } = await supabase
    .from('couple_progression_events')
    .select('event_type, occurred_at')
    .eq('couple_id', coupleId)
    .order('occurred_at', { ascending: true })
  const progression: CoupleContextProgressionEntry[] = (
    (progs ?? []) as RawProgressionRow[]
  ).map((p) => ({ eventType: p.event_type, occurredAt: p.occurred_at }))

  // Forensic profile (Wave 4) — keyed on the legacy wedding_id (the
  // `couple_identity_profile.wedding_id` column is the existing Wave 4
  // contract, the spine's couples.source_wedding_id is the join key).
  // Best-effort: a missing or unreadable profile leaves the field null
  // and the surface still renders the ribbon.
  let forensicProfile: Record<string, unknown> | null = null
  if (coupleRow.source_wedding_id) {
    try {
      const { data: prof } = await supabase
        .from('couple_identity_profile')
        .select('profile')
        .eq('wedding_id', coupleRow.source_wedding_id)
        .maybeSingle<{ profile: Record<string, unknown> | null }>()
      forensicProfile = prof?.profile ?? null
    } catch {
      // Forensic profile is enrichment, not a gate.
    }
  }

  return {
    coupleId,
    venueId: coupleRow.venue_id,
    primaryContactName: coupleRow.primary_contact_name ?? null,
    lifecycleState: coupleRow.lifecycle_state,
    channelScope: coupleRow.channel_scope ?? null,
    weddingDate: coupleRow.wedding_date ?? null,
    heatScore: coupleRow.heat_score ?? null,
    createdAt: coupleRow.created_at,
    weddingId: coupleRow.source_wedding_id ?? null,
    ribbon,
    progression,
    forensicProfile,
  }
}

// ---------------------------------------------------------------------------
// Prompt block renderer
// ---------------------------------------------------------------------------

/**
 * Render a system-prompt block from a CoupleContext. Doctrine:
 *  - Header names the couple + lifecycle so the LLM sets context first.
 *  - Ribbon is rendered chronologically. Each entry shows channel +
 *    action + direction + occurred_at + (optionally) a short text
 *    quote from raw_payload. The model treats this as the canonical
 *    record of "what we know about this couple's journey".
 *  - Progression events are appended below the ribbon as state anchors
 *    (booked, tour_attended) the model can reference but should not
 *    confuse with messages.
 *  - Forensic profile is voice-shaping context only — sensitive emotional
 *    truths are aggregated, never quoted verbatim. The existing
 *    profile-prompt-block.ts is the canonical surface-aware renderer;
 *    this module emits a slimmer summary so the operator surface can
 *    surface what is present without re-implementing the full Wave 4
 *    privacy logic.
 *
 * Returns the empty string when context is null — caller can splice
 * into a prompt without conditional formatting.
 */
export function buildCoupleContextBlock(ctx: CoupleContext | null): string {
  if (!ctx) return ''

  const header = [
    `## COUPLE CONTEXT — ${ctx.primaryContactName ?? '(no name)'}`,
    `Lifecycle: ${ctx.lifecycleState}${ctx.channelScope ? ` (channel-scoped to ${ctx.channelScope})` : ''}`,
    ctx.weddingDate ? `Wedding date: ${ctx.weddingDate}` : null,
    ctx.heatScore !== null ? `Heat score: ${ctx.heatScore}` : null,
    `Couple id: ${ctx.coupleId}`,
  ]
    .filter(Boolean)
    .join('\n')

  const ribbonLines = ctx.ribbon.length === 0
    ? 'No touchpoints attached. Treat the couple as un-evidenced; the doctrine is to refuse questions that would require ribbon evidence rather than guess from priors.'
    : ctx.ribbon
        .map((tp, i) => {
          const date = tp.occurredAt.slice(0, 10)
          const time = tp.occurredAt.slice(11, 16)
          const dir = tp.direction === 'outbound' ? '→ venue' : tp.direction === 'inbound' ? '← couple' : '? ?'
          const text = tp.textPreview ? `  "${tp.textPreview}"` : ''
          return `  ${String(i + 1).padStart(2, ' ')}. ${date} ${time} ${tp.channel}/${tp.actionType} ${dir}${text}`
        })
        .join('\n')

  const progressionLines =
    ctx.progression.length === 0
      ? null
      : ctx.progression
          .map((p) => `  - ${p.occurredAt.slice(0, 10)}: ${p.eventType}`)
          .join('\n')

  // Forensic profile — voice-shaping summary only. Never quote sensitive
  // evidence verbatim; the existing profile-prompt-block.ts is the full
  // privacy-aware renderer. This module's job is to surface its presence
  // so the operator brain knows it exists.
  const profileLine = ctx.forensicProfile
    ? 'A Wave 4 forensic profile exists for this couple. Use it for tone only; never quote sensitive emotional-truth evidence verbatim.'
    : 'No Wave 4 forensic profile exists for this couple yet.'

  const sections = [
    header,
    `### Ribbon (${ctx.ribbon.length} touchpoints)\n${ribbonLines}`,
  ]
  if (progressionLines) {
    sections.push(`### Progression\n${progressionLines}`)
  }
  sections.push(`### Forensic profile\n${profileLine}`)

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Convenience: resolve a couple by primary name (for NLQ where the
// operator types a name rather than an id). Returns the highest-heat
// match in the venue; null when no match. Multi-venue safe — venueId is
// required.
// ---------------------------------------------------------------------------

export async function findCoupleByName(
  supabase: SupabaseClient,
  venueId: string,
  name: string,
): Promise<{ coupleId: string; primaryContactName: string | null } | null> {
  const cleaned = name.trim()
  if (cleaned.length < 2) return null
  // ilike on primary_contact_name. The Tracer normalises that field;
  // the operator typing "Sarah" should hit "Sarah & James Hawthorne".
  const { data } = await supabase
    .from('couples')
    .select('id, primary_contact_name, heat_score, lifecycle_state')
    .eq('venue_id', venueId)
    .ilike('primary_contact_name', `%${cleaned}%`)
    .neq('lifecycle_state', 'channel_scoped')
    .order('heat_score', { ascending: false, nullsFirst: false })
    .limit(1)
  const row = (data ?? [])[0] as
    | { id: string; primary_contact_name: string | null }
    | undefined
  if (!row) return null
  return { coupleId: row.id, primaryContactName: row.primary_contact_name ?? null }
}
