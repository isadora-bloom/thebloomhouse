/**
 * Bloom House: Form-relay email parsers
 *
 * Wedding venues receive a huge chunk of their inbound leads through form
 * relays — The Knot, WeddingWire, Zola — and through their own website
 * pricing calculators. All of these share the same pathology:
 *
 *   • The From header is NOT the prospect. It's a masked relay address
 *     (lead@theknot.com, weddingvendors@zola.com, hello@yourvenue.com).
 *   • The real prospect's name / email / wedding date / guest count is
 *     embedded inside the body as structured key:value text.
 *
 * If the normal pipeline runs as-is, the relay address becomes the "lead"
 * and the actual prospect never lands in the CRM. This module detects each
 * relay shape and unpacks the lead details so downstream code can treat
 * them as real contacts.
 *
 * Every parser is white-label — no venue names, no hardcoded domains
 * beyond the industry platforms themselves. The venue-calculator parser
 * keys off `venueOwnEmails()` so it works for any customer out of the box.
 *
 * Hook point: `email-pipeline.ts` calls `detectFormRelay()` right after
 * parsing the From header, before the self-loop guard runs. A positive
 * match overrides fromEmail / fromName and short-circuits classification
 * with a synthetic `new_inquiry` result.
 */

export type FormRelaySource =
  | 'the_knot'
  | 'wedding_wire'
  | 'here_comes_the_guide'
  | 'zola'
  | 'venue_calculator'

