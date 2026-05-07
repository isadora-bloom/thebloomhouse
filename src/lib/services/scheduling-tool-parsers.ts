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
  // T2-F / ARCH-11.5-B: HoneyBook lifecycle events. These fire from
  // HoneyBook system mail and PRESERVE the source-system tag in the
  // event_type itself so a future Bloom-replaces-HoneyBook migration
  // can query "every booking that originated from HoneyBook" as one
  // forensic-record set. honeybook_contract_signed and
  // honeybook_payment_received are the HoneyBook-tagged equivalents
  // of contract_signed / payment_received (non-HoneyBook scheduling
  // tools keep the unprefixed kinds). honeybook_refund and
  // honeybook_amendment are NEW behaviours with no pre-T2-F equivalent.
  | 'honeybook_contract_signed'
  | 'honeybook_payment_received'
  | 'honeybook_refund'
  | 'honeybook_amendment'

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
// Canonical html→text. Tier-B #72: consolidated 5 local reimplementations
// to lib/utils/html-text.ts. The canonical helper preserves the
// attribute-tolerant block-tag → newline behaviour that the 2026-04-30
// Rixey corruption fix relies on (the original regex tightening was
// hoisted into htmlToText itself).
import { htmlToText as stripHtml } from '@/lib/utils/html-text'

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
  //
  // Hardened (2026-04-30): user-controlled guest comments could
  // contain "Event date:" or "Location:" inside their text and
  // truncate the section. Boundary now requires a label to start
  // at the very beginning of a line (no leading whitespace) AND
  // followed by `:` to mimic Calendly's actual section-label
  // formatting. We also extract emails directly from the body if
  // the section regex fails — emails belonging to a Calendly
  // event email are extremely unlikely to collide with anything
  // else, so a forward-only scan limited to the post-label window
  // is a safer fallback than nothing.
  const guestsSection = text.match(/additional guests\s*[:：]?\s*\n([\s\S]*?)(?:\n(?:Event date|Location|Invitee time zone|Questions|Description|Event Type|Invitee)\s*[:：]|\n{3,}|$)/i)
  let additionalGuestEmails: string[] = []
  if (guestsSection) {
    additionalGuestEmails = (guestsSection[1].match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())
  } else if (/additional guests/i.test(text)) {
    // Section label exists but boundary regex didn't match. Take the
    // 1KB of text after the label and pull emails forward — bounded
    // window prevents picking up the venue's reply-block addresses.
    const labelIdx = text.search(/additional guests\s*[:：]?\s*\n/i)
    if (labelIdx >= 0) {
      const window = text.slice(labelIdx, labelIdx + 1000)
      additionalGuestEmails = (window.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())
      if (additionalGuestEmails.length > 0) {
        console.warn('[parseCalendly] additional-guests boundary regex did not match; used 1KB window fallback')
      }
    }
  }

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
// received" / "Refund issued" / "Amendment" in subject. Invitee email
// sometimes in body, sometimes only the name. For the name-only case we
// return null and let classifier handle it.
//
// T2-F (2026-05-01): emits HoneyBook-tagged lifecycle kinds
// (honeybook_contract_signed / _payment_received / _refund / _amendment)
// instead of generic contract_signed / payment_received so the forensic
// record preserves the source-system attribution per ARCH-11.5-B. Refund
// and amendment are NEW kinds with no pre-T2-F equivalent. Detection
// order matters: most specific keywords first (refund + amendment can
// otherwise match the broader signed/payment patterns).

const HONEYBOOK_REFUND = /refund(?:ed|s|\s+issued|\s+processed)?|chargeback|cancellation\s+(?:processed|approved|issued)/i
const HONEYBOOK_AMENDMENT = /amendment|addendum|updated\s+(?:proposal|contract|project)|contract\s+(?:update|change|modification)/i
const HONEYBOOK_PAYMENT = /payment\s+(?:received|completed|processed|made|deposited)|invoice\s+paid|deposit\s+received|paid\s+in\s+full|retainer\s+received/i
const HONEYBOOK_SIGNED = /contract\s+signed|proposal\s+signed|signed\s+the\s+(?:contract|proposal|agreement)|accepted\s+the\s+(?:contract|proposal|agreement)|booking\s+confirmed/i

function classifyHoneyBookSubjectBody(subject: string, body: string): SchedulingEventKind {
  // Search BOTH subject and body since some templates put the keyword
  // in the body line ("Hi! Madison just signed the proposal...") with
  // a generic subject.
  const haystack = `${subject}\n${body.slice(0, 500)}`
  if (HONEYBOOK_REFUND.test(haystack))    return 'honeybook_refund'
  if (HONEYBOOK_AMENDMENT.test(haystack)) return 'honeybook_amendment'
  if (HONEYBOOK_PAYMENT.test(haystack))   return 'honeybook_payment_received'
  if (HONEYBOOK_SIGNED.test(haystack))    return 'honeybook_contract_signed'
  // No lifecycle keyword matched — default to contract_sent (proposal
  // sent / quote shared / project created). Stays as the GENERIC kind
  // because there's no Bloom-relevant lifecycle distinction here yet.
  return 'contract_sent'
}

