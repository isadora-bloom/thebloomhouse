/**
 * Universal email-body identity extractor.
 *
 * 2026-04-30 user mandate: every inbound email gets body-scanned for
 * prospect identity (emails, phones, names, date hints) regardless of
 * whether a platform-specific parser (Calendly, Knot, WW, Zola,
 * calculator) matched. Two reasons:
 *
 *   1. Catch leads from email shapes our parsers don't recognize
 *      (bespoke contact forms, web concierge tools, plain emails).
 *      Today those fall back to the From header — which is the
 *      relay, not the prospect.
 *
 *   2. Persist a reliable identity payload on interactions so
 *      retroactive linkage scripts + downstream UIs have something
 *      to work with that doesn't depend on re-running the AI
 *      classifier.
 *
 * The output is INFORMATIONAL — platform parsers (form-relay,
 * scheduling-tool) still take precedence when they fire. This
 * extractor's primary role is fallback identity + audit signal.
 */

const EMAIL_RE = /[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

// US/CA-style phone numbers — 10 digits, optional country code,
// optional formatting. Conservative: requires 3-3-4 grouping.
// International numbers won't match; that's acceptable for the
// US-venue audience and prevents capturing false positives like
// "1234567890" as a phone.
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g

// Date hints — YYYY-MM-DD, MM/DD/YYYY, "April 15, 2026", season+year,
// month+year. Captures the substring; downstream parseFuzzyDate
// handles the actual normalization.
const DATE_HINT_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  /\b(?:Spring|Summer|Fall|Autumn|Winter)\s+\d{4}\b/gi,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi,
]

// Guest count — "100 guests", "50-60", "100-150", "approx 80".
const GUEST_HINT_RE = /\b(\d{1,4})(?:\s*[-–to]\s*\d{1,4})?\s*(?:guests?|people|attendees|persons|pax)\b/i

// Name shape — capitalized first + capitalized last (or last initial).
// Conservative bounds: 2-30 chars per token, allows hyphens and
// apostrophes (O'Brien, Smith-Jones). Avoids snagging UPPERCASE
// HEADERS like "FOR: RIXEY MANOR" by requiring lowercase letters
// in the second half of each name token.
const NAME_RE = /\b([A-Z][a-z'À-ſ-]{1,29})\s+([A-Z](?:[a-z'À-ſ-]{1,29}|\.))/g

export interface ExtractedIdentity {
  /** All email addresses found in the body. Lowercased + deduped. */
  emails: string[]
  /** All phone numbers found. Normalized to digits-only. */
  phones: string[]
  /** Likely names found. First+last or first+initial. */
  names: string[]
  /** Free-form date strings — wedding date hints, etc. */
  date_hints: string[]
  /** Guest count hint as raw text (e.g. "50-60 guests"). */
  guest_count_hint: string | null
  /** Best-guess primary email — first non-venue-own, non-relay address.
   *  Used as fallback when no parser matched. */
  primary_email: string | null
}

const KNOWN_RELAY_DOMAINS = new Set([
  'calendly.com',
  'calendlymail.com',
  'acuityscheduling.com',
  'honeybook.com',
  'dubsado.com',
  'theknot.com',
  'knotemail.com',
  'member.theknot.com',
  'weddingwire.com',
  'theknotww.com',
  'herecomestheguide.com',
  'zola.com',
])

function isRelayAddress(email: string): boolean {
  const at = email.indexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase()
  if (KNOWN_RELAY_DOMAINS.has(domain)) return true
  // Sub-domain relays — e.g. "messages@theknotww.com" or
  // "connect-{hash}@zola.com" — also match parent domain.
  for (const known of KNOWN_RELAY_DOMAINS) {
    if (domain === known || domain.endsWith('.' + known)) return true
  }
  return false
}

function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, '')
}

function dedup<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

interface ExtractInput {
  body: string
  subject?: string
}

interface ExtractOptions {
  /** Venue-owned addresses to exclude from primary_email candidates. */
  ownEmails?: Set<string>
}

export function extractIdentityFromEmail(
  input: ExtractInput,
  options: ExtractOptions = {},
): ExtractedIdentity {
  const haystack = `${input.subject ?? ''}\n${input.body ?? ''}`
  const ownEmails = options.ownEmails ?? new Set<string>()

  // Emails — dedup, normalize case, exclude empty.
  const rawEmails = haystack.match(EMAIL_RE) ?? []
  const emails = dedup(rawEmails.map((e) => e.toLowerCase().trim())).filter(Boolean)

  // Phones — dedup by digits-only form. Skip obvious garbage (e.g.
  // long IDs, dates that match the pattern incidentally).
  const rawPhones = haystack.match(PHONE_RE) ?? []
  const phones = dedup(
    rawPhones
      .map(digitsOnly)
      .filter((d) => d.length === 10 || d.length === 11),
  )

  // Date hints — across all patterns.
  const dateHints: string[] = []
  for (const re of DATE_HINT_PATTERNS) {
    const m = haystack.match(re)
    if (m) dateHints.push(...m)
  }

  // Guest count.
  const guestMatch = haystack.match(GUEST_HINT_RE)
  const guestCountHint = guestMatch ? guestMatch[0].trim() : null

  // Names — first 5 capitalized-pair matches that don't look like
  // they came from a known UI label ("Reply Reply", "View on
  // WeddingPro" etc).
  const rawNames: string[] = []
  let m: RegExpExecArray | null
  NAME_RE.lastIndex = 0
  while ((m = NAME_RE.exec(haystack)) !== null && rawNames.length < 10) {
    const candidate = `${m[1]} ${m[2]}`
    // Filter out obvious non-names: navigation labels, repeated
    // capitalized words, etc.
    if (/^(Reply|View|Click|Forward|Read|Send|Open|Visit|Contact|Email|Phone|Subject|Date|From|To|Re|Fwd)\s/.test(candidate)) continue
    if (/^([A-Z][a-z]+)\s\1\b/.test(candidate)) continue // "Reply Reply"
    rawNames.push(candidate)
  }
  const names = dedup(rawNames)

  // Primary email — first email that's not venue-owned and not a
  // known relay. This is what the pipeline uses as a fallback for
  // contact resolution when no platform parser matched.
  let primaryEmail: string | null = null
  for (const e of emails) {
    if (ownEmails.has(e)) continue
    if (isRelayAddress(e)) continue
    primaryEmail = e
    break
  }

  return {
    emails,
    phones,
    names,
    date_hints: dedup(dateHints),
    guest_count_hint: guestCountHint,
    primary_email: primaryEmail,
  }
}
