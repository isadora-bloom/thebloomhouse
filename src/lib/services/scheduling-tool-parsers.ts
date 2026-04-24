/**
 * Scheduling-tool email parsers.
 *
 * Parallel to form-relay-parsers.ts. Where form-relay handles inquiry
 * sources (The Knot, WeddingWire, Zola, venue calculators), this module
 * handles scheduling / CRM tools (Calendly, Acuity, HoneyBook, Dubsado).
 *
 * Why two modules:
 *   • Form-relays announce a NEW inquiry. The parser pulls the prospect's
 *     details so the pipeline can create a wedding + contact.
 *   • Scheduling tools announce a PROGRESSION for an EXISTING inquiry
 *     (tour booked, contract signed, payment received). The parser pulls
 *     the invitee's email so the pipeline can match to an existing
 *     wedding and fire the right engagement event + advance status.
 *
 * These were originally meant to be webhook-driven (Calendly webhook
 * hydrates calendly_events). In practice, webhooks aren't hydrating data
 * for every venue (and historical Gmail backfill is the only way to pick
 * up past tours). So we parse the email path as a first-class signal
 * source. White-label by design — no hardcoded venue domains.
 *
 * Hook point: `email-pipeline.ts` calls `detectSchedulingEvent()` after
 * the form-relay detection. A positive match reroutes contact resolution
 * to the invitee's email, fires the event, advances status, and skips
 * draft generation.
 */

export type SchedulingToolSource = 'calendly' | 'acuity' | 'honeybook' | 'dubsado'

export type SchedulingEventKind =
  | 'tour_scheduled'
  | 'tour_rescheduled'
  | 'tour_cancelled'
  | 'contract_sent'
  | 'contract_signed'
  | 'payment_received'

export interface SchedulingEvent {
  source: SchedulingToolSource
  kind: SchedulingEventKind
  /** The real invitee's email — used for contact resolution. */
  inviteeEmail: string
  /** Invitee display name if extractable. */
  inviteeName: string | null
  /** Event datetime as ISO-ish string if parseable. May be null. */
  eventDatetime: string | null
  /** The raw From header we matched on, for audit. */
  matchedFrom: string
  /** Bonus fields that Calendly forms often collect on top of the
   *  booking — venues embed an inquiry-style questionnaire in the
   *  Calendly event type. When present we hydrate the wedding + people
   *  rows with them on first link. */
  extras?: {
    partnerName?: string | null
    partnerEmail?: string | null
    phone?: string | null
    guestCount?: string | null
    source?: string | null
    packageInterest?: string | null
    weddingDateHint?: string | null
    additionalGuestEmails?: string[]
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

/** Extract the first plausible non-sender email from a body. `excludeDomains`
 *  are sender/tool domains we know aren't the invitee. */
function firstExternalEmail(body: string, excludeDomains: string[]): string | null {
  const matches = body.match(EMAIL_RE) ?? []
  for (const raw of matches) {
    const lower = raw.toLowerCase()
    if (excludeDomains.some((d) => lower.endsWith('@' + d) || lower.endsWith('.' + d))) continue
    // Filter the obvious machine addresses
    if (/(no-?reply|noreply|notifications?|support|info@(rixeymanor|thebloomhouse))/i.test(lower)) continue
    return lower
  }
  return null
}

function parseDisplayName(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  // Patterns like "Name: Jane Smith" or "Invitee: Jane Smith (jane@…)"
  const paren = trimmed.match(/^(.*?)\s*\([^)]*@[^)]*\)\s*$/)
  if (paren?.[1]) return paren[1].trim() || null
  return trimmed || null
}

/**
 * Extract the value that follows a labelled line. Handles three shapes
 * Calendly / HoneyBook / Dubsado actually emit:
 *   1. "Label: value"            (single line)
 *   2. "Label:\nvalue"            (value on next line)
 *   3. "Label\nvalue"             (label without colon, value next line)
 * Returns the first non-empty value line, trimmed.
 */
