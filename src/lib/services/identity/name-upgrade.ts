/**
 * Name-upgrade pipeline for `people` rows.
 *
 * 2026-05-09 user mandate (Isadora):
 *   "no names should be just one name if they have inquired or sent an email"
 *
 * Why this file exists
 * --------------------
 * People rows are minted at first inquiry. Many platforms hand us only a
 * partial name on the first signal:
 *   - The Knot relay From: "Jen B" → first_name='Jen', last_name='B'
 *   - WeddingWire relay: first name + last initial only
 *   - Plain inbound from a personal email: only the local-part
 *
 * Later signals carry the full name in the body or in derived structures
 * we already persist:
 *   - Calculator submission body: "Jennifer Biaksangi"
 *   - Email signature on couple replies (parsed into extracted_identity.names)
 *   - Contract signer name (extracted_text on contracts)
 *   - Vendor "your guest list" replies that quote the couple's full name
 *   - Coordinator brain-dumps that mention them by full name
 *   - sage_context_notes routed by the brain-dump parser
 *
 * The universal body-extractor (`body-extract.ts`) already populates
 * `interactions.extracted_identity` with a `names: string[]` payload on
 * every inbound email. The data is there. What's missing is a service that
 * promotes the better name back onto the people row.
 *
 * Coordination with the identity resolver
 * ---------------------------------------
 * `identity/resolver.ts` merges DIFFERENT people rows. This service ONLY
 * upgrades a SINGLE people row's first_name / last_name fields. We never
 * trigger merges, we never touch tombstoned (`merged_into_id IS NOT NULL`)
 * rows, and we strictly reject candidates that would replace a complete
 * name with a different complete name (last-name conflict guard).
 *
 * Scoring rules
 * -------------
 * Given the existing first/last on a people row and a candidate (first/last)
 * gleaned from a signal:
 *
 *   - first name "more complete" iff:
 *       existing is null OR
 *       (existing is a strict prefix of candidate AND candidate is longer)
 *     "Jen" → "Jennifer" qualifies. "Sarah" → "Sara" does NOT (no prefix).
 *
 *   - last name "more complete" iff:
 *       existing is null OR
 *       existing.length <= 2 (single-letter or two-letter initial-style) OR
 *       (existing is a strict prefix of candidate AND candidate is longer)
 *     "B" → "Biaksangi" qualifies. "Smith" → "Smyth" does NOT (no prefix).
 *
 *   - Reject any candidate that disagrees with the existing in a
 *     non-prefix way on a field the existing has filled past the
 *     "single letter" threshold. This is the human-conflict guard.
 *
 *   - Email-match boost: a candidate sourced from an interaction whose
 *     `from_email` equals the people row's email gets +20 confidence.
 *     (The same person typing their own name in their own email body is
 *     the highest-quality signal we get.)
 *
 *   - Among acceptable candidates, pick the one with the highest score
 *     where score = base_confidence + email_boost + completeness_bonus.
 *     Completeness bonus rewards candidates that improve BOTH first AND
 *     last over candidates that improve only one field.
 *
 * Hard rules
 * ----------
 *   - Never downgrade. If the existing is "Jennifer" and a candidate says
 *     "Jen", we ignore the candidate.
 *   - Never merge. This file does not call `mergePeople`, does not
 *     enqueue identity matches, does not write to `people.merged_into_id`.
 *   - Never touch tombstones. `merged_into_id IS NOT NULL` rows are
 *     skipped — the canonical row is somewhere else and the resolver
 *     handles it.
 *   - Pattern fix. No venue-specific or person-specific code paths.
 *
 * Wired at
 * --------
 *   - `src/lib/services/email/pipeline.ts` after `processIncomingEmail`
 *     resolves contact + wedding (best-effort, non-blocking).
 *   - `src/app/api/admin/identity/upgrade-names/route.ts` for one-shot
 *     backfill.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  stripHtmlForNameValue,
  isRejectedGreeting,
  containsHtmlTag,
} from './name-capture'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NameCandidate {
  first: string | null
  last: string | null
  /** Free-text source label. Examples: 'calculator',
   *  'email_extracted_identity', 'contract_signer', 'manual',
   *  'sage_context_notes', 'wedding_notes'. Not enum-constrained because
   *  callers may add new sources without a migration. */
  source: string
  /** Base confidence 0-100 before email-match boost. */
  confidence: number
  /** Email associated with the signal (for email-match boost). When the
   *  candidate's email matches the people row's email, +20 is applied. */
  emailContext?: string | null
}

