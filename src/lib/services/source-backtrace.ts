/**
 * Source backtrace — find the REAL first-touch source for couples
 * whose recorded source is a scheduling tool.
 *
 * Calendly / Acuity / HoneyBook / Dubsado are scheduling plumbing, not
 * acquisition channels. When a wedding's first-touch source is one of
 * those, the actual lead almost always came from somewhere upstream —
 * The Knot, WeddingWire, the venue's own website form, an organic
 * Google search, a referral. The scheduling-tool email just sits at
 * the surface of our pipeline because that's the channel where the
 * couple finally booked the tour.
 *
 * This service walks the venue's interactions table looking for the
 * EARLIEST inbound email tied to each affected wedding (matched against
 * the COUPLE'S FULL IDENTITY CLUSTER — partner1, partner2, plus any
 * linked people row), then runs that email through detectFormRelay()
 * to recover the real source. Returns a list of candidates the
 * coordinator can review and approve. On approval, applyBacktrace()
 * updates weddings.source AND the wedding's inquiry touchpoint, leaving
 * an audit trail in the touchpoint metadata so a re-run of the same
 * backtrace is idempotent.
 *
 * T5-Rixey-TT redesign (2026-05-02):
 *
 *   1. STRUCTURAL notification-sender detection. The previous version
 *      had a hardcoded SCHEDULING_TOOL_DOMAINS list (calendly.com,
 *      acuityscheduling.com, etc.). That misses every NEW scheduling
 *      tool, every marketing-automation service (em.* / bulk.*), every
 *      autoresponder. Replaced with structural scoring across sender-
 *      pattern signals, body signals (List-Unsubscribe / "do not reply"
 *      / "this is an automated"), and known automation patterns. Score
 *      > 0.5 → discarded.
 *
 *   2. Identity-CLUSTER matching, not just primary email. The previous
 *      version matched only on couple-name tokens. Spouses book tours
 *      with different emails than the inquiry email; HoneyBook sends
 *      Client-Info forms from a third email. Now we look up ALL emails
 *      attached to the wedding's people rows (partner1 / partner2 /
 *      MOB / FOB / wedding party) and require either an email-cluster
 *      hit OR a strong full-name match within ±30d of inquiry_date.
 *
 *   3. THREE explicit return states (no_match | weak_match |
 *      confident_match) — the previous version used a 'none'/'low'/'medium'/
 *      'high' confidence enum but always surfaced every candidate. The
 *      noise was overwhelming: 124 Rixey rows where most produced
 *      "Keep Calendly OR set manually" with no real signal. The new
 *      shape lets the API/UI hide no_match entirely and badge weak_match
 *      with a "review carefully" warning.
 *
 * Multi-venue safe: takes a venueId, only reads/writes that venue's
 * data. Demo-safe: the caller decides which venue to query.
 *
 * Why interactions, not live Gmail: every onboarded venue has its full
 * email history in interactions (the pipeline ingests everything on
 * connect). Going through the local table avoids burning Gmail API
 * quota and works even if the connection was later revoked. If a
 * venue is missing emails from before their Gmail connect window,
 * that's a separate Gmail-history backfill problem.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { detectFormRelay, type FormRelayLead } from './form-relay-parsers'
import { normalizeSource } from './normalize-source'
import { getGmailClient, parseEmailBody } from './gmail'
import { dedupePeopleByName } from '@/lib/utils/couple-name'

/**
 * Sources we consider "weak" first-touch — i.e. a scheduling-tool
 * email rather than an actual acquisition channel. Backtrace candidates
 * come from this set. Venue-calculator is included because while it IS
 * a venue-owned channel, the form often runs after a couple already
 * arrived from somewhere else (search/Knot/etc.) — so we still want
 * to give the coordinator the option to rewrite it. Coordinators can
 * keep `venue_calculator` if it really was first-touch.
 */
export const WEAK_FIRST_TOUCH_SOURCES = new Set([
  'calendly',
  'acuity',
  'honeybook',
  'dubsado',
])

export interface Evidence {
  interactionId: string
  fromEmail: string | null
  fromName: string | null
  subject: string | null
  timestamp: string
  snippet: string
}

export interface BacktraceCandidate {
  weddingId: string
  coupleNames: string | null
  currentSource: string
  inquiryDate: string | null
  /** The source we'd write if the user approves this candidate. Null
   *  when we couldn't find a credible upstream email — coordinator
   *  may still keep the current source or pick one manually. */
  suggestedSource: string | null
  /** The strongest piece of evidence backing the suggestion. */
  evidence: Evidence | null
  /** Confidence is high when a form-relay parser matched the email,
   *  medium when only the sender domain matched a known platform,
   *  low when only a name match was found, none when we have nothing. */
  confidence: 'high' | 'medium' | 'low' | 'none'
  /** T5-Rixey-TT: explicit status so the UI/API can route by intent
   *  rather than guessing from confidence. no_match → hide entirely,
   *  weak_match → show with warning banner, confident_match → auto-
   *  applicable. Existing `confidence` is preserved for backward compat. */
  status: 'no_match' | 'weak_match' | 'confident_match'
  /** T5-Rixey-TT: human-readable warnings (e.g. "matched only by name,
   *  no email overlap with the lead's identity cluster") that the UI
   *  should surface alongside weak_match candidates. */
  warnings: string[]
}