/** Escape regex metacharacters so labels can contain ? . ( ) etc. */
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractLabelled(body: string, labels: string[]): string | null {
  for (const raw of labels) {
    const l = escRe(raw)
    // Shape 1: "Label: value" on one line (colon required to avoid
    // matching label text that's only embedded in a sentence)
    const oneLine = new RegExp(`(?:^|\\n)\\s*${l}\\s*[:：]\\s*([^\\n\\r]+)`, 'i')
    const m1 = body.match(oneLine)
    if (m1?.[1]) {
      const v = m1[1].trim()
      if (v) return v
    }
    // Shape 2a: "Label:" then value on the next non-blank line
    const twoLineColon = new RegExp(`(?:^|\\n)\\s*${l}\\s*[:：]\\s*\\n+\\s*([^\\n\\r]+)`, 'i')
    const m2 = body.match(twoLineColon)
    if (m2?.[1]) {
      const v = m2[1].trim()
      if (v) return v
    }
    // Shape 2b: "Label" (no colon) on its own line, then a blank line,
    // then the value. This is Calendly's Questions-section format.
    // Require the label to be at start of line AND followed by at least
    // one blank line (so we don't mis-match labels embedded in prose).
    const noColon = new RegExp(`(?:^|\\n)\\s*${l}\\s*\\n\\s*\\n+\\s*([^\\n\\r]+)`, 'i')
    const m3 = body.match(noColon)
    if (m3?.[1]) {
      const v = m3[1].trim()
      if (v) return v
    }
  }
  return null
}

function extractDatetime(body: string): string | null {
  // ISO 8601 first — Calendly + Acuity include these in invite links.
  const iso = body.match(/\b(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2})?([+-]\d{2}:?\d{2}|Z)?/)
  if (iso) return iso[0]
  // Long date: "Saturday, May 15, 2026, 2:00 PM"
  const long = body.match(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:,?\s+\d{1,2}:\d{2}\s*(?:am|pm))?/i)
  if (long) return long[0]
  return null
}

// ---------------------------------------------------------------------------
// Parsers (one per tool)
// ---------------------------------------------------------------------------

// Calendly — typical sender: notifications@calendly.com, no-reply@calendly.com.
// Body format (real sample from 2026-04-24):
//
//   Invitee:
//   Allison Gleason
//
//   Invitee Email:
//   agleason@ftsolutions.com
//
//   Additional Guests:
//   stephaniegleason10@gmail.com
//   mandaleigh7.12@gmail.com
//
//   Event Date/Time:
//   11:30am - Friday, May 1, 2026 (Eastern Time - US & Canada)
//
//   Questions:
//
//   Partners First and Last Name
//
//   Dale Roop
//
//   Partners Email
//
//   Daleroop17@gmail.com
//
//   Phone number
//
//   540.645.0564
//
// Label + value are on separate lines. Questions fields have no colon
// after the label. extractLabelled's shape-2 regex handles both.
function parseCalendly(from: string, subject: string, body: string): SchedulingEvent | null {
  const fromLower = from.toLowerCase()
  if (!/calendly\.com|calendlymail\.com/.test(fromLower)) return null

  const inviteeEmail = extractLabelledEmail(body, ['invitee email', 'invitee', 'attendee', 'from'])
    ?? firstExternalEmail(body, ['calendly.com', 'calendlymail.com'])
  if (!inviteeEmail) return null

  const inviteeName = extractLabelled(body, ['invitee', 'attendee', 'name'])
    ?.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim() || null

  // Extras — Calendly form fields for the venue's inquiry questionnaire
  const partnerName = extractLabelled(body, [
    'partners first and last name',
    "partner's first and last name",
    "partner's first and last",
    'partners name',
    'partner name',
    'partner 2 name',
  ])
  const partnerEmail = extractLabelledEmail(body, [
    'partners email',
    "partner's email",
    'partner email',
    'partner 2 email',
  ])
  const phone = extractLabelled(body, ['phone number', 'phone', 'mobile'])
  const guestCount = extractLabelled(body, [
    'do you have a number of invited guests in mind',
    'number of invited guests',
    'number of guests',
    'guest count',
    'guests',
  ])
  const hearSource = extractLabelled(body, [
    'where did you first hear about us',
    'where did you hear about us',
    'how did you hear about us',
    'source',
  ])
  const packageInterest = extractLabelled(body, [
    'which package or packages are you interested in',
    'which package',
    'package',
  ])
  const weddingDateHint = extractLabelled(body, [
    'do you have an approximate date in mind',
    'approximate date',
    'wedding date',
    'date in mind',
  ])
  // Additional Guests block — value is multi-line; grab every email that
  // follows the label and precedes the next known labelled section.
  const guestsSection = body.match(/additional guests\s*[:：]?\s*\n([\s\S]*?)(?:\n\s*(?:event date|location|invitee time zone|questions|description)|\n\n\n|$)/i)
  const additionalGuestEmails = guestsSection
    ? (guestsSection[1].match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())
    : []

  const subjectLower = subject.toLowerCase()
  let kind: SchedulingEventKind = 'tour_scheduled'
  if (/cancel/i.test(subjectLower)) kind = 'tour_cancelled'
  else if (/resched|moved|updat/i.test(subjectLower)) kind = 'tour_rescheduled'

  return {
    source: 'calendly',
    kind,
    inviteeEmail,
    inviteeName,
    eventDatetime: extractLabelled(body, ['event date/time', 'event date', 'time', 'when']) ?? extractDatetime(body),
    matchedFrom: from,
    extras: {
      partnerName: partnerName ?? null,
      partnerEmail: partnerEmail ?? null,
      phone: phone ?? null,
      guestCount: guestCount ?? null,
      source: hearSource ?? null,
      packageInterest: packageInterest ?? null,
      weddingDateHint: weddingDateHint ?? null,
      additionalGuestEmails,
    },
  }
}

