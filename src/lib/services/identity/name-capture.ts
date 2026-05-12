/**
 * Bloom House — Name-capture chokepoint (Wave 2A; Wave 4 Phase 4 fast-path)
 *
 * Wave 4 Phase 4 (2026-05-10): this module is now a FAST-PATH BOOTSTRAP
 * only. The Sonnet judge in `reconstruct.ts` is the source of truth for
 * canonical couple names — it produces evidence-quoted partner1/partner2
 * with `is_phantom_partner_relationship` on `couple_identity_profile.profile.names`.
 * `profile-to-people-sync.ts` then back-writes those names onto people
 * rows. The chokepoint here keeps people rows in a usable state at
 * write-time so the live email pipeline + UI don't display empty until
 * the reconstruction job completes. Heuristic detectors retired in this
 * file (Phase 4): `detectPhantomPartner`, `inferNameFromHandle`.
 *
 * Anchor docs:
 *   - bloom-wave4-identity-reconstruction.md (Wave 4 doctrine — retire heuristics)
 *   - IDENTITY-CAPTURE-DESIGN.md (full design — pre-Wave-4 history)
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
import { logEvent } from '@/lib/observability/logger'

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
  // Wave 3 — LLM-driven structured extraction sources. The chokepoint
  // treats these as high-confidence per-email signals because they
  // come from a parser that has salutation / body / signature layout
  // context, not flat regex.
  | 'email_signature_extraction'   // Wave-3 sender_identity from signature
  | 'email_identity_extract_header' // Wave-3 sender_identity from from_header (still LLM-classified, lower confidence)
  | 'email_identity_extract_body'   // Wave-3 sender_identity from body self-reference
  | 'reconstruct_profile_partner2'  // Wave-4 Sonnet judge wrote a non-phantom partner2 to couple_identity_profile; profile-to-people-sync minted the partner2 row from it. High confidence.

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
  | 'rejected'         // greeting / HTML / venue-own-name — never enters picker
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
// Wave 2.5 — rejection list + shape hardening (now: SAFETY NET, not primary)
// ---------------------------------------------------------------------------
//
// Live data (May 2026) showed three classes of junk slipping into the
// picker as 50-confidence "real_name" evidence:
//
//   1. Greetings — `Hi Megan`, `Hi Isadora`, `Hello Shafaq`. The body
//      extractor was emitting "Hi" + the addressee as a {first, last}
//      tuple. The shape detector saw two title-cased tokens and called
//      it real_name.
//   2. Venue's own name — `Rixey Manor` showing up as `first_name=Rixey`
//      / `last_name=Manor` for several couples because the venue's
//      outbound signature got captured as evidence about the COUPLE.
//   3. Raw HTML — `</strong>` ending up as a first_name because the
//      extracted_identity JSON preserved unescaped tags.
//
// Wave 2.5 (commit 35f9430) shipped these guards as the PRIMARY defense.
// Wave 4 Phase 4 (2026-05-10): the per-email Wave-3 LLM extractor
// (extraction/identity-from-email.ts) was retired alongside the per-couple
// Sonnet judge in identity/reconstruct.ts taking over canonical name
// resolution. The reject-list below is now a SAFETY NET on the chokepoint:
// it stops greeting/HTML/venue-name junk from landing as evidence at
// write-time, so people rows stay sane until profile-to-people-sync writes
// the canonical names from couple_identity_profile.

export const REJECTED_NAME_TOKENS: ReadonlySet<string> = new Set([
  // greetings — the most common live-data offender
  'hi', 'hello', 'hey', 'dear', 'greetings', 'hiya', 'howdy',
  // pleasantries that look like names if mis-parsed
  'thanks', 'thank', 'regards', 'best', 'cheers', 'sincerely',
  // role descriptors that should never be a first_name
  'team', 'staff', 'admin', 'support', 'info',
])

/**
 * Reject when first_name is a known greeting / pleasantry / role
 * descriptor, regardless of last_name. "Hi Megan" parses as
 * {first:'Hi', last:'Megan'} via splitFull and trips this guard.
 */
export function isRejectedGreeting(first: string | null): boolean {
  if (!first) return false
  return REJECTED_NAME_TOKENS.has(first.toLowerCase().trim())
}

/**
 * HTML tag detection — anything still carrying `<tag>` or `&entity;`
 * after our normalisation must be junk. Preferred path is to call
 * `stripHtmlForNameValue` first; this is the safety-net check that
 * forbids residual markup from ever entering evidence.
 */