interface InteractionRow {
  id: string
  wedding_id: string | null
  from_email: string | null
  from_name: string | null
  subject: string | null
  body_preview: string | null
  full_body: string | null
  timestamp: string
  direction: string
}

interface WeddingRow {
  id: string
  source: string | null
  inquiry_date: string | null
  created_at: string
  /** Built from joined people rows in findBacktraceCandidates. */
  couple_names?: string | null
}

interface PersonRow {
  wedding_id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  role: string
}

/**
 * Tokenize the couple_names string into searchable lowercase tokens.
 * Example: "Sarah & James Hawthorne" -> ["sarah", "james", "hawthorne"].
 * Drops short tokens (<3 chars) and connectors so we don't false-match
 * on "and" / "&".
 */
function nameTokens(coupleNames: string | null): string[] {
  if (!coupleNames) return []
  const STOP = new Set(['and', 'the', 'for', 'with'])
  return coupleNames
    .toLowerCase()
    .replace(/[&,\/]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t))
}

// ---------------------------------------------------------------------------
// T5-Rixey-TT: structural notification-sender detection
// ---------------------------------------------------------------------------
//
// The old version had a hardcoded list of scheduling-tool domains. That
// only catches Calendly / Acuity / HoneyBook / Dubsado. New scheduling
// tools, marketing-automation services (Sendgrid em.*, bulk.*), and
// generic autoresponders all slip past, get matched as "earliest email,"
// and then get proposed as the real first-touch source — which is
// circular (the Calendly notification proposing Calendly) or wrong-
// person (a marketing blast from List-X identifying List-X as the
// source).
//
// Replacement: score each candidate email on multiple structural
// signals; discard if the cumulative likelihood crosses a threshold.

/** Structural signals that a sender address is automation rather than
 *  a real upstream channel email. Each contributes -0.25 to the
 *  candidate-as-real-first-touch score; cap at -0.75 so a single very-
 *  obvious notification address (notifications@calendly.com) gets
 *  flagged confidently without one signal flipping the verdict. */
const SENDER_PREFIX_PATTERNS = [
  /^notifications?@/i,
  /^no[-._]?reply@/i,
  /^do[-._]?not[-._]?reply@/i,
  /^auto[-._]?(reply|responder|mailer)?@/i,
  /^automated@/i,
  /^postmaster@/i,
  /^mailer[-._]?daemon@/i,
  /^bounce[s]?@/i,
  /^system@/i,
  /^alerts?@/i,
]

/** Domains known to be scheduling/CRM/automation plumbing. NOT used
 *  as a denylist — the Calendly notification, like every other auto-
 *  generated email, scores high on multiple structural signals so it
 *  would be filtered anyway. The list is here purely to weight a
 *  single-domain match in cases where the body/subject is bland. */
const AUTOMATION_DOMAIN_PATTERNS = [
  /@calendly\.com$/i,
  /@acuityscheduling\.com$/i,
  /@dubsado\.com$/i,
  /@honeybook\.com$/i,
  /@crm\.wix\.com$/i,
  /@bulk\./i,
  /@em\./i,                // Sendgrid em.<sender>.com
  /@sendgrid\./i,
  /@mailchimp\./i,
  /@mailgun\./i,
  /@list[s]?\./i,
  /@notifications?\./i,    // notifications.example.com
]

/** Body / subject patterns that indicate the message is automation
 *  rather than a real human or upstream channel email. */
const AUTOMATION_BODY_PATTERNS = [
  /\bdo not reply\b/i,
  /\bthis is an automated\b/i,
  /\bautomated message\b/i,
  /\bunsubscribe from this (list|email)\b/i,
  /\bview this email in your browser\b/i,
  /\blist[-_\s]*unsubscribe\s*:/i,
  /\bauto[-_\s]*submitted\s*:\s*(auto-generated|auto-replied)/i,
  /\bprecedence\s*:\s*(bulk|list)/i,
  /\bx-mailer\s*:\s*[^\n]*automated/i,
  /\bnew event scheduled\b/i,           // Calendly notification preamble
  /\bnew event:\s*.*\bcalendly\b/i,     // Calendly subject pattern
  /\byou have a new appointment\b/i,    // Acuity notification
]

interface AutomationScore {
  /** 0..1 — likelihood the message is automation rather than a real
   *  upstream channel touch. Discard candidates with score > 0.5. */
  likelihood: number
  /** Reasons the score was elevated, kept for debugging/logging. */
  reasons: string[]
}

/**
 * Score the candidate interaction's automation likelihood from the
 * sender address + subject + body. Used to filter out scheduling-tool
 * notification emails and marketing-automation blasts before they can
 * be proposed as the real first-touch source. Returns a likelihood in
 * [0, 1] — caller discards anything > 0.5.
 */
