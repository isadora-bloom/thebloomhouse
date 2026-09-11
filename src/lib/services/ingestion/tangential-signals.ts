/**
 * Vision-extracted identity candidates become spine signals.
 *
 * Wave 3, W24 (HANDLE-IDENTITY-SPEC.md §4 + §5, NOVEMBER-PLAN.md).
 *
 * What this used to be
 * --------------------
 * A screenshot of a comment thread, a tag list or a followers pane was
 * read by vision, turned into `{name, username, platform}` rows, and
 * written to `tangential_signals`. Those rows were then matched against
 * `people` by `findIdentityMatches`, clustered into `candidate_identities`
 * and queued into `client_match_queue`. None of it touched couples,
 * touchpoints or fragments, so the platform kept two identity systems
 * beside each other and gave two answers to one question.
 *
 * What it is now
 * --------------
 * Every candidate becomes a `NormalizedSignal` and goes through
 * `linkSignal`, the one writer. Channel is the platform, action type is
 * what the extraction actually saw (comment / tag / mention / follow /
 * review), handles are normalised by `normalizeHandle()`, the display
 * name rides as `primary_name` at tier low, and `external_id` is stable
 * on the capture plus the row so a re-upload of the same screenshot is a
 * no-op at the database level rather than a one-hour timing guard.
 *
 * Below threshold the signal lands as a fragment. That IS the pool the
 * old `tangential_signals` table was trying to be, except fragments are
 * promoted deterministically by handle when the same person later
 * arrives through an inquiry (W22's fragment promotion), and they carry
 * touchpoints that re-anchor onto the couple.
 *
 * `tangential_signals` gets no new rows from this path. It is marked
 * deprecated in migration 400 and kept for the historical read surfaces.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { linkSignal } from '@/lib/services/identity/forwards-linker'
import { normalizeHandle } from '@/lib/services/identity/handles'
import { normalizeSource } from '@/lib/services/normalize-source'
import type { HandlePlatform, NormalizedSignal } from '@/lib/services/identity/sources/types'

export interface IdentityCandidate {
  name?: string
  first_name?: string
  last_name?: string
  username?: string
  handle?: string
  platform?: string
  context?: string
  signal_type?: string
}

export interface TangentialImportResult {
  /** Signals accepted and routed through linkSignal (duplicates excluded). */
  written: number
  /** Signals that attached to, or minted, a couple. */
  matched: number
  /** Signals that stayed pre-identity: fragment or review-queue candidate. */
  unmatched: number
  /** Of `unmatched`, the ones that became fragments (the pool). */
  fragments: number
  /** Of `unmatched`, the ones that queued a candidate_match for review. */
  candidates: number
  /** Re-fires of an external_id the spine already holds. */
  duplicates: number
  /** Candidates dropped before the linker: no usable identity at all. */
  skipped: number
}

/** Canonical source (normalizeSource) → handle platform. Anything absent
 *  has no handle namespace, so a username on it is a display string, not
 *  an identifier. */
const SOURCE_TO_HANDLE_PLATFORM: Record<string, HandlePlatform> = {
  the_knot: 'knot',
  wedding_wire: 'weddingwire',
  zola: 'zola',
  instagram: 'instagram',
  facebook: 'facebook',
  pinterest: 'pinterest',
  tiktok: 'tiktok',
}

/** Channel for a candidate whose platform has no handle namespace. */
function fallbackChannel(actionType: string): string {
  return actionType === 'review_left' ? 'review' : 'web'
}

/**
 * What the extraction saw, as a touchpoint verb. The spec names
 * comment / tag / mention for the screenshot path; the older
 * `signal_type` vocabulary maps onto it. Unknown values become
 * 'mention', the weakest honest reading of "this name appeared".
 */
const SIGNAL_TYPE_TO_ACTION: Record<string, string> = {
  comment: 'comment',
  tag: 'tag',
  mention: 'mention',
  instagram_engagement: 'comment',
  instagram_follow: 'follow',
  follow: 'follow',
  story_view: 'story_view',
  dm: 'dm',
  review: 'review_left',
  referral: 'referral',
  website_visit: 'web_visit',
  analytics_entry: 'analytics_entry',
  other: 'mention',
}

function actionTypeFor(signalType: string | undefined): string {
  const key = (signalType ?? '').trim().toLowerCase()
  return SIGNAL_TYPE_TO_ACTION[key] ?? 'mention'
}

function splitFullName(raw: string | null | undefined): { first_name: string; last_name: string } {
  const s = (raw ?? '').trim()
  if (!s) return { first_name: '', last_name: '' }
  const parts = s.split(/\s+/).filter(Boolean)
  return { first_name: parts[0] ?? '', last_name: parts.slice(1).join(' ') }
}

/** Lower-case, punctuation-free slug of a display name. Used only to
 *  build a stable external_id for a name-only candidate, never as an
 *  identifier the matcher reads. */
function nameSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** The date part of the capture. Two uploads of the same screenshot on
 *  the same day collapse to one signal; a genuine re-observation a week
 *  later is a new signal, which is what we want on a followers list. */
