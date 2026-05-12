/**
 * SMS scheduling-event extractor.
 *
 * Class-of-problem: the tours table is the canonical home of "has this
 * couple visited the venue" signal. The trigger from mig 306 stamps
 * weddings.has_toured_in_person when a tours row lands with
 * outcome='completed'. Email pipeline already extracts tour signals
 * from inquiry threads, but SMS-only leads never produce tour rows —
 * so has_toured_in_person stays false, and Sage keeps drafting "come
 * tour" replies long after the in-person visit happened.
 *
 * Live case (Justin & Sandy, RM-1139): tour May 1, AI drafted a
 * tour-invite email on May 12. SMS thread carried both the
 * confirmation ("we're set for Saturday at 10") and post-tour follow-
 * up ("thanks for showing us around") — but no tours row was ever
 * created from the SMS.
 *
 * This extractor pulls the last 30 days of SMS for one wedding, asks
 * Haiku to classify three signals (tour_requested / tour_confirmed /
 * tour_completed), and writes a tours row when confirmed. When the LLM
 * sees post-tour evidence, it stamps outcome='completed' which fires
 * trg_tours_touch_has_toured and unblocks the rest of the Sage prompt
 * stack.
 *
 * Idempotency: before INSERT we check for an existing tour within ±24h
 * of the proposed scheduled_at. The composite index from migration 313
 * (tours_venue_wedding_scheduled_idx) makes that check cheap.
 *
 * Cost: Haiku tier, ~$0.0005-0.001 per wedding. Fired only on inbound
 * SMS, fire-and-forget from openphone ingest. Drift-refresh out of
 * scope here (extractor is signal-driven, not scheduled).
 *
 * 2026-05-12 / mig 313.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson } from '@/lib/ai/client'
import { logEvent } from '@/lib/observability/logger'

/**
 * Prompt-version constant for api_costs.prompt_version. Bump when the
 * system prompt or extraction rules shift so post-hoc audits can
 * correlate quality regressions to a revision. See PROMPTS-CHANGELOG.md.
 */
export const SMS_SCHEDULING_PROMPT_VERSION = 'sms-scheduling.prompt.v1'

const SYSTEM_PROMPT = `You are reading an SMS thread between a wedding venue and a couple. Your job is to extract three structured signals about whether the couple has scheduled, confirmed, or completed an in-person tour of the venue.

You will see SMS messages in chronological order, with each message labeled as either FROM_COUPLE (inbound to the venue) or FROM_VENUE (outbound).

Return a JSON object with exactly these keys:
{
  "tour_requested": boolean,
  "tour_requested_date": string | null,
  "tour_confirmed": boolean,
  "tour_confirmed_date": string | null,
  "tour_completed": boolean,
  "tour_completed_reason": string | null,
  "evidence": string
}

Rules:
- tour_requested = true when ANY party proposes a specific tour date or time window. The couple asking "can we come Saturday?" or the venue offering "would Saturday 10am work?" both count.
- tour_requested_date should be an ISO-8601 date (YYYY-MM-DD) when extractable; null otherwise. Pick the most recently discussed candidate date if multiple appear.
- tour_confirmed = true when BOTH sides agree on a specific date+time. A confirmation may be a one-word "yes" / "perfect" / "see you then" in reply to a specific time proposal. Vague affirmations without a specific time don't count.
- tour_confirmed_date should be ISO-8601 with time when known (YYYY-MM-DDTHH:MM); date-only otherwise.
- tour_completed = true when there is evidence the tour ACTUALLY HAPPENED. Examples: a message after the confirmed date that references the visit ("thanks for showing us around", "the property was beautiful", "we'd love to follow up about pricing now that we've seen it"). Also true when either party explicitly states it happened.
- tour_completed_reason: a short phrase pointing to the evidence ("thanks message after tour date", "couple referenced the visit"). Null when tour_completed is false.
- evidence: a 1-2 sentence neutral description of what you saw. Used for audit, not for couple-facing copy.

Be conservative. When in doubt, return false. A vague "we should set up a time" without a specific proposed date is NOT a tour_requested.`

interface ExtractorResult {
  tour_requested: boolean
  tour_requested_date: string | null
  tour_confirmed: boolean
  tour_confirmed_date: string | null
  tour_completed: boolean
  tour_completed_reason: string | null
  evidence: string
}

export interface SmsExtractorOutput {
  toursCreated: number
  toursCompleted: number
  skipped?: string
}