export function containsHtmlTag(value: string): boolean {
  if (!value) return false
  return /<[^>]+>/.test(value) || /&[a-z]+;/i.test(value) || /<\/[a-z]/i.test(value)
}

/**
 * Strip HTML tags + decode common entities + collapse whitespace.
 * Returns null when the value is empty or under 2 chars after
 * stripping (junk fragment with no usable name content). Run this
 * helper at every signal-source extractor BEFORE feeding values into
 * the chokepoint so `</strong>`-style tokens never even reach
 * classifyNameShape.
 */
export function stripHtmlForNameValue(value: string | null | undefined): string | null {
  if (!value) return null
  let v = value
  // Decode the most common HTML entities. Full entity decoding is out
  // of scope; these are the ones we've seen in the wild on
  // extracted_identity values.
  v = v.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/gi, "'")
       .replace(/&apos;/gi, "'")
  // Strip tags (paired or self-closing).
  v = v.replace(/<[^>]+>/g, ' ')
  // Collapse whitespace.
  v = v.replace(/\s+/g, ' ').trim()
  if (!v) return null
  if (v.length < 2) return null
  return v
}

/**
 * Venue-own-name detector. The venue's outbound signature ("Rixey Manor",
 * "The Glass House") sometimes lands in extracted_identity as a name
 * claim; that's evidence about the venue's email, NOT about the COUPLE.
 *
 * We compare against `venues.name` and `venue_config.business_name`
 * (case + whitespace insensitive). Returns true when the candidate
 * matches either of those, OR when both first+last together reconstruct
 * the venue name.
 */
export async function isVenueOwnName(
  supabase: SupabaseClient,
  venueId: string | null,
  candidate: { first: string | null; last: string | null; full?: string | null },
): Promise<boolean> {
  if (!venueId) return false
  const names = await loadVenueOwnNames(supabase, venueId)
  if (names.size === 0) return false
  const candidates: string[] = []
  if (candidate.full) candidates.push(candidate.full)
  if (candidate.first && candidate.last) candidates.push(`${candidate.first} ${candidate.last}`)
  if (candidate.first) candidates.push(candidate.first)
  if (candidate.last) candidates.push(candidate.last)
  for (const c of candidates) {
    const norm = normaliseVenueNameToken(c)
    if (!norm) continue
    if (names.has(norm)) return true
  }
  return false
}