export function scoreAutomationLikelihood(args: {
  fromEmail: string | null
  subject: string | null
  body: string | null
}): AutomationScore {
  const reasons: string[] = []
  let score = 0

  const from = (args.fromEmail ?? '').trim().toLowerCase()
  const subject = (args.subject ?? '').trim()
  const body = (args.body ?? '').trim()

  // Sender-prefix signals (each -0.25, capped at -0.75 cumulative so a
  // single very-obvious prefix doesn't hard-flag if other signals miss).
  let prefixHits = 0
  for (const re of SENDER_PREFIX_PATTERNS) {
    if (re.test(from)) {
      prefixHits++
      reasons.push(`sender-prefix:${re.source}`)
      if (prefixHits >= 3) break
    }
  }
  score += Math.min(prefixHits, 3) * 0.25

  // Domain signals — known automation domain. Single weight 0.4 (a
  // calendly.com sender + automation body is enough to disqualify).
  for (const re of AUTOMATION_DOMAIN_PATTERNS) {
    if (re.test(from)) {
      score += 0.4
      reasons.push(`automation-domain:${re.source}`)
      break
    }
  }

  // Body/subject signals (each +0.15, cap at 4 hits = +0.6).
  let bodyHits = 0
  const haystack = `${subject}\n${body}`
  for (const re of AUTOMATION_BODY_PATTERNS) {
    if (re.test(haystack)) {
      bodyHits++
      reasons.push(`body-pattern:${re.source}`)
      if (bodyHits >= 4) break
    }
  }
  score += Math.min(bodyHits, 4) * 0.15

  // Clamp to [0, 1].
  score = Math.max(0, Math.min(1, score))
  return { likelihood: score, reasons }
}

function isLikelyAutomation(i: InteractionRow): boolean {
  const s = scoreAutomationLikelihood({
    fromEmail: i.from_email,
    subject: i.subject,
    body: i.full_body ?? i.body_preview,
  })
  return s.likelihood > 0.5
}

/**
 * Score how well a single interaction matches a couple. The earliest
 * inbound email that hits at least one name token (and doesn't look
 * like a scheduling-tool reply) is the candidate. If multiple match,
 * prefer the form-relay match.
 */
function scoreEvidence(
  i: InteractionRow,
  tokens: string[]
): { matched: boolean; sourceFromRelay: FormRelayLead | null; nameTokenHits: number } {
  const haystack = [
    i.from_email ?? '',
    i.from_name ?? '',
    i.subject ?? '',
    i.body_preview ?? '',
    i.full_body ?? '',
  ]
    .join(' ')
    .toLowerCase()

  const nameTokenHits = tokens.reduce((n, t) => (haystack.includes(t) ? n + 1 : n), 0)
  const matched = tokens.length === 0 ? false : nameTokenHits > 0

  // Run form-relay detection on the email so we recover the *actual*
  // upstream source if it's a Knot / WW / Zola / venue-form email.
  // detectFormRelay needs the venueOwn set, but for backtrace we don't
  // have it cheaply available; pass empty so only the platform parsers
  // run. (Venue-calculator detection is intentionally skipped here —
  // we can't tell venue_calc from any other inbound without that set,
  // and venue_calc emails are commonly the wedding-creation email
  // anyway, so they wouldn't be a backtrace win.)
  let sourceFromRelay: FormRelayLead | null = null
  try {
    sourceFromRelay = detectFormRelay(
      {
        from: i.from_email ?? '',
        to: '',
        subject: i.subject ?? '',
        body: i.full_body ?? i.body_preview ?? '',
      },
      new Set<string>()
    )
  } catch {
    sourceFromRelay = null
  }

  return { matched, sourceFromRelay, nameTokenHits }
}

/**
 * Heuristic: when the form-relay parsers don't catch it, look at the
 * sender domain to label known acquisition channels by domain. Returns
 * null when the sender is a generic personal email (gmail.com etc.) —
 * those are NOT evidence of any particular channel, they're just the
 * couple's personal address. Suggesting 'website' from a gmail.com
 * sender would replace one bad guess (calendly) with another. Better
 * to leave the row with no suggestion and let the live-Gmail fallback
 * keep searching for an upstream relay email.
 */
function inferSourceFromSender(fromEmail: string | null): string | null {
  if (!fromEmail) return null
  const lower = fromEmail.toLowerCase()
  if (lower.includes('@theknot.com') || lower.includes('member.theknot.com')) return 'the_knot'
  if (lower.includes('@weddingwire.com')) return 'wedding_wire'
  if (lower.includes('@zola.com')) return 'zola'
  if (lower.includes('@herecomestheguide.com')) return 'here_comes_the_guide'
  return null
}

/**
 * T5-Rixey-TT: collect every email address known to belong to this
 * wedding's identity cluster. Used to require email-overlap on at
 * least ONE candidate match, rather than relying purely on name tokens
 * (which false-match across "Sarah Johnson" the bride and "Sarah
 * Johnson" the venue's own front-desk emails).
 */
function collectClusterEmails(people: PersonRow[]): Set<string> {
  const out = new Set<string>()
  for (const p of people) {
    const e = (p.email ?? '').trim().toLowerCase()
    if (e && e.includes('@')) out.add(e)
  }
  return out
}

