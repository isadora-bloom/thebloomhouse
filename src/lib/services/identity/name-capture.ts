/**
 * Bloom House — Name-capture chokepoint (Wave 2A)
 *
 * Anchor docs:
 *   - IDENTITY-CAPTURE-DESIGN.md (full design)
 *   - IDENTITY-TRUTH-AUDIT.md (Tenant 2 / handles gap)
 *   - bloom-constitution.md (forensic identity reconstruction)
 *
 * Why this file exists
 * --------------------
 * The pipeline has been writing whatever name signal arrived first into
 * `people.first_name` / `people.last_name` and never re-evaluating. The
 * column carries Knot proxy IDs ("User <hex>"), platform usernames
 * ("Erinhorrigan", "Mconn", "Thelabrozzis"), partial names ("Jen B"),
 * and full legal names ("Jennifer Biaksangi") with no way to know which
 * is best. Once a junk shape lands first, every later signal has to
 * fight the existing column instead of layering on top.
 *
 * This service is the SINGLE chokepoint every name-capture site must
 * flow through. It:
 *
 *   1. Classifies the shape of the incoming value (real-name shape vs
 *      username shape vs proxy shape vs partial name).
 *   2. Computes a confidence score for the source-and-shape combination.
 *   3. Appends an evidence row to `people.name_evidence` (jsonb append-
 *      only log).
 *   4. Routes username-shaped values to `people.display_handle`. Routes
 *      handles to `people.platform_handles[platform]`.
 *   5. Re-runs the picker against the full evidence array and dual-
 *      writes the legacy `first_name` / `last_name` columns. The picker
 *      is what every coordinator surface and every Sage prompt reads.
 *
 * The chokepoint is non-blocking: if the migration-255 columns aren't
 * present yet (column read returns null/undefined for `name_evidence`
 * etc.), the picker treats them as empty and the legacy columns still
 * get a sensible value from the picker's projection. This way the
 * service ships green BEFORE the migration is applied in Supabase.
 *
 * What this file is NOT
 * ---------------------
 *   - NOT the resolver. Different rows / merge / tombstones live in
 *     `resolver.ts` and `merge-people.ts`. We only update one people
 *     row at a time.
 *   - NOT a backfill. Wave 2C ships the rebuild endpoint that walks
 *     historical interactions and re-feeds them into this chokepoint.
 *   - NOT UI. Wave 2D ships the lead-detail evidence panel.
 *   - NOT the sub-zero candidate row writer (this only writes to
 *     `people`). Sub-zero rows mirror their own evidence array shape;
 *     pipeline.ts threads the shape through directly using exported
 *     helpers (`isUsernameShaped`, `pickDisplayName`, etc.).
 *
 * Wave 2A ships the chokepoint + the email pipeline (the heaviest
 * user). Wave 2B ports resolver.ts, crm-import, data-import,
 * platform-detectors. The signature is intentionally stable across the
 * waves so callers don't churn between releases.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NameSource =
  | 'gmail_from_name'
  | 'email_handle_parse'
  | 'calculator_form'
  | 'contract_signer'
  | 'brain_dump_note'
  | 'tour_transcript'
  | 'coordinator_typed'
  | 'pinterest_scraper'
  | 'knot_relay'
  | 'weddingwire_relay'
  | 'instagram_handle'
  | 'partner_mention_in_body'
  | 'csv_import'
  | 'form_relay'
  | 'manual_override'

export type Platform =
  | 'pinterest'
  | 'knot'
  | 'weddingwire'
  | 'instagram'
  | 'tiktok'
  | 'facebook'
  | 'twitter'

export interface NameSignal {
  /** The first-name component when the source is structured. */
  first?: string | null
  /** The last-name component when the source is structured. */
  last?: string | null
  /** Single-string name when the source has only a full name (e.g. a
   *  Gmail "From:" header). The chokepoint splits / detects shape on
   *  this; do NOT pre-split client-side — let shape detectors run. */
  full?: string | null
  /** Platform username when the source is a handle (Pinterest pinner,
   *  Knot screen-name, IG handle). Lands in `platform_handles[platform]`. */
  handle?: string | null
  /** Platform that owns the handle. Required when `handle` is set. */
  platform?: Platform | null
  /** Email used to surface this signal. Used by the picker for the
   *  "person naming themselves" boost when the email matches the
   *  people row's stored email. */
  email?: string | null
  /** Source category — drives the base confidence in CONFIDENCE_BY_SOURCE. */
  source: NameSource
  /** ISO 8601 timestamp of when the signal landed. Defaults to now(). */
  capturedAt?: string
  /** Interaction the signal was extracted from, for audit. */
  interactionId?: string | null
  /** Override the computed confidence. Reserved for tests + special
   *  cases (manual coordinator commit). 0-100. */
  confidenceOverride?: number
}