/** Lower-case + collapse whitespace to make a comparable venue-name key. */
function normaliseVenueNameToken(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Per-call cache for venue-name lookups so we don't issue an extra
 * SELECT for every signal in a hot loop. Keyed by venueId. Populated
 * lazily; cleared by chokepoint when the supabase client doesn't match
 * (cheap protection against stale state in cron loops).
 *
 * Wave 3 expanded the set: in addition to `venues.name` and
 * `venue_config.business_name`, the cache now also includes the
 * `venue_ai_config.ai_name` (e.g. "Sage") and every team member's
 * full name from `user_profiles`. Those values are equally "venue-side"
 * — they should never be promoted to a prospect's identity.
 */
const VENUE_NAME_CACHE = new Map<string, { names: Set<string>; cachedAt: number }>()
const VENUE_NAME_CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes is plenty; venue rename is rare.

async function loadVenueOwnNames(
  supabase: SupabaseClient,
  venueId: string,
): Promise<Set<string>> {
  const cached = VENUE_NAME_CACHE.get(venueId)
  if (cached && Date.now() - cached.cachedAt < VENUE_NAME_CACHE_TTL_MS) return cached.names
  const names = new Set<string>()
  try {
    const [venueResp, configResp, aiResp, teamResp] = await Promise.all([
      supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
      supabase.from('venue_config').select('business_name').eq('venue_id', venueId).maybeSingle(),
      supabase.from('venue_ai_config').select('ai_name').eq('venue_id', venueId).maybeSingle(),
      supabase
        .from('user_profiles')
        .select('first_name, last_name')
        .eq('venue_id', venueId)
        .limit(50),
    ])
    const venueName = (venueResp.data?.name as string | null | undefined) ?? null
    const businessName = (configResp.data?.business_name as string | null | undefined) ?? null
    const aiName = (aiResp.data?.ai_name as string | null | undefined) ?? null
    const norm1 = normaliseVenueNameToken(venueName)
    const norm2 = normaliseVenueNameToken(businessName)
    const norm3 = normaliseVenueNameToken(aiName)
    if (norm1) names.add(norm1)
    if (norm2) names.add(norm2)
    if (norm3) names.add(norm3)
    // Team member names — full name only. We deliberately DO NOT add
    // first-only matches here: a prospect named "Megan" and a coordinator
    // also named "Megan" must not collide. Full-name signature matches
    // are safe (very unlikely two distinct full names align). The Wave-3
    // LLM extractor's `venue_side_echoes` output is the better instrument
    // for ambiguous first-only matches because it has the salutation /
    // signature context.
    const teamRows = (teamResp.data ?? []) as Array<{
      first_name: string | null
      last_name: string | null
    }>
    for (const t of teamRows) {
      const composed = [t.first_name ?? '', t.last_name ?? ''].filter(Boolean).join(' ').trim()
      const composedNorm = normaliseVenueNameToken(composed)
      if (composedNorm) names.add(composedNorm)
    }
  } catch {
    // Swallow — venue-name detection is a guard, not a hard requirement.
  }
  VENUE_NAME_CACHE.set(venueId, { names, cachedAt: Date.now() })
  return names
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
  // Wave 3 — LLM-driven extractor sources. The LLM-with-layout signal
  // is the strongest per-email signal we have; a clean signature carries
  // a legal name with very high reliability. Header is lower because the
  // LLM still has to trust the from_header which can carry a relay
  // username; body self-reference is lowest because it's an inference.
  email_signature_extraction: 75,
  email_identity_extract_header: 60,
  email_identity_extract_body: 50,
  // Sonnet reconstruct judge — already weighed every piece of evidence
  // for the couple. When it emits a non-phantom partner2 name at
  // confidence_0_100 >= some threshold, it's the highest-quality
  // structured signal we have short of coordinator typing.
  reconstruct_profile_partner2: 90,
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
    case 'rejected':      return 0
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

// Wave 4 Phase 4 (2026-05-10): `detectPhantomPartner` retired.
// The Sonnet judge in reconstruct.ts emits
// `profile.names.is_phantom_partner_relationship`; profile-to-people-sync
// tombstones phantom partner2 rows post-reconstruction. The synchronous
// rule-based detector ("partner2 first === partner1 first AND no last
// AND no email") is redundant once the LLM judge owns the call.
//
// Wave 4 Phase 4: `inferNameFromHandle` (CamelCase username heuristic)
// retired. Smushed-handle splitting is exactly the kind of guess the
// reconstruct.ts judge handles with evidence quotes.

/**
 * "rosalie.hoyle@gmail.com" → "Rosalie Hoyle".  Best-effort.
 *
 * Returns null when the local-part shape suggests a handle (no dot,
 * digits, etc).
 *
 * Fast-path bootstrap ONLY: used at email-pipeline write-time so the
 * people row has a sensible first/last before reconstruct.ts runs. The
 * Wave 4 Sonnet judge is the source of truth for canonical names.
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
  // Single-token local-part — no handle splitter (Wave 4 Phase 4 retired
  // the CamelCase heuristic). Coordinator can label manually; the
  // reconstruct.ts judge produces canonical names from message bodies.
  return null
}

/**
 * Joint-handle parser for shared couple email accounts. Splits handles
 * like `justinlovewithsandy@gmail.com`, `michaelandjane@`, `kateandtom@`,
 * `sam-n-alex@`, `johnplusgina@`. Returns the two partners when both
 * tokens look like real names + the joiner is in the known set.
 *
 * Returns null for:
 *   - Single-name handles ("justin@", "sandy@" — use inferNameFromEmail)
 *   - Handles with digits ("justin2025@" — too ambiguous)
 *   - Handles with no recognised joiner ("justinsandy@" — could be one
 *     person's compound first name; coordinator labels manually)
 *
 * Discovered 2026-05-12 (Justin + Sandy at Rixey) — joint accounts are
 * common for booked couples and the existing handle-parser missed them
 * entirely, leaving every SMS unmatched.
 */
export function parseJointEmailHandle(
  email: string,
): { partner1_first: string; partner2_first: string } | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at < 1) return null
  const local = email.slice(0, at).toLowerCase()
  if (/\d/.test(local)) return null

  // Role addresses are not personal — never treat as a couple handle.
  if (ROLE_LOCAL_PARTS.has(local)) return null

  // First try explicit separators (`.`, `_`, `-`) with a joiner token.
  const separated = local.split(/[._-]+/).filter(Boolean)
  if (separated.length === 3) {
    const [a, joiner, b] = separated
    if (KNOWN_JOINERS.has(joiner) && isPlausibleFirstName(a) && isPlausibleFirstName(b)) {
      return { partner1_first: titleCase(a), partner2_first: titleCase(b) }
    }
  }

  // Run-on handles: scan for known joiner substrings inside a single
  // continuous local part. Conservative — only accept when the two
  // flanking tokens both pass the stricter isPlausibleFirstName gate.
  //
  // Dropped the bare 'n' joiner from this set (used to split "danny"
  // and "milkhoneyespresso" — too many false positives). The 'n'
  // joiner is kept for the explicit-separator form ("sam.n.alex").
  //
  // Examples that match:
  //   justinlovewithsandy → justin + sandy (joiner: lovewith)
  //   michaelandjane     → michael + jane (joiner: and)
  //   johnplusgina        → john + gina (joiner: plus)
  for (const joiner of RUN_ON_JOINERS) {
    const idx = local.indexOf(joiner)
    if (idx < 3) continue
    const a = local.slice(0, idx)
    const b = local.slice(idx + joiner.length)
    if (!isPlausibleFirstName(a) || !isPlausibleFirstName(b)) continue
    return { partner1_first: titleCase(a), partner2_first: titleCase(b) }
  }

  return null
}

