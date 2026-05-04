/**
 * Booked-Data Recovery — universal back-fill service for missing
 * booking_value on booked / completed weddings.
 *
 * T5-Rixey-MMM (2026-05-03). Anchor: bloom-constitution.md.
 *
 * Why this exists
 * ---------------
 * Wedding venues onboarding to Bloom typically have a backlog of
 * booked / completed weddings with missing or zero booking_value,
 * missing source, and missing wedding_date. The data lives in their
 * email history (calculator-estimate emails, contract emails,
 * HoneyBook export confirmations) but nothing in Bloom currently
 * walks those emails to recover the real numbers.
 *
 * For Rixey today the gap is 12 of 51 booked weddings (24% of
 * bookings missing data). For a typical onboarding venue this gap
 * will be HIGHER — historical bookings predate Bloom's email
 * tracking entirely.
 *
 * This is a structural problem, not a Rixey-specific one. The
 * service is built to run on every onboarding venue automatically.
 *
 * Three capabilities, run in this order per missing-bv wedding:
 *
 *   1. honeybook_dedup_merge       — Many Calendly-booked weddings
 *                                    are duplicates of HoneyBook
 *                                    records the dedup didn't
 *                                    catch. The HoneyBook record has
 *                                    the contract data; the Calendly-
 *                                    synthesized one doesn't. Find
 *                                    the duplicate, merge source →
 *                                    HoneyBook (HoneyBook survives).
 *   2. calculator_extract          — Pull the largest dollar amount
 *                                    from the latest calculator-
 *                                    estimate email (universal
 *                                    interactivecalculator.com OR
 *                                    venue's own templated estimates
 *                                    sent from venue domain).
 *   3. honeybook_export_recover    — For HoneyBook-imported weddings
 *                                    with zero bv, look in the import
 *                                    interaction's extracted_identity
 *                                    blob for total / amount / value.
 *
 * Constraints
 * -----------
 * - Regex-based extraction. NO Claude API calls. AI extraction is a
 *   follow-up stream — the values are already in the subject line /
 *   first dollar match in the body, and the fuzzy cases are handled
 *   by capability 2 (HoneyBook duplicate merge) which has a different
 *   evidence shape.
 * - Booking_value is INTEGER CENTS (Bloom convention; migration 181).
 *   All extractors output cents.
 * - Idempotent: the orchestrator's filter restricts to weddings with
 *   missing-bv, so a successful recovery on day 1 means day 2 doesn't
 *   re-attempt the same wedding.
 *
 * Data model invariants honored
 * -----------------------------
 * - merged_into_id IS NULL means "active wedding" — the orchestrator
 *   filters on this so already-merged rows are not retried.
 * - When merging, the source wedding's merged_into_id is stamped to
 *   the surviving HoneyBook record id. Constitution invariant: losers
 *   are NEVER hard-deleted.
 * - Every attempt — recovered, merged, no-match, error — writes a row
 *   to booked_data_recovery_log so the readiness page + audit trail
 *   surface what was tried.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { venueOwnEmails } from '@/lib/services/email-pipeline'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Universal calculator vendor — third-party SaaS used by many venues
 * (including Rixey via contact@interactivecalculator.com). Always a
 * candidate for capability 1 regardless of venue domain.
 */
const UNIVERSAL_CALCULATOR_DOMAINS = [
  'interactivecalculator.com',
] as const

/**
 * Subject patterns that indicate an estimate / quote email from the
 * venue's own automation. Match against subject lines on emails sent
 * FROM addresses in venueOwnEmails.
 *
 * Why these patterns: the canonical examples are:
 *   - "New estimate: Taylor Smith & Brayxton alexander — $15,725"
 *   - "Your Rixey Manor estimate"
 *   - "Estimate for Paige & Tanner"
 *   - "Quote for Smith wedding"
 */
