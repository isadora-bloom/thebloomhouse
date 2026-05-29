/**
 * Phase 1.1.c — Calendly ORIGIN replay (ORIGIN-INGESTION-SPEC.md).
 *
 * Calendly reconstruction must come from ORIGIN, not the mirror. The
 * verbatim origin payload is preserved on `weddings.calendly_qa`
 * (migration 322, written by the Calendly webhook at
 * src/app/api/webhooks/calendly/route.ts) under three keys:
 *
 *   - webhook_questions_and_answers  : Array<{question, answer, position?}>
 *                                      (the four-state custom-question Q&A)
 *   - webhook_qa_flattened           : Record<question, answer>
 *   - webhook_invitee_raw            : the FULL Calendly invitee payload
 *                                      (email, name, uri, scheduled_event,
 *                                       created_at, questions_and_answers, ...)
 *
 * This replay reads those origin rows, rebuilds a `NormalizedSignal` per
 * invitee event via the canonical `calendlyToNormalizedSignal` builder
 * (so the replayed signal is byte-identical to the live webhook's signal
 * — same external_id, tier, raw_payload shape, Q&A-derived partner +
 * source enrichment), and routes each through the cascade chokepoint
 * `linkSignal`. Identity (email / phone / name / four-state Q&A) flows
 * from ORIGIN, not from any downstream mirror table.
 *
 * Idempotent: `linkSignal` dedups on
 * UNIQUE(venue_id, channel, external_id). The replayed external_id is the
 * Calendly invitee URI (`webhook_invitee_raw.uri`) — the same key the
 * live webhook used — so re-running this replay never double-writes.
 *
 * Footprint: ONE new file. It constructs no Supabase client of its own —
 * the caller injects the service client (built per
 * scripts/data-integrity-check.ts:
 *   createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { linkSignal, type NormalizedSignal } from '@/lib/spine/cascade'
import { calendlyToNormalizedSignal } from '@/lib/services/identity/calendly-to-signal'

// Shape of the origin-preserved blob on weddings.calendly_qa (migration 322).
interface CalendlyQaBlob {
  webhook_questions_and_answers?: unknown
  webhook_qa_flattened?: unknown
  webhook_invitee_raw?: unknown
  [key: string]: unknown
}

interface WeddingQaRow {
  id: string
  calendly_qa: CalendlyQaBlob | null
}

export interface ReplayCalendlyArgs {
  /** Service-role Supabase client, injected by the caller. */
  supabase: SupabaseClient
  /** Venue scope. Only weddings for this venue are replayed. */
  venueId: string
}

export interface ReplayCalendlyResult {
  /** How many invitee events we built a signal for and sent to linkSignal. */
  processed: number
  /** How many of those resolved to a couple (attached / minted), i.e.
   *  linkSignal returned a non-null matched_couple_id. */
  linked: number
}

const PAGE_SIZE = 500

/**
 * Replay every preserved Calendly origin payload through the cascade.
 *
 * Reads `weddings` rows for the venue that carry a `calendly_qa` blob
 * with a `webhook_invitee_raw` payload, rebuilds the invitee.created
 * signal via `calendlyToNormalizedSignal`, and links it. Returns counts.
 */
export async function replayCalendlyFromQa(
  args: ReplayCalendlyArgs,
): Promise<ReplayCalendlyResult> {
  const { supabase, venueId } = args

  let processed = 0
  let linked = 0
  let offset = 0

  for (;;) {
    const { data, error } = await supabase
      .from('weddings')
      .select('id, calendly_qa')
      .eq('venue_id', venueId)
      .not('calendly_qa', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      throw new Error(`[calendly-replay] weddings read failed: ${error.message}`)
    }

    const rows = (data ?? []) as WeddingQaRow[]
    if (rows.length === 0) break

    for (const row of rows) {
      const blob = row.calendly_qa
      if (!blob || typeof blob !== 'object') continue

      // ORIGIN payload: the full Calendly invitee object the webhook saw.
      const rawInvitee = blob.webhook_invitee_raw
      if (!rawInvitee || typeof rawInvitee !== 'object') {
        // No verbatim origin payload preserved for this wedding (e.g. a
        // CSV-only calendly_qa). Skip — origin-only replay by contract.
        continue
      }

      const payload = rawInvitee as Record<string, unknown>

      // Re-attach the four-state Q&A onto the payload when the invitee
      // blob didn't carry questions_and_answers inline (the webhook
      // stores it under a sibling key). The builder probes
      // payload.questions_and_answers + scheduled_event.questions_and_answers,
      // so surfacing it here keeps partner-email / source enrichment alive.
      if (
        !Array.isArray(payload.questions_and_answers) &&
        Array.isArray(blob.webhook_questions_and_answers)
      ) {
        payload.questions_and_answers = blob.webhook_questions_and_answers
      }

      // Build the canonical signal. 'invitee_created' → tour_booked, the
      // origin event class for a preserved booking payload. external_id =
      // payload.uri (the Calendly invitee URI), matching the live webhook
      // so the replay is idempotent against already-linked touchpoints.
      let signal: NormalizedSignal
      try {
        signal = calendlyToNormalizedSignal({
          event: 'invitee_created',
          payload,
          weddingId: row.id,
        })
      } catch (buildErr) {
        // A malformed origin payload shouldn't abort the whole replay.
        console.warn(
          `[calendly-replay] signal build failed for wedding ${row.id}:`,
          buildErr instanceof Error ? buildErr.message : buildErr,
        )
        continue
      }

      processed += 1

      try {
        const result = await linkSignal({
          supabase,
          venueId,
          signal,
          bypassCache: true,
          source: 'replay:calendly-origin',
        })
        if (result.matched_couple_id) {
          linked += 1
        }
      } catch (linkErr) {
        // Fail-soft per replay row: the linker emits its own telemetry +
        // failed tracer_run_events row. Keep draining the rest.
        console.warn(
          `[calendly-replay] linkSignal failed for wedding ${row.id} ` +
            `(external_id=${signal.external_id}):`,
          linkErr instanceof Error ? linkErr.message : linkErr,
        )
      }
    }

    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return { processed, linked }
}
