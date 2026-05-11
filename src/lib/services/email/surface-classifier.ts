/**
 * Surface classifier (Wave 28).
 *
 * Pure rules-based decision: WHERE does this interaction belong in the UI?
 *
 *   inbox                — couple-facing conversation thread (default)
 *   system_notification  — automated email from a SaaS tool (Calendly,
 *                          HoneyBook, autoresponder)
 *   crm_attribution      — synthetic interaction from a CRM import adapter
 *                          (HoneyBook, Dubsado, Aisle Planner sync rows)
 *   voice_capture        — Omi / Plaud / SMS / Zoom transcript that powers
 *                          /agent/audio-inbox
 *   integration_event    — webhook-driven structured event (Calendly booking,
 *                          web-form submission, Twilio SMS receipt, Zoom
 *                          transcript) where THE ROW IS the event, not the
 *                          email about it
 *
 * Mirrors migration 294's backfill logic exactly. Pipeline calls this
 * post-insert to upgrade rows from the default 'inbox'; CRM adapters call
 * this (or hard-code) at parse-time so commitNormalisedRows lands the
 * right surface on first write.
 */

export type Surface =
  | 'inbox'
  | 'system_notification'
  | 'crm_attribution'
  | 'voice_capture'
  | 'integration_event'

export interface SurfaceClassifierInput {
  fromEmail?: string | null
  /** interactions.type — email / call / voicemail / sms / meeting / web_form. */
  type?: string | null
  /** Non-null when the row was written by a CRM-import adapter. */
  crmSource?: string | null
  /** T5-Rixey-BBB signal class. Synthetic provenance rows from CRM adapters
   *  declare signal_class='crm' or 'source' on bodies that start with
   *  "provider:..." — that pattern is the canonical "this isn't a real
   *  inbox email" signal. */
  signalClass?: string | null
  /** When known (CRM-import synthetic rows), the body text. The migration
   *  backfill uses `full_body LIKE 'provider:%'` as the crm_attribution
   *  marker; we mirror it here. */
  body?: string | null
}

const SYSTEM_NOTIFICATION_DOMAIN_PATTERNS: RegExp[] = [
  /@calendly\.com$/i,
  /@acuityscheduling\.com$/i,
  /^notifications@honeybook\.com$/i,
  /^no-?reply@/i,
  /^donotreply@/i,
]

function looksLikeSystemNotificationSender(fromEmail: string | null | undefined): boolean {
  if (!fromEmail) return false
  const trimmed = fromEmail.trim().toLowerCase()
  if (!trimmed) return false
  return SYSTEM_NOTIFICATION_DOMAIN_PATTERNS.some((re) => re.test(trimmed))
}

export function classifySurface(input: SurfaceClassifierInput): Surface {
  const { fromEmail, type, crmSource, body } = input

  // Voice capture wins first — Omi/Plaud meetings + voicemails route to
  // /agent/audio-inbox regardless of crm_source. SMS rides the same
  // surface (Stream 3 will land Twilio).
  if (type === 'voicemail' || type === 'meeting' || type === 'sms') {
    // CRM-imported "meeting" rows are synthetic touchpoints, not real
    // captures — those still belong on crm_attribution. Mirrors the
    // migration-294 NOT IN clause.
    const isImportedMeeting = !!crmSource && type === 'meeting'
    if (!isImportedMeeting) return 'voice_capture'
  }

  // CRM synthetic provenance rows: marker is body starting "provider:"
  // (HoneyBook adapter's hear-source synthetic row). Also catch rows
  // with crm_source set and no subject (legacy synthetic shape) — same
  // as migration 294's OR clause.
  if (crmSource) {
    if (body && body.startsWith('provider:')) return 'crm_attribution'
  }

  // System-notification senders (Calendly, HoneyBook notifications,
  // no-reply@*, donotreply@*). Only applies to inbound email.
  if (type === 'email' && looksLikeSystemNotificationSender(fromEmail)) {
    return 'system_notification'
  }

  return 'inbox'
}
