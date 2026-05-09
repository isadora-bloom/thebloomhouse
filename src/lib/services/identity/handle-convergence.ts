/**
 * Cross-platform handle convergence (Wave 2C — Tenant 2 forensic merge).
 *
 * Anchor docs:
 *   - IDENTITY-TRUTH-AUDIT.md Q-C "Cross-source: does the system merge
 *     identity across platforms?" — flagged the gap below as the most-
 *     undelivered promise of the entire codebase.
 *   - bloom-constitution.md — "the same human appears as
 *     `madison.bryant@gmail.com` AND `Madison B.` on Knot AND `@madisonb`
 *     on IG…All five are one lead."
 *
 * Why this file exists
 * --------------------
 * The clusterer (`candidate-clusterer.ts:563`) keys on
 * `(venue_id, source_platform, fingerprint)`, so the same handle string
 * arriving on Pinterest, Knot, and Instagram will produce THREE
 * `candidate_identities` rows, not one. The chokepoint
 * (`name-capture.ts`) writes per-platform handles into
 * `people.platform_handles[platform]` (mig 255), which gives us the
 * MEMBER side of the convergence problem — but no one has yet built the
 * MATCHER. Three independent handle-shaped signals of "rosaliehoyle"
 * across three platforms remain three rows in the database.
 *
 * What the matcher does
 * ---------------------
 * For one venue:
 *
 *   1. Collect every distinct handle observed in either of the two
 *      stores: `people.platform_handles` (jsonb map of platform → handle)
 *      AND `tangential_signals.extracted_identity.username` (string).
 *
 *   2. Group each handle by its case-insensitive normalized form
 *      (lowercase, strip leading punctuation, drop trailing platform
 *      decoration).
 *
 *   3. For every handle observed across 2+ DIFFERENT records (people
 *      OR candidates) — including across multiple platforms — emit a
 *      merge proposal. Multi-platform-same-handle is a STRONG same-
 *      person signal. Single-platform-multiple-records is also valid
 *      (two candidates with the same Knot handle is still a same-person
 *      signal that the clusterer might have missed).
 *
 *   4. Score each proposal:
 *        - +50 base
 *        - +20 if the handle appeared on 2+ DIFFERENT platforms
 *        - +15 if a `people` row + `candidate_identities` row converge
 *          on the same handle (the post-zero+pre-zero merge case)
 *        - +10 if first/last name observations across the records are
 *          compatible (same first name OR one is a strict prefix of
 *          the other)
 *        - −30 if name observations directly conflict (Sarah vs Mark
 *          on the same handle is suspicious — could be a shared
 *          household account, do NOT auto-merge)
 *
 *   5. Return proposals sorted by score desc. The coordinator UI
 *      reviews + applies the merge through the existing
 *      `mergePeople` / `applyClusterMerge` machinery — this service
 *      DOES NOT mutate the database.
 *
 * Hard rules
 * ----------
 *   - This service is READ ONLY. No writes, no merges, no notifications.
 *     The output is a proposal list the coordinator reviews.
 *   - Handles shorter than 4 chars are ignored (too generic; "ben",
 *     "kim" hit too many randoms).
 *   - Handles that look like real-name initials ("jb", "kp") are ignored.
 *   - Handles that look like obvious bot / generic shapes
 *     (`user12345`, `wedding_admin`, `info`) are ignored.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RecordKind = 'people' | 'candidate_identities'

export interface HandleRecord {
  kind: RecordKind
  recordId: string
  /** Original handle as captured. */
  rawHandle: string
  /** Normalised lower-case form used for matching. */
  normalizedHandle: string
  /** Platform the handle was observed on. */
  platform: string
  /** First name on the record (people.first_name OR
   *  candidate_identities.first_name). */
  firstName: string | null
  /** Last name on the record (people.last_name OR
   *  candidate_identities.last_name). Candidate rows store only
   *  last_initial; we promote that into last_name when no full last
   *  is available so the compatibility check can fire. */
  lastName: string | null
  email: string | null
}

export interface HandleMergeProposal {
  /** The normalized handle that anchored this proposal. */
  handle: string
  /** All records that share this handle. 2+ entries by definition. */
  records: HandleRecord[]
  /** Distinct platforms the handle was observed on. */
  platforms: string[]
  /** Heuristic confidence 0..100. Higher = more certain same-person. */
  score: number
  /** Why this proposal scored where it did — surfaces in coordinator UI. */
  reasoning: string[]
  /** Whether the records mix `people` and `candidate_identities`. The
   *  coordinator UI may want to render those proposals differently
   *  because the merge machinery they target differs (mergePeople vs.
   *  the candidate-resolver promotion path). */
  mixed: boolean
}

export interface HandleConvergenceResult {
  venueId: string
  /** Total handles inspected after filtering. */
  handlesInspected: number
  /** Total proposals returned. */
  proposalsFound: number
  proposals: HandleMergeProposal[]
}

// ---------------------------------------------------------------------------
// Filters — handles we drop before clustering
// ---------------------------------------------------------------------------

