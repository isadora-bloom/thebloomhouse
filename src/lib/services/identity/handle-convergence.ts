/**
 * Cross-platform handle convergence.
 *
 * Anchor docs:
 *   - HANDLE-IDENTITY-SPEC.md §1 and §2 (wave 3, 2026-09-09)
 *   - IDENTITY-TRUTH-AUDIT.md Q-C "Cross-source: does the system merge
 *     identity across platforms?"
 *   - bloom-constitution.md — "the same human appears as
 *     `madison.bryant@gmail.com` AND `Madison B.` on Knot AND `@madisonb`
 *     on IG…All five are one lead."
 *
 * What changed in wave 3
 * ----------------------
 * This module used to read `people.platform_handles`,
 * `candidate_identities.username` and `tangential_signals.extracted_
 * identity.username`, and it scored same-platform repeats as evidence.
 * Both of those are gone.
 *
 *   - The store is the spine: `couples.handles` and `fragments.handles`
 *     (migration 398), normalised by `normalizeHandle()`, written only
 *     through `linkSignal`. `people.platform_handles` is legacy and
 *     read-only.
 *   - Same-platform repeats are no longer this module's business. W22's
 *     `handle_exact` cascade stage matches same platform, same handle,
 *     deterministically and at tier high, inside the linker. Proposing
 *     it again here would be a second queue holding a question the
 *     cascade has already answered.
 *
 * What is left, and why it is not redundant
 * -----------------------------------------
 * The one thing the cascade deliberately will not do. `handlesIntersect`
 * is platform-scoped on purpose: "rosie" on Instagram and "rosie" on
 * TikTok are two facts, not one, and treating them as one would fuse
 * strangers who happen to share a common username. But the same string
 * across two platforms IS worth a human look, especially when it is
 * distinctive. So this module proposes cross-platform pairs only, at a
 * low tier, into `candidate_matches` — the one review queue — where a
 * coordinator decides. It never merges and never auto-binds.
 *
 * Hard rules
 * ----------
 *   - `crossPlatformHandleMerge` is READ ONLY. Only
 *     `proposeHandleConvergenceMatches` writes, and it writes review
 *     rows, never a merge.
 *   - Handles shorter than 4 chars are ignored (too generic; "ben",
 *     "kim" hit too many randoms).
 *   - Handles that look like real-name initials ("jb", "kp") are ignored.
 *   - Handles that look like obvious bot / generic shapes
 *     (`user12345`, `wedding_admin`, `info`) are ignored.
 *   - Only cross-platform groups are proposed. A group confined to one
 *     platform is the cascade's job.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { insertCandidateMatch } from './tracer'
import type { HandlePlatform } from './sources/types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Which table a converging record came from. `couple` and `fragment`
 * are what this module emits from wave 3 onward. `people` and
 * `candidate_identities` remain in the union because the admin
 * decision surfaces still branch on them for rows decided before the
 * cutover; nothing produces them any more.
 */
export type RecordKind = 'couple' | 'fragment' | 'people' | 'candidate_identities'

export interface HandleRecord {
  kind: RecordKind
  recordId: string
  /** Original handle as stored. Already normalised on the spine. */
  rawHandle: string
  /** Normalised lower-case form used for matching. */
  normalizedHandle: string
  /** Platform the handle was observed on. */
  platform: string
  /** First name observed on the record. */
  firstName: string | null
  /** Last name observed on the record, when there is one. */
  lastName: string | null
  email: string | null
}

