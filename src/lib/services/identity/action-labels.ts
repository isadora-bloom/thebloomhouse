/**
 * Operator-friendly touchpoint labels.
 *
 * Why
 * ---
 * The touchpoint pipeline writes `action_type` values in raw enum form
 * (`body_extracted_email`, `crm_imported_lost`, `voicemail_received`,
 * `referral_self_report`, etc). Three operator surfaces used to render
 * those values verbatim via `action.replace(/_/g, ' ')`, leaking the
 * spine vocabulary into the tooltip / anchor label / queue caption
 * the operator actually reads. This module centralises the
 * channel+action → plain-English mapping so every UI consumes the same
 * dictionary.
 *
 * Anchor
 * ------
 * Doctrine: every operator-facing string is plain English (Round 2
 * audit TIER 3 / `scripts/check-operator-vocab.mjs`). The map below
 * mirrors the progression-event vocabulary in
 * `lib/services/identity/progression.ts` so an event-eligible action
 * always reads the same way it does in the progression log.
 *
 * Fallback
 * --------
 * Unmapped (channel, action) tuples fall back to the legacy
 * `action.replace(/_/g, ' ')` rendering. We never throw or render
 * nothing — graceful degradation keeps the surface honest while the
 * map is brought up to date for any new ingest channel.
 */

const EXACT_TUPLES: ReadonlyMap<string, string> = new Map([
  // ---- SMS / phone / voicemail (Pbatch2-1) ---------------------------------
  ['sms|sms_inbound', 'Text received'],
  ['sms|sms_outbound', 'Text sent'],
  ['phone|inbound_call', 'Phone call'],
  ['phone|outbound_call', 'Phone call (outbound)'],
  ['phone|voicemail_received', 'Voicemail'],
  ['voicemail|voicemail_received', 'Voicemail'],

  // ---- Zoom (Pbatch2-1 / Pbatch2-5) ----------------------------------------
  ['zoom|meeting_completed', 'Zoom meeting'],
  ['zoom|meeting_scheduled', 'Zoom scheduled'],

  // ---- HoneyBook CSV (H3 import + crm_attribution) -------------------------
  ['honeybook|crm_imported_inquiry', 'HoneyBook inquiry'],
  ['honeybook|crm_imported_booked', 'HoneyBook booking'],
  ['honeybook|crm_imported_lost', 'HoneyBook lost'],
  ['honeybook|crm_attribution', 'Source attribution'],
  ['honeybook|contract_signed', 'Contract signed'],
  ['honeybook|booking_signed', 'Contract signed'],

  // ---- Calendly (C-series) -------------------------------------------------
  ['calendly|tour_booked', 'Tour booked'],
  ['calendly|tour_cancelled', 'Tour cancelled'],
  ['calendly|tour_attended', 'Tour attended'],
  ['calendly|tour_completed_inferred', 'Tour attended'],
  ['calendly|tour_rescheduled', 'Tour rescheduled'],
  ['calendly|no_show', 'Tour no-show'],

  // ---- Email (Gmail) -------------------------------------------------------
  ['gmail|reply', 'Email reply'],
  ['gmail|inquiry', 'Email inquiry'],
  ['gmail|inbound_followup', 'Email follow-up'],
  ['gmail|venue_sent', 'Email sent'],
  ['gmail|auto_send', 'Email sent'],
  ['gmail|outbound', 'Email sent'],
  ['gmail|human_requested', 'Wants human reply'],

  // ---- Inquiry portals (Knot / WeddingWire / Zola / Website) ---------------
  ['knot|inquiry', 'The Knot inquiry'],
  ['knot|inquiry_form', 'The Knot inquiry'],
  ['knot|message', 'The Knot message'],
  ['theknot|inquiry', 'The Knot inquiry'],
  ['theknot|inquiry_form', 'The Knot inquiry'],
  ['weddingwire|inquiry', 'WeddingWire inquiry'],
  ['weddingwire|inquiry_form', 'WeddingWire inquiry'],
  ['weddingwire|message', 'WeddingWire message'],
  ['wedding_wire|inquiry', 'WeddingWire inquiry'],
  ['wedding_wire|inquiry_form', 'WeddingWire inquiry'],
  ['zola|inquiry', 'Zola inquiry'],
  ['zola|inquiry_form', 'Zola inquiry'],
  ['zola|message', 'Zola message'],
  ['website|inquiry', 'Website inquiry'],
  ['website|inquiry_form_submitted', 'Website inquiry'],
  ['website|inquiry_form', 'Website inquiry'],

  // ---- Portal --------------------------------------------------------------
  ['portal|portal_click', 'Portal click'],
  ['portal|portal_visit', 'Portal visit'],
])

/**
 * Channel-agnostic action types — these mean the same thing no matter
 * which channel surfaced them (a "self-reported referral" reads the same
 * whether it came in over email or SMS).
 */
const ACTION_ONLY: ReadonlyMap<string, string> = new Map([
  ['discovery_self_report', 'How they found us'],
  ['referral_self_report', 'Referral'],
  ['body_extracted_email', 'Found in message body'],
  ['body_extracted_phone', 'Found in message body'],
  ['body_extracted_name', 'Found in message body'],
  ['name_self_report', 'Name self-reported'],
  ['handle_self_report', 'Handle self-reported'],
  ['status_change', 'Status change'],
])

/**
 * Return an operator-friendly label for a touchpoint's
 * (channel, action_type) pair. Always returns a non-empty string —
 * unmapped tuples fall back to `action.replace(/_/g, ' ')`.
 *
 * `channel` accepts `null` for callers that only have the action_type
 * in scope (e.g. cascade events on a journey where the channel was
 * already shown alongside).
 */
export function humanActionLabel(
  channel: string | null | undefined,
  action: string | null | undefined,
): string {
  const a = (action ?? '').trim()
  if (!a) return ''
  const c = (channel ?? '').trim().toLowerCase()

  if (c) {
    const exact = EXACT_TUPLES.get(`${c}|${a}`)
    if (exact) return exact
  }

  const actionOnly = ACTION_ONLY.get(a)
  if (actionOnly) return actionOnly

  return a.replace(/_/g, ' ')
}