/** Match an interaction to a cluster: at least one cluster email must
 *  appear in the From address OR within the body's first ~500 chars
 *  (covers reply-to / cc / "From: <name> <email>" footers). */
function matchesCluster(i: InteractionRow, clusterEmails: Set<string>): boolean {
  if (clusterEmails.size === 0) return false
  const from = (i.from_email ?? '').toLowerCase()
  const haystack = [
    from,
    (i.body_preview ?? '').toLowerCase(),
    (i.full_body ?? '').slice(0, 500).toLowerCase(),
  ].join(' ')
  for (const e of clusterEmails) {
    if (haystack.includes(e)) return true
  }
  return false
}

/** Match an interaction to a cluster's name tokens with a strong
 *  threshold (≥2 distinct tokens hit, e.g. first AND last name) so a
 *  single-token false-positive doesn't escalate to confident_match. */
function strongNameMatch(i: InteractionRow, tokens: string[]): boolean {
  if (tokens.length < 2) return false
  const haystack = [
    i.from_email ?? '',
    i.from_name ?? '',
    i.subject ?? '',
    i.body_preview ?? '',
    i.full_body ?? '',
  ]
    .join(' ')
    .toLowerCase()
  let hits = 0
  for (const t of tokens) {
    if (haystack.includes(t)) hits++
    if (hits >= 2) return true
  }
  return false
}

/** Date proximity check: the candidate must fall within ±30 days of
 *  inquiry_date when matching purely on name (not email). Stops weak
 *  full-name matches from picking up an unrelated email about a
 *  different couple with the same surname. */
function withinNameMatchWindow(i: InteractionRow, inquiryDate: Date | null): boolean {
  if (!inquiryDate) return true   // no inquiry date → can't filter, allow
  const t = new Date(i.timestamp).getTime()
  if (Number.isNaN(t)) return false
  const delta = Math.abs(t - inquiryDate.getTime())
  return delta <= 30 * 24 * 60 * 60 * 1000
}

/**
 * Strip a body to a tiny preview string for the review UI.
 */
function makeSnippet(text: string | null, max = 160): string {
  if (!text) return ''
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned
}

/**
 * Search the venue's live Gmail mailbox for the earliest message
 * matching a couple's name. Used as a fallback when the local
 * interactions table has nothing — interactions only holds the 90-day
 * onboarding backfill plus polling deltas, so for older weddings the
 * real first-touch email lives only in Gmail itself.
 *
 * Strategy: build a Gmail search query using the couple's name tokens
 * (`"Sarah" "Hawthorne"`) restricted to inbound mail (-from:me), with
 * `before:` set to the wedding's inquiry_date + 1 day so we never
 * pick up post-booking confirmations. We pull the earliest-matching
 * message via list+get, parse the headers and body, and return a
 * synthetic "interaction-shape" record so the caller can score it the
 * same way as a local interaction.
 *
 * Returns null if Gmail isn't connected, no message matched, or the
 * API errored. We treat all those as "no fallback evidence" rather
 * than failing the whole backtrace pass.
 */
async function searchGmailForCouple(
  venueId: string,
  tokens: string[],
  inquiryCutoff: Date
): Promise<InteractionRow | null> {
  if (tokens.length === 0) return null
  const gmail = await getGmailClient(venueId)
  if (!gmail) return null

  // Quote each token so Gmail treats it as an exact-match phrase
  // rather than a fuzzy term. before: takes YYYY/MM/DD.
  const cutoff = new Date(inquiryCutoff)
  const yyyy = cutoff.getUTCFullYear()
  const mm = String(cutoff.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(cutoff.getUTCDate()).padStart(2, '0')
  const phrase = tokens.map((t) => `"${t}"`).join(' ')
  // -from:me restricts to inbound only; the venue's own outbound
  // would otherwise dominate results for any couple they later
  // emailed. -category:promotions/social skips Gmail's auto-filtered
  // newsletter buckets.
  const q = `${phrase} -from:me -category:promotions -category:social before:${yyyy}/${mm}/${dd}`

  let messageIds: string[] = []
  try {
    const list: { data: { messages?: Array<{ id?: string }> } } =
      await gmail.users.messages.list({ userId: 'me', q, maxResults: 25 })
    messageIds = (list.data.messages ?? [])
      .map((m: { id?: string }) => m.id)
      .filter((id: string | undefined): id is string => !!id)
  } catch (err) {
    console.warn('[backtrace] Gmail search failed:', err)
    return null
  }
  if (messageIds.length === 0) return null

  // Fetch all candidates so we can pick the EARLIEST. The list API
  // returns messages in reverse-chronological order; we want the
  // oldest match — that's our true first touch.
  type GmailHit = { id: string; from: string; to: string; subject: string; body: string; date: string }
  const hits: GmailHit[] = []
  for (const id of messageIds) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
      const headers = (msg.data.payload?.headers ?? []) as Array<{ name: string; value: string }>
      const get = (name: string) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
      hits.push({
        id,
        from: get('From'),
        to: get('To'),
        subject: get('Subject'),
        body: parseEmailBody((msg.data.payload ?? {}) as Record<string, unknown>),
        date: get('Date'),
      })
    } catch (err) {
      console.warn(`[backtrace] failed to fetch Gmail message ${id}:`, err)
    }
  }
  if (hits.length === 0) return null

  // Pick the earliest by Date header.
  hits.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const earliest = hits[0]

  // Shape it into an InteractionRow so the rest of the pipeline can
  // score it uniformly. We don't have a real interaction id (this
  // message was never ingested), so prefix with `gmail:` to mark
  // origin.
  const fromEmail = (() => {
    const m = earliest.from.match(/<([^>]+)>/)
    return (m ? m[1] : earliest.from).trim().toLowerCase() || null
  })()
  const fromName = (() => {
    const m = earliest.from.match(/^([^<]+)</)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
  })()
  return {
    id: `gmail:${earliest.id}`,
    wedding_id: null,
    from_email: fromEmail,
    from_name: fromName,
    subject: earliest.subject,
    body_preview: earliest.body.slice(0, 500),
    full_body: earliest.body,
    timestamp: new Date(earliest.date).toISOString(),
    direction: 'inbound',
  }
}