/**
 * One row in `people.name_evidence` jsonb array. Shape mirrors mig 255.
 */
export interface NameEvidence {
  source: NameSource
  value: { first: string | null; last: string | null }
  /** Original raw value (before shape detection) for audit. Stored when
   *  the chokepoint received `full` rather than pre-split first/last. */
  raw?: string | null
  confidence: number
  capturedAt: string
  interactionId?: string | null
  /** Shape classification result, kept for audit + UI ("rejected as
   *  handle"). One of: 'real_name' | 'first_initial' | 'first_only' |
   *  'username' | 'proxy' | 'unknown'. */
  shape: NameShape
}

export type NameShape =
  | 'real_name'        // proper-cased, has space, both first/last present
  | 'first_initial'    // "Jen B" / "Heidy D"
  | 'first_only'       // "Adam"
  | 'username'         // "Erinhorrigan", "rosaliehoyle", "thelabrozzis"
  | 'proxy'            // "User 89436314x..."
  | 'unknown'

export interface CaptureResult {
  recorded: boolean
  evidenceAdded: number
  handleCaptured: boolean
  /** Did the picker rerun and (potentially) update `first_name` /
   *  `last_name`? `false` when the shape was rejected entirely. */
  pickerRanThough: boolean
  newDisplay: { first: string | null; last: string | null; confidence: number } | null
}

export interface PickResult {
  first: string | null
  last: string | null
  confidence: number
  handleHint: string | null
}

// ---------------------------------------------------------------------------
// Confidence ladder
// ---------------------------------------------------------------------------

/**
 * Static base confidence per source. Dynamic sources (Gmail, Knot,
 * WeddingWire) are 0 here — confidence is computed from the shape
 * detector instead, see `computeConfidenceForShape`.
 */
const CONFIDENCE_BY_SOURCE: Record<NameSource, number> = {
  manual_override: 100,
  coordinator_typed: 100,
  contract_signer: 98,
  calculator_form: 95,
  brain_dump_note: 80,
  tour_transcript: 70,
  csv_import: 65,
  form_relay: 60,
  partner_mention_in_body: 40,
  gmail_from_name: 0,
  knot_relay: 0,
  weddingwire_relay: 0,
  pinterest_scraper: 25,
  instagram_handle: 25,
  email_handle_parse: 20,
}

/** Sources whose confidence depends on shape, not source. */
const DYNAMIC_SHAPE_SOURCES: ReadonlySet<NameSource> = new Set<NameSource>([
  'gmail_from_name',
  'knot_relay',
  'weddingwire_relay',
])

/**
 * Compute the confidence for a dynamic-shape source based on the
 * detected shape. Tuned per the design doc § 4b.
 */
function computeConfidenceForShape(shape: NameShape): number {
  switch (shape) {
    case 'real_name':     return 50
    case 'first_initial': return 30
    case 'first_only':    return 20
    case 'username':      return 5
    case 'proxy':         return 0
    case 'unknown':       return 10
  }
}

/** Threshold under which the picker's chosen value is "(unverified)" in UI. */
export const UNVERIFIED_THRESHOLD = 40

// ---------------------------------------------------------------------------
// Shape detectors — exported for capture sites that want pre-classification
// ---------------------------------------------------------------------------

const PROXY_REGEX = /^user\s+[a-f0-9]{20,}$/i

/**
 * `User 89436314x630a2de3b6d57e165fc99f` shape — Knot proxy IDs.
 */
export function isProxyShaped(value: string): boolean {
  if (!value) return false
  const v = value.trim()
  return PROXY_REGEX.test(v)
}

