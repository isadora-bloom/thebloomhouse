/**
 * Phase B matcher — structured-signal scoring + tier assignment.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §2 (Promotion Rules) + §4 + §5.
 *
 * Doctrine §2 specifies a hybrid: integer-weighted structured signals
 * for the easy cases, Sonnet judge for the ambiguous middle. This file
 * is the structured half. The judge half lives in `llm-judge.ts` and
 * is invoked by the tracer when scoreCandidate returns
 * `needs_judge: true`.
 *
 * Why integer weights, not 0-1 floats
 * -----------------------------------
 * Floats invite fake precision and silent drift. The doctrine
 * explicitly bans them ("§5 Don't skip #1"). The 100/95/60/etc weights
 * are the published contract: tweaking one is a doctrine event, not a
 * casual code edit.
 *
 * The legacy `backtrack.ts` scoreCandidate uses 0-1 floats and only
 * handles the partial-identity case (Knot/Instagram → wedding). It
 * stays in place untouched as part of the Wave 4-8 legacy stack. Phase
 * B reads the new `couples` table and writes the new `candidate_matches`
 * table, so the two matchers run in parallel without overlap.
 *
 * Tier mapping
 * ------------
 *   score >= 100   → 'high'             (auto-promote / auto-attach)
 *   60-99          → 'medium'           (queue candidate for operator)
 *   30-59          → 'low'              (queue candidate, surface only on request)
 *   <30            → 'below_threshold'  (store as related-but-unlinked)
 *
 * needs_judge = true when score is 40-90 (the ambiguous middle).
 * Tracer / Linker should call the LLM judge for those before final
 * tier assignment. Judge can downgrade `medium` to `low/reject` or
 * upgrade `low` to `medium`.
 */

import {
  normalizeEmail,
  canonicaliseEmail,
  normalizePhone,
} from './resolver'
import {
  cascadeMatch,
  describeMatch,
  type CascadeSignal,
  type CascadeCandidate,
} from './identity-cascade'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MatchTier = 'high' | 'medium' | 'low' | 'below_threshold'

/**
 * The slim shape the matcher reads. Both legacy weddings and new
 * couples rows can be reshaped into this form by callers; the matcher
 * itself never queries the DB.
 */
export interface MatchableRecord {
  /** Stable id (couples.id or fragments.id or weddings.id, caller's choice). */
  id: string
  primary_email?: string | null
  primary_phone?: string | null
  partner_email?: string | null
  partner_phone?: string | null
  primary_name?: string | null
  partner_name?: string | null
  wedding_date?: string | null
  /** Approximate moment this record's identity was observed. For couples
   *  this is created_at or wedding_date; for fragments it is the
   *  fragment's occurred_at. Used by cross-channel temporal scoring. */
  observed_at?: string | null
  /** Optional session signals. */
  session_ip?: string | null
  session_fingerprint?: string | null
}

export interface MatcherSignal {
  name: string
  weight: number
  evidence: string
}

export interface MatcherVerdict {
  score: number
  tier: MatchTier
  signals: MatcherSignal[]
  /** True when score is in 40-90, the band where the LLM judge fires
   *  per doctrine §2. The tracer/linker reads this flag; the matcher
   *  itself never calls the judge. */
  needs_judge: boolean
  /** Short structured-reason string for persistence to
   *  `candidate_matches.matcher_reason` / `couple_merge_events.reason`. */
  reason: string
}

// ---------------------------------------------------------------------------
// Weights (doctrine §2)
// ---------------------------------------------------------------------------

const W = {
  email_exact: 100,
  phone_exact: 100,
  partner_email: 95,
  partner_phone: 95,
  full_name_exact: 60,
  first_name_plus_last_initial: 25,
  name_levenshtein_within_2: 40,
  wedding_date_within_30d: 30,
  same_ip_in_session: 20,
  same_browser_fingerprint: 25,
  cross_channel_temporal_lt_6h: 35,
  cross_channel_temporal_lt_48h: 20,
  cross_channel_temporal_lt_2w: 10,
} as const

// ---------------------------------------------------------------------------
// Tier band thresholds
// ---------------------------------------------------------------------------

const TIER_HIGH = 100
const TIER_MEDIUM = 60
const TIER_LOW = 30
const JUDGE_BAND_LOW = 40
const JUDGE_BAND_HIGH = 90

function bandFor(score: number): MatchTier {
  if (score >= TIER_HIGH) return 'high'
  if (score >= TIER_MEDIUM) return 'medium'
  if (score >= TIER_LOW) return 'low'
  return 'below_threshold'
}

// ---------------------------------------------------------------------------
// String helpers (private — name normalisation specific to matcher)
// ---------------------------------------------------------------------------

