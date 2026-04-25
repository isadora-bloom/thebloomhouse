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
 * EARLIEST inbound email tied to each affected wedding (by name match),
 * then runs that email through detectFormRelay() to recover the real
 * source. Returns a list of candidates the coordinator can review and
 * approve. On approval, applyBacktrace() updates weddings.source AND
 * the wedding's inquiry touchpoint, leaving an audit trail in the
 * touchpoint metadata so a re-run of the same backtrace is idempotent.
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
 * Sender domains that should NEVER be treated as first-touch
 * evidence. Scheduling-tool emails ARE the thing we're trying to
 * back-trace away from, so picking a Calendly confirmation as the
 * "earliest matching email" would just keep recommending Calendly.
 */
const SCHEDULING_TOOL_DOMAINS = [
  'calendly.com',
  'acuityscheduling.com',
  'honeybook.com',
  'dubsado.com',
]

function isSchedulingToolSender(fromEmail: string | null): boolean {
  if (!fromEmail) return false
  const lower = fromEmail.toLowerCase()
  return SCHEDULING_TOOL_DOMAINS.some((d) => lower.includes(`@${d}`) || lower.endsWith(d))
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
 */
export async function findBacktraceCandidates(
  venueId: string,
  options: { useLiveGmail?: boolean } = {}
): Promise<BacktraceCandidate[]> {
  const useLiveGmail = options.useLiveGmail !== false
  const sb = createServiceClient()

  const { data: weddings, error: wedErr } = await sb
    .from('weddings')
    .select('id, source, inquiry_date, created_at')
    .eq('venue_id', venueId)
    .in('source', [...WEAK_FIRST_TOUCH_SOURCES])
  if (wedErr) console.warn('[backtrace] weddings query error:', wedErr.message)
  const weddingRows = (weddings ?? []) as WeddingRow[]
  if (weddingRows.length === 0) return []


  // Join the linked people rows so we have couple names to search by.
  // people.wedding_id is the FK; partner1/partner2 are the rows that
  // belong to the couple themselves. Other roles (guests, vendors)
  // would muddy name search.
  const { data: people } = await sb
    .from('people')
    .select('wedding_id, first_name, last_name, role')
    .in('wedding_id', weddingRows.map((w) => w.id))
    .in('role', ['partner1', 'partner2'])
  const peopleByWedding = new Map<string, PersonRow[]>()
  for (const p of (people ?? []) as PersonRow[]) {
    const arr = peopleByWedding.get(p.wedding_id) ?? []
    arr.push(p)
    peopleByWedding.set(p.wedding_id, arr)
  }
  for (const w of weddingRows) {
    const ppl = peopleByWedding.get(w.id) ?? []
    const parts = ppl
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

    // Search space: this wedding's linked interactions FIRST (they're
    // already attached to this wedding, so name match isn't strictly
    // required), then the unlinked global inbound pool filtered by
    // name token. Constrain to "before or at the inquiry_date + 1 day"
    // so we don't pick up post-booking emails as the supposed first
    // touch.
    const inquiryCutoff = w.inquiry_date ? new Date(w.inquiry_date) : new Date(w.created_at)
    inquiryCutoff.setDate(inquiryCutoff.getDate() + 1)

    // Filter out scheduling-tool emails — those would just recommend
    // Calendly back to itself. The whole point of backtrace is to find
    // what brought the couple BEFORE they ever booked the tour.
    const wedInteractions = (byWedding.get(w.id) ?? []).filter(
      (i) => new Date(i.timestamp) <= inquiryCutoff && !isSchedulingToolSender(i.from_email)
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
      if (liveHit) {
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

    if (pick) {
      const { i, score } = pick
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
    })
  }

  // Most recent inquiry first.
  candidates.sort((a, b) => {
    const at = a.inquiryDate ?? ''
    const bt = b.inquiryDate ?? ''
    return bt.localeCompare(at)
  })

  return candidates
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