/**
 * Find every wedding for the venue whose recorded first-touch source
 * is a scheduling tool, then for each one look back through inbound
 * email history for the earliest inbound that names the couple. Return
 * the candidate list sorted by inquiry date descending so the most
 * recent (most likely to still be relevant) come first.
 *
 * Two-pass search:
 *   1. Local `interactions` table (free, instant) — covers the 90-day
 *      onboarding backfill window plus everything captured since.
 *   2. Live Gmail API (uses quota, no date cap) — fallback for older
 *      weddings whose first-touch email predates the onboarding
 *      backfill window. Skipped if `useLiveGmail: false` is passed
 *      (lets callers preview without burning Gmail quota).
 *
 * T5-Rixey-TT: candidates with status='no_match' are FILTERED OUT of
 * the returned list (the caller's UI doesn't want noise). To get every
 * wedding regardless of match status (e.g. for an audit dashboard),
 * pass `{ includeNoMatch: true }`.
 */
export async function findBacktraceCandidates(
  venueId: string,
  options: { useLiveGmail?: boolean; includeNoMatch?: boolean } = {}
): Promise<BacktraceCandidate[]> {
  const useLiveGmail = options.useLiveGmail !== false
  const includeNoMatch = options.includeNoMatch === true
  const sb = createServiceClient()

  const { data: weddings, error: wedErr } = await sb
    .from('weddings')
    .select('id, source, inquiry_date, created_at')
    .eq('venue_id', venueId)
    .in('source', [...WEAK_FIRST_TOUCH_SOURCES])
  if (wedErr) console.warn('[backtrace] weddings query error:', wedErr.message)
  const weddingRows = (weddings ?? []) as WeddingRow[]
  if (weddingRows.length === 0) return []


  // Join the linked people rows so we have couple names + EMAILS to
  // search by. Stream-TT widens beyond partner1/partner2 to ALL roles
  // — MOB / FOB / wedding-party emails belong to the same identity
  // cluster and frequently book the tour for the couple. The previous
  // version restricted to partner1/partner2 only.
  const { data: people } = await sb
    .from('people')
    .select('wedding_id, first_name, last_name, email, role')
    .in('wedding_id', weddingRows.map((w) => w.id))
  const peopleByWedding = new Map<string, PersonRow[]>()
  for (const p of (people ?? []) as PersonRow[]) {
    const arr = peopleByWedding.get(p.wedding_id) ?? []
    arr.push(p)
    peopleByWedding.set(p.wedding_id, arr)
  }
  for (const w of weddingRows) {
    const ppl = peopleByWedding.get(w.id) ?? []
    // couple_names string only includes partner1/partner2 — that's the
    // human-readable label for the UI; the cluster-email check uses
    // the wider set.
    // T5-Rixey-EEE Bug 1 (defense-in-depth): dedupe by name.
    const partners = dedupePeopleByName(
      ppl.filter((p) => p.role === 'partner1' || p.role === 'partner2')
    )
    const parts = partners
      .map((p) => [p.first_name, p.last_name].filter(Boolean).join(' ').trim())
      .filter(Boolean)
    w.couple_names = parts.join(' & ') || null
  }

  // Pull all inbound interactions for this venue once. For Rixey this
  // is ~hundreds of rows; per-wedding queries would be 167 round-trips.
  const { data: interactions } = await sb
    .from('interactions')
    .select('id, wedding_id, from_email, from_name, subject, body_preview, full_body, timestamp, direction')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: true })
  const allInteractions = (interactions ?? []) as InteractionRow[]

  // Index by wedding_id so we can look up that wedding's emails fast.
  // A wedding with no linked interactions still gets searched against
  // the global pool by name token (some inquiries are linked to the
  // wedding only via the inquiry email, others via later threads).
  const byWedding = new Map<string, InteractionRow[]>()
  for (const i of allInteractions) {
    if (!i.wedding_id) continue
    const arr = byWedding.get(i.wedding_id) ?? []
    arr.push(i)
    byWedding.set(i.wedding_id, arr)
  }

  const candidates: BacktraceCandidate[] = []

  for (const w of weddingRows) {
    const coupleNames = w.couple_names ?? null
    const tokens = nameTokens(coupleNames)
    const ppl = peopleByWedding.get(w.id) ?? []
    const clusterEmails = collectClusterEmails(ppl)

    // Search space: this wedding's linked interactions FIRST (they're
    // already attached to this wedding, so name match isn't strictly
    // required), then the unlinked global inbound pool filtered by
    // name token. Constrain to "before or at the inquiry_date + 1 day"
    // so we don't pick up post-booking emails as the supposed first
    // touch.
    const inquiryDate = w.inquiry_date ? new Date(w.inquiry_date) : new Date(w.created_at)
    const inquiryCutoff = new Date(inquiryDate)
    inquiryCutoff.setDate(inquiryCutoff.getDate() + 1)

    // Filter out automation candidates STRUCTURALLY (sender pattern +
    // body signals + known automation domains). The previous version
    // had a hardcoded SCHEDULING_TOOL_DOMAINS list; this catches new
    // tools / autoresponders / marketing blasts too.
    const wedInteractions = (byWedding.get(w.id) ?? []).filter(
      (i) => new Date(i.timestamp) <= inquiryCutoff && !isLikelyAutomation(i)
    )

    // Strongest candidate: earliest interaction linked to the wedding
    // that matches a form-relay parser (Knot / WW / Zola / HCTG /
    // venue calc). Otherwise earliest linked interaction with a
    // credible *known-channel* sender — we no longer fall back to
    // "earliest with any sender", because a personal-email match
    // (gmail.com) is not first-touch evidence.
    let pick: { i: InteractionRow; score: ReturnType<typeof scoreEvidence> } | null = null
    for (const i of wedInteractions) {
      const score = scoreEvidence(i, tokens)
      if (score.sourceFromRelay) {
        pick = { i, score }
        break // first form-relay hit is the strongest possible
      }
      // Only treat a non-relay match as a candidate if its sender
      // looks like a known acquisition channel.
      if (!pick && inferSourceFromSender(i.from_email)) pick = { i, score }
    }

    // No local hit (or only a weak name-match without a relay
    // signature) — query the live Gmail mailbox by name. This is what
    // catches couples whose original Knot/WW email predates the 90-day
    // onboarding backfill.
    if (useLiveGmail && (!pick || !pick.score.sourceFromRelay)) {
      const liveHit = await searchGmailForCouple(venueId, tokens, inquiryCutoff)
      // Apply the same automation filter to live-Gmail hits — Gmail
      // search will happily return Calendly notification emails too.
      if (liveHit && !isLikelyAutomation(liveHit)) {
        const score = scoreEvidence(liveHit, tokens)
        // Only override the local pick if the live result actually
        // improves things — i.e. matches a relay parser, OR the local
        // pick was empty.
        if (score.sourceFromRelay || !pick) {
          pick = { i: liveHit, score }
        }
      }
    }

    let suggested: string | null = null
    let confidence: BacktraceCandidate['confidence'] = 'none'
    let evidence: Evidence | null = null
    let status: BacktraceCandidate['status'] = 'no_match'
    const warnings: string[] = []

    if (pick) {
      const { i, score } = pick
      // Gate every match against (a) cluster-email overlap OR
      // (b) strong full-name match within the date window. This is
      // what stops "Christian Harper" → "Valerie Callaway" wrong-
      // person matches: Valerie's email isn't in Christian's cluster
      // and a single shared first-name token doesn't pass the strong-
      // match check.
      const hasEmailOverlap = matchesCluster(i, clusterEmails)
      const hasStrongName = strongNameMatch(i, tokens) && withinNameMatchWindow(i, inquiryDate)

      if (!hasEmailOverlap && !hasStrongName) {
        // Pick exists but doesn't actually identify THIS couple.
        // Don't propose anything; leave status=no_match.
        pick = null
      } else {
        if (score.sourceFromRelay) {
          suggested = score.sourceFromRelay.source
          confidence = 'high'
        } else {
          const inferred = inferSourceFromSender(i.from_email)
          if (inferred && inferred !== w.source) {
            // Known-domain match (theknot.com, weddingwire.com, etc.)
            // without a full relay parser hit. Useful but not as strong
            // as a relay parse — call it medium.
            suggested = inferred
            confidence = 'medium'
          }
        }
        evidence = {
          interactionId: i.id,
          fromEmail: i.from_email,
          fromName: i.from_name,
          subject: i.subject,
          timestamp: i.timestamp,
          snippet: makeSnippet(i.body_preview ?? i.full_body),
        }

        // Decide status from confidence + match strength.
        if (suggested && confidence === 'high' && hasEmailOverlap) {
          status = 'confident_match'
        } else if (suggested) {
          status = 'weak_match'
          if (!hasEmailOverlap) {
            warnings.push(
              "Matched on couple's name only — no email overlap with the lead's identity cluster. Review the source email carefully before applying.",
            )
          }
          if (confidence === 'medium') {
            warnings.push('Only the sender-domain matched a known channel; no upstream form-relay parser confirmed it.')
          }
        } else {
          status = 'no_match'
        }
      }
    }

    // If we still have nothing, also normalize the suggested label so
    // the UI gets a canonical key it can stylize. normalizeSource
    // accepts/returns the same canonical value for already-canonical
    // input.
    const normalized = suggested ? normalizeSource(suggested) : null

    candidates.push({
      weddingId: w.id,
      coupleNames,
      currentSource: w.source ?? 'unknown',
      inquiryDate: w.inquiry_date,
      suggestedSource: normalized,
      evidence,
      confidence,
      status,
      warnings,
    })
  }

  // Most recent inquiry first.
  candidates.sort((a, b) => {
    const at = a.inquiryDate ?? ''
    const bt = b.inquiryDate ?? ''
    return bt.localeCompare(at)
  })

  if (includeNoMatch) return candidates
  // Default: hide no_match from the queue entirely.
  return candidates.filter((c) => c.status !== 'no_match')
}