export interface HandleMergeProposal {
  /** The normalized handle that anchored this proposal. */
  handle: string
  /** All records that share this handle. 2+ entries by definition. */
  records: HandleRecord[]
  /** Distinct platforms the handle was observed on. 2+ by definition. */
  platforms: string[]
  /** Heuristic confidence 0..100. A suggestion, never an auto-merge bar. */
  score: number
  /** Why this proposal scored where it did — surfaces in coordinator UI. */
  reasoning: string[]
  /** Whether the records mix a known couple with a pre-identity
   *  fragment. Those are the interesting ones: accepting promotes the
   *  fragment rather than fusing two couples. */
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

/**
 * Spine handles arrive already normalised by `normalizeHandle()`, so
 * this only applies the "is it worth clustering on" filters. Returns
 * null for anything too generic to be evidence.
 */
function clusterableHandle(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = String(raw).trim().toLowerCase()
  if (!v) return null
  if (v.length < 4) return null
  if (GENERIC_HANDLE_BLOCKLIST.has(v)) return null
  if (isProxyHandle(v)) return null
  if (isInitialShaped(v)) return null
  return v
}

// ---------------------------------------------------------------------------
// Loaders — the spine, and only the spine
// ---------------------------------------------------------------------------

interface CoupleRow {
  id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  primary_contact_email: string | null
  handles: Partial<Record<HandlePlatform, string>> | null
}

interface FragmentRow {
  id: string
  identity_hint: string | null
  handles: Partial<Record<HandlePlatform, string>> | null
}

/** First token of a display name. Couples store one name string per
 *  partner, not first / last columns. */
function firstToken(name: string | null): string | null {
  const t = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return t[0] ?? null
}

function restOfName(name: string | null): string | null {
  const t = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return t.length > 1 ? t.slice(1).join(' ') : null
}

function recordsFromHandleMap(
  kind: RecordKind,
  recordId: string,
  handles: Partial<Record<HandlePlatform, string>> | null,
  firstName: string | null,
  lastName: string | null,
  email: string | null,
): HandleRecord[] {
  if (!handles || typeof handles !== 'object') return []
  const out: HandleRecord[] = []
  for (const [platform, handle] of Object.entries(handles)) {
    const normalized = clusterableHandle(handle)
    if (!normalized) continue
    out.push({
      kind,
      recordId,
      rawHandle: handle as string,
      normalizedHandle: normalized,
      platform,
      firstName,
      lastName,
      email,
    })
  }
  return out
}

async function loadCoupleHandles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<HandleRecord[]> {
  const { data, error } = await supabase
    .from('couples')
    .select('id, primary_contact_name, partner_contact_name, primary_contact_email, handles')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
  if (error || !data) return []
  const out: HandleRecord[] = []
  for (const raw of data as CoupleRow[]) {
    out.push(
      ...recordsFromHandleMap(
        'couple',
        raw.id,
        raw.handles,
        firstToken(raw.primary_contact_name),
        restOfName(raw.primary_contact_name),
        raw.primary_contact_email,
      ),
    )
  }
  return out
}

/** Unpromoted fragments are the pre-identity side. A handle here has
 *  never been attached to anybody, so a cross-platform hit against a
 *  couple is the case worth a coordinator's eye. */
async function loadFragmentHandles(
  supabase: SupabaseClient,
  venueId: string,
): Promise<HandleRecord[]> {
  const { data, error } = await supabase
    .from('fragments')
    .select('id, identity_hint, handles')
    .eq('venue_id', venueId)
    .is('promoted_to_couple_id', null)
  if (error || !data) return []
  const out: HandleRecord[] = []
  for (const raw of data as FragmentRow[]) {
    const hint = raw.identity_hint && !raw.identity_hint.startsWith('@') ? raw.identity_hint : null
    out.push(
      ...recordsFromHandleMap(
        'fragment',
        raw.id,
        raw.handles,
        firstToken(hint),
        restOfName(hint),
        null,
      ),
    )
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
 * Compute cross-platform handle proposals for one venue. Read only.
 *
 * Same-platform groups are skipped: `handle_exact` in the cascade
 * already binds those at tier high inside the linker, so surfacing them
 * here would ask the coordinator a question the system has answered.
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

  const [coupleHandles, fragmentHandles] = await Promise.all([
    loadCoupleHandles(supabase, venueId),
    loadFragmentHandles(supabase, venueId),
  ])

  const all = [...coupleHandles, ...fragmentHandles]
  result.handlesInspected = all.length
  if (all.length === 0) return result

  const byHandle = new Map<string, HandleRecord[]>()
  for (const h of all) {
    const arr = byHandle.get(h.normalizedHandle) ?? []
    arr.push(h)
    byHandle.set(h.normalizedHandle, arr)
  }

  for (const [handle, records] of byHandle.entries()) {
    if (records.length < 2) continue

    // One record can hold the same handle on two platforms. That is one
    // record, not two, so dedupe by (kind, id) before counting.
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
    // Cross-platform only. Everything else belongs to the cascade.
    if (platforms.length < 2) continue

    const mixed =
      dedupRecords.some((r) => r.kind === 'couple') &&
      dedupRecords.some((r) => r.kind === 'fragment')

    const reasoning: string[] = []
    let score = 40
    reasoning.push(
      `Handle "${handle}" appears on ${dedupRecords.length} spine records across ${platforms.join(', ')}`,
    )
    reasoning.push(
      'Platform-scoped matching treats these as separate facts. This is a suggestion for a human, not evidence.',
    )

    if (mixed) {
      score += 15
      reasoning.push('Spans a known couple and an unpromoted fragment — accepting promotes the fragment')
    }

    const compat = nameCompatibility(dedupRecords)
    if (compat === 'compatible') {
      score += 10
      reasoning.push('Name observations across records are compatible (equal or prefix relation)')
    } else if (compat === 'conflicting') {
      score -= 30
      reasoning.push('Name observations CONFLICT — could be a shared account or two strangers, do NOT merge')
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

  result.proposals.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.handle.localeCompare(b.handle)
  })

  result.proposalsFound = result.proposals.length
  return result
}

export interface HandleProposalWriteResult {
  proposals: number
  pairsQueued: number
}

/**
 * Push the cross-platform proposals into `candidate_matches` so they
 * land in the one review queue at /intel/identity-review rather than a
 * queue of their own.
 *
 * Tier is always low. A shared string on two platforms is the weakest
 * kind of same-person hint the platform records, and the whole point of
 * the platform-scoped rule is that it must not fuse anybody on its own.
 * `insertCandidateMatch` swallows the unique-violation, so re-running
 * this is a no-op.
 */
export async function proposeHandleConvergenceMatches(
  supabase: SupabaseClient,
  venueId: string,
): Promise<HandleProposalWriteResult> {
  const out: HandleProposalWriteResult = { proposals: 0, pairsQueued: 0 }
  const { proposals } = await crossPlatformHandleMerge(supabase, venueId)

  for (const p of proposals) {
    // A conflicting-name proposal is noise, not a question. Keep it out
    // of the coordinator's queue; it still shows on the read surface.
    if (p.score < 40) continue
    const spineRecords = p.records.filter((r) => r.kind === 'couple' || r.kind === 'fragment')
    if (spineRecords.length < 2) continue
    out.proposals++

    const primary = spineRecords[0]
    for (let i = 1; i < spineRecords.length; i += 1) {
      const secondary = spineRecords[i]
      await insertCandidateMatch(
        supabase,
        venueId,
        primary.recordId,
        primary.kind === 'couple' ? 'couple' : 'fragment',
        secondary.recordId,
        secondary.kind === 'couple' ? 'couple' : 'fragment',
        'low',
        `handle_convergence: "${p.handle}" seen on ${p.platforms.join(' and ')} (score ${p.score}). ${p.reasoning.join(' ')}`,
      )
      out.pairsQueued++
    }
  }

  return out
}
