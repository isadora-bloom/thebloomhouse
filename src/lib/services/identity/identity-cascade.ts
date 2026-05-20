/**
 * Identity cascade — deterministic-first match order (Tier 8 / §C.5).
 *
 * Doctrine reset 2026-05-20. The pre-cascade matcher mixed deterministic
 * identifiers and fuzzy name signals in one weighted score, which let
 * a 5-char first-name typo (Kayla vs Makayla, distance 2) outrank a
 * missing email match. The cascade fixes that by running every
 * deterministic rule first, exiting on the first hit, and only falling
 * through to the fuzzy scorer when nothing deterministic matched.
 *
 * The 8 stages, in order:
 *
 *   1. Exact primary email match
 *   2. Exact full first + last name match (case-insensitive)
 *   3. Nickname (per nicknames.ts) + exact last name match
 *   4. Exact phone match (E.164 normalised)
 *   5. Email-localpart logical-name match (timmy.blogs ↔ timothyblogs)
 *   6. Body / CC cross-reference of a known identifier on the inbound
 *      message — Susan sends an email referencing Tim's email or phone
 *      anywhere in the body / CC list, and Tim's identifier is on file
 *      for some couple → that couple's match. Susan's message attaches
 *      as an interaction; she is NOT promoted to a people row.
 *   7. Paired-name mention ("susan and timothy") IN COMBINATION WITH a
 *      corroborating deterministic signal in the same message (matching
 *      wedding date OR a known identifier of either partner). Paired
 *      names alone are too weak — many couples can share first names;
 *      the corroborator is what makes it deterministic.
 *   8. Family-name + matching wedding date ("the Bloggs wedding on
 *      March 15") + a couple with last_name=Bloggs and wedding_date
 *      within ±7d.
 *
 *   — fallback — matcher.ts scoreCandidate runs only when the cascade
 *      returned `matched: false`.
 *
 * Multi-venue safe. No Rixey-specific clauses.
 */

import { canonicaliseEmail, normalizePhone } from './resolver'
import { nicknameEquivalent } from './nicknames'
import { logicalLocalpartMatch, localpartOf } from './email-localpart'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The inbound signal seeking a match — an email arriving, a Calendly
 * booking, a brain-dump CSV row. The cascade reads only what is set;
 * unknown fields are simply skipped.
 */
export interface CascadeSignal {
  /** Sender's primary email, when available. */
  primaryEmail?: string | null
  /** Sender's phone in any format (will be normalised). */
  primaryPhone?: string | null
  /** Sender's first name as it appeared on the signal. */
  firstName?: string | null
  /** Sender's last name as it appeared on the signal. */
  lastName?: string | null
  /** Full body text (subject + body + CC field joined when applicable).
   *  Used by stages 6/7/8 for cross-reference and paired-name scans. */
  bodyText?: string | null
  /** Wedding date claimed in the signal (ISO yyyy-mm-dd), when present.
   *  Used by stage 8 corroboration. */
  weddingDate?: string | null
  /** Additional emails / phones found in the message body / CC list.
   *  The pipeline's body-extractor already pulls these out; the cascade
   *  reads them verbatim. */
  bodyEmails?: string[]
  bodyPhones?: string[]
}

/**
 * The candidate couples to match against. The cascade compares the
 * signal against every candidate in order and returns the first match.
 *
 * Each candidate carries its people rows (so the cascade can compare
 * against partner names + alternate identifiers) and its wedding_date.
 */
export interface CascadeCandidate {
  coupleId: string
  weddingDate: string | null
  people: Array<{
    firstName: string | null
    lastName: string | null
    email: string | null
    phone: string | null
  }>
}

export type CascadeStageId =
  | 'exact_email'
  | 'exact_full_name'
  | 'nickname_plus_last_name'
  | 'exact_phone'
  | 'email_localpart_logical_name'
  | 'body_cross_reference'
  | 'paired_name_with_corroborator'
  | 'family_name_plus_date'

export interface CascadeMatch {
  matched: true
  coupleId: string
  stage: CascadeStageId
  evidence: string
}

export interface CascadeMiss {
  matched: false
}

export type CascadeResult = CascadeMatch | CascadeMiss

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lowerTrim(s: string | null | undefined): string | null {
  if (!s) return null
  const t = s.trim().toLowerCase()
  return t.length === 0 ? null : t
}