const ESTIMATE_SUBJECT_PATTERNS: RegExp[] = [
  /\bnew estimate\b/i,
  /\bestimate for\b/i,
  /\bquote for\b/i,
  /\bestimate:\b/i,
  /\bquote:\b/i,
  /\byour [a-z][a-z0-9' &-]{2,40} estimate\b/i,
]

/**
 * Lower bound for "real wedding" booking value to filter out tiny
 * extractions that are almost certainly NOT the contract total
 * (deposits, fees, tip lines, etc). $500 = 50000 cents.
 */
const MIN_PLAUSIBLE_BOOKING_VALUE_CENTS = 50_000

/**
 * Upper bound for sanity-check. $1,000,000 = 100_000_000 cents. A real
 * wedding wouldn't exceed this; if extraction returns a value above,
 * it's almost certainly an artifact (multiple totals concatenated,
 * year-numbers parsed as dollars, etc.).
 */
const MAX_PLAUSIBLE_BOOKING_VALUE_CENTS = 100_000_000

/**
 * HoneyBook-duplicate detection windows.
 *   - HIGH confidence: both partner first+last match exactly AND date
 *     window within 30 days.
 *   - MEDIUM confidence: one full name matches AND date window within
 *     60 days.
 */
const DEDUP_HIGH_DATE_WINDOW_DAYS = 30
const DEDUP_MEDIUM_DATE_WINDOW_DAYS = 60

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecoveryCapability =
  | 'calculator_extract'
  | 'honeybook_dedup_merge'
  | 'honeybook_export_recover'
  | 'no_op'

export type RecoveryOutcome = 'recovered' | 'merged' | 'no_match' | 'error'

export type RecoveryConfidence = 'high' | 'medium' | 'low' | null

export interface CalculatorExtractResult {
  valueCents: number | null
  sourceInteractionId: string | null
  confidence: 'high' | 'medium' | null
  evidence: {
    subject?: string
    dollar_amounts?: number[]
    picked_amount?: number
    from_email?: string
  }
}

export interface HoneyBookDuplicateResult {
  duplicateWeddingId: string | null
  confidence: 'high' | 'medium' | null
  evidence: {
    matched_partners?: Array<{ first: string; last: string }>
    date_window_days?: number
    source_score?: number
    source_partners?: Array<{ first: string; last: string }>
    source_inquiry_date?: string | null
    target_inquiry_date?: string | null
  }
}

export interface HoneyBookExportRecoverResult {
  valueCents: number | null
  source: 'export_payload' | 'interaction_blob' | null
  evidence: {
    extracted_field?: string
    raw_value?: unknown
  }
}

export interface RecoveryReportItem {
  weddingId: string
  capability: RecoveryCapability
  outcome: RecoveryOutcome
  recoveredValueCents: number | null
  duplicateWeddingId: string | null
  confidence: RecoveryConfidence
  errorMessage: string | null
}

export interface RecoveryReport {
  venueId: string
  totalCandidates: number
  recovered: RecoveryReportItem[]
  merged: RecoveryReportItem[]
  noMatch: RecoveryReportItem[]
  errors: RecoveryReportItem[]
}

// ---------------------------------------------------------------------------
// Helper: extract dollar amounts from text
// ---------------------------------------------------------------------------

/**
 * Pull every dollar amount from a string. Returns an array of cents
 * values. Strips the dollar sign + commas, allows decimals.
 *
 *   "estimate: $15,725.00 + $1,200 upgrade = $16,925" → [1572500, 120000, 1692500]
 */
function extractDollarAmountsAsCents(text: string): number[] {
  if (!text) return []
  const out: number[] = []
  // Match $X, $X.YY, $X,XXX, $X,XXX.YY. Avoid matching "12.50%" by
  // requiring a leading $ or the pattern starting with $.
  const re = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].replace(/,/g, '')
    const dollars = Number(raw)
    if (!Number.isFinite(dollars) || dollars <= 0) continue
    const cents = Math.round(dollars * 100)
    out.push(cents)
  }
  return out
}

/**
 * Pick the most likely booking-total amount from a list of cents
 * values pulled from an estimate email. The total is almost always
 * the LARGEST line (package + upgrades + total — the total wins);
 * return that, after applying plausibility bounds.
 */
function pickBookingValue(amounts: number[]): number | null {
  const plausible = amounts.filter(
    (c) =>
      c >= MIN_PLAUSIBLE_BOOKING_VALUE_CENTS &&
      c <= MAX_PLAUSIBLE_BOOKING_VALUE_CENTS,
  )
  if (plausible.length === 0) return null
  return Math.max(...plausible)
}

// ---------------------------------------------------------------------------
// Helper: name normalization + Levenshtein
// ---------------------------------------------------------------------------

function normalizeName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

/** Classic edit-distance — small enough to run on partner-name pairs. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length
  const n = b.length
  let prev: number[] = new Array(n + 1)
  let curr: number[] = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

function namesEquivalent(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  // Tight Levenshtein — cover typos like "Tanner" vs "Tannor" but
  // not unrelated names. ≤ 2 keeps it tight (single character delta
  // for short names; two for longer ones).
  return levenshtein(a, b) <= 2
}

// ---------------------------------------------------------------------------
// Capability 1: Calculator-estimate extractor
// ---------------------------------------------------------------------------

/**
 * Walk this wedding's interactions for a calculator-estimate email
 * (universal interactivecalculator.com OR the venue's own templated
 * estimate emails) and pull the largest dollar amount.
 *
 * Logic:
 *   - Pull interactions for this wedding where from_email matches:
 *       a) any UNIVERSAL_CALCULATOR_DOMAINS (interactivecalculator.com)
 *       b) any of the venue's own emails (venueOwnEmails) AND subject
 *          matches an ESTIMATE_SUBJECT_PATTERN
 *   - For each match, extract dollar amounts from subject + full_body.
 *   - Pick the LARGEST plausible amount (calculators show package +
 *     upgrades + total — total wins).
 *   - If multiple interactions match, pick the LATEST (final estimate).
 */