function lowerTrim(s: string | null | undefined): string | null {
  if (!s) return null
  const t = s.trim().toLowerCase()
  return t.length === 0 ? null : t
}

function firstName(full: string | null | undefined): string | null {
  const t = lowerTrim(full)
  if (!t) return null
  return t.split(/\s+/)[0] ?? null
}

function lastInitial(full: string | null | undefined): string | null {
  const t = lowerTrim(full)
  if (!t) return null
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
  const last = parts[parts.length - 1]
  return last ? last[0] ?? null : null
}

/** Damerau-Levenshtein distance, capped at `cap`. Returns cap+1 if the
 *  true distance exceeds the cap. Cap exists so we never burn 100ms on
 *  pathological cases at Tracer scale (millions of pair comparisons). */
function levenshteinCapped(a: string, b: string, cap: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const m = a.length
  const n = b.length
  if (m === 0) return n > cap ? cap + 1 : n
  if (n === 0) return m > cap ? cap + 1 : m
  let prev = new Array<number>(n + 1)
  let cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    let rowMin = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(
        cur[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      )
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > cap) return cap + 1
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]!
}

function fullNameMatches(a: string | null, b: string | null): boolean {
  const na = lowerTrim(a)
  const nb = lowerTrim(b)
  if (!na || !nb) return false
  // A "full name" needs at least two tokens. 'emma' === 'emma' isn't a
  // full-name match — it's a first-name match (which doesn't fire on
  // its own without a corroborating last initial).
  if (na.split(/\s+/).length < 2 || nb.split(/\s+/).length < 2) return false
  return na === nb
}

function firstPlusInitialMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const af = firstName(a)
  const bf = firstName(b)
  if (!af || !bf || af !== bf) return false
  const ai = lastInitial(a)
  const bi = lastInitial(b)
  // Both must have a last initial — otherwise we'd promote on first-only.
  if (!ai || !bi) return false
  return ai === bi
}

/**
 * Name-typo equivalence under bounded edit distance.
 *
 * Two doctrine guards against the Tier-8 §C.5 failure mode the audit
 * 2026-05-20 caught (Rixey couple Makayla Keeley merged with a Kayla
 * Williams thread on a single name-substring distance-2 match):
 *
 *  1. STRICT-SUBSTRING GUARD. If either lowercased name strictly contains
 *     the other as a contiguous substring (case-insensitive), refuse the
 *     match. This is almost always a name-truncation false-positive
 *     ("Kayla" ⊂ "Makayla", "Anna" ⊂ "Hannah", "Joel" ⊂ "Joelle") rather
 *     than a typo. Real typos like "Sarah" → "Saraha" or "Jon" → "John"
 *     do not share a contiguous-substring relationship.
 *
 *  2. LENGTH-AWARE DISTANCE. For short names (< 6 chars), require
 *     distance ≤ 1, not ≤ 2. Edit-distance 2 on a 5-character name is a
 *     40% edit ratio — too permissive to be a typo signal. Real typos
 *     on short names are almost always single edits; pairs at distance 2
 *     on short names are usually different names ("Kayla" vs "Layla",
 *     "Hugo" vs "Hugh", "Maya" vs "Maja"). For longer names (≥ 6 chars)
 *     the original distance-2 cap stays — "Stephanie" / "Stefanie" /
 *     "Stephany" all need distance 1-2 tolerance to merge.
 *
 * The guards are defence in depth. A clean fix would also require a
 * corroborating signal (last initial, email domain, ±72h temporal) before
 * the Levenshtein weight fires alone; that is a larger redesign tracked
 * separately. These guards stop the worst-shaped false positive without
 * touching every caller.
 */
function nameWithinLevenshtein2(a: string | null, b: string | null): boolean {
  const na = lowerTrim(a)
  const nb = lowerTrim(b)
  if (!na || !nb) return false
  if (na === nb) return false // already handled by exact match

  // Strict-substring guard: refuse when either name fully contains the
  // other. Name-truncation false-positive shape (Kayla ⊂ Makayla).
  if (na.includes(nb) || nb.includes(na)) return false

  // Length-aware distance cap. Short names (< 6 chars) tolerate one
  // edit only; longer names keep the original two-edit cap.
  const shorter = Math.min(na.length, nb.length)
  const cap = shorter < 6 ? 1 : 2
  return levenshteinCapped(na, nb, cap) <= cap
}

function emailsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return canonicaliseEmail(a) === canonicaliseEmail(b)
}

function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalizePhone(a) === normalizePhone(b)
}

function daysApart(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!isFinite(ta) || !isFinite(tb)) return null
  return Math.abs(ta - tb) / 86_400_000
}