/** Generic handles that are NEVER a same-person signal — bots,
 *  defaults, role accounts. Lower-case set. */
const GENERIC_HANDLE_BLOCKLIST: ReadonlySet<string> = new Set([
  'admin',
  'info',
  'support',
  'contact',
  'office',
  'team',
  'help',
  'hello',
  'noreply',
  'no-reply',
  'pinterest',
  'theknot',
  'weddingwire',
  'instagram',
  'facebook',
  'wedding',
  'weddings',
  'bride',
  'groom',
  'couple',
  'guest',
  'venue',
  'planner',
  'photographer',
])

/** Handles shaped like `user12345` / `User\s+<hex>` — Knot proxy IDs
 *  and bot-shaped values. Drop entirely from clustering. */
function isProxyHandle(h: string): boolean {
  if (/^user\s*\d+$/i.test(h)) return true
  if (/^user[._-]?[a-f0-9]{6,}$/i.test(h)) return true
  if (/^guest\d+$/i.test(h)) return true
  return false
}

/** Initial-shaped handles — "jb", "kp", "ms_" — too generic. */
function isInitialShaped(h: string): boolean {
  if (h.length <= 3 && /^[a-z]+$/.test(h)) return true
  return false
}

function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null
  let v = String(raw).trim().toLowerCase()
  // Strip a leading @ / dot / underscore that platform-prefix decoration
  // sometimes adds.
  v = v.replace(/^[@._-]+/, '')
  // Strip trailing whitespace + punctuation.
  v = v.replace(/[._\-\s]+$/, '')
  if (!v) return null
  if (v.length < 4) return null
  if (GENERIC_HANDLE_BLOCKLIST.has(v)) return null
  if (isProxyHandle(v)) return null
  if (isInitialShaped(v)) return null
  return v
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface PeopleRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  platform_handles: Record<string, string | null> | null
}

interface CandidateRow {
  id: string
  source_platform: string
  first_name: string | null
  last_name: string | null
  last_initial: string | null
  email: string | null
  username: string | null
}

async function loadPeopleHandles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<HandleRecord[]> {
  // platform_handles arrived in mig 255; tolerant to its absence on a
  // fresh checkout (column-not-found errors fall through to []).
  const { data, error } = await supabase
    .from('people')
    .select('id, first_name, last_name, email, platform_handles')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .not('platform_handles', 'is', null)
  if (error || !data) return []
  const out: HandleRecord[] = []
  for (const raw of data as PeopleRow[]) {
    const handles = raw.platform_handles
    if (!handles || typeof handles !== 'object') continue
    for (const [platform, handle] of Object.entries(handles)) {
      const normalized = normalizeHandle(handle)
      if (!normalized) continue
      out.push({
        kind: 'people',
        recordId: raw.id,
        rawHandle: handle as string,
        normalizedHandle: normalized,
        platform,
        firstName: raw.first_name,
        lastName: raw.last_name,
        email: raw.email,
      })
    }
  }
  return out
}

async function loadCandidateHandles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<HandleRecord[]> {
  // The clusterer writes the username two places: a top-level
  // `candidate_identities.username` column AND each contributing
  // signal's `tangential_signals.extracted_identity.username`. We
  // read the candidate column because it's the de-duplicated,
  // canonical-per-cluster store.
  const { data, error } = await supabase
    .from('candidate_identities')
    .select('id, source_platform, first_name, last_name, last_initial, email, username')
    .eq('venue_id', venueId)
    .is('resolved_wedding_id', null)
    .not('username', 'is', null)
  if (error || !data) return []
  const out: HandleRecord[] = []
  for (const raw of data as CandidateRow[]) {
    const normalized = normalizeHandle(raw.username)
    if (!normalized) continue
    const lastName = raw.last_name ?? raw.last_initial ?? null
    out.push({
      kind: 'candidate_identities',
      recordId: raw.id,
      rawHandle: raw.username ?? '',
      normalizedHandle: normalized,
      platform: raw.source_platform,
      firstName: raw.first_name,
      lastName,
      email: raw.email,
    })
  }
  return out
}

/** Also harvest from `tangential_signals.extracted_identity.username`
 *  for signals that haven't yet been clustered into a candidate (the
 *  Pinterest-anonymous case where `first_name` is null and the
 *  clusterer skipped the row). These signals get aggregated under a
 *  synthetic record id of `signal:<id>` so the coordinator UI can
 *  surface "this handle was seen on Pinterest but never resolved." */