export interface FormRelayLead {
  source: FormRelaySource
  /** The prospect's real email — what findOrCreateContact should key on. */
  leadEmail: string
  /** Display name for the prospect. */
  leadName: string | null
  /** Second partner name if the form exposes it. */
  partnerName?: string | null
  /** Free-text event date as it appears in the body (e.g. "Sat 1/22/2028"). */
  eventDate?: string | null
  /** Free-text guest count ("101 - 150", "85", "100–150"). */
  guestCount?: string | null
  /** Budget string as written in the body, if present. */
  budget?: string | null
  /** The prospect's personal note, if the form captures one. */
  note?: string | null
  /** Where future outbound replies should be sent — the relay address
   *  that actually routes back to the prospect (Knot inbox, Zola connect-*,
   *  or the prospect's personal email for venue calculators). */
  replyToEmail: string
  /** The raw From header we matched on, kept for audit + for logging the
   *  original relay that introduced the lead. */
  matchedRelayFrom: string
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/** Pull every email-shaped token from a string, lowercased + deduped. */
function findAllEmails(text: string): string[] {
  if (!text) return []
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.add(m[0].toLowerCase())
  return [...out]
}

/** Grab the first value after a "Label:" style key. Case-insensitive, tolerates
 *  newline-separated or same-line value formats. */
function fieldAfter(text: string, label: string): string | null {
  if (!text) return null
  // Match "Label:" then optional whitespace (incl. newline) then value up to newline.
  const re = new RegExp(`${label}\\s*[:：]\\s*([^\\n\\r]+)`, 'i')
  const m = text.match(re)
  if (!m) return null
  const v = m[1].trim()
  return v || null
}

function extractEmailAddress(from: string): string {
  if (from.includes('<') && from.includes('>')) {
    const m = from.match(/<([^>]+)>/)
    return m ? m[1].toLowerCase().trim() : from.toLowerCase().trim()
  }
  return from.toLowerCase().trim()
}

function extractDisplayName(from: string): string | null {
  if (from.includes('<')) {
    const n = from.split('<')[0].trim().replace(/["']/g, '')
    return n || null
  }
  return null
}

// ---------------------------------------------------------------------------
// The Knot
// ---------------------------------------------------------------------------
//
// The Knot sends inquiries from `<prospect>.<slug>@member.theknot.com`.
// The display name IS the prospect's real name. The body contains a
// "Personal email:" line with the prospect's real Gmail/etc., plus wedding
// date / guest count / budget / events.
//
// Reply-to: the Knot relay address (so The Knot can route it back to the
// prospect via their WeddingPro inbox). The personal email is stored so
// outreach tooling later can switch to direct-email if the venue wants.

function parseTheKnot(from: string, body: string): FormRelayLead | null {
  const fromAddr = extractEmailAddress(from)
  const isKnot =
    /@(member\.)?theknot\.com$/i.test(fromAddr) ||
    /theknot\.com/i.test(fromAddr)
  if (!isKnot) return null

  const displayName = extractDisplayName(from)
  const personalEmail = fieldAfter(body, 'Personal email')
  const weddingDate = fieldAfter(body, 'Wedding date')
  const guestCount = fieldAfter(body, 'Guest count')
  const budget = fieldAfter(body, 'Budget')

  // Prefer the personal email for identity — that's the durable contact.
  // Fall back to the relay so we still capture a lead even when the
  // "Personal email:" line is missing (they sometimes redact it until
  // the first reply).
  const leadEmail = personalEmail && personalEmail.includes('@')
    ? personalEmail.toLowerCase()
    : fromAddr

  return {
    source: 'the_knot',
    leadEmail,
    leadName: displayName,
    eventDate: weddingDate,
    guestCount,
    budget,
    // Reply via the Knot relay so The Knot can route it back through
    // WeddingPro — that's how the prospect actually sees it.
    replyToEmail: fromAddr,
    matchedRelayFrom: fromAddr,
  }
}

// ---------------------------------------------------------------------------
// WeddingWire (stub — same shape as Knot, refine when a real sample arrives)
// ---------------------------------------------------------------------------

function parseWeddingWire(from: string, body: string): FormRelayLead | null {
  const fromAddr = extractEmailAddress(from)
  const isWW =
    /weddingwire\.com$/i.test(fromAddr) ||
    /@.*weddingwire\.com$/i.test(fromAddr)
  if (!isWW) return null

  const displayName = extractDisplayName(from)
  const personalEmail = fieldAfter(body, 'Personal email') || fieldAfter(body, 'Email')
  const weddingDate = fieldAfter(body, 'Wedding date') || fieldAfter(body, 'Event date')
  const guestCount = fieldAfter(body, 'Guest count') || fieldAfter(body, 'Guests')
  const budget = fieldAfter(body, 'Budget')

  const leadEmail = personalEmail && personalEmail.includes('@')
    ? personalEmail.toLowerCase()
    : fromAddr

  return {
    source: 'wedding_wire',
    leadEmail,
    leadName: displayName,
    eventDate: weddingDate,
    guestCount,
    budget,
    replyToEmail: fromAddr,
    matchedRelayFrom: fromAddr,
  }
}

// ---------------------------------------------------------------------------
// Here Comes The Guide (same shape as Knot / WW — display name is real,
// body has "Wedding date:" / "Guest count:" / "Email:" lines).
// ---------------------------------------------------------------------------

function parseHereComesTheGuide(from: string, body: string): FormRelayLead | null {
  const fromAddr = extractEmailAddress(from)
  const isHCTG = /herecomestheguide\.com$/i.test(fromAddr) || /herecomestheguide/i.test(fromAddr)
  if (!isHCTG) return null

  const displayName = extractDisplayName(from)
  const personalEmail =
    fieldAfter(body, 'Personal email') ||
    fieldAfter(body, 'Email address') ||
    fieldAfter(body, 'Email')
  const weddingDate =
    fieldAfter(body, 'Wedding date') ||
    fieldAfter(body, 'Event date') ||
    fieldAfter(body, 'Date')
  const guestCount =
    fieldAfter(body, 'Guest count') ||
    fieldAfter(body, 'Guests') ||
    fieldAfter(body, 'Estimated guests')
  const budget = fieldAfter(body, 'Budget')

  const leadEmail = personalEmail && personalEmail.includes('@')
    ? personalEmail.toLowerCase()
    : fromAddr

  return {
    source: 'here_comes_the_guide',
    leadEmail,
    leadName: displayName,
    eventDate: weddingDate,
    guestCount,
    budget,
    replyToEmail: fromAddr,
    matchedRelayFrom: fromAddr,
  }
}

// ---------------------------------------------------------------------------
// Zola
// ---------------------------------------------------------------------------
//
// Zola inquiries come from `weddingvendors@zola.com` (or another *@zola.com
// address) with a generic display name like "Zola Vendor Communication".
// The REAL reply-to is inside the body as `connect-<uuid>@zola.com` — that
// is the masked address that routes back to the prospect. Prospect name is
// in a "X & Y sent you an inquiry!" headline; their note is free-form.

function parseZola(from: string, body: string): FormRelayLead | null {
  const fromAddr = extractEmailAddress(from)
  const isZola = /@zola\.com$/i.test(fromAddr) || /zola\.com/i.test(fromAddr)
  if (!isZola) return null

  // Real reply-to lives in the body, not the From header.
  const connectMatch = body.match(/connect-[a-f0-9-]+@zola\.com/i)
  const replyTo = connectMatch ? connectMatch[0].toLowerCase() : fromAddr

  // Prospect name(s): "Molly w & Ethan W sent you an inquiry!"
  //                  "Jane Smith sent you an inquiry!"
  let leadName: string | null = null
  let partnerName: string | null = null
  const sentRe = /([A-Z][^\n\r!]*?)\s+sent you an inquiry/i
  const sentMatch = body.match(sentRe)
  if (sentMatch) {
    const whole = sentMatch[1].trim()
    // "X & Y" or "X and Y" → split.
    const split = whole.split(/\s*(?:&|\band\b)\s*/i)
    leadName = split[0]?.trim() || null
    partnerName = split[1]?.trim() || null
  }

  // "Desired day:", "Guest count:", "Overall budget:".
  const desiredDay = fieldAfter(body, 'Desired day') || fieldAfter(body, 'Wedding date')
  const guestCount = fieldAfter(body, 'Guest count')
  const budget = fieldAfter(body, 'Overall budget') || fieldAfter(body, 'Budget')

  // Their note is wrapped in curly quotes after "Their note to you".
  let note: string | null = null
  const noteMatch = body.match(/Their note to you\s*[\r\n]+[""“]([\s\S]*?)[""”]/i)
  if (noteMatch) note = noteMatch[1].trim()

  return {
    source: 'zola',
    leadEmail: replyTo,
    leadName,
    partnerName,
    eventDate: desiredDay,
    guestCount,
    budget,
    note,
    replyToEmail: replyTo,
    matchedRelayFrom: fromAddr,
  }
}

// ---------------------------------------------------------------------------
// Venue calculator (any venue)
// ---------------------------------------------------------------------------
//
// Pattern: the venue's own pricing-calculator page emails the prospect a
// summary (e.g. "Your <Venue> estimate") and CCs the venue. From is a
// venue-owned address, so the self-loop guard would normally short-circuit
// it. That's wrong — the prospect's email is sitting in the To header, and
// the body is a structured estimate that's a stronger signal than most
// hand-written inquiries.
//
// We detect by: From ∈ venueOwnEmails AND body matches calculator shape
// ("Estimated total" / "Your … estimate" / "Season" + "Guests" keys). Lead
// email is the first To recipient that is NOT a venue-owned address.

const CALCULATOR_BODY_KEYWORDS = [
  'estimated total',
  "here's a summary of what you put together",
  'retainer on booking',
]

// "Your <any venue> estimate" — generic match so every venue's calculator
// passes without needing a per-venue keyword in the literal list above.
const CALCULATOR_BODY_PATTERNS: RegExp[] = [
  /your [a-z][a-z0-9' &-]{2,40} estimate/i,
]

const CALCULATOR_SUBJECT_KEYWORDS = [
  'estimate',
  'your quote',
  'pricing summary',
  'inquiry summary',
]

function looksLikeCalculator(subject: string, body: string): boolean {
  const s = (subject || '').toLowerCase()
  const b = (body || '').toLowerCase()
  if (CALCULATOR_SUBJECT_KEYWORDS.some((k) => s.includes(k))) return true
  if (CALCULATOR_BODY_KEYWORDS.some((k) => b.includes(k))) return true
  if (CALCULATOR_BODY_PATTERNS.some((r) => r.test(body))) return true
  // Generic shape: body contains "Season" + "Guests" + a dollar total.
  const hasSeason = /\bseason\b/i.test(body)
  const hasGuests = /\bguests?\b/i.test(body)
  const hasTotal = /\$\s?\d[\d,]{2,}/.test(body)
  return hasSeason && hasGuests && hasTotal
}

function parseVenueCalculator(
  from: string,
  to: string,
  subject: string,
  body: string,
  venueOwn: Set<string>
): FormRelayLead | null {
  const fromAddr = extractEmailAddress(from)
  if (!venueOwn.has(fromAddr)) return null
  if (!looksLikeCalculator(subject, body)) return null

  // First non-venue recipient in the To header. "To" may be comma-separated
  // and may contain "Name <email>" pairs.
  const toParts = (to || '').split(',').map((s) => s.trim()).filter(Boolean)
  let leadEmail: string | null = null
  let leadName: string | null = null
  for (const part of toParts) {
    const addr = extractEmailAddress(part)
    if (!addr.includes('@')) continue
    if (venueOwn.has(addr)) continue
    leadEmail = addr
    leadName = extractDisplayName(part)
    break
  }
  // Fallback: scan body for any email that isn't venue-owned. Calculators
  // often repeat the prospect's email in the summary.
  if (!leadEmail) {
    const candidates = findAllEmails(body).filter((e) => !venueOwn.has(e))
    if (candidates.length > 0) leadEmail = candidates[0]
  }
  if (!leadEmail) return null

  // Common calculator fields.
  const season = fieldAfter(body, 'Season')
  const guests = fieldAfter(body, 'Guests') || fieldAfter(body, 'Guest count')
  const eventDate = fieldAfter(body, 'Wedding date') || fieldAfter(body, 'Event date') || season

  // If the local-part looks like a name (briannabass1008 → "Brianna Bass"),
  // try to salvage a human name when the display name is blank.
  if (!leadName) {
    const local = leadEmail.split('@')[0]
    // Strip trailing digits, split on dots/underscores/hyphens.
    const cleaned = local.replace(/\d+$/, '').replace(/[._-]+/g, ' ').trim()
    if (cleaned.length >= 3) {
      leadName = cleaned
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ')
    }
  }

  return {
    source: 'venue_calculator',
    leadEmail,
    leadName,
    eventDate,
    guestCount: guests,
    // Calculator reply goes direct to the prospect's real email.
    replyToEmail: leadEmail,
    matchedRelayFrom: fromAddr,
  }
}

// ---------------------------------------------------------------------------
// Shape-heuristic fallback
// ---------------------------------------------------------------------------
//
// Protects against platform domain/format changes. When none of the named
// parsers match but the body shows the tell-tale labelled-field shape of a
// wedding-venue contact form — "Personal email:", "Wedding date:",
// "Guest count:", "Estimated guest count:" etc. — treat it as an unknown
// form relay and unpack what we can. Conservative: requires TWO or more
// labelled fields AND a discoverable email. A one-off mention of
// "Wedding date" in prose won't trigger it.
//
// The source is tagged `venue_calculator` because that's the most likely
// shape (bespoke venue website form) and it's the only source we don't
// hard-link to a platform in intelligence_extractions.

const SHAPE_LABELS = [
  'personal email',
  'contact email',
  'email address',
  'wedding date',
  'event date',
  'preferred date',
  'guest count',
  'number of guests',
  'estimated guest count',
  'estimated guests',
  'budget',
  'venue type',
  "partner's name",
  'partner name',
  'fiance',
]

function parseShapeHeuristic(
  from: string,
  body: string,
  venueOwn: Set<string>
): FormRelayLead | null {
  if (!body) return null
  const lower = body.toLowerCase()

  // Count labelled fields actually present in the body.
  let labelHits = 0
  for (const label of SHAPE_LABELS) {
    // Word-boundary to avoid "wedding date" matching inside an arbitrary sentence.
    const re = new RegExp(`(^|[\\n\\s])${label}\\s*[:：]`, 'i')
    if (re.test(lower)) labelHits++
    if (labelHits >= 2) break
  }
  if (labelHits < 2) return null

  // Prefer a labelled personal email; fall back to the first body email
  // that is NOT a venue-owned address and NOT a known relay domain.
  const personalEmail =
    fieldAfter(body, 'personal email') ||
    fieldAfter(body, 'contact email') ||
    fieldAfter(body, 'email address') ||
    fieldAfter(body, 'email')

  const bodyEmails = findAllEmails(body)
  const relayDomains = /@(member\.)?theknot\.com|@weddingwire\.com|@herecomestheguide\.com|@zola\.com/i

  const fromAddr = extractEmailAddress(from)
  const candidate =
    (personalEmail && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(personalEmail)
      ? personalEmail.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase()
      : null) ||
    bodyEmails.find((e) => !venueOwn.has(e) && !relayDomains.test(e) && e !== fromAddr) ||
    null
  if (!candidate) return null

  const leadName =
    fieldAfter(body, 'name') ||
    fieldAfter(body, 'first name') ||
    extractDisplayName(from)

  return {
    source: 'venue_calculator',
    leadEmail: candidate,
    leadName: leadName ?? null,
    partnerName: fieldAfter(body, "partner's name") || fieldAfter(body, 'partner name') || null,
    eventDate:
      fieldAfter(body, 'wedding date') ||
      fieldAfter(body, 'event date') ||
      fieldAfter(body, 'preferred date'),
    guestCount:
      fieldAfter(body, 'estimated guest count') ||
      fieldAfter(body, 'guest count') ||
      fieldAfter(body, 'number of guests'),
    budget: fieldAfter(body, 'budget'),
    note: fieldAfter(body, 'note') || fieldAfter(body, 'message') || null,
    replyToEmail: candidate,
    matchedRelayFrom: fromAddr,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run every parser in priority order and return the first match.
 *
 * Order matters: platform parsers (Knot, WeddingWire, Zola) run first
 * because their From headers are unambiguous. The venue-calculator parser
 * runs next because it opts-in based on venueOwnEmails. The shape-heuristic
 * fallback runs last as a safety net for platforms that change domain /
 * format or for bespoke contact forms we've never seen before.
 *
 * INTENTIONALLY EXCLUDED: calendly.com, acuityscheduling.com, honeybook.com,
 * dubsado.com. These are scheduling / booking tools, NOT inquiry-relay
 * platforms. Their emails are confirmations of already-scheduled events
 * (the webhook — not the email — is the source of truth). Adding a
 * Calendly parser here would wrongly treat the tour confirmation as a new
 * inquiry and its `startTime` would land in `weddings.wedding_date`.
 * These domains are seeded into `venue_email_filters` (migration 069)
 * with action=ignore/no_draft so they short-circuit before classification.
 */
export function detectFormRelay(
  email: { from: string; to: string; subject: string; body: string },
  venueOwn: Set<string>
): FormRelayLead | null {
  return (
    parseTheKnot(email.from, email.body) ||
    parseWeddingWire(email.from, email.body) ||
    parseHereComesTheGuide(email.from, email.body) ||
    parseZola(email.from, email.body) ||
    parseVenueCalculator(email.from, email.to, email.subject, email.body, venueOwn) ||
    parseShapeHeuristic(email.from, email.body, venueOwn)
  )
}