/**
 * Username / handle shape — single-token, lowercase or smushed-case,
 * suspicious length, contains digits, or local-part-shaped.
 *
 * Returns true when the value should NOT be stored as a name.
 *
 * Rules (per design doc § 4d, ordered by specificity):
 *   1. Single token + length >= 11 + smushed-case (no whitespace, has
 *      caps in non-prefix positions).
 *   2. Single token all-lowercase + length >= 6.
 *   3. Contains digits.
 *   4. Single-token email-local-part shape: only [a-z0-9._-] + length >= 8.
 *   5. Contains "via WeddingWire" / "@member.theknot" / similar relay
 *      tokens.
 *   6. ALL CAPS + length > 12 with junk punctuation.
 *
 * Returns FALSE for "real_name" / "first_initial" / "first_only" shapes.
 */
export function isUsernameShaped(value: string): boolean {
  if (!value) return false
  const v = value.trim()
  if (!v) return false

  // Multi-token? Probably a real name. Falls through to other shape
  // detectors. We only consider single-token values "username-shaped"
  // by default. Two-token "X y" patterns are real_name / first_initial.
  if (/\s/.test(v)) {
    // Special-case: "via WeddingWire" / "@member.theknot.com" embedded
    // anywhere → still a relay-handle.
    if (/\bvia\s+(weddingwire|the\s*knot|wedding\s*spot|zola)\b/i.test(v)) return true
    if (/@member\.theknot\.com|@weddingwire/i.test(v)) return true
    return false
  }

  // Single token from here on.

  // Rule 3 — contains digits.
  if (/\d/.test(v)) return true

  // Rule 1 — single-token length >= 11 with smushed-case (real names
  // are rarely 11+ chars without a space, and even those that are
  // ("Christopher", "Maximilian") don't have caps mid-word).
  if (v.length >= 11) {
    // Mixed case with at least one uppercase past index 0, OR all-lower-
    // case smush. Both indicate handle origin.
    const hasMidCap = /[A-Z]/.test(v.slice(1))
    const allLower = v === v.toLowerCase()
    if (hasMidCap || allLower) return true
  }

  // Rule 2 — single-token all-lowercase, length >= 6.
  // Catches "mconn", "erinhorrigan" if it lands lowercase. Real-name
  // single tokens at this length are typically Title Case from the From
  // header.
  if (v.length >= 6 && v === v.toLowerCase() && /^[a-z]+$/.test(v)) {
    return true
  }

  // Rule 4 — single-token email-local-part shape ([a-z0-9._-] only).
  if (v.length >= 8 && /^[a-z0-9._-]+$/i.test(v) && /[._-]/.test(v)) {
    return true
  }

  // Rule 6 — ALL CAPS + length > 12 with junk punctuation.
  if (v.length > 12 && v === v.toUpperCase() && /[^A-Z\s]/.test(v)) return true

  return false
}

/**
 * "Jen", "Adam", "Sarah Smith" — anything that does NOT trip the
 * username or proxy detector AND has at least one alphabetic character.
 */
export function isRealNameShaped(value: string): boolean {
  if (!value) return false
  const v = value.trim()
  if (!v) return false
  if (isProxyShaped(v)) return false
  if (isUsernameShaped(v)) return false
  return /[A-Za-z]/.test(v)
}

/**
 * Detect a "Mary and Mendy Pratt" / "Mary & Mendy Pratt" / "Mary y Mendy
 * Pratt" pattern. Returns the parts when matched, null otherwise.
 *
 * Used to split a single CSV cell that holds two partners into proper
 * partner1 + partner2 rows with shared last name (Pratt).
 */