/**
 * Single-wedding backtrace + auto-apply if high-confidence.
 *
 * Called from the email pipeline at wedding-create time so we
 * never persist 'calendly' as the first-touch source when the real
 * upstream channel (the_knot, wedding_wire, etc.) is one Gmail
 * search away. Fire-and-forget from the caller's POV: it returns
 * the candidate so the caller can log / surface it, but no error
 * propagates.
 *
 * Behavior:
 *   - If the wedding's source isn't in WEAK_FIRST_TOUCH_SOURCES,
 *     no-op (only scheduling tools need backtracing).
 *   - Searches local interactions FIRST (cheap), then live Gmail.
 *   - status='confident_match' → applyBacktrace runs with
 *     backtraced_by='auto' so the audit trail distinguishes
 *     auto-applied from coordinator-confirmed corrections.
 *   - weak_match / no_match → returns the candidate without writing.
 *     The bulk panel and inline override remain available for
 *     manual confirmation.
 *
 * Multi-venue safe: every read filters on venueId and the wedding
 * is verified to belong to that venue before any work.
 */
export async function backtraceOneWedding(
  venueId: string,
  weddingId: string,
  options: { useLiveGmail?: boolean; autoApplyHigh?: boolean } = {}
): Promise<BacktraceCandidate | null> {
  const useLiveGmail = options.useLiveGmail !== false
  const autoApplyHigh = options.autoApplyHigh !== false
  const sb = createServiceClient()

  const { data: wedding } = await sb
    .from('weddings')
    .select('id, venue_id, source, inquiry_date, created_at')
    .eq('id', weddingId)
    .maybeSingle()
  const wedRow = wedding as
    | { id: string; venue_id: string; source: string | null; inquiry_date: string | null; created_at: string }
    | null
  if (!wedRow || wedRow.venue_id !== venueId) return null
  if (!wedRow.source || !WEAK_FIRST_TOUCH_SOURCES.has(wedRow.source)) return null

  // Pull this couple's full identity cluster — name tokens AND every
  // email associated with the wedding's people rows.
  const { data: people } = await sb
    .from('people')
    .select('wedding_id, first_name, last_name, email, role')
    .eq('wedding_id', weddingId)
  const ppl = (people ?? []) as PersonRow[]
  // T5-Rixey-EEE Bug 1 (defense-in-depth): dedupe by name.
  const partners = dedupePeopleByName(
    ppl.filter((p) => p.role === 'partner1' || p.role === 'partner2')
  )
  const coupleNames = partners
    .map((p) => [p.first_name, p.last_name].filter(Boolean).join(' ').trim())
    .filter(Boolean)
    .join(' & ') || null
  const tokens = nameTokens(coupleNames)
  const clusterEmails = collectClusterEmails(ppl)
  if (tokens.length === 0 && clusterEmails.size === 0) return null

  const inquiryDate = wedRow.inquiry_date ? new Date(wedRow.inquiry_date) : new Date(wedRow.created_at)
  const inquiryCutoff = new Date(inquiryDate)
  inquiryCutoff.setDate(inquiryCutoff.getDate() + 1)

  // Local first — only this wedding's already-linked inbound emails.
  // Skip automation senders (their confirmation emails would just
  // recommend Calendly back to itself).
  const { data: localIxs } = await sb
    .from('interactions')
    .select('id, wedding_id, from_email, from_name, subject, body_preview, full_body, timestamp, direction')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: true })
  const localCandidates = ((localIxs ?? []) as InteractionRow[])
    .filter((i) => new Date(i.timestamp) <= inquiryCutoff && !isLikelyAutomation(i))

  let pick: { i: InteractionRow; score: ReturnType<typeof scoreEvidence> } | null = null
  for (const i of localCandidates) {
    const s = scoreEvidence(i, tokens)
    if (s.sourceFromRelay) {
      pick = { i, score: s }
      break
    }
    if (!pick && inferSourceFromSender(i.from_email)) pick = { i, score: s }
  }

  if (useLiveGmail && (!pick || !pick.score.sourceFromRelay)) {
    const liveHit = await searchGmailForCouple(venueId, tokens, inquiryCutoff)
    if (liveHit && !isLikelyAutomation(liveHit)) {
      const s = scoreEvidence(liveHit, tokens)
      if (s.sourceFromRelay || !pick) pick = { i: liveHit, score: s }
    }
  }

  let suggestedSource: string | null = null
  let confidence: BacktraceCandidate['confidence'] = 'none'
  let evidence: Evidence | null = null
  let status: BacktraceCandidate['status'] = 'no_match'
  const warnings: string[] = []

  if (pick) {
    const { i, score } = pick
    const hasEmailOverlap = matchesCluster(i, clusterEmails)
    const hasStrongName = strongNameMatch(i, tokens) && withinNameMatchWindow(i, inquiryDate)

    if (!hasEmailOverlap && !hasStrongName) {
      // Don't propose anything — pick doesn't identify this couple.
    } else {
      if (score.sourceFromRelay) {
        suggestedSource = score.sourceFromRelay.source
        confidence = 'high'
      } else {
        const inferred = inferSourceFromSender(i.from_email)
        if (inferred && inferred !== wedRow.source) {
          suggestedSource = inferred
          confidence = 'medium'
        }
      }
      evidence = {
        interactionId: i.id,
        fromEmail: i.from_email,
        fromName: i.from_name,
        subject: i.subject,
        timestamp: i.timestamp,
        snippet: makeSnippet(i.body_preview ?? i.full_body),
      }
      if (suggestedSource && confidence === 'high' && hasEmailOverlap) {
        status = 'confident_match'
      } else if (suggestedSource) {
        status = 'weak_match'
        if (!hasEmailOverlap) {
          warnings.push("Matched on couple's name only — no email overlap with the lead's identity cluster.")
        }
        if (confidence === 'medium') {
          warnings.push('Only the sender-domain matched a known channel; no upstream form-relay parser confirmed it.')
        }
      }
    }
  }

  const normalized = suggestedSource ? normalizeSource(suggestedSource) : null
  const candidate: BacktraceCandidate = {
    weddingId,
    coupleNames,
    currentSource: wedRow.source,
    inquiryDate: wedRow.inquiry_date,
    suggestedSource: normalized,
    evidence,
    confidence,
    status,
    warnings,
  }

  // Auto-apply only on confident_match — a form-relay parser
  // unambiguously identified the upstream channel AND the candidate's
  // identity-cluster email overlaps. Anything weaker we leave for
  // human review.
  if (autoApplyHigh && status === 'confident_match' && normalized && normalized !== wedRow.source) {
    try {
      await applyBacktrace(venueId, weddingId, normalized, 'auto')
    } catch (err) {
      console.warn(`[backtrace] auto-apply failed for ${weddingId}:`, err)
    }
  }

  return candidate
}