export async function extractBookingValueFromCalculatorEmails(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<CalculatorExtractResult> {
  // Look up the venue id so we can hydrate the venueOwnEmails set
  // (drives the templated-from-venue-domain branch).
  const { data: weddingRow } = await supabase
    .from('weddings')
    .select('venue_id')
    .eq('id', weddingId)
    .maybeSingle()

  if (!weddingRow) {
    return { valueCents: null, sourceInteractionId: null, confidence: null, evidence: {} }
  }

  const venueId = weddingRow.venue_id as string
  const ownEmails = await venueOwnEmails(venueId)
  // Derive venue-owned domains from the registered venue emails. This
  // captures the (Rixey-shaped) case where the templated estimate
  // sender (hello@rixeymanor.com) is NOT individually registered in
  // gmail_connections / venue_config.automation_emails but is on the
  // same domain as a registered email (info@rixeymanor.com). The
  // subject-pattern guard still gates this branch — a venue insider
  // sending an unrelated email from hello@rixeymanor.com without an
  // estimate-shaped subject is correctly skipped.
  //
  // Public-mailbox domains (gmail.com, outlook.com, etc.) are
  // explicitly excluded so a coordinator's personal Gmail (which
  // legitimately appears in venueOwnEmails because it sat on user_
  // profiles or in prevOutbounds) can't expand the venue domain set.
  const PUBLIC_MAILBOX_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
    'yahoo.com', 'yahoo.co.uk', 'live.com', 'icloud.com', 'me.com',
    'aol.com', 'protonmail.com', 'pm.me', 'msn.com',
    'lindymail.ai', // shared infra mailbox per existing fixtures
  ])
  const ownDomains = new Set<string>()
  for (const email of ownEmails) {
    if (!email.includes('@')) continue
    const domain = email.split('@')[1]
    if (!domain) continue
    if (PUBLIC_MAILBOX_DOMAINS.has(domain)) continue
    ownDomains.add(domain)
  }

  // Pull every interaction for the wedding, ordered by newest first
  // so the LATEST estimate wins when multiple match.
  const { data: interactions } = await supabase
    .from('interactions')
    .select('id, from_email, subject, full_body, body_preview, timestamp')
    .eq('wedding_id', weddingId)
    .eq('type', 'email')
    .order('timestamp', { ascending: false })
    .limit(200)

  if (!interactions || interactions.length === 0) {
    return { valueCents: null, sourceInteractionId: null, confidence: null, evidence: {} }
  }

  type InteractionRow = {
    id: string
    from_email: string | null
    subject: string | null
    full_body: string | null
    body_preview: string | null
    timestamp: string | null
  }

  const candidates: Array<{
    row: InteractionRow
    dollar_amounts: number[]
    picked: number | null
    confidence: 'high' | 'medium'
  }> = []

  for (const raw of interactions as InteractionRow[]) {
    const fromEmail = (raw.from_email ?? '').toLowerCase().trim()
    const fromDomain = fromEmail.includes('@') ? fromEmail.split('@')[1] : ''
    const subject = raw.subject ?? ''
    const body = raw.full_body ?? raw.body_preview ?? ''

    // Universal: any interactivecalculator-style domain.
    const isUniversalCalc = UNIVERSAL_CALCULATOR_DOMAINS.some((d) => fromDomain === d)
    // Venue-templated: from any address on a venue-owned domain (so
    // hello@rixeymanor.com qualifies even if only info@rixeymanor.com
    // is registered) AND subject matches an estimate pattern. The
    // subject-pattern guard prevents legitimate venue-internal
    // emails (replies / coordination) from being misinterpreted as
    // estimates. Falls back to the registered-email exact match when
    // the from-address sits on a public mailbox domain — which is
    // legitimate for boutique venues that route through Gmail.
    const onVenueDomain = fromDomain.length > 0 && ownDomains.has(fromDomain)
    const isVenueRegistered = ownEmails.has(fromEmail)
    const subjectLooksLikeEstimate = ESTIMATE_SUBJECT_PATTERNS.some((re) => re.test(subject))
    const isVenueTemplated = (onVenueDomain || isVenueRegistered) && subjectLooksLikeEstimate

    if (!isUniversalCalc && !isVenueTemplated) continue

    // Extract from BOTH subject and body — the venue-templated case
    // ("New estimate: Taylor Smith & Brayxton alexander — $15,725")
    // puts the value directly in the subject.
    const subjectAmounts = extractDollarAmountsAsCents(subject)
    const bodyAmounts = extractDollarAmountsAsCents(body)
    const allAmounts = [...subjectAmounts, ...bodyAmounts]
    const picked = pickBookingValue(allAmounts)
    if (picked == null) continue

    // Confidence rule:
    //   - high: subject contains a plausible amount (the venue's
    //     templated subject is the canonical case — subject == final
    //     estimate).
    //   - medium: only body contains plausible amounts (calculator
    //     emails where the total is buried in body markup).
    const subjectHasPlausible = pickBookingValue(subjectAmounts) != null
    const confidence: 'high' | 'medium' = subjectHasPlausible ? 'high' : 'medium'

    candidates.push({ row: raw, dollar_amounts: allAmounts, picked, confidence })
  }

  if (candidates.length === 0) {
    return { valueCents: null, sourceInteractionId: null, confidence: null, evidence: {} }
  }

  // The latest matching interaction wins (interactions list is already
  // ordered newest-first).
  const winner = candidates[0]
  return {
    valueCents: winner.picked,
    sourceInteractionId: winner.row.id,
    confidence: winner.confidence,
    evidence: {
      subject: winner.row.subject ?? '',
      dollar_amounts: winner.dollar_amounts,
      picked_amount: winner.picked ?? undefined,
      from_email: (winner.row.from_email ?? '').toLowerCase().trim(),
    },
  }
}

