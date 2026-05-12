/**
 * Personality-change cascade.
 *
 * Fires when venue_ai_config gets updated (dials, vibe, signoff,
 * banned phrases — any field that affects draft voice). Every pending
 * draft is flagged stale so the coordinator UI can prompt regenerate-
 * with-new-voice.
 *
 * Contract: fire-and-forget. Never throws.
 *
 * Scope
 * -----
 * All contexts. Both inquiry and client drafts pick up personality.
 *
 * Wire point
 * ----------
 * The personality page (settings/personality/page.tsx) currently saves
 * via direct supabase.from('venue_ai_config').update() — no API
 * roundtrip. To fire this cascade, the page either (a) routes its save
 * through a new API endpoint that ALSO fires the cascade, or (b) does
 * a fire-and-forget POST to /api/cascades/personality-changed right
 * after the .update succeeds.
 *
 * Until that wiring lands, this cascade can be triggered manually via
 * the admin maintenance endpoint or invoked from any operator-facing
 * "I changed something" action.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface PersonalityCascadeArgs {
  venueId: string
  supabase: SupabaseClient
  /** Free-text label for telemetry — 'slider_save' | 'voice_training' |
   *  'signoff_edit' | 'banned_phrase_add'. */
  reason: string
  correlationId?: string | null
}

export interface PersonalityCascadeResult {
  draftsFlagged: number
  errors: string[]
  latencyMs: number
}

export async function triggerPersonalityCascade(
  args: PersonalityCascadeArgs,
): Promise<PersonalityCascadeResult> {
  const { venueId, supabase, reason, correlationId } = args
  const started = Date.now()
  const result: PersonalityCascadeResult = {
    draftsFlagged: 0,
    errors: [],
    latencyMs: 0,
  }

  try {
    const { data, error } = await supabase
      .from('drafts')
      .update({ personality_stale_at: new Date().toISOString() })
      .eq('venue_id', venueId)
      .eq('status', 'pending')
      .is('personality_stale_at', null)
      .select('id')

    if (error) {
      result.errors.push(`update_failed: ${error.message}`)
    } else {
      result.draftsFlagged = (data ?? []).length
    }
  } catch (err) {
    result.errors.push(
      `threw: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  result.latencyMs = Date.now() - started

  logEvent({
    level: result.errors.length > 0 ? 'warn' : 'info',
    msg: 'cascade.personality',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'cascade.personality',
    outcome: result.errors.length > 0 ? 'fail' : 'ok',
    latency_ms: result.latencyMs,
    data: {
      reason,
      drafts_flagged: result.draftsFlagged,
      error_count: result.errors.length,
      first_error: result.errors[0] ?? null,
    },
  })

  return result
}