/**
 * Apply an approved backtrace correction. Updates weddings.source AND
 * the wedding's inquiry touchpoint, with audit metadata so a re-run of
 * findBacktraceCandidates skips weddings that were already corrected.
 *
 * This is the idempotent write contract:
 *   - weddings.source becomes newSource
 *   - the inquiry touchpoint (one per wedding by Phase 1 invariant)
 *     gets source=newSource and metadata.backtraced_from=oldSource
 *   - we DON'T delete or rewrite calendly_booked / tour_booked rows;
 *     the scheduling-tool touchpoint is still the truthful record of
 *     which channel booked the tour. Only the *first-touch* changes.
 */
export async function applyBacktrace(
  venueId: string,
  weddingId: string,
  newSource: string,
  appliedBy: string | null = null
): Promise<{ ok: boolean; oldSource: string | null }> {
  const sb = createServiceClient()
  const normalized = normalizeSource(newSource)

  const { data: wedding } = await sb
    .from('weddings')
    .select('id, venue_id, source')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding || wedding.venue_id !== venueId) {
    return { ok: false, oldSource: null }
  }
  const oldSource = (wedding.source as string | null) ?? null

  // 1) Update weddings.source — this is the canonical first-touch.
  // adapter-source-justified: applyBacktrace is the SANCTIONED writer
  //   for weddings.source corrections (coordinator-confirmed or auto-
  //   applied confident_match). The CI guard at scripts/check-adapter-
  //   source-justification.mjs accepts this marker.
  await sb.from('weddings').update({ source: normalized }).eq('id', weddingId)

  // 2) Update the inquiry touchpoint. There is exactly one per wedding
  //    by Phase 1 invariant (ONE_PER_WEDDING_TOUCH_TYPES dedup). Keep
  //    occurred_at; just rewrite source + add audit metadata.
  const { data: tps } = await sb
    .from('wedding_touchpoints')
    .select('id, metadata')
    .eq('wedding_id', weddingId)
    .eq('touch_type', 'inquiry')
    .limit(1)
  const tp = (tps ?? [])[0] as { id: string; metadata: Record<string, unknown> | null } | undefined
  if (tp) {
    const newMeta = {
      ...(tp.metadata ?? {}),
      backtraced_from: oldSource,
      backtraced_to: normalized,
      backtraced_at: new Date().toISOString(),
      ...(appliedBy ? { backtraced_by: appliedBy } : {}),
    }
    await sb
      .from('wedding_touchpoints')
      .update({ source: normalized, metadata: newMeta })
      .eq('id', tp.id)
  }

  return { ok: true, oldSource }
}