// Separator-form joiners ("kate.and.tom@", "sam_n_alex@", etc).
const KNOWN_JOINERS = new Set(['and', 'n', 'plus', '&', 'with'])

// Run-on form joiners — substring search inside a single token.
// Order matters: longer joiners first so "lovewith" wins over the shorter
// "with" for "justinlovewithsandy". 'n' is intentionally NOT in this
// list — it's too prone to false splits on long handles ("milkhoneyespresso"
// would split on the 'n' inside 'honey').
const RUN_ON_JOINERS: string[] = [
  'loveswith',
  'lovewith',
  'andthe',
  'meets',
  'plus',
  'and',
  '&',
]

/** Role addresses (no person behind them — skip every body-email path). */
const ROLE_LOCAL_PARTS = new Set([
  'hello', 'hi', 'info', 'contact', 'support', 'help', 'admin',
  'team', 'office', 'sales', 'marketing', 'noreply', 'no-reply',
  'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster',
  'bounce', 'bounces', 'unsubscribe', 'press', 'pr', 'media',
  'billing', 'accounts', 'invoices', 'orders', 'service', 'services',
  'inquiries', 'inquiry', 'reservations', 'bookings', 'events',
])

/** Words that show up inside email handles but are NEVER first names
 *  in this context (business names, common nouns, domain leakage).
 *  Used to reject handle splits where one flank is a non-name word. */
const NON_NAME_WORDS = new Set([
  // Domain-word leakage
  'gmail', 'yahoo', 'hotmail', 'outlook', 'aol', 'icloud', 'proton', 'protonmail',
  'live', 'me', 'mac', 'msn', 'comcast', 'verizon', 'att', 'sbcglobal',
  // Generic English nouns we've seen in real handles
  'milk', 'honey', 'espresso', 'coffee', 'tea', 'cafe', 'shop',
  'wedding', 'weddings', 'bride', 'brides', 'groom', 'venue',
  'love', 'loves', 'forever', 'always', 'together', 'us',
  'family', 'home', 'house', 'studio', 'works', 'media',
  // Common short noise
  'the', 'a', 'an', 'is', 'it', 'we', 'our', 'my', 'go', 'on',
  // Body parts / nouns that look name-shaped
  'eye', 'eyes', 'son', 'mom', 'dad', 'baby', 'pet',
])

function isPlausibleFirstName(s: string): boolean {
  if (!s) return false
  // Real first names are typically 3-20 chars. 2-char names exist (Ed, Jo, Al)
  // but are rare enough that requiring 3+ here removes most false splits.
  if (s.length < 3 || s.length > 20) return false
  if (!/^[a-z]+$/.test(s)) return false
  if (NON_NAME_WORDS.has(s)) return false
  return true
}