async function loadOrphanSignalHandles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<HandleRecord[]> {
  const { data, error } = await supabase
    .from('tangential_signals')
    .select('id, source_platform, extracted_identity')
    .eq('venue_id', venueId)
    .is('candidate_identity_id', null)
  if (error || !data) return []
  const out: HandleRecord[] = []
  for (const raw of data as Array<{
    id: string
    source_platform: string | null
    extracted_identity: Record<string, unknown> | null
  }>) {
    if (!raw.source_platform || !raw.extracted_identity) continue
    const username = raw.extracted_identity.username
    if (typeof username !== 'string') continue
    const normalized = normalizeHandle(username)
    if (!normalized) continue
    out.push({
      kind: 'candidate_identities',
      // Synthetic id so this surface in the proposal but is clearly
      // not a real candidate row. Coordinator action would be
      // "trigger reclusterVenue + resolve" rather than "mergePeople".
      recordId: `orphan-signal:${raw.id}`,
      rawHandle: username,
      normalizedHandle: normalized,
      platform: raw.source_platform,
      firstName: null,
      lastName: null,
      email: null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function lower(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

/** Returns 'compatible' | 'conflicting' | 'unknown'. Compatible includes
 *  the case where one side has no name observation. */
function nameCompatibility(records: HandleRecord[]): 'compatible' | 'conflicting' | 'unknown' {
  const firsts = records.map((r) => lower(r.firstName)).filter(Boolean)
  if (firsts.length < 2) return 'unknown'
  // Compatible iff every first name is either equal to or a prefix of
  // the longest seen first name.
  const longest = firsts.reduce((a, b) => (b.length > a.length ? b : a), firsts[0])
  for (const f of firsts) {
    if (longest === f) continue
    if (longest.startsWith(f)) continue
    return 'conflicting'
  }
  return 'compatible'
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Compute cross-platform handle merge proposals for one venue.
 *
 * Read-only. The result is a list of proposals the coordinator
 * surface displays. A future "apply this merge" action would call
 * `mergePeople` (people-people merge) or trigger `reclusterVenue`
 * (orphan signal + candidate consolidation) — both are existing
 * services, this one only proposes.
 */
export async function crossPlatformHandleMerge(
  supabase: SupabaseClient,
  venueId: string,
): Promise<HandleConvergenceResult> {
  const result: HandleConvergenceResult = {
    venueId,
    handlesInspected: 0,
    proposalsFound: 0,
    proposals: [],
  }

  const [peopleHandles, candidateHandles, orphanHandles] = await Promise.all([
    loadPeopleHandles(supabase, venueId),
    loadCandidateHandles(supabase, venueId),
    loadOrphanSignalHandles(supabase, venueId),
  ])

  const all = [...peopleHandles, ...candidateHandles, ...orphanHandles]
  result.handlesInspected = all.length
  if (all.length === 0) return result

  // Group by normalized handle.
  const byHandle = new Map<string, HandleRecord[]>()
  for (const h of all) {
    const arr = byHandle.get(h.normalizedHandle) ?? []
    arr.push(h)
    byHandle.set(h.normalizedHandle, arr)
  }

  // Build proposals.
  for (const [handle, records] of byHandle.entries()) {
    if (records.length < 2) continue

    // De-duplicate: a single record can have the same handle on the
    // same platform twice (people row with platform_handles[knot] +
    // candidate row with the same Knot username). That's still ONE
    // record on each side. Two records on the SAME platform with the
    // SAME handle is the multi-row-same-platform case (also a valid
    // signal — the clusterer missed a merge).
    const recordKeys = new Set<string>()
    const dedupRecords: HandleRecord[] = []
    for (const r of records) {
      const k = `${r.kind}:${r.recordId}`
      if (recordKeys.has(k)) continue
      recordKeys.add(k)
      dedupRecords.push(r)
    }
    if (dedupRecords.length < 2) continue

    const platforms = Array.from(new Set(dedupRecords.map((r) => r.platform)))
    const mixed =
      dedupRecords.some((r) => r.kind === 'people') &&
      dedupRecords.some((r) => r.kind === 'candidate_identities')

    const reasoning: string[] = []
    let score = 50
    reasoning.push(`Handle "${handle}" observed on ${dedupRecords.length} records`)

    if (platforms.length >= 2) {
      score += 20
      reasoning.push(`Cross-platform convergence (${platforms.join(', ')}) — strong same-person signal`)
    } else {
      reasoning.push(`Same platform (${platforms[0]}) — clusterer may have missed a merge`)
    }

    if (mixed) {
      score += 15
      reasoning.push('Spans both pre-zero candidate and post-zero people record — Constitution Point-Zero merge')
    }

    const compat = nameCompatibility(dedupRecords)
    if (compat === 'compatible') {
      score += 10
      reasoning.push('Name observations across records are compatible (equal or prefix relation)')
    } else if (compat === 'conflicting') {
      score -= 30
      reasoning.push('Name observations CONFLICT — could be shared household account, NOT auto-merge')
    } else {
      reasoning.push('Name observations missing on at least one record (no compatibility check possible)')
    }

    score = Math.max(0, Math.min(100, score))

    result.proposals.push({
      handle,
      records: dedupRecords,
      platforms,
      score,
      reasoning,
      mixed,
    })
  }

  // Sort by score desc, then by handle asc for stability.
  result.proposals.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.handle.localeCompare(b.handle)
  })

  result.proposalsFound = result.proposals.length
  return result
}
