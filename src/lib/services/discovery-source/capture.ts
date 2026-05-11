/**
 * Bloom House — Wave 15 discovery-source capture writer.
 *
 * Anchor docs:
 *   - bloom-constitution.md (every captured source signal lands
 *     somewhere visible; operator override > inferred state)
 *   - bloom-phase-b-decisions.md (attribution_events audit row per
 *     decision — discovery_sources rows propagate into attribution
 *     events for ROI rollups)
 *
 * What this service does
 * ----------------------
 * Given a captured "How did you hear about us?" answer (from Calendly
 * Q&A, intake form, etc.), write:
 *   1. One row in discovery_sources (verbatim + canonical mapping)
 *   2. One row in attribution_events with bucket='attribution',
 *      source_platform=<canonical>, decided_by='auto', tier='tier_1_full_name'
 *      (deterministic capture — we know exactly what the prospect said)
 *
 * Idempotent: uniqueness on (venue_id, person_id, capture_source,
 * capture_ref). If Calendly retries the webhook we don't double-write.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  mapWithRule,
  type CanonicalDiscoverySource,
} from './canonical'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CaptureDiscoverySourceInput {
  venueId: string
  weddingId: string | null
  personId: string | null
  /** 'calendly' / 'website_form' / 'intake_form' / 'phone' / ... */
  captureSource: string
  /** The verbatim question text that produced this answer. */
  questionText?: string | null
  /** The verbatim answer. */
  answerText: string
  /** Optional pointer back to the capture event (calendly invitee URI). */
  captureRef?: string | null
  /** Optional referrer name, when canonical='friend' and the form
   *  captured a separate referrer name. */
  referrerName?: string | null
  supabase?: SupabaseClient
}