function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity
  return Math.abs(ta - tb) / 86_400_000
}

/** Find every email-like substring in arbitrary text. Used by stage 6
 *  body cross-reference when the caller did not pre-extract bodyEmails. */
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g

function extractEmails(text: string): string[] {
  return Array.from(text.matchAll(EMAIL_RE)).map((m) => m[0])
}

function extractPhones(text: string): string[] {
  return Array.from(text.matchAll(PHONE_RE)).map((m) => m[0])
}

// ---------------------------------------------------------------------------
// Stage implementations — each returns a CascadeMatch when it fires, null
// otherwise.
// ---------------------------------------------------------------------------

function stage1ExactEmail(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeMatch | null {
  const sigEmail = canonicaliseEmail(signal.primaryEmail ?? '')
  if (!sigEmail) return null
  for (const c of candidates) {
    for (const p of c.people) {
      if (!p.email) continue
      if (canonicaliseEmail(p.email) === sigEmail) {
        return {
          matched: true,
          coupleId: c.coupleId,
          stage: 'exact_email',
          evidence: `email_exact:${sigEmail}`,
        }
      }
    }
  }
  return null
}

function stage2ExactFullName(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeMatch | null {
  const sf = lowerTrim(signal.firstName)
  const sl = lowerTrim(signal.lastName)
  if (!sf || !sl) return null
  for (const c of candidates) {
    for (const p of c.people) {
      const pf = lowerTrim(p.firstName)
      const pl = lowerTrim(p.lastName)
      if (!pf || !pl) continue
      if (pf === sf && pl === sl) {
        return {
          matched: true,
          coupleId: c.coupleId,
          stage: 'exact_full_name',
          evidence: `full_name_exact:${sf} ${sl}`,
        }
      }
    }
  }
  return null
}

function stage3NicknamePlusLastName(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeMatch | null {
  const sf = lowerTrim(signal.firstName)
  const sl = lowerTrim(signal.lastName)
  if (!sf || !sl) return null
  for (const c of candidates) {
    for (const p of c.people) {
      const pf = lowerTrim(p.firstName)
      const pl = lowerTrim(p.lastName)
      if (!pf || !pl) continue
      // Last name must match exactly.
      if (pl !== sl) continue
      // First names equivalent under the nickname dictionary (this
      // returns true when they are literally equal as well; stage 2
      // would have caught that, so this only fires when they differ
      // case-insensitively but are dictionary-aliased).
      if (nicknameEquivalent(sf, pf)) {
        return {
          matched: true,
          coupleId: c.coupleId,
          stage: 'nickname_plus_last_name',
          evidence: `nickname:${sf}~${pf} + last:${sl}`,
        }
      }
    }
  }
  return null
}

function stage4ExactPhone(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeMatch | null {
  const sigPhone = normalizePhone(signal.primaryPhone ?? '')
  if (!sigPhone) return null
  for (const c of candidates) {
    for (const p of c.people) {
      if (!p.phone) continue
      if (normalizePhone(p.phone) === sigPhone) {
        return {
          matched: true,
          coupleId: c.coupleId,
          stage: 'exact_phone',
          evidence: `phone_exact:${sigPhone}`,
        }
      }
    }
  }
  return null
}

function stage5EmailLocalpartLogicalName(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeMatch | null {
  const sigLp = localpartOf(signal.primaryEmail ?? null)
  if (!sigLp) return null
  for (const c of candidates) {
    for (const p of c.people) {
      const candLp = localpartOf(p.email)
      if (!candLp) continue
      if (sigLp === candLp) continue // stage 1 would have caught it
      if (logicalLocalpartMatch(sigLp, candLp)) {
        return {
          matched: true,
          coupleId: c.coupleId,
          stage: 'email_localpart_logical_name',
          evidence: `localpart:${sigLp}~${candLp}`,
        }
      }
    }
  }
  return null
}

function stage6BodyCrossReference(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeMatch | null {
  const body = signal.bodyText ?? ''
  if (!body) return null

  // Gather every identifier mentioned in the body. Prefer caller-
  // supplied bodyEmails / bodyPhones (already extracted), fall back to
  // a regex scan of bodyText.
  const bodyEmailsRaw = signal.bodyEmails && signal.bodyEmails.length > 0
    ? signal.bodyEmails
    : extractEmails(body)
  const bodyPhonesRaw = signal.bodyPhones && signal.bodyPhones.length > 0
    ? signal.bodyPhones
    : extractPhones(body)
  const bodyEmails = new Set(
    bodyEmailsRaw
      .map((e) => canonicaliseEmail(e))
      .filter((e): e is string => Boolean(e)),
  )
  const bodyPhones = new Set(
    bodyPhonesRaw
      .map((p) => normalizePhone(p))
      .filter((p): p is string => Boolean(p)),
  )

  // Exclude the sender's own identifiers — finding YOUR OWN email in
  // your own message body is not a cross-reference signal.
  const senderEmail = canonicaliseEmail(signal.primaryEmail ?? '')
  if (senderEmail) bodyEmails.delete(senderEmail)
  const senderPhone = normalizePhone(signal.primaryPhone ?? '')
  if (senderPhone) bodyPhones.delete(senderPhone)

  if (bodyEmails.size === 0 && bodyPhones.size === 0) return null

  for (const c of candidates) {
    for (const p of c.people) {
      const pe = p.email ? canonicaliseEmail(p.email) : null
      if (pe && bodyEmails.has(pe)) {
        return {
          matched: true,
          coupleId: c.coupleId,
          stage: 'body_cross_reference',
          evidence: `body_email:${pe}`,
        }
      }
      const pp = p.phone ? normalizePhone(p.phone) : null
      if (pp && bodyPhones.has(pp)) {
        return {
          matched: true,
          coupleId: c.coupleId,
          stage: 'body_cross_reference',
          evidence: `body_phone:${pp}`,
        }
      }
    }
  }
  return null
}

/**
 * Detect a paired-name mention in the body — "susan and timothy",
 * "sue & tim", "sue and tim's wedding", "timmy and sue". Returns the
 * pair of lowercased first-name tokens found, or null.
 *
 * The detector is conservative: it requires the literal pattern
 * `<name1> (and|&) <name2>` with optional possessive. It does not try
 * to interpret a paragraph of mixed names.
 */
function detectPairedNames(body: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  const re = /\b([A-Za-z]{2,20})\s+(?:and|&)\s+([A-Za-z]{2,20})(?:'s)?\b/gi
  for (const m of body.matchAll(re)) {
    const a = m[1].toLowerCase()
    const b = m[2].toLowerCase()
    if (a !== b) pairs.push([a, b])
  }
  return pairs
}

function stage7PairedNameWithCorroborator(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeMatch | null {
  const body = signal.bodyText ?? ''
  if (!body) return null
  const pairs = detectPairedNames(body)
  if (pairs.length === 0) return null

  // Stage 7 fires only when the paired-name match is corroborated by a
  // matching wedding date OR a deterministic identifier of either
  // partner appears in the message.
  const sigDate = signal.weddingDate ?? null
  const senderEmail = canonicaliseEmail(signal.primaryEmail ?? '')
  const senderPhone = normalizePhone(signal.primaryPhone ?? '')
  const bodyEmailsRaw = signal.bodyEmails && signal.bodyEmails.length > 0
    ? signal.bodyEmails
    : extractEmails(body)
  const bodyPhonesRaw = signal.bodyPhones && signal.bodyPhones.length > 0
    ? signal.bodyPhones
    : extractPhones(body)
  const allEmails = new Set([senderEmail, ...bodyEmailsRaw.map(canonicaliseEmail)].filter((v): v is string => Boolean(v)))
  const allPhones = new Set([senderPhone, ...bodyPhonesRaw.map(normalizePhone)].filter((v): v is string => Boolean(v)))

  for (const c of candidates) {
    if (c.people.length < 2) continue // need at least two partners to "pair-match"
    const peopleFirsts = c.people
      .map((p) => lowerTrim(p.firstName))
      .filter((v): v is string => Boolean(v))
    if (peopleFirsts.length < 2) continue

    for (const [a, b] of pairs) {
      // Each side of the pair must equivalence-match one DISTINCT
      // person on this couple.
      let matchedA: number | null = null
      let matchedB: number | null = null
      for (let i = 0; i < peopleFirsts.length; i++) {
        if (matchedA === null && nicknameEquivalent(a, peopleFirsts[i])) matchedA = i
        else if (matchedB === null && i !== matchedA && nicknameEquivalent(b, peopleFirsts[i])) matchedB = i
      }
      if (matchedA === null || matchedB === null) continue

      // Corroborate.
      let corroborator: string | null = null
      if (sigDate && c.weddingDate && sigDate === c.weddingDate) {
        corroborator = `date:${sigDate}`
      } else {
        for (const p of c.people) {
          const pe = p.email ? canonicaliseEmail(p.email) : null
          if (pe && allEmails.has(pe)) {
            corroborator = `email:${pe}`
            break
          }
          const pp = p.phone ? normalizePhone(p.phone) : null
          if (pp && allPhones.has(pp)) {
            corroborator = `phone:${pp}`
            break
          }
        }
      }
      if (!corroborator) continue

      return {
        matched: true,
        coupleId: c.coupleId,
        stage: 'paired_name_with_corroborator',
        evidence: `pair:${a}&${b} + ${corroborator}`,
      }
    }
  }
  return null
}

function stage8FamilyNamePlusDate(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeMatch | null {
  const body = signal.bodyText ?? ''
  if (!body) return null
  const sigDate = signal.weddingDate ?? null
  if (!sigDate) return null

  // Look for "the <lastname> wedding" or "<lastname>'s wedding" or
  // "<lastname>-<lastname> wedding" — the family-name surface form. The
  // matched lastname is whatever capitalised token sits in that slot.
  const bodyLower = body.toLowerCase()
  for (const c of candidates) {
    if (!c.weddingDate) continue
    if (daysBetween(sigDate, c.weddingDate) > 7) continue
    for (const p of c.people) {
      const last = lowerTrim(p.lastName)
      if (!last || last.length < 3) continue
      const patterns = [
        `the ${last} wedding`,
        `${last}'s wedding`,
        `${last} wedding`,
      ]
      for (const pat of patterns) {
        if (bodyLower.includes(pat)) {
          return {
            matched: true,
            coupleId: c.coupleId,
            stage: 'family_name_plus_date',
            evidence: `family:${last} + date:${sigDate}~${c.weddingDate}`,
          }
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const STAGES: Array<(s: CascadeSignal, c: CascadeCandidate[]) => CascadeMatch | null> = [
  stage1ExactEmail,
  stage2ExactFullName,
  stage3NicknamePlusLastName,
  stage4ExactPhone,
  stage5EmailLocalpartLogicalName,
  stage6BodyCrossReference,
  stage7PairedNameWithCorroborator,
  stage8FamilyNamePlusDate,
]

/**
 * Run the cascade against a list of candidate couples. Returns the first
 * deterministic match, or `{ matched: false }` when every stage missed.
 *
 * Caller convention: when this returns `matched: false`, fall through
 * to the existing matcher.ts scoreCandidate scoring path. The cascade
 * never asserts "no match" globally — it asserts "no deterministic
 * match here; let the typo-tolerant scorer decide".
 */
export function cascadeMatch(
  signal: CascadeSignal,
  candidates: CascadeCandidate[],
): CascadeResult {
  if (candidates.length === 0) return { matched: false }
  for (const stage of STAGES) {
    const hit = stage(signal, candidates)
    if (hit) return hit
  }
  return { matched: false }
}

/**
 * Convenience: short label for the operator audit log. Stage 6 / 7 / 8
 * matches deserve more prose than a stage id so the operator can read
 * the cascade audit without referring back to the docs.
 */
export function describeMatch(m: CascadeMatch): string {
  switch (m.stage) {
    case 'exact_email':
      return `exact email match (${m.evidence})`
    case 'exact_full_name':
      return `exact full-name match (${m.evidence})`
    case 'nickname_plus_last_name':
      return `nickname match with exact last name (${m.evidence})`
    case 'exact_phone':
      return `exact phone match (${m.evidence})`
    case 'email_localpart_logical_name':
      return `email-localpart logical-name match (${m.evidence})`
    case 'body_cross_reference':
      return `body cross-referenced a known identifier (${m.evidence})`
    case 'paired_name_with_corroborator':
      return `paired-name mention corroborated by a deterministic signal (${m.evidence})`
    case 'family_name_plus_date':
      return `family-name mention with matching wedding date (${m.evidence})`
  }
}