function parseHoneyBook(from: string, subject: string, body: string): SchedulingEvent | null {
  const fromLower = from.toLowerCase()
  if (!/honeybook\.com/.test(fromLower)) return null

  const inviteeEmail = extractLabelledEmail(body, ['email', 'client email', 'from', 'replying to'])
    ?? firstExternalEmail(body, ['honeybook.com'])
  if (!inviteeEmail) return null

  const inviteeName = extractLabelled(body, ['client', 'name', 'project', 'for'])
    ?.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim() || null

  const kind = classifyHoneyBookSubjectBody(subject, body)

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
    // T2-F lifecycle: HoneyBook source-tagged events. The literal
    // honeybook_* event_type preserves forensic source attribution
    // (ARCH-11.5-B). Downstream consumers normalize via
    // normalizeEventTypeForScoring() to bucket signed+payment
    // alongside the generic contract_signed for heat / attribution
    // / signal-inference. Refund + amendment have no unprefixed
    // equivalent — they're new behaviours.
    case 'honeybook_contract_signed':  return 'honeybook_contract_signed'
    case 'honeybook_payment_received': return 'honeybook_payment_received'
    case 'honeybook_refund':           return 'honeybook_refund'
    case 'honeybook_amendment':        return 'honeybook_amendment'
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
    // T2-F lifecycle: signed + payment behave like the generic
    // equivalents (status → booked, with rank guard preventing
    // downgrade). Refund deliberately returns null — coordinator
    // decides whether the refund should flip the wedding to 'lost'
    // (some refunds are partial, some are followed by re-booking).
    // Amendment is purely informational, no status change.
    case 'honeybook_contract_signed':  return 'booked'
    case 'honeybook_payment_received': return 'booked'
    case 'honeybook_refund':           return null
    case 'honeybook_amendment':        return null
  }
}

/**
 * Map an engagement_event.event_type string → its un-prefixed equivalent
 * for downstream scoring / filtering. Per Playbook ARCH-11.5-B, source-
 * tagged event types preserve forensic lineage but should NOT force every
 * heat-mapping / attribution / signal-inference filter to learn the
 * prefixed form. Consumers call normalize before comparing.
 *
 *   honeybook_contract_signed  → contract_signed
 *   honeybook_payment_received → contract_signed   (payment ≡ signed for scoring)
 *   honeybook_refund           → honeybook_refund  (no equivalent — passes through)
 *   honeybook_amendment        → honeybook_amendment (passes through)
 *   <anything else>            → <unchanged>
 */
export function normalizeEventTypeForScoring(eventType: string): string {
  switch (eventType) {
    case 'honeybook_contract_signed':  return 'contract_signed'
    case 'honeybook_payment_received': return 'contract_signed'
    default:                            return eventType
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
  const t = parseCalendlyDatetime(eventDatetime)
  if (t === null) return baseKind
  return t < now.getTime() ? 'tour_completed' : 'tour_scheduled'
}

/**
 * Parse a Calendly Event Date/Time string to a unix ms timestamp.
 * Calendly emits a few formats:
 *   "11:30am - Friday, May 1, 2026 (Eastern Time - US & Canada)"
 *   "06:00pm - Thu, Apr 30, 2026"
 *   "02:30pm - Sun, Apr 19, 2026"
 *   "Friday, May 1, 2026 11:30 AM"      ← natural form (rare)
 *   "2026-05-01T15:30:00Z"               ← ISO (also rare)
 *
 * The first form is the most common and JS Date.parse can't handle it
 * directly because:
 *   - "11:30am" has no space before am/pm — Chrome/V8 won't parse
 *   - The "TIME - DATE" ordering with a dash is non-standard
 * Returns null when no parse strategy works.
 */
export function parseCalendlyDatetime(s: string): number | null {
  const cleaned = s.replace(/\s*\([^)]+\)\s*$/, '').trim()
  if (!cleaned) return null

  // 1. Direct ISO + natural date attempt
  let t = Date.parse(cleaned)
  if (!Number.isNaN(t)) return t

  // 2. "TIME - DATE" → reorder + normalize "11:30am" → "11:30 AM"
  const m = cleaned.match(/^(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–—]\s*(.+)$/i)
  if (m) {
    const time = m[1].replace(/(\d)(am|pm)/i, '$1 $2').toUpperCase()
    const date = m[2]
    t = Date.parse(`${date} ${time}`)
    if (!Number.isNaN(t)) return t
    // Some browsers want "May 1, 2026 11:30 AM" specifically; try without
    // the leading weekday
    const dateNoWeek = date.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun),\s*/i, '')
    t = Date.parse(`${dateNoWeek} ${time}`)
    if (!Number.isNaN(t)) return t
  }

  // 3. Last resort: just try the date portion — even without time we
  // can compare days. Better than missing past tours entirely.
  const dateOnly = cleaned.replace(/^\d{1,2}:\d{2}\s*(?:am|pm)?\s*[-–—]\s*/i, '')
    .replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun),\s*/i, '')
  t = Date.parse(dateOnly)
  if (!Number.isNaN(t)) return t

  return null
}