interface SmsRow {
  direction: 'inbound' | 'outbound'
  timestamp: string
  body_preview: string | null
  full_body: string | null
}

/**
 * Pull last 30 days of SMS for a wedding and extract tour scheduling
 * signals via Haiku. Writes/updates a tours row when evidence is
 * strong; otherwise no-op.
 */
export async function extractTourSignalsFromSmsThread(params: {
  supabase: SupabaseClient
  weddingId: string
  venueId: string
  correlationId?: string
}): Promise<SmsExtractorOutput> {
  const { supabase, weddingId, venueId, correlationId } = params
  const startedAt = Date.now()

  // Stamp last-run regardless of whether we wrote anything — this is
  // throttle data for the drift-refresh layer (out of scope here, but
  // doctrine: write the bookkeeping field every time the extractor
  // visits the wedding).
  const stampLastRun = async () => {
    try {
      await supabase
        .from('weddings')
        .update({ sms_scheduling_extracted_at: new Date().toISOString() })
        .eq('id', weddingId)
    } catch {
      // Bookkeeping failure is not fatal.
    }
  }

  // 30-day window. SMS rows live in interactions.type='sms' (mig 002 +
  // 063 schema). Read both directions so the LLM sees the back-and-forth.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: rows, error } = await supabase
    .from('interactions')
    .select('direction, timestamp, body_preview, full_body')
    .eq('type', 'sms')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
    .gte('timestamp', since)
    .order('timestamp', { ascending: true })
    .limit(200)

  if (error) {
    logEvent({
      level: 'warn',
      msg: 'sms_scheduling_extractor_fetch_failed',
      venueId,
      correlationId,
      event_type: 'sms.scheduling_extract',
      outcome: 'fail',
      data: { wedding_id: weddingId, error: error.message },
    })
    await stampLastRun()
    return { toursCreated: 0, toursCompleted: 0, skipped: 'fetch_failed' }
  }

  const sms = (rows ?? []) as SmsRow[]
  if (sms.length < 2) {
    // A single message is never enough to evidence a tour cycle.
    await stampLastRun()
    return { toursCreated: 0, toursCompleted: 0, skipped: 'thread_too_short' }
  }

  // Build the user-prompt body. Cap each message at 800 chars to keep
  // the prompt budget bounded; tour-scheduling signal lives in the
  // first few lines anyway.
  const lines: string[] = []
  for (const m of sms) {
    const label = m.direction === 'inbound' ? 'FROM_COUPLE' : 'FROM_VENUE'
    const ts = m.timestamp.slice(0, 16).replace('T', ' ')
    const body = (m.full_body ?? m.body_preview ?? '').slice(0, 800)
    if (!body.trim()) continue
    lines.push(`[${ts}] ${label}: ${body}`)
  }
  if (lines.length < 2) {
    await stampLastRun()
    return { toursCreated: 0, toursCompleted: 0, skipped: 'thread_empty_bodies' }
  }

  const userPrompt = `SMS thread:\n\n${lines.join('\n')}\n\nReturn JSON only.`

  let extracted: ExtractorResult
  try {
    extracted = await callAIJson<ExtractorResult>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      venueId,
      taskType: 'sms_scheduling_extract',
      tier: 'haiku',
      contentTier: 2,
      maxTokens: 400,
      temperature: 0,
      promptVersion: SMS_SCHEDULING_PROMPT_VERSION,
      correlationId,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'sms_scheduling_extractor_llm_failed',
      venueId,
      correlationId,
      event_type: 'sms.scheduling_extract',
      outcome: 'fail',
      data: { wedding_id: weddingId, error: err instanceof Error ? err.message : String(err) },
    })
    await stampLastRun()
    return { toursCreated: 0, toursCompleted: 0, skipped: 'llm_failed' }
  }

  let toursCreated = 0
  let toursCompleted = 0

  // Honour tour_confirmed -> tours INSERT path. We require both a
  // confirmation signal AND a parsable scheduled_at, otherwise we
  // can't write a row that the trigger will accept (scheduled_at is
  // nullable but a NULL row is useless for the has_toured stamp).
  if (extracted.tour_confirmed && extracted.tour_confirmed_date) {
    const proposed = parseExtractorDate(extracted.tour_confirmed_date)
    if (proposed) {
      // Idempotency window: skip if any tour row already sits within
      // ±24h. Trust the existing row — coordinator may have edited it.
      const lo = new Date(proposed.getTime() - 86_400_000).toISOString()
      const hi = new Date(proposed.getTime() + 86_400_000).toISOString()
      const { data: existing } = await supabase
        .from('tours')
        .select('id, outcome, scheduled_at')
        .eq('venue_id', venueId)
        .eq('wedding_id', weddingId)
        .gte('scheduled_at', lo)
        .lte('scheduled_at', hi)
        .limit(1)

      if (!existing || existing.length === 0) {
        const { error: insertErr } = await supabase.from('tours').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          scheduled_at: proposed.toISOString(),
          tour_type: 'in_person',
          source: 'sms_extractor',
          notes:
            extracted.evidence?.slice(0, 500) ??
            'Inferred from SMS thread by Haiku extractor.',
        })
        if (insertErr) {
          logEvent({
            level: 'warn',
            msg: 'sms_scheduling_tour_insert_failed',
            venueId,
            correlationId,
            event_type: 'sms.scheduling_extract',
            outcome: 'fail',
            data: { wedding_id: weddingId, error: insertErr.message },
          })
        } else {
          toursCreated++
        }
      }
    }
  }

  // tour_completed → update outcome='completed' on the matching tour
  // row. Prefer the row inside ±24h of tour_confirmed_date; else fall
  // back to the most recent non-completed in_person tour for this
  // wedding. The trg_tours_touch_has_toured trigger from mig 306 fires
  // on UPDATE OF outcome and stamps weddings.has_toured_in_person.
  if (extracted.tour_completed) {
    let updateTarget: { id: string; outcome: string | null } | null = null

    if (extracted.tour_confirmed_date) {
      const proposed = parseExtractorDate(extracted.tour_confirmed_date)
      if (proposed) {
        const lo = new Date(proposed.getTime() - 86_400_000).toISOString()
        const hi = new Date(proposed.getTime() + 86_400_000).toISOString()
        const { data: candidate } = await supabase
          .from('tours')
          .select('id, outcome')
          .eq('venue_id', venueId)
          .eq('wedding_id', weddingId)
          .gte('scheduled_at', lo)
          .lte('scheduled_at', hi)
          .order('scheduled_at', { ascending: false })
          .limit(1)
        if (candidate && candidate.length > 0) {
          updateTarget = candidate[0] as { id: string; outcome: string | null }
        }
      }
    }

    if (!updateTarget) {
      const { data: fallback } = await supabase
        .from('tours')
        .select('id, outcome')
        .eq('venue_id', venueId)
        .eq('wedding_id', weddingId)
        .neq('outcome', 'completed')
        .order('scheduled_at', { ascending: false })
        .limit(1)
      if (fallback && fallback.length > 0) {
        updateTarget = fallback[0] as { id: string; outcome: string | null }
      }
    }

    if (updateTarget && updateTarget.outcome !== 'completed') {
      const { error: updErr } = await supabase
        .from('tours')
        .update({
          outcome: 'completed',
          notes:
            (extracted.tour_completed_reason ?? extracted.evidence ?? '').slice(0, 500) ||
            'Marked completed by SMS extractor.',
        })
        .eq('id', updateTarget.id)
      if (updErr) {
        logEvent({
          level: 'warn',
          msg: 'sms_scheduling_tour_complete_failed',
          venueId,
          correlationId,
          event_type: 'sms.scheduling_extract',
          outcome: 'fail',
          data: { wedding_id: weddingId, tour_id: updateTarget.id, error: updErr.message },
        })
      } else {
        toursCompleted++
      }
    }
  }

  await stampLastRun()

  logEvent({
    level: 'info',
    msg: 'sms_scheduling_extractor_complete',
    venueId,
    correlationId,
    event_type: 'sms.scheduling_extract',
    outcome: 'ok',
    latency_ms: Date.now() - startedAt,
    data: {
      wedding_id: weddingId,
      tours_created: toursCreated,
      tours_completed: toursCompleted,
      tour_requested: extracted.tour_requested,
      tour_confirmed: extracted.tour_confirmed,
      tour_completed: extracted.tour_completed,
    },
  })

  return { toursCreated, toursCompleted }
}

/**
 * Parse an extractor-returned date. Accepts ISO-8601 with or without
 * time. Returns null if the value isn't a usable Date.
 */
function parseExtractorDate(value: string | null): Date | null {
  if (!value) return null
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return null
  return new Date(t)
}