// ---------------------------------------------------------------------------
// Capability 2: HoneyBook-duplicate detector
// ---------------------------------------------------------------------------

/**
 * Find a HoneyBook-imported wedding that is the same human as this
 * source wedding. Operates on partner names + date proximity.
 *
 * Search constraints (all required):
 *   - Same venue
 *   - crm_source = 'honeybook' on the candidate
 *   - status IN ('booked', 'completed') on the candidate
 *   - merged_into_id IS NULL on the candidate (active set only)
 *   - At least one partner first+last matches via case-insensitive
 *     equality OR Levenshtein ≤ 2 on each name part
 *   - inquiry_date OR wedding_date within ±60 days of the source's
 *
 * Confidence:
 *   - high: BOTH partners' first+last match AND date window ≤ 30d
 *   - medium: ONE partner's first+last matches AND date window ≤ 60d
 *   - low: skip (returns null)
 */
export async function findHoneyBookDuplicateForWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<HoneyBookDuplicateResult> {
  // Fetch source wedding context.
  const { data: source } = await supabase
    .from('weddings')
    .select('id, venue_id, inquiry_date, wedding_date, merged_into_id')
    .eq('id', weddingId)
    .maybeSingle()

  if (!source) {
    return { duplicateWeddingId: null, confidence: null, evidence: {} }
  }

  type SourceRow = {
    id: string
    venue_id: string
    inquiry_date: string | null
    wedding_date: string | null
    merged_into_id: string | null
  }
  const src = source as SourceRow

  // Skip if the source is itself already merged.
  if (src.merged_into_id) {
    return { duplicateWeddingId: null, confidence: null, evidence: {} }
  }

  // Fetch source partners (partner1 + partner2 + bride + groom +
  // partner — covering every couple-role label used by the people
  // table over time).
  const { data: srcPeopleRaw } = await supabase
    .from('people')
    .select('first_name, last_name, role')
    .eq('wedding_id', src.id)

  type PersonRow = { first_name: string | null; last_name: string | null; role: string }
  const couplePartners = ((srcPeopleRaw ?? []) as PersonRow[]).filter((p) =>
    ['partner1', 'partner2', 'bride', 'groom', 'partner'].includes(p.role),
  )
  const sourcePartners = couplePartners
    .map((p) => ({ first: normalizeName(p.first_name), last: normalizeName(p.last_name) }))
    .filter((p) => p.first.length > 0 && p.last.length > 0)

  if (sourcePartners.length === 0) {
    return { duplicateWeddingId: null, confidence: null, evidence: {} }
  }

  // Anchor date: prefer wedding_date over inquiry_date because
  // HoneyBook records most reliably stamp wedding_date. Falls back to
  // inquiry_date when neither is set.
  const srcAnchorIso = src.wedding_date ?? src.inquiry_date ?? null
  if (!srcAnchorIso) {
    // Without a date anchor we can't enforce the proximity rule and
    // would risk false-positive merges. Better to return no_match.
    return { duplicateWeddingId: null, confidence: null, evidence: {} }
  }
  const srcAnchorMs = new Date(srcAnchorIso).getTime()

  // Pull every active HoneyBook-sourced booked / completed wedding in
  // the venue. Bound the candidate set to the wide ±60d window ahead
  // of partner-name matching, so we never round-trip every booked
  // wedding.
  const windowMs = DEDUP_MEDIUM_DATE_WINDOW_DAYS * 86_400_000
  const lowerIso = new Date(srcAnchorMs - windowMs).toISOString()
  const upperIso = new Date(srcAnchorMs + windowMs).toISOString()

  const { data: candidatesRaw } = await supabase
    .from('weddings')
    .select('id, inquiry_date, wedding_date')
    .eq('venue_id', src.venue_id)
    .eq('crm_source', 'honeybook')
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
    .neq('id', src.id)
    .or(`inquiry_date.gte.${lowerIso},wedding_date.gte.${lowerIso.slice(0, 10)}`)

  // Note on the .or filter: inquiry_date is timestamptz (full ISO),
  // wedding_date is date (YYYY-MM-DD). Using slice(0,10) keeps the
  // operator legal for the date column. We post-filter exact window
  // below so the .or doesn't accidentally return the upper-bound out.

  type CandidateRow = { id: string; inquiry_date: string | null; wedding_date: string | null }
  const candidatesAll = (candidatesRaw ?? []) as CandidateRow[]

  // Tight post-filter: anchor date must be within +/- windowMs.
  const candidates = candidatesAll.filter((c) => {
    const anchor = c.wedding_date ?? c.inquiry_date
    if (!anchor) return false
    const ms = new Date(anchor).getTime()
    if (!Number.isFinite(ms)) return false
    return Math.abs(ms - srcAnchorMs) <= windowMs
  })

  if (candidates.length === 0) {
    return { duplicateWeddingId: null, confidence: null, evidence: { source_partners: sourcePartners } }
  }

  // For each candidate, fetch its partners + score against source.
  const candidateIds = candidates.map((c) => c.id)
  const { data: candidatePeopleRaw } = await supabase
    .from('people')
    .select('wedding_id, first_name, last_name, role')
    .in('wedding_id', candidateIds)

  type CandPersonRow = { wedding_id: string; first_name: string | null; last_name: string | null; role: string }
  const peopleByWedding = new Map<string, Array<{ first: string; last: string }>>()
  for (const p of ((candidatePeopleRaw ?? []) as CandPersonRow[])) {
    if (!['partner1', 'partner2', 'bride', 'groom', 'partner'].includes(p.role)) continue
    const first = normalizeName(p.first_name)
    const last = normalizeName(p.last_name)
    if (!first || !last) continue
    const arr = peopleByWedding.get(p.wedding_id) ?? []
    arr.push({ first, last })
    peopleByWedding.set(p.wedding_id, arr)
  }

  let best: {
    candidate: CandidateRow
    matchedPartners: Array<{ first: string; last: string }>
    confidence: 'high' | 'medium'
    dateWindowDays: number
    score: number
  } | null = null

  for (const cand of candidates) {
    const candPartners = peopleByWedding.get(cand.id) ?? []
    if (candPartners.length === 0) continue

    // Count partners in source that match a partner in candidate.
    const matched: Array<{ first: string; last: string }> = []
    for (const sp of sourcePartners) {
      const hit = candPartners.find(
        (cp) => namesEquivalent(sp.first, cp.first) && namesEquivalent(sp.last, cp.last),
      )
      if (hit) matched.push({ first: sp.first, last: sp.last })
    }

    if (matched.length === 0) continue

    const candAnchorIso = cand.wedding_date ?? cand.inquiry_date
    if (!candAnchorIso) continue
    const dateDiffDays = Math.abs(new Date(candAnchorIso).getTime() - srcAnchorMs) / 86_400_000

    let confidence: 'high' | 'medium' | null = null
    if (matched.length >= 2 && matched.length === sourcePartners.length && dateDiffDays <= DEDUP_HIGH_DATE_WINDOW_DAYS) {
      confidence = 'high'
    } else if (matched.length >= 1 && dateDiffDays <= DEDUP_MEDIUM_DATE_WINDOW_DAYS) {
      confidence = 'medium'
    }
    if (!confidence) continue

    // Score = matched partner count + (1 - date_distance_norm). Higher
    // is better. Tie-break by closer date.
    const score = matched.length + (1 - dateDiffDays / DEDUP_MEDIUM_DATE_WINDOW_DAYS)

    if (
      !best ||
      score > best.score ||
      (score === best.score && dateDiffDays < best.dateWindowDays)
    ) {
      best = {
        candidate: cand,
        matchedPartners: matched,
        confidence,
        dateWindowDays: dateDiffDays,
        score,
      }
    }
  }

  if (!best) {
    return {
      duplicateWeddingId: null,
      confidence: null,
      evidence: { source_partners: sourcePartners, source_inquiry_date: src.inquiry_date },
    }
  }

  return {
    duplicateWeddingId: best.candidate.id,
    confidence: best.confidence,
    evidence: {
      matched_partners: best.matchedPartners,
      date_window_days: Math.round(best.dateWindowDays),
      source_score: Number(best.score.toFixed(2)),
      source_partners: sourcePartners,
      source_inquiry_date: src.inquiry_date,
      target_inquiry_date: best.candidate.inquiry_date ?? best.candidate.wedding_date,
    },
  }
}