export interface NameUpgrade {
  personId: string
  from: { first: string | null; last: string | null }
  to: { first: string | null; last: string | null }
  source: string
  confidence: number
}

export interface UpgradeResult {
  upgrades: NameUpgrade[]
  scanned: number
}

export interface UpgradeOptions {
  dryRun?: boolean
  supabase?: SupabaseClient
}

// ---------------------------------------------------------------------------
// Pure scoring helpers
// ---------------------------------------------------------------------------

const lower = (s: string | null | undefined): string =>
  (s ?? '').trim().toLowerCase()

/** A candidate first name is considered acceptable when it does NOT
 *  conflict with the existing. Conflict means: existing is non-trivial
 *  (length > 2) and candidate is neither a prefix of existing nor an
 *  extension of existing. We treat <= 2 chars as "trivial" (initials,
 *  single-letter stubs) and accept any extension over them.
 *
 *  Returns the policy:
 *    'upgrade'  — candidate strictly improves the existing
 *    'equal'    — same name, no change
 *    'reject'   — conflict; skip
 *    'noop'     — candidate empty
 */
function classifyFirstNameMove(
  existing: string | null,
  candidate: string | null,
): 'upgrade' | 'equal' | 'reject' | 'noop' {
  if (!candidate || !candidate.trim()) return 'noop'
  const c = lower(candidate)
  if (!existing || !existing.trim()) {
    // No existing → any candidate is an upgrade.
    return 'upgrade'
  }
  const e = lower(existing)
  if (e === c) return 'equal'
  // Trivial existing (<=2 chars including initials with a dot).
  const eAlpha = e.replace(/\W+/g, '')
  if (eAlpha.length <= 2) {
    if (c.startsWith(eAlpha)) return 'upgrade'
    return 'reject'
  }
  // Non-trivial: require strict-prefix relationship to consider an upgrade.
  if (c.startsWith(e) && c.length > e.length) return 'upgrade'
  // Anything else is a different person or a typo. Reject.
  return 'reject'
}

function classifyLastNameMove(
  existing: string | null,
  candidate: string | null,
): 'upgrade' | 'equal' | 'reject' | 'noop' {
  if (!candidate || !candidate.trim()) return 'noop'
  const c = lower(candidate)
  if (!existing || !existing.trim()) return 'upgrade'
  const e = lower(existing)
  if (e === c) return 'equal'
  const eAlpha = e.replace(/\W+/g, '')
  // Initial-style ("B", "B.", "Bi") gets upgraded by anything that starts
  // with it. Two-character existing stays in this lane: "Bi" → "Biaksangi".
  if (eAlpha.length <= 2) {
    if (c.startsWith(eAlpha)) return 'upgrade'
    return 'reject'
  }
  if (c.startsWith(e) && c.length > e.length) return 'upgrade'
  return 'reject'
}

// ---------------------------------------------------------------------------
// Candidate-extraction helpers
// ---------------------------------------------------------------------------

/** Split a free-text full name into [first, last]. Multi-word last names
 *  (van der Berg, Martin-Dye) are kept whole on the last side. Returns
 *  [null, null] for empty input. */
export function splitFullName(input: string | null | undefined): [string | null, string | null] {
  if (!input) return [null, null]
  const cleaned = input.replace(/\s+/g, ' ').trim()
  if (!cleaned) return [null, null]
  const parts = cleaned.split(' ').filter(Boolean)
  if (parts.length === 0) return [null, null]
  if (parts.length === 1) return [parts[0], null]
  const first = parts[0]
  const last = parts.slice(1).join(' ')
  return [first, last]
}

interface InteractionRow {
  id: string
  person_id: string | null
  from_email: string | null
  full_body: string | null
  subject: string | null
  extracted_identity: Record<string, unknown> | null
}

interface PeopleRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  merged_into_id: string | null
  wedding_id: string | null
  /** Sticky-state Pattern 1: when true, name-upgrade skips this row.
   *  See migration 306. */
  name_locked_by_operator: boolean | null
}

interface WeddingRow {
  id: string
  venue_id: string
  notes: string | null
  sage_context_notes: unknown
}

/** Extract every candidate name from the body of a single interaction.
 *  Looks at:
 *    - extracted_identity.names[] (already body-scanned by the universal
 *      extractor — most reliable since it dedup-filters nav chrome)
 *    - extracted_identity.first_name / last_name (form-relay parsers
 *      sometimes write these directly)
 *  Returns one NameCandidate per pair. Empty candidates filtered out. */