function hoursApart(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!isFinite(ta) || !isFinite(tb)) return null
  return Math.abs(ta - tb) / 3_600_000
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split a "First Last" full-name string into its parts. The matcher
 * receives full names; the cascade reads first / last separately.
 * Returns nulls when the string is empty or single-token.
 */
function splitFullName(
  full: string | null | undefined,
): { firstName: string | null; lastName: string | null } {
  if (!full) return { firstName: null, lastName: null }
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: null, lastName: null }
  if (parts.length === 1) return { firstName: parts[0], lastName: null }
  return {
    firstName: parts[0],
    lastName: parts[parts.length - 1],
  }
}

function asCascadeSignal(r: MatchableRecord): CascadeSignal {
  const split = splitFullName(r.primary_name)
  return {
    primaryEmail: r.primary_email ?? null,
    primaryPhone: r.primary_phone ?? null,
    firstName: split.firstName,
    lastName: split.lastName,
  }
}

function asCascadeCandidate(r: MatchableRecord): CascadeCandidate {
  const split = splitFullName(r.primary_name)
  const partnerSplit = splitFullName(r.partner_name)
  return {
    coupleId: r.id,
    weddingDate: r.wedding_date ?? null,
    people: [
      {
        firstName: split.firstName,
        lastName: split.lastName,
        email: r.primary_email ?? null,
        phone: r.primary_phone ?? null,
      },
      {
        firstName: partnerSplit.firstName,
        lastName: partnerSplit.lastName,
        email: r.partner_email ?? null,
        phone: r.partner_phone ?? null,
      },
    ].filter((p) => p.firstName || p.email || p.phone),
  }
}