// Acuity — typical sender: no-reply@acuityscheduling.com. Body has
// "Name: …" and "Email: …" labelled lines.
function parseAcuity(from: string, subject: string, body: string): SchedulingEvent | null {
  const fromLower = from.toLowerCase()
  if (!/acuityscheduling\.com/.test(fromLower)) return null

  const inviteeEmail = extractLabelledEmail(body, ['email', 'client email', 'from'])
    ?? firstExternalEmail(body, ['acuityscheduling.com'])
  if (!inviteeEmail) return null

  const inviteeName = extractLabelled(body, ['name', 'client', 'attendee'])
    ?.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim() || null

  let kind: SchedulingEventKind = 'tour_scheduled'
  const subjectLower = subject.toLowerCase()
  if (/cancel/i.test(subjectLower)) kind = 'tour_cancelled'
  else if (/resched/i.test(subjectLower)) kind = 'tour_rescheduled'

  return {
    source: 'acuity',
    kind,
    inviteeEmail,
    inviteeName,
    eventDatetime: extractDatetime(body),
    matchedFrom: from,
  }
}

// HoneyBook — sender: *.honeybook.com. Body references the couple by name
// and typically includes "Proposal Signed" / "Contract Signed" / "Payment
// received" in subject. Invitee email sometimes in body, sometimes only
// the name. For the name-only case we return null and let classifier
// handle it.
function parseHoneyBook(from: string, subject: string, body: string): SchedulingEvent | null {
  const fromLower = from.toLowerCase()
  if (!/honeybook\.com/.test(fromLower)) return null

  const inviteeEmail = extractLabelledEmail(body, ['email', 'client email', 'from', 'replying to'])
    ?? firstExternalEmail(body, ['honeybook.com'])
  if (!inviteeEmail) return null

  const inviteeName = extractLabelled(body, ['client', 'name', 'project', 'for'])
    ?.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim() || null

  const subjectLower = subject.toLowerCase()
  let kind: SchedulingEventKind = 'contract_sent'
  if (/signed|accepted/.test(subjectLower)) kind = 'contract_signed'
  else if (/payment|invoice|paid|deposit/.test(subjectLower)) kind = 'payment_received'

  return {
    source: 'honeybook',
    kind,
    inviteeEmail,
    inviteeName,
    eventDatetime: extractDatetime(body),
    matchedFrom: from,
  }
}