function candidatesFromInteraction(row: InteractionRow): NameCandidate[] {
  const out: NameCandidate[] = []
  const ei = row.extracted_identity ?? null
  if (!ei) return out
  const fromEmail = (row.from_email ?? '').trim().toLowerCase() || null

  // Direct first / last fields when the parser populated them.
  // Wave 2.5: strip HTML markup BEFORE accepting the value, and reject
  // greeting tokens so "Hi"/"Hello" never lands as a first_name.
  const rawDirectFirst = typeof ei.first_name === 'string' ? ei.first_name : null
  const rawDirectLast = typeof ei.last_name === 'string' ? ei.last_name : null
  const directFirst = stripHtmlForNameValue(rawDirectFirst)
  const directLast = stripHtmlForNameValue(rawDirectLast)
  const directRejected = isRejectedGreeting(directFirst)
  if ((directFirst || directLast) && !directRejected) {
    out.push({
      first: directFirst,
      last: directLast,
      source: 'email_extracted_identity',
      confidence: 70,
      emailContext: fromEmail,
    })
  }

  // names[] from body-extract — capitalized "First Last" pairs. Wave 2.5:
  // strip HTML and reject greetings before splitting.
  const names = Array.isArray(ei.names) ? (ei.names as unknown[]) : []
  for (const n of names) {
    if (typeof n !== 'string') continue
    if (containsHtmlTag(n)) continue
    const cleaned = stripHtmlForNameValue(n)
    if (!cleaned) continue
    const [first, last] = splitFullName(cleaned)
    if (!first && !last) continue
    if (isRejectedGreeting(first)) continue
    out.push({
      first,
      last,
      source: 'email_extracted_identity',
      // Body-extracted names are slightly less reliable than direct
      // parser fields (they can capture vendor names, signature lines,
      // etc.). Base confidence 60.
      confidence: 60,
      emailContext: fromEmail,
    })
  }

  // Calculator emails carry the full name in the body verbatim. Bump
  // confidence when the subject or body looks calculator-shaped.
  const subjectLower = (row.subject ?? '').toLowerCase()
  const bodyLower = (row.full_body ?? '').toLowerCase()
  const looksLikeCalculator =
    subjectLower.includes('estimate') ||
    bodyLower.includes('calculator') ||
    bodyLower.includes('new calculator submission')
  if (looksLikeCalculator) {
    // Promote every candidate from this row to the 'calculator' source +
    // higher confidence. We mutate the just-pushed entries (last
    // names.length + 1 entries when directFirst/directLast existed).
    const pushedCount = (directFirst || directLast ? 1 : 0) + names.filter((n) => typeof n === 'string').length
    for (let i = out.length - pushedCount; i < out.length; i++) {
      if (i < 0) continue
      out[i] = { ...out[i], source: 'calculator', confidence: Math.max(out[i].confidence, 80) }
    }
  }

  return out
}

/** Pull free-text candidate names from a wedding's notes / sage context.
 *  Coordinator brain-dumps and scheduler imports occasionally name the
 *  couple in plain English. We use a lightweight capitalized-pair scan
 *  identical in spirit to the body-extractor. */
function candidatesFromWeddingText(wedding: WeddingRow): NameCandidate[] {
  const out: NameCandidate[] = []
  const NAME_RE = /\b([A-Z][a-z'À-ſ-]{1,29})\s+([A-Z](?:[a-z'À-ſ-]{1,29}|\.))/g

  const harvestFrom = (text: string, source: string) => {
    // Wave 2.5: strip HTML from the source text BEFORE running the
    // regex. Sage-context-notes occasionally store rendered HTML.
    const cleanedText = stripHtmlForNameValue(text) ?? ''
    if (!cleanedText) return
    NAME_RE.lastIndex = 0
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = NAME_RE.exec(cleanedText)) !== null && seen.size < 8) {
      const candidate = `${m[1]} ${m[2]}`
      // Filter obvious non-names — same blacklist as body-extract.ts.
      if (/^(Reply|View|Click|Forward|Read|Send|Open|Visit|Contact|Email|Phone|Subject|Date|From|To|Re|Fwd)\s/.test(candidate)) continue
      if (/^([A-Z][a-z]+)\s\1\b/.test(candidate)) continue
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const [first, last] = splitFullName(candidate)
      if (!first) continue
      // Wave 2.5: reject greetings. The NAME_RE could land on a
      // capitalised greeting like "Hi Megan" if the harvested text
      // begins with one.
      if (isRejectedGreeting(first)) continue
      out.push({
        first,
        last,
        source,
        // Lower confidence than body-extract because brain-dump notes
        // can mention vendors, parents, planners.
        confidence: 50,
      })
    }
  }

  if (wedding.notes && wedding.notes.trim()) {
    harvestFrom(wedding.notes, 'wedding_notes')
  }

  // sage_context_notes is a jsonb array of mixed-shape entries. Extract
  // any string fields that look like prose and harvest names from them.
  const scn = wedding.sage_context_notes
  if (Array.isArray(scn)) {
    for (const entry of scn) {
      if (!entry) continue
      const blob = typeof entry === 'string' ? entry : JSON.stringify(entry)
      harvestFrom(blob, 'sage_context_notes')
    }
  }

  return out
}

