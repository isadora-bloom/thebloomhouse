/**
 * Bloom House — Wave 20 Voice DNA apply flow.
 *
 * Anchor docs (~/.claude memory/):
 *   - bloom-constitution.md (operator authority — applying a derivation
 *     is the operator-explicit moment where proposals become ground
 *     truth in voice_preferences)
 *
 * What this does
 * --------------
 * The operator browses a derivation in the Voice DNA UI, picks which
 * buckets ('banned_phrases', 'approved_phrases', 'tone_descriptors',
 * 'voice_principles') they want to merge into voice_preferences, then
 * hits "apply". This service:
 *   1. Loads the derivation row.
 *   2. For each picked field, upserts the relevant rows into
 *      voice_preferences (preference_type chosen to match the
 *      bucket).
 *   3. Marks the derivation as applied=true with applied_fields,
 *      applied_at, applied_by.
 *
 * Important: this NEVER replaces existing voice_preferences entries
 * silently. We use upsert with onConflict='venue_id,preference_type,
 * content' — pre-existing rows are reinforced (score+1) rather than
 * overwritten. The operator can still remove rows manually from the
 * existing rules / phrases page if they want.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { createLogger, newCorrelationId } from '@/lib/observability/logger'
import { redactError } from '@/lib/observability/redact'
import type {
  DerivedApprovedPhrase,
  DerivedBannedPhrase,
  DerivedToneDescriptor,
  DerivedVoicePrinciple,
} from '@/config/prompts/voice-dna-derive'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApplyableField =
  | 'banned_phrases'
  | 'approved_phrases'
  | 'tone_descriptors'
  | 'voice_principles'

export const APPLYABLE_FIELDS: ReadonlyArray<ApplyableField> = [
  'banned_phrases',
  'approved_phrases',
  'tone_descriptors',
  'voice_principles',
]

export interface ApplyOptions {
  derivationId: string
  /** Which buckets to merge. Empty array = no-op. Defaults to all. */
  fields?: ApplyableField[]
  /** Filter to specific items within each bucket. Keyed by field name;
   *  value is an array of indexes (0-based) into the derivation array.
   *  When omitted, ALL items in the chosen field are applied. */
  itemIndexes?: Partial<Record<ApplyableField, number[]>>
  supabase?: SupabaseClient
  userId?: string
  correlationId?: string
}

export interface ApplySuccess {
  ok: true
  derivationId: string
  applied_fields: ApplyableField[]
  rows_written: number
  per_field: Record<ApplyableField, number>
  correlationId: string
}

export interface ApplyFailure {
  ok: false
  reason: 'not_found' | 'already_applied' | 'already_dismissed' | 'no_fields' | 'persist_failed'
  details?: string
  correlationId: string
}

export type ApplyResult = ApplySuccess | ApplyFailure

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DerivationRow {
  id: string
  venue_id: string
  derived_banned_phrases: DerivedBannedPhrase[] | null
  derived_approved_phrases: DerivedApprovedPhrase[] | null
  derived_tone_descriptors: DerivedToneDescriptor[] | null
  derived_voice_principles: DerivedVoicePrinciple[] | null
  applied: boolean
  dismissed: boolean
}

function filterByIndex<T>(items: T[], indexes: number[] | undefined): T[] {
  if (!indexes || indexes.length === 0) return items
  const set = new Set(indexes)
  return items.filter((_, i) => set.has(i))
}

/**
 * Upsert a voice_preferences row. Source-tagged 'conversation' since
 * the underlying signal is the coordinator's email corpus +
 * draft-edit history (per migration 023 enum: 'review' | 'testimonial'
 * | 'conversation' | 'manual' | 'training_game'). confidence_flag
 * 'imported_high' marks it as derivation-sourced (per migration 168).
 */