// Dubsado — sender: notifications@dubsado.com.
function parseDubsado(from: string, subject: string, body: string): SchedulingEvent | null {
  const fromLower = from.toLowerCase()
  if (!/dubsado\.com/.test(fromLower)) return null

  const inviteeEmail = extractLabelledEmail(body, ['email', 'client email', 'from'])
    ?? firstExternalEmail(body, ['dubsado.com'])
  if (!inviteeEmail) return null

  const inviteeName = extractLabelled(body, ['client', 'name'])
    ?.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim() || null

  const subjectLower = subject.toLowerCase()
  let kind: SchedulingEventKind = 'contract_sent'
  if (/signed|accepted/.test(subjectLower)) kind = 'contract_signed'
  else if (/payment|invoice|paid/.test(subjectLower)) kind = 'payment_received'

  return {
    source: 'dubsado',
    kind,
    inviteeEmail,
    inviteeName,
    eventDatetime: extractDatetime(body),
    matchedFrom: from,
  }
}

// ---------------------------------------------------------------------------
// Label + email extraction
// ---------------------------------------------------------------------------

/** Extract an email that follows a labelled line (same shapes as
 *  extractLabelled — handles one-line "Label: a@b", two-line
 *  "Label:\na@b", and no-colon "Label\na@b"). */
function extractLabelledEmail(body: string, labels: string[]): string | null {
  for (const raw of labels) {
    const l = escRe(raw)
    // Shape 1: "Label: a@b" on one line (colon required)
    const oneLine = new RegExp(
      `(?:^|\\n)\\s*${l}\\s*[:：][^\\n]*?([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})`,
      'i'
    )
    const m1 = body.match(oneLine)
    if (m1?.[1]) return m1[1].toLowerCase()
    // Shape 2a: "Label:" then email on next non-blank line
    const twoLineColon = new RegExp(
      `(?:^|\\n)\\s*${l}\\s*[:：]\\s*\\n+\\s*([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})`,
      'i'
    )
    const m2 = body.match(twoLineColon)
    if (m2?.[1]) return m2[1].toLowerCase()
    // Shape 2b: "Label" (no colon), blank line, email — Calendly Questions
    const noColon = new RegExp(
      `(?:^|\\n)\\s*${l}\\s*\\n\\s*\\n+\\s*([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})`,
      'i'
    )
    const m3 = body.match(noColon)
    if (m3?.[1]) return m3[1].toLowerCase()
  }
  return null
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export function detectSchedulingEvent(email: {
  from: string
  subject: string
  body: string
}): SchedulingEvent | null {
  return (
    parseCalendly(email.from, email.subject, email.body) ||
    parseAcuity(email.from, email.subject, email.body) ||
    parseHoneyBook(email.from, email.subject, email.body) ||
    parseDubsado(email.from, email.subject, email.body)
  )
}

/** Map a scheduling event kind → the engagement_event type that should fire. */
export function eventKindToEngagementType(kind: SchedulingEventKind): string {
  switch (kind) {
    case 'tour_scheduled':     return 'tour_scheduled'
    case 'tour_rescheduled':   return 'tour_rescheduled'
    case 'tour_cancelled':     return 'tour_cancelled'
    case 'contract_sent':      return 'contract_sent'
    case 'contract_signed':    return 'contract_signed'
    case 'payment_received':   return 'contract_signed' // payment = booked, treat as signed
  }
}

/** Map a scheduling event kind → wedding status the wedding should advance to. */
export function eventKindToStatus(kind: SchedulingEventKind): string | null {
  switch (kind) {
    case 'tour_scheduled':     return 'tour_scheduled'
    case 'tour_rescheduled':   return null // don't change status on reschedule
    case 'tour_cancelled':     return null // coordinator reviews before marking lost
    case 'contract_sent':      return 'proposal_sent'
    case 'contract_signed':    return 'booked'
    case 'payment_received':   return 'booked'
  }
}