/** Pull candidate signer names from contracts.extracted_text. */
function candidatesFromContractText(text: string | null): NameCandidate[] {
  if (!text || !text.trim()) return []
  const out: NameCandidate[] = []
  const NAME_RE = /\b([A-Z][a-z'À-ſ-]{1,29})\s+([A-Z](?:[a-z'À-ſ-]{1,29}|\.))/g
  NAME_RE.lastIndex = 0
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = NAME_RE.exec(text)) !== null && seen.size < 12) {
    const candidate = `${m[1]} ${m[2]}`
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const [first, last] = splitFullName(candidate)
    if (!first) continue
    out.push({
      first,
      last,
      source: 'contract_signer',
      // Contracts are signed documents — the highest-quality name source
      // we have short of ID verification.
      confidence: 90,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Scoring + selection
// ---------------------------------------------------------------------------

interface ScoredOutcome {
  candidate: NameCandidate
  resolvedFirst: string | null
  resolvedLast: string | null
  totalScore: number
}

function scoreCandidateAgainstPerson(
  person: PeopleRow,
  candidate: NameCandidate,
): ScoredOutcome | null {
  const firstMove = classifyFirstNameMove(person.first_name, candidate.first)
  const lastMove = classifyLastNameMove(person.last_name, candidate.last)

  // Any reject vetoes the entire candidate. We treat the candidate as a
  // unit because a real human's name should not contradict itself: if
  // the last name conflicts, the first name is probably about a
  // different person too.
  if (firstMove === 'reject' || lastMove === 'reject') return null

  // No movement at all — skip.
  if (firstMove !== 'upgrade' && lastMove !== 'upgrade') return null

  const resolvedFirst =
    firstMove === 'upgrade' ? candidate.first : person.first_name
  const resolvedLast =
    lastMove === 'upgrade' ? candidate.last : person.last_name

  // Score: base + email-boost + completeness bonus.
  const personEmail = (person.email ?? '').trim().toLowerCase() || null
  const emailBoost =
    personEmail &&
    candidate.emailContext &&
    candidate.emailContext === personEmail
      ? 20
      : 0
  const completenessBonus =
    firstMove === 'upgrade' && lastMove === 'upgrade' ? 15 : 0

  const totalScore = candidate.confidence + emailBoost + completenessBonus
  return { candidate, resolvedFirst, resolvedLast, totalScore }
}

function pickBestCandidate(
  person: PeopleRow,
  candidates: NameCandidate[],
): ScoredOutcome | null {
  let best: ScoredOutcome | null = null
  for (const c of candidates) {
    const scored = scoreCandidateAgainstPerson(person, c)
    if (!scored) continue
    if (!best || scored.totalScore > best.totalScore) best = scored
  }
  return best
}

// ---------------------------------------------------------------------------
// Public entry: upgradePeopleNameFromTouchpoints
// ---------------------------------------------------------------------------

/**
 * Inspect every signal attached to a wedding and upgrade the names on
 * its people rows when a more-complete name is available.
 *
 * @param weddingId The wedding to scan.
 * @param options.dryRun When true, return what would change without writing.
 *
 * @returns scanned: number of people rows examined.
 *          upgrades: per-person before/after with the source that won.
 */
export async function upgradePeopleNameFromTouchpoints(
  weddingId: string,
  options: UpgradeOptions = {},
): Promise<UpgradeResult> {
  const supabase = options.supabase ?? createServiceClient()
  const dryRun = options.dryRun === true

  // ---- Pull the wedding (for venue id + notes/sage_context_notes). -------
  const { data: weddingRow, error: weddingErr } = await supabase
    .from('weddings')
    .select('id, venue_id, notes, sage_context_notes, merged_into_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (weddingErr || !weddingRow) {
    return { upgrades: [], scanned: 0 }
  }
  // Don't operate on tombstoned weddings — the canonical row is elsewhere
  // and that's where signals will accumulate.
  if (weddingRow.merged_into_id) {
    return { upgrades: [], scanned: 0 }
  }
  const wedding = weddingRow as WeddingRow

  // ---- Pull all people on the wedding (skip tombstones). -----------------
  const { data: peopleRows } = await supabase
    .from('people')
    .select('id, first_name, last_name, email, merged_into_id, wedding_id, name_locked_by_operator')
    .eq('wedding_id', weddingId)
    .is('merged_into_id', null)
  const people: PeopleRow[] = (peopleRows ?? []) as PeopleRow[]
  if (people.length === 0) return { upgrades: [], scanned: 0 }

  // ---- Pull every interaction on the wedding with identity signal. -------
  // Cast a wide net: extracted_identity OR calculator-shaped subject/body.
  // The OR clause uses ilike so we don't depend on the parser having
  // populated extracted_identity for older rows.
  const { data: interactionRows } = await supabase
    .from('interactions')
    .select('id, person_id, from_email, full_body, subject, extracted_identity')
    .eq('wedding_id', weddingId)
    .or(
      'extracted_identity.not.is.null,subject.ilike.%estimate%,full_body.ilike.%calculator%',
    )
  const interactions: InteractionRow[] = (interactionRows ?? []) as InteractionRow[]

  // ---- Pull contracts for signer-name candidates. ------------------------
  const { data: contractRows } = await supabase
    .from('contracts')
    .select('extracted_text')
    .eq('wedding_id', weddingId)
  const contractCandidates: NameCandidate[] = []
  for (const c of contractRows ?? []) {
    const txt = (c as { extracted_text: string | null }).extracted_text
    contractCandidates.push(...candidatesFromContractText(txt))
  }

  // ---- Build the universal candidate pool. -------------------------------
  const allCandidates: NameCandidate[] = []
  for (const i of interactions) {
    allCandidates.push(...candidatesFromInteraction(i))
  }
  allCandidates.push(...candidatesFromWeddingText(wedding))
  allCandidates.push(...contractCandidates)

  if (allCandidates.length === 0) {
    return { upgrades: [], scanned: people.length }
  }

  // ---- Per-person: pick best candidate, write if not dryRun. -------------
  const upgrades: NameUpgrade[] = []
  for (const person of people) {
    // Sticky-state Pattern 1: operator-locked names are frozen. The
    // forensic record (name_evidence) still receives new claims via
    // upstream writers; only the *displayed* projection is locked.
    if (person.name_locked_by_operator === true) continue
    const winner = pickBestCandidate(person, allCandidates)
    if (!winner) continue
    // Sanity: don't write if the resolved values exactly equal current.
    if (
      lower(winner.resolvedFirst) === lower(person.first_name) &&
      lower(winner.resolvedLast) === lower(person.last_name)
    ) {
      continue
    }

    const upgrade: NameUpgrade = {
      personId: person.id,
      from: { first: person.first_name, last: person.last_name },
      to: { first: winner.resolvedFirst, last: winner.resolvedLast },
      source: winner.candidate.source,
      confidence: winner.totalScore,
    }
    upgrades.push(upgrade)

    if (!dryRun) {
      const updates: Record<string, unknown> = {}
      if (lower(winner.resolvedFirst) !== lower(person.first_name)) {
        updates.first_name = winner.resolvedFirst
      }
      if (lower(winner.resolvedLast) !== lower(person.last_name)) {
        updates.last_name = winner.resolvedLast
      }
      if (Object.keys(updates).length > 0) {
        const { error: updErr } = await supabase
          .from('people')
          .update(updates)
          .eq('id', person.id)
          .is('merged_into_id', null)
        if (updErr) {
          // Per-row failure: log and continue. The pipeline must never
          // throw out of best-effort.
          console.warn(
            '[identity/name-upgrade] update failed for person',
            person.id,
            ':',
            updErr.message,
          )
        }
      }
    }
  }

  return { upgrades, scanned: people.length }
}

// Internal exports for the backfill route to construct admin notifications.
export const __test__ = {
  classifyFirstNameMove,
  classifyLastNameMove,
  splitFullName,
  candidatesFromInteraction,
  candidatesFromWeddingText,
  candidatesFromContractText,
  scoreCandidateAgainstPerson,
  pickBestCandidate,
}