export function scoreCandidate(
  primary: MatchableRecord,
  secondary: MatchableRecord,
): MatcherVerdict {
  if (primary.id === secondary.id) {
    return {
      score: 0,
      tier: 'below_threshold',
      signals: [],
      needs_judge: false,
      reason: 'self-match',
    }
  }

  // D6/§C.5 cascade reset (2026-05-20). Run the deterministic cascade
  // FIRST. If any stage matches, return a high-tier verdict with the
  // cascade evidence; skip the fuzzy scoring entirely. Stages 6/7/8
  // need bodyText and never fire from scoreCandidate (which operates
  // on MatchableRecord pairs, not inbound messages) — those run from
  // the live email-pipeline path. Stages 1-5 cover every deterministic
  // pair-comparison the matcher needs.
  const cascadeResult = cascadeMatch(
    asCascadeSignal(primary),
    [asCascadeCandidate(secondary)],
  )
  if (cascadeResult.matched) {
    return {
      score: TIER_HIGH,
      tier: 'high',
      signals: [
        {
          name: `cascade_${cascadeResult.stage}`,
          weight: TIER_HIGH,
          evidence: cascadeResult.evidence,
        },
      ],
      needs_judge: false,
      reason: `cascade:${describeMatch(cascadeResult)}`,
    }
  }

  const signals: MatcherSignal[] = []
  let score = 0

  // ---- Email / phone exact (the cheapest highest-signal checks) -----------
  // Primary↔primary OR secondary↔secondary OR cross. Email and phone
  // each fire once at most — the highest cross-pair wins.
  const emailHit =
    emailsMatch(primary.primary_email, secondary.primary_email) ||
    emailsMatch(primary.partner_email, secondary.partner_email)
  if (emailHit) {
    score += W.email_exact
    const e = canonicaliseEmail(primary.primary_email) ?? canonicaliseEmail(primary.partner_email)
    signals.push({ name: 'email_exact', weight: W.email_exact, evidence: e ?? '' })
  } else if (
    emailsMatch(primary.primary_email, secondary.partner_email) ||
    emailsMatch(primary.partner_email, secondary.primary_email)
  ) {
    score += W.partner_email
    signals.push({ name: 'partner_email', weight: W.partner_email, evidence: 'cross-pair' })
  }

  const phoneHit =
    phonesMatch(primary.primary_phone, secondary.primary_phone) ||
    phonesMatch(primary.partner_phone, secondary.partner_phone)
  if (phoneHit) {
    score += W.phone_exact
    const p = normalizePhone(primary.primary_phone) ?? normalizePhone(primary.partner_phone)
    signals.push({ name: 'phone_exact', weight: W.phone_exact, evidence: p ?? '' })
  } else if (
    phonesMatch(primary.primary_phone, secondary.partner_phone) ||
    phonesMatch(primary.partner_phone, secondary.primary_phone)
  ) {
    score += W.partner_phone
    signals.push({ name: 'partner_phone', weight: W.partner_phone, evidence: 'cross-pair' })
  }

  // ---- Name signals -------------------------------------------------------
  // Fires once for the best name pair across {primary↔primary,
  // partner↔partner, primary↔partner cross}.
  const namePairs: Array<[string | null | undefined, string | null | undefined]> = [
    [primary.primary_name, secondary.primary_name],
    [primary.partner_name, secondary.partner_name],
    [primary.primary_name, secondary.partner_name],
    [primary.partner_name, secondary.primary_name],
  ]

  let bestNameWeight = 0
  let bestNameEvidence = ''
  for (const [a, b] of namePairs) {
    if (!a || !b) continue
    if (fullNameMatches(a, b)) {
      if (W.full_name_exact > bestNameWeight) {
        bestNameWeight = W.full_name_exact
        bestNameEvidence = `full_name_exact:${lowerTrim(a)}`
      }
    } else if (nameWithinLevenshtein2(a, b)) {
      if (W.name_levenshtein_within_2 > bestNameWeight) {
        bestNameWeight = W.name_levenshtein_within_2
        bestNameEvidence = `levenshtein2:${lowerTrim(a)}~${lowerTrim(b)}`
      }
    } else if (firstPlusInitialMatches(a, b)) {
      if (W.first_name_plus_last_initial > bestNameWeight) {
        bestNameWeight = W.first_name_plus_last_initial
        bestNameEvidence = `first+initial:${firstName(a)} ${lastInitial(a)}.`
      }
    }
  }
  if (bestNameWeight > 0) {
    score += bestNameWeight
    signals.push({ name: 'name_match', weight: bestNameWeight, evidence: bestNameEvidence })
  }

  // ---- Wedding date proximity --------------------------------------------
  const dateGap = daysApart(primary.wedding_date, secondary.wedding_date)
  if (dateGap !== null && dateGap <= 30) {
    score += W.wedding_date_within_30d
    signals.push({
      name: 'wedding_date_within_30d',
      weight: W.wedding_date_within_30d,
      evidence: `gap=${Math.round(dateGap)}d`,
    })
  }

  // ---- Session signals ----------------------------------------------------
  if (primary.session_ip && primary.session_ip === secondary.session_ip) {
    score += W.same_ip_in_session
    signals.push({
      name: 'same_ip_in_session',
      weight: W.same_ip_in_session,
      evidence: primary.session_ip,
    })
  }
  if (
    primary.session_fingerprint &&
    primary.session_fingerprint === secondary.session_fingerprint
  ) {
    score += W.same_browser_fingerprint
    signals.push({
      name: 'same_browser_fingerprint',
      weight: W.same_browser_fingerprint,
      evidence: primary.session_fingerprint,
    })
  }

  // ---- Cross-channel temporal --------------------------------------------
  // Only one of the three bands fires (the tightest one). Requires BOTH
  // sides to have observed_at — wedding_date does NOT count because
  // two records describing the same couple share wedding_date by
  // definition, so falling back to it would fire the cross-channel
  // signal on every same-couple comparison (false positive on every
  // unrelated couple with a coincidentally shared date).
  const hourGap = hoursApart(primary.observed_at, secondary.observed_at)
  if (hourGap !== null) {
    if (hourGap < 6) {
      score += W.cross_channel_temporal_lt_6h
      signals.push({
        name: 'cross_channel_temporal_lt_6h',
        weight: W.cross_channel_temporal_lt_6h,
        evidence: `gap=${hourGap.toFixed(1)}h`,
      })
    } else if (hourGap < 48) {
      score += W.cross_channel_temporal_lt_48h
      signals.push({
        name: 'cross_channel_temporal_lt_48h',
        weight: W.cross_channel_temporal_lt_48h,
        evidence: `gap=${hourGap.toFixed(1)}h`,
      })
    } else if (hourGap < 2 * 7 * 24) {
      score += W.cross_channel_temporal_lt_2w
      signals.push({
        name: 'cross_channel_temporal_lt_2w',
        weight: W.cross_channel_temporal_lt_2w,
        evidence: `gap=${(hourGap / 24).toFixed(1)}d`,
      })
    }
  }

  const tier = bandFor(score)
  const needs_judge = score >= JUDGE_BAND_LOW && score <= JUDGE_BAND_HIGH

  const reason =
    signals.length === 0
      ? `no signals (score=${score})`
      : `score=${score} tier=${tier}` +
        (needs_judge ? ' (judge-band)' : '') +
        ' :: ' +
        signals.map((s) => `${s.name}=${s.weight}`).join('+')

  return { score, tier, signals, needs_judge, reason }
}

// ---------------------------------------------------------------------------
// Test surface (exported for the 50-pair Rixey fixture)
// ---------------------------------------------------------------------------

export const __test = {
  bandFor,
  levenshteinCapped,
  W,
  TIER_HIGH,
  TIER_MEDIUM,
  TIER_LOW,
  JUDGE_BAND_LOW,
  JUDGE_BAND_HIGH,
}