function captureDay(signalDate: string | null | undefined): string {
  const d = signalDate ? new Date(signalDate) : new Date()
  const ms = d.getTime()
  const safe = Number.isFinite(ms) ? d : new Date()
  return safe.toISOString().slice(0, 10)
}

export async function importIdentityCandidates(args: {
  supabase: SupabaseClient
  venueId: string
  candidates: IdentityCandidate[]
  sourceEntryId?: string | null
  sourceContext?: string | null
  signalDate?: string | null
}): Promise<TangentialImportResult> {
  const { supabase, venueId, candidates, sourceEntryId, sourceContext, signalDate } = args
  const out: TangentialImportResult = {
    written: 0,
    matched: 0,
    unmatched: 0,
    fragments: 0,
    candidates: 0,
    duplicates: 0,
    skipped: 0,
  }

  const occurredAt = signalDate ?? new Date().toISOString()
  const day = captureDay(signalDate)

  for (const cand of candidates) {
    const signal = candidateToSignal(cand, {
      sourceEntryId: sourceEntryId ?? null,
      sourceContext: sourceContext ?? null,
      occurredAt,
      captureDay: day,
    })
    if (!signal) {
      out.skipped++
      continue
    }

    try {
      const res = await linkSignal({
        supabase,
        venueId,
        signal,
        source: 'vision_identity',
      })
      if (res.duplicate || res.action === 'duplicate') {
        out.duplicates++
        continue
      }
      out.written++
      if (res.action === 'attached' || res.action === 'minted') {
        out.matched++
      } else {
        out.unmatched++
        if (res.action === 'fragment' || res.action === 'cold_start') out.fragments++
        else out.candidates++
      }
    } catch (err) {
      // Never let one bad candidate stop the batch. The signal is not
      // lost: the same screenshot re-imported produces the same
      // external_id, so a retry picks it up.
      console.warn(
        '[vision-identity] linkSignal threw for one candidate:',
        err instanceof Error ? err.message : err,
      )
      out.skipped++
    }
  }

  return out
}

/**
 * Shape one vision candidate into a NormalizedSignal. Exported for the
 * unit tests: this is where the whole contract lives, so it is worth
 * testing without a database at all.
 *
 * Returns null when the candidate carries no usable identity (neither a
 * handle we can normalise nor a readable name).
 */
export function candidateToSignal(
  cand: IdentityCandidate,
  ctx: {
    sourceEntryId: string | null
    sourceContext: string | null
    occurredAt: string
    captureDay: string
  },
): NormalizedSignal | null {
  const first = (cand.first_name ?? splitFullName(cand.name).first_name).trim()
  const last = (cand.last_name ?? splitFullName(cand.name).last_name).trim()
  const displayName = (cand.name ?? `${first} ${last}`).trim()

  const canonicalSource = cand.platform ? normalizeSource(cand.platform) : null
  const handlePlatform = canonicalSource ? SOURCE_TO_HANDLE_PLATFORM[canonicalSource] ?? null : null

  const rawHandle = (cand.username ?? cand.handle ?? '').trim()
  const handle = handlePlatform ? normalizeHandle(handlePlatform, rawHandle) : null
  const handles = handle && handlePlatform ? ({ [handlePlatform]: handle } as Partial<Record<HandlePlatform, string>>) : null

  // No handle we can trust and no name to read: nothing to link.
  if (!handle && !first && !displayName) return null

  const actionType = actionTypeFor(cand.signal_type)
  const channel = handlePlatform ?? fallbackChannel(actionType)

  // external_id is stable on the capture plus the row. The capture is
  // the brain-dump entry when there is one, otherwise the day the
  // signal is dated to; the row is the handle when we have one, else a
  // slug of the name. Re-importing the same screenshot re-derives the
  // same id and the spine's UNIQUE (venue_id, channel, external_id)
  // makes the second pass a no-op.
  const capture = ctx.sourceEntryId ?? ctx.captureDay
  const rowKey = handle ?? nameSlug(displayName || first)
  const externalId = `social:${channel}:${actionType}:${rowKey}:${capture}`

  const identityHint = handle ? `@${handle}` : (displayName || first || null)

  return {
    external_id: externalId,
    channel,
    action_type: actionType,
    occurred_at: ctx.occurredAt,
    // A screenshot of a comment is the weakest honest evidence there
    // is. It can corroborate, it must not attach on its own: the
    // cascade decides, and below threshold it becomes a fragment.
    signal_tier: 'low',
    identity_hint: identityHint,
    primary_name: displayName || first || null,
    handles,
    raw_payload: {
      kind: 'vision_identity_candidate',
      platform: cand.platform ?? null,
      canonical_source: canonicalSource,
      signal_type: cand.signal_type ?? null,
      first_name: first || null,
      last_name: last || null,
      raw_handle: rawHandle || null,
      source_context: cand.context ?? ctx.sourceContext,
      source_entry_id: ctx.sourceEntryId,
    },
  }
}