export interface CaptureDiscoverySourceResult {
  ok: boolean
  discoverySourceId: string | null
  attributionEventId: string | null
  canonical: CanonicalDiscoverySource
  ruleMatched: string
  /** True if this is a fresh insert; false if the unique index collapsed
   *  it onto an existing row (idempotency hit). */
  inserted: boolean
  /** Skip reason for empty inputs. */
  skipped?: string
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function captureDiscoverySource(
  input: CaptureDiscoverySourceInput,
): Promise<CaptureDiscoverySourceResult> {
  const supabase = input.supabase ?? createServiceClient()

  // Empty-answer guard.
  if (!input.answerText || !input.answerText.trim()) {
    return {
      ok: true,
      discoverySourceId: null,
      attributionEventId: null,
      canonical: 'unknown',
      ruleMatched: 'empty_answer',
      inserted: false,
      skipped: 'empty_answer',
    }
  }

  const { canonical, rule_matched } = mapWithRule(input.answerText)

  // 1. Idempotent write to discovery_sources. The UNIQUE INDEX uses
  //    COALESCE on person_id + capture_ref so a NULL person_id or
  //    NULL capture_ref maps to a stable sentinel rather than letting
  //    multiple NULL-rows duplicate.
  const insertRow = {
    venue_id: input.venueId,
    wedding_id: input.weddingId,
    person_id: input.personId,
    capture_source: input.captureSource,
    question_text: input.questionText ?? null,
    answer_text: input.answerText,
    canonical_source: canonical,
    referrer_name: input.referrerName ?? null,
    capture_ref: input.captureRef ?? null,
  }

  // Idempotency: SELECT first; if already present, skip insert + skip
  // attribution_events fan-out. (We do not surface partial duplicates.)
  const personIdForLookup =
    input.personId ?? '00000000-0000-0000-0000-000000000000'
  const captureRefForLookup = input.captureRef ?? ''

  let existingId: string | null = null
  try {
    const { data: existing } = await supabase
      .from('discovery_sources')
      .select('id')
      .eq('venue_id', input.venueId)
      .eq('capture_source', input.captureSource)
      // PostgREST does not directly compare with COALESCE — split on
      // person_id null / not-null.
      .eq('capture_ref', captureRefForLookup)
      .maybeSingle()
    if (existing) existingId = (existing as { id: string }).id
  } catch {
    // Probe failure means we proceed with insert; the unique index will
    // catch true duplicates.
  }

  if (!existingId && input.personId) {
    try {
      const { data: existing2 } = await supabase
        .from('discovery_sources')
        .select('id')
        .eq('venue_id', input.venueId)
        .eq('person_id', input.personId)
        .eq('capture_source', input.captureSource)
        .eq('capture_ref', captureRefForLookup)
        .maybeSingle()
      if (existing2) existingId = (existing2 as { id: string }).id
    } catch {
      // pass-through
    }
  }

  if (existingId) {
    return {
      ok: true,
      discoverySourceId: existingId,
      attributionEventId: null,
      canonical,
      ruleMatched: rule_matched,
      inserted: false,
    }
  }

  const { data: dsRow, error: dsErr } = await supabase
    .from('discovery_sources')
    .insert(insertRow)
    .select('id')
    .single()

  if (dsErr || !dsRow) {
    // Insert failed — most likely a unique-index collision (race).
    // Return the canonical mapping so the caller still logs the event.
    console.warn(
      '[discovery-source] insert failed (likely race / dup):',
      dsErr?.message,
    )
    return {
      ok: false,
      discoverySourceId: null,
      attributionEventId: null,
      canonical,
      ruleMatched: rule_matched,
      inserted: false,
    }
  }

  const discoverySourceId = (dsRow as { id: string }).id

  // 2. Fan out to attribution_events when we have a wedding linkage.
  //    Without a wedding the row stays in discovery_sources only and
  //    can be re-fanned later when the wedding resolves.
  let attributionEventId: string | null = null
  if (input.weddingId) {
    try {
      // Note: attribution_events has a CHECK constraint
      // (attribution_events_source_present, added in mig 279) requiring
      // ONE OF:
      //   - candidate_identity_id (Phase B platform-signal path)
      //   - referrer_wedding_id (Wave 14 resolved match)
      //   - referrer_name_text (Wave 14 deferred correlation)
      //
      // Discovery captures are NONE of those — they're a direct
      // operator-form capture, not a platform-signal cluster and not a
      // referrer mention. To satisfy the constraint without overloading
      // the referrer columns semantically, we populate
      // referrer_name_text with the verbatim discovery_source answer
      // (prefixed "discovery:") — it's the closest existing slot. The
      // discovery_source row remains the SOURCE OF TRUTH; this
      // attribution_events row exists so ROI rollups + first-touch
      // computation see the channel.
      const discoveryAnchor = `discovery:${input.answerText}`
      const attrInsertRow = {
        venue_id: input.venueId,
        wedding_id: input.weddingId,
        candidate_identity_id: null,
        source_platform: canonical,
        confidence: 95,
        tier: 'tier_1_full_name',
        decided_by: 'auto',
        reasoning:
          `Wave 15 discovery_source capture from ${input.captureSource}. ` +
          `Verbatim answer: "${truncate(input.answerText, 200)}". ` +
          `Mapping rule: ${rule_matched}.`,
        is_first_touch: false,
        bucket: 'attribution',
        // signal_class='source' — this is an acquisition signal (couple
        // is telling us how they discovered the venue), not a touchpoint.
        signal_class: 'source',
        referrer_evidence_quote:
          canonical === 'friend' && input.referrerName
            ? `Discovery answer: "${input.answerText}" (referrer: ${input.referrerName})`
            : `Discovery answer: "${input.answerText}"`,
        referrer_name_text:
          canonical === 'friend' && input.referrerName
            ? input.referrerName
            : discoveryAnchor,
        referrer_relationship_text:
          canonical === 'friend' && input.referrerName
            ? 'friend_or_family'
            : 'discovery_source',
      }
      const { data: attrRow, error: attrErr } = await supabase
        .from('attribution_events')
        .insert(attrInsertRow)
        .select('id')
        .single()
      if (attrErr) {
        console.warn(
          '[discovery-source] attribution_events fan-out failed:',
          attrErr.message,
        )
      } else if (attrRow) {
        attributionEventId = (attrRow as { id: string }).id
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[discovery-source] attribution_events fan-out threw:', msg)
    }
  }

  return {
    ok: true,
    discoverySourceId,
    attributionEventId,
    canonical,
    ruleMatched: rule_matched,
    inserted: true,
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 3) + '...'
}

// ---------------------------------------------------------------------------
// Calendly Q&A extractor
// ---------------------------------------------------------------------------

import { isDiscoveryQuestion } from './canonical'

/**
 * Calendly's invitee.created payload includes a `questions_and_answers`
 * array on the invitee. Shape (per Calendly docs):
 *   [{ question: 'How did you hear about us?', answer: 'ChatGPT', position: 0 }]
 *
 * This extractor pulls the first answer whose question text matches one
 * of the discovery-question patterns. Returns null when no Q&A array is
 * present or no question matched.
 */
export interface ExtractedDiscoveryAnswer {
  questionText: string
  answerText: string
}

export function extractDiscoveryAnswerFromCalendly(
  payload: Record<string, unknown> | null | undefined,
): ExtractedDiscoveryAnswer | null {
  if (!payload) return null

  // Calendly's questions_and_answers can live directly on the invitee
  // payload OR nested inside scheduled_event.questions_and_answers
  // depending on webhook version. Probe both.
  const qaCandidates: unknown[] = []
  const directQa = payload.questions_and_answers
  if (Array.isArray(directQa)) qaCandidates.push(...directQa)

  const scheduledEvent = payload.scheduled_event
  if (
    scheduledEvent &&
    typeof scheduledEvent === 'object' &&
    !Array.isArray(scheduledEvent)
  ) {
    const seQa = (scheduledEvent as Record<string, unknown>).questions_and_answers
    if (Array.isArray(seQa)) qaCandidates.push(...seQa)
  }

  for (const item of qaCandidates) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const q = typeof r.question === 'string' ? r.question : null
    const a = typeof r.answer === 'string' ? r.answer : null
    if (!q || !a) continue
    if (!isDiscoveryQuestion(q)) continue
    if (!a.trim()) continue
    return { questionText: q, answerText: a.trim() }
  }
  return null
}

/**
 * Sibling extractor: pulls a separate "Who referred you?" answer
 * when the form has both questions. Returns the referrer name or null.
 */
const REFERRER_QUESTION_PATTERNS = [
  'who referred',
  'who recommended',
  'name of the person',
  'referrer name',
  'who told you about us',
] as const

export function extractReferrerNameFromCalendly(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) return null
  const qaCandidates: unknown[] = []
  const directQa = payload.questions_and_answers
  if (Array.isArray(directQa)) qaCandidates.push(...directQa)
  const scheduledEvent = payload.scheduled_event
  if (
    scheduledEvent &&
    typeof scheduledEvent === 'object' &&
    !Array.isArray(scheduledEvent)
  ) {
    const seQa = (scheduledEvent as Record<string, unknown>).questions_and_answers
    if (Array.isArray(seQa)) qaCandidates.push(...seQa)
  }
  for (const item of qaCandidates) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const q = typeof r.question === 'string' ? r.question.toLowerCase() : null
    const a = typeof r.answer === 'string' ? r.answer : null
    if (!q || !a) continue
    if (!REFERRER_QUESTION_PATTERNS.some((p) => q.includes(p))) continue
    if (!a.trim()) continue
    return a.trim()
  }
  return null
}