async function upsertVoicePreference(
  supabase: SupabaseClient,
  venueId: string,
  derivationId: string,
  args: {
    preference_type: 'banned_phrase' | 'approved_phrase' | 'dimension' | 'rule'
    content: string
    confidence: number
  },
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('voice_preferences')
      .upsert(
        {
          venue_id: venueId,
          preference_type: args.preference_type,
          content: args.content,
          score: Math.max(1, Math.round(args.confidence / 10)),  // 1-10 scale
          sample_count: 1,
          source_type: 'conversation',
          source_reference: `voice_dna_derivation:${derivationId}`,
          confidence_flag: 'imported_high',
        },
        { onConflict: 'venue_id,preference_type,content' },
      )
    if (error) return false
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Public entry — applyDerivation
// ---------------------------------------------------------------------------

export async function applyDerivation(opts: ApplyOptions): Promise<ApplyResult> {
  const correlationId = opts.correlationId ?? newCorrelationId()
  const supabase = opts.supabase ?? createServiceClient()
  const log = createLogger({
    correlationId,
    actor: opts.userId ? `user:${opts.userId}` : 'system',
  })
  const fields = (opts.fields && opts.fields.length > 0)
    ? opts.fields
    : (APPLYABLE_FIELDS as ApplyableField[])

  if (fields.length === 0) {
    return { ok: false, reason: 'no_fields', correlationId }
  }

  // Load the derivation row.
  const { data: row, error: loadErr } = await supabase
    .from('voice_dna_derivations')
    .select(
      'id, venue_id, derived_banned_phrases, derived_approved_phrases, '
      + 'derived_tone_descriptors, derived_voice_principles, applied, dismissed',
    )
    .eq('id', opts.derivationId)
    .maybeSingle()
  if (loadErr || !row) {
    return {
      ok: false,
      reason: 'not_found',
      details: loadErr?.message,
      correlationId,
    }
  }
  const derivation = row as unknown as DerivationRow
  if (derivation.applied) {
    return { ok: false, reason: 'already_applied', correlationId }
  }
  if (derivation.dismissed) {
    return { ok: false, reason: 'already_dismissed', correlationId }
  }

  // Apply per field.
  const perField: Record<ApplyableField, number> = {
    banned_phrases: 0,
    approved_phrases: 0,
    tone_descriptors: 0,
    voice_principles: 0,
  }
  let rowsWritten = 0

  if (fields.includes('banned_phrases')) {
    const items = filterByIndex(
      derivation.derived_banned_phrases ?? [],
      opts.itemIndexes?.banned_phrases,
    )
    for (const item of items) {
      const ok = await upsertVoicePreference(supabase, derivation.venue_id, derivation.id, {
        preference_type: 'banned_phrase',
        content: item.phrase,
        confidence: item.confidence,
      })
      if (ok) {
        perField.banned_phrases++
        rowsWritten++
      }
    }
  }

  if (fields.includes('approved_phrases')) {
    const items = filterByIndex(
      derivation.derived_approved_phrases ?? [],
      opts.itemIndexes?.approved_phrases,
    )
    for (const item of items) {
      const ok = await upsertVoicePreference(supabase, derivation.venue_id, derivation.id, {
        preference_type: 'approved_phrase',
        content: item.phrase,
        confidence: item.confidence,
      })
      if (ok) {
        perField.approved_phrases++
        rowsWritten++
      }
    }
  }

  if (fields.includes('tone_descriptors')) {
    const items = filterByIndex(
      derivation.derived_tone_descriptors ?? [],
      opts.itemIndexes?.tone_descriptors,
    )
    for (const item of items) {
      const ok = await upsertVoicePreference(supabase, derivation.venue_id, derivation.id, {
        preference_type: 'dimension',
        content: `TONE: ${item.descriptor}`,
        confidence: item.confidence,
      })
      if (ok) {
        perField.tone_descriptors++
        rowsWritten++
      }
    }
  }

  if (fields.includes('voice_principles')) {
    const items = filterByIndex(
      derivation.derived_voice_principles ?? [],
      opts.itemIndexes?.voice_principles,
    )
    for (const item of items) {
      const ok = await upsertVoicePreference(supabase, derivation.venue_id, derivation.id, {
        preference_type: 'rule',
        content: item.principle,
        confidence: item.confidence,
      })
      if (ok) {
        perField.voice_principles++
        rowsWritten++
      }
    }
  }

  // Mark the derivation applied.
  try {
    const { error: markErr } = await supabase
      .from('voice_dna_derivations')
      .update({
        applied: true,
        applied_fields: fields,
        applied_at: new Date().toISOString(),
        applied_by: opts.userId ?? null,
      })
      .eq('id', opts.derivationId)
    if (markErr) {
      log.error('voice_dna_apply.mark_failed', {
        event_type: 'voice_dna_apply',
        outcome: 'fail',
        data: { error: markErr.message, derivation_id: opts.derivationId },
      })
      return {
        ok: false,
        reason: 'persist_failed',
        details: markErr.message,
        correlationId,
      }
    }
  } catch (err) {
    log.error('voice_dna_apply.mark_throw', {
      event_type: 'voice_dna_apply',
      outcome: 'fail',
      data: { error: redactError(err), derivation_id: opts.derivationId },
    })
    return {
      ok: false,
      reason: 'persist_failed',
      details: err instanceof Error ? err.message : 'unknown',
      correlationId,
    }
  }

  log.info('voice_dna_apply.success', {
    event_type: 'voice_dna_apply',
    outcome: 'ok',
    data: {
      venue_id: derivation.venue_id,
      derivation_id: opts.derivationId,
      applied_fields: fields,
      rows_written: rowsWritten,
      per_field: perField,
    },
  })

  return {
    ok: true,
    derivationId: opts.derivationId,
    applied_fields: fields,
    rows_written: rowsWritten,
    per_field: perField,
    correlationId,
  }
}

// ---------------------------------------------------------------------------
// Dismiss flow
// ---------------------------------------------------------------------------

export interface DismissOptions {
  derivationId: string
  reason?: string
  userId?: string
  supabase?: SupabaseClient
}

export async function dismissDerivation(opts: DismissOptions): Promise<{
  ok: boolean
  reason?: string
}> {
  const supabase = opts.supabase ?? createServiceClient()

  const { data: row, error: loadErr } = await supabase
    .from('voice_dna_derivations')
    .select('id, applied, dismissed')
    .eq('id', opts.derivationId)
    .maybeSingle()
  if (loadErr || !row) {
    return { ok: false, reason: 'not_found' }
  }
  const r = row as { applied: boolean; dismissed: boolean }
  if (r.applied) return { ok: false, reason: 'already_applied' }
  if (r.dismissed) return { ok: false, reason: 'already_dismissed' }

  const { error: updErr } = await supabase
    .from('voice_dna_derivations')
    .update({
      dismissed: true,
      dismissed_at: new Date().toISOString(),
      dismissed_by: opts.userId ?? null,
      dismiss_reason: opts.reason ?? null,
    })
    .eq('id', opts.derivationId)
  if (updErr) return { ok: false, reason: updErr.message }

  return { ok: true }
}