// ---------------------------------------------------------------------------
// Capability 3: HoneyBook export-payload value recovery
// ---------------------------------------------------------------------------

/**
 * Walk this wedding's "Imported from HoneyBook" interaction(s) and
 * look at the extracted_identity blob for a `total` / `amount` /
 * `value` field. Used for the gap class where the May 2024 HoneyBook
 * export landed but didn't carry booking_value in the row that became
 * this wedding.
 *
 * Out of scope: re-hitting the HoneyBook API. HoneyBook's API rate
 * limits are tight and a re-pull of every venue's history is a
 * separate project.
 */
export async function recoverHoneyBookValueFromExportPayload(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<HoneyBookExportRecoverResult> {
  const { data: interactions } = await supabase
    .from('interactions')
    .select('id, subject, extracted_identity, full_body, body_preview, timestamp')
    .eq('wedding_id', weddingId)
    .eq('type', 'email')
    .order('timestamp', { ascending: false })
    .limit(50)

  if (!interactions || interactions.length === 0) {
    return { valueCents: null, source: null, evidence: {} }
  }

  type InteractionRow = {
    id: string
    subject: string | null
    extracted_identity: Record<string, unknown> | null
    full_body: string | null
    body_preview: string | null
    timestamp: string | null
  }

  for (const raw of interactions as InteractionRow[]) {
    const subject = (raw.subject ?? '').toLowerCase()
    if (!/imported from honeybook/i.test(subject)) continue

    // Step 1: check the extracted_identity blob.
    const ei = raw.extracted_identity ?? {}
    for (const field of ['total', 'amount', 'value', 'booking_value', 'contract_total']) {
      const val = (ei as Record<string, unknown>)[field]
      if (val == null) continue
      const dollars = typeof val === 'number' ? val : Number(String(val).replace(/[^0-9.]/g, ''))
      if (!Number.isFinite(dollars) || dollars <= 0) continue
      // The HoneyBook export field is dollars; normalise to cents.
      const cents = Math.round(dollars * 100)
      if (cents < MIN_PLAUSIBLE_BOOKING_VALUE_CENTS || cents > MAX_PLAUSIBLE_BOOKING_VALUE_CENTS) continue
      return {
        valueCents: cents,
        source: 'export_payload',
        evidence: { extracted_field: field, raw_value: val },
      }
    }

    // Step 2: fall back to scanning the body for a dollar pattern.
    // The May 2024 export style was free-text — so a regex over the
    // body picks up "Total: $X,XXX" lines.
    const body = raw.full_body ?? raw.body_preview ?? ''
    const amounts = extractDollarAmountsAsCents(body)
    const picked = pickBookingValue(amounts)
    if (picked != null) {
      return {
        valueCents: picked,
        source: 'interaction_blob',
        evidence: { extracted_field: 'body_dollar_scan', raw_value: picked / 100 },
      }
    }
  }

  return { valueCents: null, source: null, evidence: {} }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all three capabilities against every missing-bv wedding for a
 * venue. Returns a per-venue report. Logs every attempt to
 * booked_data_recovery_log for audit.
 *
 * Capability order per wedding:
 *   1. honeybook_dedup_merge — if HIGH match found, MERGE + skip the
 *      rest (the duplicate already has the contract data; capability
 *      2/3 would write a redundant value into a row that's about to
 *      be tomb-stoned via merged_into_id).
 *   2. calculator_extract — universal first-party extraction.
 *   3. honeybook_export_recover — only fires when the wedding came
 *      from a HoneyBook export and capability 2 didn't find a value.
 */
export async function recoverBookedDataForVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<RecoveryReport> {
  // Pull all booked / completed weddings with missing booking_value.
  // The filter mirrors the audit: status booked/completed,
  // merged_into_id IS NULL, booking_value IS NULL OR booking_value = 0.
  const { data: rows, error } = await supabase
    .from('weddings')
    .select('id, crm_source, booking_value')
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
    .or('booking_value.is.null,booking_value.eq.0')

  if (error) {
    console.error(`[booked-data-recovery] candidate fetch failed for venue ${venueId}:`, error.message)
    return {
      venueId,
      totalCandidates: 0,
      recovered: [],
      merged: [],
      noMatch: [],
      errors: [],
    }
  }

  const candidates = (rows ?? []) as Array<{ id: string; crm_source: string | null; booking_value: number | null }>
  const report: RecoveryReport = {
    venueId,
    totalCandidates: candidates.length,
    recovered: [],
    merged: [],
    noMatch: [],
    errors: [],
  }

  for (const w of candidates) {
    const result = await recoverOneWedding(supabase, venueId, w.id, w.crm_source)
    if (result.outcome === 'recovered') report.recovered.push(result)
    else if (result.outcome === 'merged') report.merged.push(result)
    else if (result.outcome === 'no_match') report.noMatch.push(result)
    else report.errors.push(result)
  }

  return report
}

/**
 * Single-wedding orchestration. Runs capabilities in priority order
 * and stops at the first success. Always writes one log row per
 * outcome — recovered / merged / no_match / error.
 */
async function recoverOneWedding(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  crmSource: string | null,
): Promise<RecoveryReportItem> {
  // Capability 1: HoneyBook duplicate.
  try {
    const dedup = await findHoneyBookDuplicateForWedding(supabase, weddingId)
    if (dedup.duplicateWeddingId && dedup.confidence === 'high') {
      // Stamp merged_into_id on the SOURCE wedding pointing at the
      // surviving HoneyBook record. Source is tomb-stoned; HoneyBook
      // record carries on.
      const { error: mergeErr } = await supabase
        .from('weddings')
        .update({ merged_into_id: dedup.duplicateWeddingId })
        .eq('id', weddingId)

      if (mergeErr) {
        await logAttempt(supabase, {
          venueId,
          weddingId,
          capability: 'honeybook_dedup_merge',
          outcome: 'error',
          duplicateWeddingId: dedup.duplicateWeddingId,
          confidence: dedup.confidence,
          evidence: dedup.evidence,
          errorMessage: mergeErr.message,
        })
        return {
          weddingId,
          capability: 'honeybook_dedup_merge',
          outcome: 'error',
          recoveredValueCents: null,
          duplicateWeddingId: dedup.duplicateWeddingId,
          confidence: dedup.confidence,
          errorMessage: mergeErr.message,
        }
      }

      await logAttempt(supabase, {
        venueId,
        weddingId,
        capability: 'honeybook_dedup_merge',
        outcome: 'merged',
        duplicateWeddingId: dedup.duplicateWeddingId,
        confidence: dedup.confidence,
        evidence: dedup.evidence,
      })
      return {
        weddingId,
        capability: 'honeybook_dedup_merge',
        outcome: 'merged',
        recoveredValueCents: null,
        duplicateWeddingId: dedup.duplicateWeddingId,
        confidence: dedup.confidence,
        errorMessage: null,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[booked-data-recovery] dedup error wedding=${weddingId}:`, msg)
    await logAttempt(supabase, {
      venueId,
      weddingId,
      capability: 'honeybook_dedup_merge',
      outcome: 'error',
      errorMessage: msg,
    })
    // Continue to capability 2 — error in capability 1 should NOT
    // block the calculator extractor.
  }

  // Capability 2: calculator extract.
  try {
    const calc = await extractBookingValueFromCalculatorEmails(supabase, weddingId)
    if (calc.valueCents != null) {
      const { error: writeErr } = await supabase
        .from('weddings')
        .update({ booking_value: calc.valueCents })
        .eq('id', weddingId)

      if (writeErr) {
        await logAttempt(supabase, {
          venueId,
          weddingId,
          capability: 'calculator_extract',
          outcome: 'error',
          recoveredValueCents: calc.valueCents,
          sourceInteractionId: calc.sourceInteractionId,
          confidence: calc.confidence,
          evidence: calc.evidence,
          errorMessage: writeErr.message,
        })
        return {
          weddingId,
          capability: 'calculator_extract',
          outcome: 'error',
          recoveredValueCents: calc.valueCents,
          duplicateWeddingId: null,
          confidence: calc.confidence,
          errorMessage: writeErr.message,
        }
      }

      await logAttempt(supabase, {
        venueId,
        weddingId,
        capability: 'calculator_extract',
        outcome: 'recovered',
        recoveredValueCents: calc.valueCents,
        sourceInteractionId: calc.sourceInteractionId,
        confidence: calc.confidence,
        evidence: calc.evidence,
      })
      return {
        weddingId,
        capability: 'calculator_extract',
        outcome: 'recovered',
        recoveredValueCents: calc.valueCents,
        duplicateWeddingId: null,
        confidence: calc.confidence,
        errorMessage: null,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.error(`[booked-data-recovery] calc error wedding=${weddingId}:`, msg)
    // Continue — capability 3 may still find something.
  }

  // Capability 3: HoneyBook export-payload recovery (only when the
  // wedding came from a HoneyBook import).
  if (crmSource === 'honeybook') {
    try {
      const recover = await recoverHoneyBookValueFromExportPayload(supabase, weddingId)
      if (recover.valueCents != null) {
        const { error: writeErr } = await supabase
          .from('weddings')
          .update({ booking_value: recover.valueCents })
          .eq('id', weddingId)

        if (writeErr) {
          await logAttempt(supabase, {
            venueId,
            weddingId,
            capability: 'honeybook_export_recover',
            outcome: 'error',
            recoveredValueCents: recover.valueCents,
            evidence: recover.evidence,
            errorMessage: writeErr.message,
          })
          return {
            weddingId,
            capability: 'honeybook_export_recover',
            outcome: 'error',
            recoveredValueCents: recover.valueCents,
            duplicateWeddingId: null,
            confidence: null,
            errorMessage: writeErr.message,
          }
        }

        await logAttempt(supabase, {
          venueId,
          weddingId,
          capability: 'honeybook_export_recover',
          outcome: 'recovered',
          recoveredValueCents: recover.valueCents,
          evidence: recover.evidence,
        })
        return {
          weddingId,
          capability: 'honeybook_export_recover',
          outcome: 'recovered',
          recoveredValueCents: recover.valueCents,
          duplicateWeddingId: null,
          confidence: null,
          errorMessage: null,
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      console.error(`[booked-data-recovery] export-recover error wedding=${weddingId}:`, msg)
    }
  }

  // Nothing matched. Log the no_op state so the audit trail shows the
  // wedding was attempted (capability='no_op' so audit can see we
  // tried all three but none stuck).
  await logAttempt(supabase, {
    venueId,
    weddingId,
    capability: 'no_op',
    outcome: 'no_match',
  })
  return {
    weddingId,
    capability: 'no_op',
    outcome: 'no_match',
    recoveredValueCents: null,
    duplicateWeddingId: null,
    confidence: null,
    errorMessage: null,
  }
}

// ---------------------------------------------------------------------------
// Audit log writer
// ---------------------------------------------------------------------------

interface LogAttemptArgs {
  venueId: string
  weddingId: string
  capability: RecoveryCapability
  outcome: RecoveryOutcome
  recoveredValueCents?: number | null
  sourceInteractionId?: string | null
  duplicateWeddingId?: string | null
  confidence?: RecoveryConfidence
  evidence?: Record<string, unknown>
  errorMessage?: string | null
}

async function logAttempt(supabase: SupabaseClient, args: LogAttemptArgs): Promise<void> {
  const { error } = await supabase.from('booked_data_recovery_log').insert({
    venue_id: args.venueId,
    wedding_id: args.weddingId,
    capability: args.capability,
    outcome: args.outcome,
    recovered_value_cents: args.recoveredValueCents ?? null,
    source_interaction_id: args.sourceInteractionId ?? null,
    duplicate_wedding_id: args.duplicateWeddingId ?? null,
    confidence: args.confidence ?? null,
    evidence: args.evidence ?? null,
    error_message: args.errorMessage ?? null,
  })
  if (error) {
    // Don't block recovery on a log failure — just warn loudly.
    console.error(`[booked-data-recovery] log insert failed:`, error.message)
  }
}

// ---------------------------------------------------------------------------
// All-venues entry (cron)
// ---------------------------------------------------------------------------

/**
 * Cron entry. Iterates every venue with at least one booked /
 * completed wedding and runs recoverBookedDataForVenue. Returns a
 * per-venue rolled-up summary so the cron telemetry surfaces what
 * was recovered.
 *
 * Per-venue failures are caught + logged so one bad venue can't take
 * down the whole sweep.
 */
export async function recoverBookedDataAllVenues(): Promise<
  Record<
    string,
    {
      total_candidates: number
      recovered: number
      merged: number
      no_match: number
      errors: number
    }
  >
> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .neq('status', 'churned')

  const out: Record<
    string,
    {
      total_candidates: number
      recovered: number
      merged: number
      no_match: number
      errors: number
    }
  > = {}

  for (const v of (venues ?? []) as Array<{ id: string }>) {
    try {
      const report = await recoverBookedDataForVenue(supabase, v.id)
      out[v.id] = {
        total_candidates: report.totalCandidates,
        recovered: report.recovered.length,
        merged: report.merged.length,
        no_match: report.noMatch.length,
        errors: report.errors.length,
      }
    } catch (err) {
      console.error(
        `[booked-data-recovery] venue ${v.id} swept fatally:`,
        err instanceof Error ? err.message : 'unknown',
      )
      out[v.id] = {
        total_candidates: 0,
        recovered: 0,
        merged: 0,
        no_match: 0,
        errors: 1,
      }
    }
  }

  return out
}
