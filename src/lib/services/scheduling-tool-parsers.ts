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
  | 'tour_completed'      // tour event whose date is now in the past
  | 'tour_rescheduled'
  | 'tour_cancelled'
  | 'contract_sent'
  | 'contract_signed'
  | 'payment_received'
  // The following kinds are for ALREADY-BOOKED couples — Calendly event
  // types that only make sense after the contract is signed. Surfacing
  // them as their own kinds prevents the pipeline from treating a final
  // walkthrough as a "new tour booking" and downgrading a booked couple
  // back to tour_scheduled.
  | 'final_walkthrough'
  | 'pre_wedding_event'   // drop-offs, rehearsals
  | 'planning_meeting'    // onboarding, planning calls, post-booking consults

export interface SchedulingEvent {
  source: SchedulingToolSource
  kind: SchedulingEventKind
  /** The real invitee's email — used for contact resolution. */
  inviteeEmail: string
  /** Invitee display name if extractable. */
  inviteeName: string | null
  /** Event datetime as ISO-ish string if parseable. May be null. */
  eventDatetime: string | null
  /** Calendly's "Event Type" name — e.g. "Rixey Manor Venue Tour",
   *  "Final Walkthrough (6 - 3 weeks before wedding date)",
   *  "1hr Planning Meeting on Zoom". Used by callers to decide what
   *  status to apply (a final walkthrough means already-booked). */
  eventTypeName: string | null
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

/**
 * Strip HTML to plain text before label matching. Calendly / Acuity /
 * HoneyBook all send HTML-heavy bodies where labels are wrapped in
 * <strong>, <td>, <div>. Without stripping, the label capture groups
 * pick up "</strong>" or raw markup instead of the value. Handles:
 *   - Remove <script> and <style> blocks (content too)
 *   - Replace <br>, </p>, </div> with newlines (preserves the
 *     "label / value on next line" pattern the regex relies on)
 *   - Strip all remaining tags
 *   - Decode the handful of entities Calendly uses (&amp; &lt; etc.)
 *   - Collapse runs of blank lines
 */
function stripHtml(body: string): string {
  if (!body.includes('<')) return body // plain text already
  let s = body
  // Remove script + style blocks entirely (content unsafe)
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  // Block-level tags → newlines so "Label" and "Value" stay on separate lines
  s = s.replace(/<\/(p|div|tr|td|li|h[1-6]|table|br)\s*\/?>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, '')
  // Decode common entities
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
  // Collapse 3+ blank lines → 2 so the "Label\n\nValue" pattern is
  // preserved but we don't get 20 blank lines between sections
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

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

/**
 * Normalize an invitee-style name string into a {primary, partner} pair.
 * Calendly's Invitee field accepts free text from the couple, so we see
 * a mix of formats:
 *
 *   "Allison Gleason"                    → primary: Allison Gleason
 *   "Gleason, Allison"                   → primary: Allison Gleason (Last, First swap)
 *   "John and Rachel Davis"              → primary: John Davis, partner: Rachel Davis
 *   "Ellie and Bonnie"                   → primary: Ellie, partner: Bonnie
 *   "Valerie Callaway & Christian Harper" → primary: Valerie Callaway, partner: Christian Harper
 *   "Morgan and Grace Newport"           → primary: Morgan Newport, partner: Grace Newport
 *   "John & Rachel"                       → primary: John, partner: Rachel
 *   "N & A Boozy"                         → primary: N Boozy, partner: A Boozy (best-effort)
 *
 * When the partner is already known from a separate Calendly form field
 * (extras.partnerName), the caller should prefer that. This helper is
 * the fallback when the Invitee label itself contains both names.
 */
export function parseInviteeName(raw: string | null): { primary: string; partner: string | null } | null {
  if (!raw) return null
  let s = raw.trim()
  // Strip "(email)" suffix if present
  s = s.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim()
  if (!s) return null

  // "Last, First" → "First Last". Detect by exactly one comma + two
  // tokens. Ignore if the comma-form has 3+ tokens (could be a list).
  if (/^[^,]+,\s+[^,]+$/.test(s)) {
    const [last, first] = s.split(',').map((p) => p.trim())
    if (last && first && !/\s/.test(last) && !/\s+and\s+|\s*&\s*/i.test(s)) {
      return { primary: `${first} ${last}`.trim(), partner: null }
    }
  }

  // Couple form: "X and Y [shared-last]" or "X & Y [shared-last]"
  const coupleMatch = s.match(/^(.+?)\s+(?:and|&)\s+(.+)$/i)
  if (coupleMatch) {
    let firstHalf = coupleMatch[1].trim()
    let secondHalf = coupleMatch[2].trim()

    // Case A: second half has 2+ tokens — "Rachel Davis" — assume the
    // last token is the shared surname. Apply it to first half if that
    // doesn't already include a surname.
    const secondTokens = secondHalf.split(/\s+/)
    const firstTokens = firstHalf.split(/\s+/)
    if (secondTokens.length >= 2 && firstTokens.length === 1) {
      const sharedLast = secondTokens[secondTokens.length - 1]
      firstHalf = `${firstHalf} ${sharedLast}`
    }
    return { primary: firstHalf, partner: secondHalf }
  }

  return { primary: s, partner: null }
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
  // Detect Calendly by EITHER sender domain OR body signature. The
  // sender check catches live ingestion. The body-signature fallback
  // is needed for re-scanning stored interactions where the pipeline
  // rewrote from_email to the invitee (so sender no longer shows as
  // calendly.com). Signature = "A new event has been scheduled" in
  // combination with "Invitee Email:" — unique to Calendly's format.
  const hasSender = /calendly\.com|calendlymail\.com/.test(fromLower)
  // Body signature: the "Invitee Email" label is Calendly-specific
  // (no other service uses that exact phrasing in their notifications).
  // Catches all event types — New Event, Canceled, Updated, reminders —
  // including stored interactions where from_email was rewritten to
  // the invitee's address by the pipeline at ingest time.
  const hasCalendlyBody = /Invitee Email/i.test(body)
  if (!hasSender && !hasCalendlyBody) return null

  // Strip HTML once — Calendly bodies are always HTML and regex label
  // matching picks up "</strong>" instead of the actual value otherwise.
  const text = stripHtml(body)

  const inviteeEmail = extractLabelledEmail(text, ['invitee email', 'invitee', 'attendee', 'from'])
    ?? firstExternalEmail(text, ['calendly.com', 'calendlymail.com'])
  if (!inviteeEmail) return null

  const rawInvitee = extractLabelled(text, ['invitee', 'attendee', 'name'])
    ?.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim() || null
  const parsedName = parseInviteeName(rawInvitee)
  const inviteeName = parsedName?.primary ?? null
  // If the invitee label itself contained a partner ("John and Rachel
  // Davis"), surface the partner half so callers can populate partner2.
  // Falls through to the partner-name extracted from the Calendly form
  // field below if the invitee label was just one name.
  const partnerFromInvitee = parsedName?.partner ?? null

  // Extras — Calendly form fields for the venue's inquiry questionnaire
  const partnerName = extractLabelled(text, [
    'partners first and last name',
    "partner's first and last name",
    "partner's first and last",
    'partners name',
    'partner name',
    'partner 2 name',
  ])
  const partnerEmail = extractLabelledEmail(text, [
    'partners email',
    "partner's email",
    'partner email',
    'partner 2 email',
  ])
  const phone = extractLabelled(text, ['phone number', 'phone', 'mobile'])
  const guestCount = extractLabelled(text, [
    'do you have a number of invited guests in mind',
    'number of invited guests',
    'number of guests',
    'guest count',
    'guests',
  ])
  const hearSource = extractLabelled(text, [
    'where did you first hear about us',
    'where did you hear about us',
    'how did you hear about us',
    'source',
  ])
  const packageInterest = extractLabelled(text, [
    'which package or packages are you interested in',
    'which package',
    'package',
  ])
  const weddingDateHint = extractLabelled(text, [
    'do you have an approximate date in mind',
    'approximate date',
    'wedding date',
    'date in mind',
  ])
  // Additional Guests block — value is multi-line; grab every email that
  // follows the label and precedes the next known labelled section.
  const guestsSection = text.match(/additional guests\s*[:：]?\s*\n([\s\S]*?)(?:\n\s*(?:event date|location|invitee time zone|questions|description)|\n\n\n|$)/i)
  const additionalGuestEmails = guestsSection
    ? (guestsSection[1].match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())
    : []

  // Extract Calendly's "Event Type:" label — drives kind classification.
  // Sample values from Rixey: "Rixey Manor Venue Tour",
  // "Final Walkthrough (6 - 3 weeks before wedding date)",
  // "1hr Planning Meeting on Zoom", "Pre-Tour Phone Call",
  // "Pre-Wedding Drop Off", "Onboarding and Initial Planning".
  const eventTypeName = extractLabelled(text, ['event type', 'event'])
  const evt = (eventTypeName ?? subject ?? '').toLowerCase()
  const subjectLower = subject.toLowerCase()

  let kind: SchedulingEventKind = 'tour_scheduled'
  if (/cancel/i.test(subjectLower)) {
    kind = 'tour_cancelled'
  } else if (/resched|moved|updat/i.test(subjectLower)) {
    kind = 'tour_rescheduled'
  } else if (/final walkthrough|walk[- ]?through/i.test(evt)) {
    // Final walkthrough = booked couple checking the venue 3-6 weeks
    // pre-wedding. Never a new lead.
    kind = 'final_walkthrough'
  } else if (/pre[- ]?wedding|drop[- ]?off|rehearsal/i.test(evt)) {
    kind = 'pre_wedding_event'
  } else if (/planning|onboarding|consultation|initial planning/i.test(evt)) {
    // Planning meetings (1hr Zoom, onboarding call) come AFTER booking.
    kind = 'planning_meeting'
  }
  // else: default 'tour_scheduled' covers "Rixey Manor Venue Tour",
  // "Pre-Tour Phone Call" — both still in the tour-funnel stage.

  return {
    source: 'calendly',
    kind,
    inviteeEmail,
    inviteeName,
    eventDatetime: extractLabelled(text, ['event date/time', 'event date', 'time', 'when']) ?? extractDatetime(text),
    eventTypeName: eventTypeName ?? null,
    matchedFrom: from,
    extras: {
      partnerName: partnerName ?? partnerFromInvitee ?? null,
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
    eventTypeName: extractLabelled(body, ['event type', 'event']) ?? null,
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
    eventTypeName: extractLabelled(body, ['event type', 'event']) ?? null,
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
    eventTypeName: extractLabelled(body, ['event type', 'event']) ?? null,
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
    case 'tour_completed':     return 'tour_completed'
    case 'tour_rescheduled':   return 'tour_rescheduled'
    case 'tour_cancelled':     return 'tour_cancelled'
    case 'contract_sent':      return 'contract_sent'
    case 'contract_signed':    return 'contract_signed'
    case 'payment_received':   return 'contract_signed' // payment = booked, treat as signed
    case 'final_walkthrough':  return 'final_walkthrough'
    case 'pre_wedding_event':  return 'pre_wedding_event'
    case 'planning_meeting':   return 'planning_meeting'
  }
}

/** Map a scheduling event kind → wedding status the wedding should advance to.
 *  Returns null when the event shouldn't change status (rescheduled, cancelled,
 *  or events that imply already-booked which we let the rank guard handle). */
export function eventKindToStatus(kind: SchedulingEventKind): string | null {
  switch (kind) {
    case 'tour_scheduled':     return 'tour_scheduled'
    case 'tour_completed':     return 'tour_completed'
    case 'tour_rescheduled':   return null
    case 'tour_cancelled':     return null
    case 'contract_sent':      return 'proposal_sent'
    case 'contract_signed':    return 'booked'
    case 'payment_received':   return 'booked'
    // Already-booked event types — only advance to 'booked' if the
    // wedding isn't there yet. Rank guard at the call site prevents
    // downgrade if the wedding is past 'booked' (e.g. 'completed').
    case 'final_walkthrough':  return 'booked'
    case 'pre_wedding_event':  return 'booked'
    case 'planning_meeting':   return 'booked'
  }
}

/** Decide the status + kind for a tour event given the event datetime
 *  and the current time. A tour whose datetime is in the past is a
 *  completed tour, not a scheduled one. Returns the appropriate kind
 *  to fire — caller substitutes the original tour_scheduled kind for
 *  this when needed. */
export function timeAwareTourKind(
  baseKind: SchedulingEventKind,
  eventDatetime: string | null,
  now: Date = new Date()
): SchedulingEventKind {
  if (baseKind !== 'tour_scheduled' || !eventDatetime) return baseKind
  // Try to parse the datetime — Calendly format examples:
  //   "11:30am - Friday, May 1, 2026 (Eastern Time - US & Canada)"
  //   "Friday, May 1, 2026 11:30 AM"
  //   "2026-05-01T15:30:00Z"
  const cleaned = eventDatetime.replace(/\s*\([^)]+\)\s*$/, '').trim()
  // Try direct parse first (handles ISO + many natural forms)
  let t = new Date(cleaned).getTime()
  if (Number.isNaN(t)) {
    // Reorder "11:30am - Friday, May 1, 2026" → "Friday, May 1, 2026 11:30 AM"
    const m = cleaned.match(/^(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–—]\s*(.+)$/i)
    if (m) t = new Date(`${m[2]} ${m[1]}`).getTime()
  }
  if (Number.isNaN(t)) return baseKind
  return t < now.getTime() ? 'tour_completed' : 'tour_scheduled'
}
