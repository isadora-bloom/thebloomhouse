/**
 * Interaction "flavor" detection — disambiguates a row's transport
 * type (sms/email/meeting in the DB) from the underlying CONTENT
 * source the coordinator actually cares about reading.
 *
 * Concrete case: Calendly notifications can arrive either as
 *   - interactions.type='sms'  (venue phone received Calendly's SMS
 *     notification), or
 *   - interactions.type='meeting' (CSV import via tour-scheduler.ts:
 *     synthetic per-event row, body starts with "provider:calendly\n…").
 *
 * In both cases the rendered row labelled itself "SMS received: …" or
 * "Meeting: …" which is technically true but unhelpful — the
 * coordinator's mental model is "the Calendly event". This helper
 * surfaces that classification so the renderers can swap label +
 * icon without changing the DB type.
 *
 * The detection is intentionally cheap (string prefix check) — the
 * body is the source of truth, no metadata table or env wiring.
 */

export type InteractionFlavor = 'calendly' | null

/**
 * Returns 'calendly' when the row is an SMS or meeting whose body
 * was written by the tour-scheduler Calendly importer
 * (full_body starts with "provider:calendly"). Returns null
 * otherwise — caller falls back to its existing label/icon.
 */
export function detectInteractionFlavor(
  type: string | null | undefined,
  body: string | null | undefined,
): InteractionFlavor {
  if (!body) return null
  if (type !== 'sms' && type !== 'meeting') return null
  // Trim leading whitespace defensively — the writer always emits
  // "provider:calendly\n…" without leading WS, but some importers
  // may prepend a header line.
  if (body.trimStart().startsWith('provider:calendly')) return 'calendly'
  return null
}