function looksLikeNameToken(s: string): boolean {
  // Back-compat for older callers — same as isPlausibleFirstName but
  // accepts 2-char minimum (matches the original less-strict heuristic).
  if (!s) return false
  if (s.length < 2 || s.length > 20) return false
  return /^[a-z]+$/.test(s)
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
 *
 * Wave 2.5: HTML-tagged values and greeting-token leads are stamped
 * 'rejected' here. Venue-own-name rejection requires a DB lookup so it
 * happens in `captureNameEvidence` (async) — not in this pure helper.
 */
export function classifyNameShape(value: string): NameShape {
  if (!value || !value.trim()) return 'unknown'
  const v = value.trim()
  // Wave 2.5: HTML tags / entities anywhere in the value mean we
  // failed to strip markup upstream. Reject so picker never sees it.
  if (containsHtmlTag(v)) return 'rejected'
  if (isProxyShaped(v)) return 'proxy'
  if (isUsernameShaped(v)) return 'username'
  // Real-name analysis — split into tokens.
  const tokens = v.split(/\s+/).filter(Boolean)
  // Wave 2.5: if the first token is a greeting / pleasantry, the whole
  // value is a greeting+addressee mis-parse ("Hi Megan", "Dear Isadora",
  // "Thanks Shafaq"). Reject before token-count classification.
  if (tokens.length > 0 && isRejectedGreeting(tokens[0])) return 'rejected'
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
  // Wave 2.5: strip HTML markup from raw inputs BEFORE shape detection.
  // Live data showed `</strong>` landing as a first_name because the
  // extracted_identity JSON preserved unescaped tags. We strip
  // defensively at the chokepoint so any signal source that didn't
  // pre-clean is still safe.
  const cleanFull = stripHtmlForNameValue(signal.full ?? null)
  const cleanFirst = stripHtmlForNameValue(signal.first ?? null)
  const cleanLast = stripHtmlForNameValue(signal.last ?? null)

  let first: string | null = cleanFirst?.trim() || null
  let last: string | null = cleanLast?.trim() || null
  let raw: string | null = null
  if ((!first && !last) && cleanFull) {
    raw = cleanFull
    const split = splitFull(cleanFull)
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
  // Wave 2.5: rejected (greeting / HTML / venue-name) shapes — same
  // treatment as proxy. Stored at confidence 0 for audit so we can see
  // what got filtered, never picked, never displayed.
  if (shape === 'rejected') {
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
      // Wave 2.5: rejected shapes are NEVER pickable.
      if (ev.shape === 'username' || ev.shape === 'proxy' || ev.shape === 'rejected') continue
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
  // is below the verified threshold. Rejected shapes do NOT contribute
  // to the handle hint — a greeting / HTML fragment / venue name is
  // not a useful handle either.
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

  // Wave 2.5: junk-clear path. When the only evidence available is
  // rejected / username / proxy shaped (no real-name candidates above
  // the unverified threshold), return null tuple so the caller can
  // explicitly NULL out legacy first_name / last_name. The legacy
  // pre-Wave-2 columns carrying `Mconn`, `Erinhorrigan`, `User <hex>`
  // get cleared through this path during the rebuild-names backfill.
  const noRealEvidence = f.value === null && l.value === null
  if (noRealEvidence) {
    return { first: null, last: null, confidence: 0, handleHint }
  }
  if (confidence < UNVERIFIED_THRESHOLD) {
    // Below threshold — picker can't return a verified value. Caller
    // surfaces handleHint instead. NULL out the columns so junk doesn't
    // linger as the displayed name.
    return { first: null, last: null, confidence: 0, handleHint }
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

  // 1. Read current row. Wave 2.5: pull venue_id too so we can run the
  // async venue-own-name check on the candidate evidence.
  // Some installs may not yet have run mig 255 — name_evidence /
  // display_handle / platform_handles / name_confidence will come back
  // undefined. We treat undefined as empty/null and never crash.
  const { data: row, error: readErr } = await supabase
    .from('people')
    .select('id, venue_id, name_evidence, display_handle, platform_handles, first_name, last_name, email, name_confidence')
    .eq('id', personId)
    .maybeSingle()

  if (readErr || !row) {
    // Person doesn't exist (or mig 255 column read errored). Bail out
    // safely; the legacy direct-write code is still the source of
    // truth in this case.
    return result
  }

  const fields: PeopleRowFields = row as PeopleRowFields
  const venueId = (row as { venue_id?: string | null }).venue_id ?? null
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
  let evidence = buildEvidenceFromSignal(signal)

  // Wave 2.5: async venue-own-name check. If the candidate's combined
  // value matches the venue's name or business_name, stamp 'rejected'
  // shape so it never enters the picker. Audit-log the rejection.
  if (evidence && evidence.shape !== 'rejected' && evidence.shape !== 'proxy' && venueId) {
    const isVenue = await isVenueOwnName(supabase, venueId, {
      first: evidence.value.first,
      last: evidence.value.last,
      full: evidence.raw,
    })
    if (isVenue) {
      logEvent({
        level: 'warn',
        msg: 'name-capture.rejected',
        event_type: 'identity.name_capture',
        outcome: 'skip',
        venueId,
        data: {
          person_id: personId,
          source: signal.source,
          reason: 'venue_own_name',
          raw: evidence.raw ?? `${evidence.value.first ?? ''} ${evidence.value.last ?? ''}`.trim(),
        },
      })
      evidence = {
        ...evidence,
        shape: 'rejected',
        value: { first: null, last: null },
        confidence: 0,
      }
    }
  }

  // Audit-log other rejections (greeting / HTML) caught synchronously
  // by classifyNameShape inside buildEvidenceFromSignal. Useful for
  // tuning the reject list later without another DB scan.
  if (evidence && evidence.shape === 'rejected') {
    const lowerRaw = (evidence.raw ?? '').toLowerCase()
    let reason: string = 'rejected'
    if (containsHtmlTag(evidence.raw ?? '')) {
      reason = 'html_markup'
    } else if (lowerRaw && [...REJECTED_NAME_TOKENS].some((t) => lowerRaw.startsWith(t))) {
      reason = 'greeting'
    }
    if (reason !== 'rejected' && reason !== 'venue_own_name') {
      // Don't double-log venue_own_name (already emitted above).
      logEvent({
        level: 'warn',
        msg: 'name-capture.rejected',
        event_type: 'identity.name_capture',
        outcome: 'skip',
        venueId,
        data: {
          person_id: personId,
          source: signal.source,
          reason,
          raw: evidence.raw ?? null,
        },
      })
    }
  }

  if (evidence) {
    if (!deduplicateEvidence(existingEvidence, evidence)) {
      evidenceArr = [...existingEvidence, evidence]
      updates.name_evidence = evidenceArr
      result.evidenceAdded = 1
    }

    // 4. Display-handle stamp for username/proxy shape. Rejected shapes
    // (greeting / HTML / venue-name) do NOT populate display_handle —
    // they're not useful as a fallback display either.
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
  // legacy columns.
  //
  // Wave 2.5 — junk-clear path:
  //   When the picker returns null first AND null last (no real-name
  //   evidence above the unverified threshold), explicitly NULL out the
  //   legacy columns so pre-existing junk values like `Mconn`,
  //   `Erinhorrigan`, or `Hi`/`Megan` get cleared. Coordinator-typed
  //   overrides (confidence === 100) are preserved by the picker because
  //   they live as their own evidence row and survive the bestFor scan.
  const pick = pickDisplayName(evidenceArr)
  result.pickerRanThough = true
  result.newDisplay = { first: pick.first, last: pick.last, confidence: pick.confidence }

  const curConfidence = typeof fields.name_confidence === 'number' ? fields.name_confidence : 0
  const pickerHasValue = pick.first !== null || pick.last !== null
  const pickerCleared = !pickerHasValue && (fields.first_name !== null || fields.last_name !== null)

  const shouldDualWrite =
    // Always write when the existing column is null and the picker has a value.
    (!fields.first_name && pick.first) ||
    (!fields.last_name && pick.last) ||
    // Otherwise only write when the picker's confidence is GREATER than
    // the recorded name_confidence. Equal confidence does not trigger a
    // rewrite (avoids ping-pong on equal-quality signals).
    (pick.confidence > curConfidence && pickerHasValue) ||
    // Wave 2.5 junk-clear: picker returned null tuple but the legacy
    // columns are populated. The existing column is junk by definition
    // (no usable evidence supports it). Force NULL.
    pickerCleared

  if (shouldDualWrite) {
    if (pickerCleared) {
      // Explicitly null the legacy columns. Don't touch name_confidence
      // up unless the prior column was actually populated.
      if (fields.first_name !== null) updates.first_name = null
      if (fields.last_name !== null) updates.last_name = null
      updates.name_confidence = 0
    } else {
      if (pick.first !== null && pick.first !== fields.first_name) updates.first_name = pick.first
      if (pick.last !== null && pick.last !== fields.last_name) updates.last_name = pick.last
      if (pick.confidence !== curConfidence) updates.name_confidence = pick.confidence
    }
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

/**
 * Wave 2.5 — prune junk evidence rows from a name_evidence array.
 *
 * Walks the existing array and drops (or stamps confidence=0) any row
 * that matches the rejection rules introduced in Wave 2.5:
 *   - `value.first` is a known greeting token (REJECTED_NAME_TOKENS)
 *   - `raw` or `value` contains residual HTML markup
 *   - the (first, last, raw) reconstructs the venue's own name
 *
 * Use this from the rebuild-names backfill so historical evidence
 * captured before Wave 2.5 also gets cleaned. Returns the cleaned array
 * plus a per-reason count for audit logging.
 *
 * Idempotent: rows already stamped 'rejected' / 'proxy' / 'username' are
 * left untouched.
 */
export function pruneJunkEvidence(
  evidence: NameEvidence[],
  venueOwnNames: ReadonlySet<string>,
): { cleaned: NameEvidence[]; pruned: { greeting: number; html: number; venue_own_name: number } } {
  const pruned = { greeting: 0, html: 0, venue_own_name: 0 }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { cleaned: [], pruned }
  }
  const cleaned: NameEvidence[] = []
  for (const ev of evidence) {
    if (!ev || !ev.value) {
      cleaned.push(ev)
      continue
    }
    // Already-rejected / handle / proxy rows pass through unchanged.
    if (ev.shape === 'rejected' || ev.shape === 'username' || ev.shape === 'proxy') {
      cleaned.push(ev)
      continue
    }
    const first = ev.value.first ?? null
    const last = ev.value.last ?? null
    const raw = ev.raw ?? null
    const combined = raw ?? [first, last].filter(Boolean).join(' ').trim()

    let reason: 'greeting' | 'html' | 'venue_own_name' | null = null
    if (containsHtmlTag(first ?? '') || containsHtmlTag(last ?? '') || containsHtmlTag(combined)) {
      reason = 'html'
    } else if (isRejectedGreeting(first)) {
      reason = 'greeting'
    } else if (venueOwnNames.size > 0) {
      // Venue-name match check: any of {first, last, full, "first last"}
      // matches a known venue name (case + whitespace insensitive).
      const probes: string[] = []
      if (combined) probes.push(combined)
      if (first) probes.push(first)
      if (last) probes.push(last)
      if (first && last) probes.push(`${first} ${last}`)
      for (const p of probes) {
        const norm = p.replace(/\s+/g, ' ').trim().toLowerCase()
        if (norm && venueOwnNames.has(norm)) {
          reason = 'venue_own_name'
          break
        }
      }
    }

    if (reason) {
      pruned[reason] += 1
      cleaned.push({
        ...ev,
        shape: 'rejected',
        value: { first: null, last: null },
        confidence: 0,
      })
    } else {
      cleaned.push(ev)
    }
  }
  return { cleaned, pruned }
}

/**
 * Wave 2.5 — async wrapper that loads venue's own names and runs
 * `pruneJunkEvidence`. Convenience for callers that have a supabase
 * client + venueId but not the name set.
 */
export async function pruneJunkEvidenceForVenue(
  supabase: SupabaseClient,
  venueId: string | null,
  evidence: NameEvidence[],
): Promise<{ cleaned: NameEvidence[]; pruned: { greeting: number; html: number; venue_own_name: number } }> {
  const venueNames = venueId ? await loadVenueOwnNames(supabase, venueId) : new Set<string>()
  return pruneJunkEvidence(evidence, venueNames)
}

// ---------------------------------------------------------------------------
// Cross-platform handle lookup (Wave 2B / Tenant 2 prep)
// ---------------------------------------------------------------------------

/**
 * Find people rows whose `platform_handles[platform]` contains the given
 * handle, scoped to a venue. When `platform` is omitted, scans ALL
 * platforms on each person's handle map and returns any row whose map
 * contains the handle on any platform.
 *
 * Used by:
 *   - The resolver's same-person multi-platform path: when an inquiry
 *     arrives with a Pinterest handle that already exists on another
 *     person row at the venue, that's a same-person signal.
 *   - Wave 2C's merge-candidate emitter: cross-platform handle
 *     convergence is a Tier-1 same-person hint.
 *
 * Implementation note: Supabase's jsonb operator `?` (key exists) doesn't
 * help here because we want to match the VALUE at a key, not the key
 * itself. The `->>` text projection works for an exact value match, so
 * `platform_handles->>pinterest = 'rosaliehoyle'` is the right pattern
 * when we know the platform. For the platform-agnostic path we pull all
 * rows that have ANY entry in platform_handles and JS-filter — at venue
 * scope this is bounded (low thousands per venue).
 *
 * Returns an array of person ids. Empty array on no matches or table-
 * not-yet-migrated (Phase 1 schema-only installs may not have the column;
 * we tolerate the error).
 */
export async function findPeopleByHandle(
  supabase: SupabaseClient,
  venueId: string,
  handle: string,
  platform?: Platform | null,
): Promise<string[]> {
  const trimmed = (handle ?? '').trim()
  if (!venueId || !trimmed) return []

  // Strip a leading '@' so callers can pass IG-style handles either way.
  const needle = trimmed.replace(/^@+/, '')
  if (!needle) return []

  // Fast path: caller knows the platform.
  if (platform) {
    try {
      const { data, error } = await supabase
        .from('people')
        .select('id, platform_handles')
        .eq('venue_id', venueId)
        .is('merged_into_id', null)
        .not('platform_handles', 'is', null)
      if (error) return []
      const rows = (data ?? []) as Array<{
        id: string
        platform_handles: Record<string, string | null> | null
      }>
      const out: string[] = []
      for (const r of rows) {
        const map = r.platform_handles ?? {}
        const v = (map[platform] ?? '').trim().replace(/^@+/, '')
        if (v && v.toLowerCase() === needle.toLowerCase()) {
          out.push(r.id)
        }
      }
      return out
    } catch {
      return []
    }
  }

  // Platform-agnostic: any platform on the handle map matches.
  try {
    const { data, error } = await supabase
      .from('people')
      .select('id, platform_handles')
      .eq('venue_id', venueId)
      .is('merged_into_id', null)
      .not('platform_handles', 'is', null)
    if (error) return []
    const rows = (data ?? []) as Array<{
      id: string
      platform_handles: Record<string, string | null> | null
    }>
    const out: string[] = []
    for (const r of rows) {
      const map = r.platform_handles ?? {}
      for (const v of Object.values(map)) {
        const cand = (v ?? '').trim().replace(/^@+/, '').toLowerCase()
        if (cand && cand === needle.toLowerCase()) {
          out.push(r.id)
          break
        }
      }
    }
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Parenthetical-role descriptor classifier (Wave 2B)
// ---------------------------------------------------------------------------

/**
 * Map a parenthetical-role substring to a structured wedding_relationships
 * role. "(mother of the Bride)" → 'mother', "(planner)" → 'planner',
 * "(MOH)" → 'maid_of_honor', "(family)" → 'family_friend' fallback.
 *
 * Returns null when no descriptor recognised.
 */
export function classifyParentheticalRole(value: string): {
  role: string
  detail: string | null
} | null {
  if (!value) return null
  const m = value.match(/\(([^)]+)\)/)
  if (!m) return null
  const inner = m[1].trim().toLowerCase()
  if (!inner) return null

  // Mother / mom variants.
  if (/\b(mother|mom|mum|mama)\b/.test(inner)) {
    return { role: 'mother', detail: m[1].trim() }
  }
  // Father / dad variants.
  if (/\b(father|dad|papa)\b/.test(inner)) {
    return { role: 'father', detail: m[1].trim() }
  }
  // Planner / wedding planner / coordinator.
  if (/\b(planner|coordinator|wedding\s*planner)\b/.test(inner)) {
    return { role: 'planner', detail: m[1].trim() }
  }
  // Maid of honor / MOH.
  if (/\b(maid\s*of\s*honou?r|moh)\b/.test(inner)) {
    return { role: 'maid_of_honor', detail: m[1].trim() }
  }
  // Best man.
  if (/\bbest\s*man\b/.test(inner)) {
    return { role: 'best_man', detail: m[1].trim() }
  }
  // Sibling.
  if (/\b(sister|brother|sibling)\b/.test(inner)) {
    return { role: 'sibling', detail: m[1].trim() }
  }
  // Family / family friend / aunt / uncle / cousin.
  if (/\b(family|aunt|uncle|cousin|grandma|grandpa|grandmother|grandfather)\b/.test(inner)) {
    return { role: 'family_friend', detail: m[1].trim() }
  }
  // In-laws.
  if (/\b(mother.?in.?law)\b/.test(inner)) {
    return { role: 'mother_in_law', detail: m[1].trim() }
  }
  if (/\b(father.?in.?law)\b/.test(inner)) {
    return { role: 'father_in_law', detail: m[1].trim() }
  }
  // Vendor contact.
  if (/\b(vendor|caterer|florist|photographer|dj|venue\s*manager)\b/.test(inner)) {
    return { role: 'vendor_contact', detail: m[1].trim() }
  }
  // Friend.
  if (/\bfriend\b/.test(inner)) {
    return { role: 'family_friend', detail: m[1].trim() }
  }
  // Anything else — recognise as a role but tag 'other'.
  return { role: 'other', detail: m[1].trim() }
}

/**
 * Strip the trailing `'s` / `’s` from a token. Used by HoneyBook /
 * tour-scheduler / data-import paths where "Mike's Wedding" leaves
 * "Mike's" as a partner first name.
 */
export function stripTrailingPossessive(value: string): string {
  if (!value) return value
  return value.replace(/['’][sS]$/u, '')
}