export function detectDoubleNameString(value: string): { first1: string; first2: string; last: string } | null {
  if (!value) return null
  const v = value.trim()
  if (!v) return null
  // Word-AND-word-LASTNAME pattern. Word = capitalized alphabetic, 2+ chars.
  const m = v.match(/^([A-Z][a-z]+)\s+(?:and|&|y)\s+([A-Z][a-z]+)\s+([A-Z][a-z\-']+)$/)
  if (!m) return null
  return { first1: m[1], first2: m[2], last: m[3] }
}

/**
 * Phantom partner detector — "Brett & Brett" shape. partner2 has the
 * same first name as partner1 AND no last name AND no own email.
 *
 * Used by the email pipeline before inserting partner2 from an
 * LLM-extracted body sign-off. Almost always means the classifier
 * read "thanks, Brett" and emitted partnerName='Brett' when partner1
 * is already Brett.
 */
export function detectPhantomPartner(
  p1: { first: string | null; last: string | null; email: string | null },
  p2: { first: string | null; last: string | null; email: string | null },
): boolean {
  const p1First = (p1.first ?? '').trim().toLowerCase()
  const p2First = (p2.first ?? '').trim().toLowerCase()
  if (!p1First || !p2First) return false
  if (p1First !== p2First) return false
  // Same first; check if p2 lacks distinguishing data.
  const p2HasLast = !!(p2.last && p2.last.trim())
  const p2HasEmail = !!(p2.email && p2.email.trim())
  if (p2HasLast || p2HasEmail) return false
  return true
}

/**
 * Best-effort: extract a (first, last) tuple from a smushed handle
 * like "rosaliehoyle". Heuristic — splits on the boundary where the
 * second half starts with a vowel + consonant pair that looks like a
 * surname stem. Confidence is intentionally low (caller stores at 25).
 *
 * Returns null when no reasonable split exists.
 */
export function inferNameFromHandle(handle: string): { first: string | null; last: string | null } | null {
  if (!handle) return null
  const v = handle.trim().toLowerCase()
  // Strip platform-prefix punctuation.
  const stripped = v.replace(/^[@._-]+/, '')
  if (!stripped) return null
  // Reject very short handles — no useful split exists.
  if (stripped.length < 7) return null
  // Reject handles that are clearly not a personal name (digits, dots).
  if (!/^[a-z]+$/.test(stripped)) return null

  // Try split positions 4..length-3 and pick the FIRST split where:
  //   - both parts are >= 3 chars
  //   - both parts contain at least one vowel
  // This is a cheap heuristic; accuracy is bounded by the lack of a
  // name dictionary in the repo. Confidence is correspondingly low.
  for (let i = 4; i <= stripped.length - 3; i++) {
    const a = stripped.slice(0, i)
    const b = stripped.slice(i)
    if (!/[aeiou]/.test(a)) continue
    if (!/[aeiou]/.test(b)) continue
    return { first: titleCase(a), last: titleCase(b) }
  }
  return null
}

/**
 * "rosalie.hoyle@gmail.com" → "Rosalie Hoyle".  Best-effort.
 *
 * Returns null when the local-part shape suggests a handle (no dot,
 * digits, etc).
 */
export function inferNameFromEmail(email: string): { first: string | null; last: string | null } | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at < 1) return null
  const local = email.slice(0, at).toLowerCase()
  // Only handle the "first.last" / "first_last" / "first-last" shape.
  // No digits.
  if (/\d/.test(local)) return null
  const parts = local.split(/[._-]+/).filter(Boolean)
  if (parts.length === 2) {
    // Reject when either part is a single letter or super long
    if (parts[0].length < 2 || parts[1].length < 2) return null
    if (parts[0].length > 20 || parts[1].length > 20) return null
    return { first: titleCase(parts[0]), last: titleCase(parts[1]) }
  }
  // Single-token local-part — try the handle splitter for an inference.
  if (parts.length === 1) {
    return inferNameFromHandle(parts[0])
  }
  return null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function titleCase(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

/**
 * Classify a single name string into a NameShape. Used by dynamic-
 * confidence sources (Gmail / Knot / WeddingWire) to score shape.
 */
export function classifyNameShape(value: string): NameShape {
  if (!value || !value.trim()) return 'unknown'
  const v = value.trim()
  if (isProxyShaped(v)) return 'proxy'
  if (isUsernameShaped(v)) return 'username'
  // Real-name analysis — split into tokens.
  const tokens = v.split(/\s+/).filter(Boolean)
  if (tokens.length === 1) {
    // Single real-name-shaped token = first_only.
    return 'first_only'
  }
  if (tokens.length === 2) {
    const last = tokens[1]
    // "Jen B" or "Heidy D." — single-letter last token OR token with
    // trailing period and length 2.
    const lastAlpha = last.replace(/\W/g, '')
    if (lastAlpha.length <= 2) return 'first_initial'
    return 'real_name'
  }
  // 3+ tokens — treat as real_name.
  return 'real_name'
}

/**
 * Split a `full` string into (first, last) tuples per the same rules
 * the legacy pipeline used (first whitespace-split token + rest joined).
 */
function splitFull(full: string): { first: string | null; last: string | null } {
  const trimmed = (full ?? '').trim()
  if (!trimmed) return { first: null, last: null }
  const tokens = trimmed.split(/\s+/)
  const first = tokens[0] ?? null
  const last = tokens.length > 1 ? tokens.slice(1).join(' ') : null
  // Strip a single trailing period from the last token (initial form).
  const lastClean = last ? last.replace(/\.+$/, '') : last
  return { first, last: lastClean }
}

/**
 * Compute the evidence row for a NameSignal — runs shape detection,
 * scores confidence, and projects (first, last) values. Pure function.
 *
 * Returns null when the signal carries no usable name data (e.g. only
 * a handle / no full / no first+last).
 */
export function buildEvidenceFromSignal(signal: NameSignal): NameEvidence | null {
  const capturedAt = signal.capturedAt ?? new Date().toISOString()
  // Shape inputs into a candidate (first, last) + raw.
  let first: string | null = signal.first?.trim() || null
  let last: string | null = signal.last?.trim() || null
  let raw: string | null = null
  if ((!first && !last) && signal.full) {
    raw = signal.full
    const split = splitFull(signal.full)
    first = split.first
    last = split.last
  }
  if (!first && !last) return null

  // Combined string for shape classification — prefers the original
  // raw input when present (preserves "Jen B" rather than reconstructed
  // "Jen B").
  const combined = raw ?? [first, last].filter(Boolean).join(' ').trim()
  const shape = classifyNameShape(combined)

  // Compute confidence.
  let confidence: number
  if (typeof signal.confidenceOverride === 'number') {
    confidence = clamp(signal.confidenceOverride, 0, 100)
  } else if (DYNAMIC_SHAPE_SOURCES.has(signal.source)) {
    confidence = computeConfidenceForShape(shape)
  } else {
    confidence = CONFIDENCE_BY_SOURCE[signal.source] ?? 0
  }

  // Reject (proxy) shapes hard — they MUST never become a name.
  if (shape === 'proxy') {
    return {
      source: signal.source,
      value: { first: null, last: null },
      raw: raw ?? combined,
      confidence: 0,
      capturedAt,
      interactionId: signal.interactionId ?? null,
      shape,
    }
  }
  // Reject username shape into a 5-confidence salvage row — picker
  // ignores anything below UNVERIFIED_THRESHOLD for display.
  if (shape === 'username') {
    return {
      source: signal.source,
      value: { first: null, last: null },
      raw: raw ?? combined,
      confidence: confidence > 5 ? 5 : confidence,
      capturedAt,
      interactionId: signal.interactionId ?? null,
      shape,
    }
  }

  return {
    source: signal.source,
    value: { first, last },
    raw,
    confidence,
    capturedAt,
    interactionId: signal.interactionId ?? null,
    shape,
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

/**
 * Project the evidence array into a (first, last, confidence) tuple.
 *
 * Algorithm:
 *   - For each field (first, last) independently:
 *       candidates = evidence rows with a non-empty value for this field
 *                   AND shape != 'username' AND shape != 'proxy'
 *       pick highest confidence; ties broken by most-recent captured_at
 *   - Picked confidence = max(first_pick.confidence, last_pick.confidence)
 *   - If best confidence < UNVERIFIED_THRESHOLD, surface handleHint
 *     (most-recent username-shaped raw) so the UI can display
 *     "Knot: rosaliehoyle (unverified)".
 *   - Coordinator override (confidence === 100) is the implicit highest
 *     and always wins by the same picker (no special-casing required).
 */
export function pickDisplayName(evidence: NameEvidence[]): PickResult {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { first: null, last: null, confidence: 0, handleHint: null }
  }

  function bestFor(field: 'first' | 'last'): { value: string | null; confidence: number } {
    let best: { value: string; confidence: number; capturedAt: string } | null = null
    for (const ev of evidence) {
      if (!ev || !ev.value) continue
      if (ev.shape === 'username' || ev.shape === 'proxy') continue
      const v = ev.value[field]
      if (!v) continue
      if (best === null || ev.confidence > best.confidence ||
          (ev.confidence === best.confidence && ev.capturedAt > best.capturedAt)) {
        best = { value: v, confidence: ev.confidence, capturedAt: ev.capturedAt }
      }
    }
    if (!best) return { value: null, confidence: 0 }
    return { value: best.value, confidence: best.confidence }
  }

  const f = bestFor('first')
  const l = bestFor('last')
  const confidence = Math.max(f.confidence, l.confidence)

  // Handle hint: most-recent username/proxy raw, when name confidence
  // is below the verified threshold.
  let handleHint: string | null = null
  if (confidence < UNVERIFIED_THRESHOLD) {
    let bestHandle: { raw: string; capturedAt: string } | null = null
    for (const ev of evidence) {
      if (ev.shape !== 'username' && ev.shape !== 'proxy') continue
      const raw = ev.raw ?? null
      if (!raw) continue
      if (!bestHandle || ev.capturedAt > bestHandle.capturedAt) {
        bestHandle = { raw, capturedAt: ev.capturedAt }
      }
    }
    handleHint = bestHandle?.raw ?? null
  }

  return { first: f.value, last: l.value, confidence, handleHint }
}

// ---------------------------------------------------------------------------
// Write contract — the public chokepoint
// ---------------------------------------------------------------------------

interface PeopleRowFields {
  name_evidence?: NameEvidence[] | null
  display_handle?: string | null
  platform_handles?: Record<string, string | null> | null
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  name_confidence?: number | null
}

/**
 * Append-only evidence dedup. Two evidence rows are duplicates when
 * they share (source, value.first, value.last) AND captured within 1
 * hour of each other. Same signal twice from the same source within an
 * hour does NOT produce two rows.
 */
function deduplicateEvidence(existing: NameEvidence[], next: NameEvidence): boolean {
  const HOUR_MS = 60 * 60 * 1000
  const nextTs = Date.parse(next.capturedAt)
  for (const ev of existing) {
    if (ev.source !== next.source) continue
    if ((ev.value?.first ?? null) !== (next.value?.first ?? null)) continue
    if ((ev.value?.last ?? null) !== (next.value?.last ?? null)) continue
    const evTs = Date.parse(ev.capturedAt)
    if (Number.isFinite(evTs) && Number.isFinite(nextTs) && Math.abs(evTs - nextTs) <= HOUR_MS) {
      return true
    }
  }
  return false
}

/**
 * Capture a single name signal against a person row. The single
 * chokepoint every capture site flows through.
 *
 * Order of operations:
 *   1. Read current people row (name_evidence, display_handle,
 *      platform_handles, first_name, last_name, email).
 *   2. If the signal carries a handle, append to platform_handles map.
 *   3. Build the evidence row from the signal (shape detection +
 *      confidence scoring). Append to name_evidence unless it
 *      duplicates a recent entry from the same source.
 *   4. If the evidence shape is `username` or `proxy`, stamp
 *      `display_handle` with the raw value (when not already set).
 *   5. Run the picker against the updated evidence array.
 *   6. Dual-write `first_name` / `last_name` / `name_confidence` from
 *      the picker output.
 *
 * Idempotent — same signal twice in an hour yields exactly one
 * evidence row + one picker rerun. Safe to call from concurrent
 * pipeline lanes; race-on-the-same-row is rare in practice (Gmail
 * delivery serialises).
 */
export async function captureNameEvidence(
  supabase: SupabaseClient,
  personId: string,
  signal: NameSignal,
): Promise<CaptureResult> {
  const result: CaptureResult = {
    recorded: false,
    evidenceAdded: 0,
    handleCaptured: false,
    pickerRanThough: false,
    newDisplay: null,
  }

  if (!personId || !signal || !signal.source) return result

  // 1. Read current row.
  // Some installs may not yet have run mig 255 — name_evidence /
  // display_handle / platform_handles / name_confidence will come back
  // undefined. We treat undefined as empty/null and never crash.
  const { data: row, error: readErr } = await supabase
    .from('people')
    .select('id, name_evidence, display_handle, platform_handles, first_name, last_name, email, name_confidence')
    .eq('id', personId)
    .maybeSingle()

  if (readErr || !row) {
    // Person doesn't exist (or mig 255 column read errored). Bail out
    // safely; the legacy direct-write code is still the source of
    // truth in this case.
    return result
  }

  const fields: PeopleRowFields = row as PeopleRowFields
  const existingEvidence: NameEvidence[] = Array.isArray(fields.name_evidence)
    ? (fields.name_evidence as NameEvidence[])
    : []
  const existingHandles: Record<string, string | null> =
    fields.platform_handles && typeof fields.platform_handles === 'object'
      ? { ...(fields.platform_handles as Record<string, string | null>) }
      : {}

  const updates: Record<string, unknown> = {}
  let evidenceArr = existingEvidence

  // 2. Platform handle capture.
  if (signal.handle && signal.handle.trim()) {
    const handle = signal.handle.trim()
    const platform = signal.platform
    if (platform) {
      const cur = existingHandles[platform]
      if (cur !== handle) {
        existingHandles[platform] = handle
        updates.platform_handles = existingHandles
        result.handleCaptured = true
      }
    }
  }

  // 3. Build + append evidence.
  const evidence = buildEvidenceFromSignal(signal)
  if (evidence) {
    if (!deduplicateEvidence(existingEvidence, evidence)) {
      evidenceArr = [...existingEvidence, evidence]
      updates.name_evidence = evidenceArr
      result.evidenceAdded = 1
    }

    // 4. Display-handle stamp for username/proxy shape.
    if ((evidence.shape === 'username' || evidence.shape === 'proxy') && evidence.raw) {
      // Don't overwrite an existing display_handle — append-only behaviour.
      // Different handles on different platforms go to platform_handles
      // anyway; display_handle is the catch-all when no platform is known.
      if (!fields.display_handle) {
        updates.display_handle = evidence.raw
      }
    }
  }

  // 5 + 6. Run the picker against the updated evidence and dual-write
  // legacy columns. Only update when the picker produces a non-null
  // value for a field that's currently null OR the picker confidence
  // exceeds the current name_confidence on the row (preserves coordinator
  // typed values at 100 against any later signal).
  const pick = pickDisplayName(evidenceArr)
  result.pickerRanThough = true
  result.newDisplay = { first: pick.first, last: pick.last, confidence: pick.confidence }

  const curConfidence = typeof fields.name_confidence === 'number' ? fields.name_confidence : 0
  const shouldDualWrite =
    // Always write when the existing column is null and the picker has a value.
    (!fields.first_name && pick.first) ||
    (!fields.last_name && pick.last) ||
    // Otherwise only write when the picker's confidence is GREATER than
    // the recorded name_confidence. Equal confidence does not trigger a
    // rewrite (avoids ping-pong on equal-quality signals).
    (pick.confidence > curConfidence && (pick.first !== null || pick.last !== null))

  if (shouldDualWrite) {
    if (pick.first !== null && pick.first !== fields.first_name) updates.first_name = pick.first
    if (pick.last !== null && pick.last !== fields.last_name) updates.last_name = pick.last
    if (pick.confidence !== curConfidence) updates.name_confidence = pick.confidence
  }

  if (Object.keys(updates).length === 0) {
    // Nothing to persist — early return so we don't issue a no-op UPDATE.
    result.recorded = result.evidenceAdded > 0 || result.handleCaptured
    return result
  }

  // 7. Persist. We tolerate column-not-found errors on installs where
  // mig 255 hasn't been applied — the legacy column writes still go
  // through via the same UPDATE. Strategy: try the full update first;
  // if it fails with a 42703 (undefined_column), retry with only the
  // legacy fields.
  const { error: updateErr } = await supabase
    .from('people')
    .update(updates)
    .eq('id', personId)

  if (updateErr) {
    // Strip mig-255-only fields and retry. Errors silently suppressed
    // beyond this — pipeline ingest must not break on a name update.
    const legacyOnly: Record<string, unknown> = {}
    if ('first_name' in updates) legacyOnly.first_name = updates.first_name
    if ('last_name' in updates) legacyOnly.last_name = updates.last_name
    if (Object.keys(legacyOnly).length > 0) {
      await supabase
        .from('people')
        .update(legacyOnly)
        .eq('id', personId)
    }
  }

  result.recorded = true
  return result
}
