/**
 * Social captures onto the identity spine.
 *
 * Wave 3, HANDLE-IDENTITY-SPEC.md §4 and §5. Until now a follower, a
 * story viewer or a DM sender arrived as a handle, and a handle could
 * not exist on the spine. `social/match-engagements.ts` bound those rows
 * straight to the legacy `people` table by three matchers, two of which
 * were guesses: trigram similarity on a display name at 0.5, and "the
 * email local part contains the handle" at confidence 50. Both bound
 * strangers to real couples, outside every guard the spine has, and
 * nothing they wrote ever reached `couples` / `touchpoints` /
 * `fragments`.
 *
 * What this module does
 * ---------------------
 * Turns one parsed engagement into one `NormalizedSignal` and hands it
 * to `linkSignal`, the only writer. The signal carries the handle as a
 * first-class identifier, so W22's `handle_exact` cascade stage can
 * attach it deterministically; when no couple owns the handle yet the
 * signal lands as a fragment and waits, which is the honest answer for
 * a stranger who followed the venue.
 *
 * Shape, per the spec table:
 *
 *   channel      = the platform ('instagram' | 'tiktok' | ...)
 *   action_type  = the metric verb ('follow' | 'story_view' | 'dm' |
 *                  'comment' | 'tag' | 'profile_visit' |
 *                  'video_engagement')
 *   handles      = { [platform]: normalizeHandle(...) }
 *   primary_name = the display name when the capture showed one
 *   occurred_at  = back-derived from the relative age (date-parser.ts)
 *   external_id  = social:{platform}:{metric}:{handle}:{capture_date}
 *   signal_tier  = 'low'
 *
 * A display name from a followers list corroborates, it never attaches
 * on its own: tier 'low' is what keeps it in the candidate queue instead
 * of fusing two people who happen to share a surname.
 *
 * Idempotency
 * -----------
 * `external_id` pins the capture date, not the replay date, so re-running
 * the replay produces the same id and `linkSignal` returns 'duplicate'.
 * A handle that fails `normalizeHandle()` is skipped with a counted
 * reason and never written; junk does not get a touchpoint.
 *
 * Contract: takes the Supabase client as a parameter, never builds one.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { linkSignalBatch, type LinkAction, type LinkResult } from '@/lib/spine/cascade'
import { invalidateCouplesCache } from '../forwards-linker'
import type { HandlePlatform, NormalizedSignal } from '../sources/types'
import { normalizeHandle } from '../handles'
import { parseRelativeAge, type SocialDatePrecision } from '@/lib/services/social/date-parser'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The closed set of verbs a social signal may carry (spec §4). */
export type SocialActionType =
  | 'follow'
  | 'story_view'
  | 'dm'
  | 'comment'
  | 'tag'
  | 'profile_visit'
  | 'video_engagement'

/** Platforms the capture surfaces support. Every one of them is also a
 *  `HandlePlatform`, which is what lets the handle ride on the signal. */
const SOCIAL_PLATFORMS = ['instagram', 'tiktok', 'facebook', 'pinterest'] as const
export type SocialCapturePlatform = (typeof SOCIAL_PLATFORMS)[number]

function isSocialPlatform(value: string): value is SocialCapturePlatform {
  return (SOCIAL_PLATFORMS as readonly string[]).includes(value)
}

/**
 * `social_captures.metric_type` to the spec verb.
 *
 * Three notes on the coarse edges. A Facebook page like and a Pinterest
 * board follow are both "this person chose to keep seeing us", so both
 * are `follow`. Post engagement and a Pinterest save are both "this
 * person acted on a post"; the spec vocabulary has no separate verb for
 * a like or a save, so they share `comment`. TikTok video interactions
 * keep their own verb because the spec names it.
 */
const METRIC_TO_ACTION: Record<string, SocialActionType> = {
  new_followers: 'follow',
  page_likes: 'follow',
  board_follows: 'follow',
  story_views: 'story_view',
  dms: 'dm',
  post_engagement: 'comment',
  saves: 'comment',
  profile_visits: 'profile_visit',
  profile_views: 'profile_visit',
  video_engagement: 'video_engagement',
}

/**
 * The finer verb the vision extractor emits per row
 * (`SocialVisionRow.action`, vision-prompt.ts). When present it wins over
 * the capture-level metric, because one screenshot of a notifications
 * list mixes follows, comments and mentions in the same capture.
 */
const VISION_ACTION_TO_ACTION: Record<string, SocialActionType> = {
  started_following: 'follow',
  follow: 'follow',
  page_like: 'follow',
  board_follow: 'follow',
  viewed_story: 'story_view',
  messaged: 'dm',
  dm: 'dm',
  commented: 'comment',
  commented_video: 'comment',
  liked_post: 'comment',
  saved_post: 'comment',
  saved_pin: 'comment',
  mentioned: 'tag',
  tagged: 'tag',
  viewed_profile: 'profile_visit',
  liked_video: 'video_engagement',
}

/** Map a capture metric plus an optional per-row verb to the spec verb. */
export function resolveActionType(
  metricType: string,
  visionAction?: string | null,
): SocialActionType | null {
  if (visionAction) {
    const fine = VISION_ACTION_TO_ACTION[visionAction.trim().toLowerCase()]
    if (fine) return fine
  }
  return METRIC_TO_ACTION[metricType.trim().toLowerCase()] ?? null
}

// ---------------------------------------------------------------------------
// Signal shaping
// ---------------------------------------------------------------------------

/** One parsed engagement, whichever surface produced it. The text-paste
 *  parser fills handle + display_name; the vision extractor also fills
 *  `relative_age` and `vision_action`; the replay reads the stored row
 *  and fills `engagement_at`. */
export interface SocialEngagementInput {
  /** `social_engagements.id`, when the row is already on disk. */
  id?: string | null
  platform: string
  metric_type: string
  handle: string
  display_name?: string | null
  /** Verbatim from the screenshot: "2d", "1w", "May 04". */
  relative_age?: string | null
  /** The finer per-row verb from vision extraction. */
  vision_action?: string | null
  /** Already-derived time, i.e. `social_engagements.engagement_at`. */
  engagement_at?: string | null
  post_id?: string | null
}

export interface SocialCaptureContext {
  id: string
  captured_at: string
}

export type SocialSkipReason =
  | 'handle_normalisation_failed'
  | 'unsupported_platform'
  | 'unmapped_action'
  | 'missing_capture'

export type ShapeOutcome =
  | { ok: true; signal: NormalizedSignal }
  | { ok: false; reason: SocialSkipReason; handle: string }

/** The date part of an ISO timestamp, which is what the external id pins. */
function captureDateKey(capturedAt: string): string {
  const d = new Date(capturedAt)
  if (Number.isNaN(d.getTime())) return capturedAt.slice(0, 10)
  return d.toISOString().slice(0, 10)
}

/**
 * Turn one parsed engagement into a signal. Returns a skip with a reason
 * rather than throwing, so a capture of 400 handles with two bad rows
 * still lands 398.
 */
export function buildSocialSignal(
  row: SocialEngagementInput,
  capture: SocialCaptureContext,
): ShapeOutcome {
  const platformRaw = (row.platform ?? '').trim().toLowerCase()
  if (!isSocialPlatform(platformRaw)) {
    return { ok: false, reason: 'unsupported_platform', handle: row.handle ?? '' }
  }
  const platform: HandlePlatform = platformRaw

  const actionType = resolveActionType(row.metric_type ?? '', row.vision_action)
  if (!actionType) {
    return { ok: false, reason: 'unmapped_action', handle: row.handle ?? '' }
  }

  const handle = normalizeHandle(platform, row.handle)
  if (!handle) {
    return { ok: false, reason: 'handle_normalisation_failed', handle: row.handle ?? '' }
  }

  // Time: the relative age first, because it is what the platform
  // actually told us; then the stored engagement_at; then the capture
  // instant, which is only ever a ceiling.
  const derived = parseRelativeAge(row.relative_age, capture.captured_at)
  let occurredAt: string
  let precision: SocialDatePrecision | 'capture_ceiling'
  let source: string
  if (derived) {
    occurredAt = derived.occurred_at
    precision = derived.precision
    source = 'relative_age'
  } else if (row.engagement_at) {
    occurredAt = new Date(row.engagement_at).toISOString()
    precision = 'day'
    source = 'engagement_at'
  } else {
    occurredAt = new Date(capture.captured_at).toISOString()
    precision = 'capture_ceiling'
    source = 'captured_at'
  }

  const displayName = row.display_name?.trim() || null
  const metric = (row.metric_type ?? '').trim().toLowerCase()

  const signal: NormalizedSignal = {
    external_id: `social:${platform}:${metric}:${handle}:${captureDateKey(capture.captured_at)}`,
    channel: platform,
    action_type: actionType,
    occurred_at: occurredAt,
    signal_tier: 'low',
    identity_hint: displayName ? `${displayName} (@${handle})` : `@${handle}`,
    primary_name: displayName,
    handles: { [platform]: handle } as Partial<Record<HandlePlatform, string>>,
    raw_payload: {
      social_capture_id: capture.id,
      social_engagement_id: row.id ?? null,
      platform,
      metric_type: metric,
      action_type: actionType,
      handle,
      handle_raw: row.handle,
      display_name: displayName,
      relative_age: row.relative_age ?? null,
      post_id: row.post_id ?? null,
      occurred_at_source: source,
      occurred_at_precision: precision,
      captured_at: capture.captured_at,
      adapter: SOCIAL_ADAPTER_VERSION,
    },
  }

  return { ok: true, signal }
}

export const SOCIAL_ADAPTER_VERSION = 'social-to-spine/v1'

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

/** What the coordinator UI sees. `social_engagements.match_status` keeps
 *  its three legal values (migration 324 CHECK); the detail lives in
 *  `match_method`, which now names a spine outcome rather than a guess. */
export interface SocialOutcome {
  match_status: 'matched' | 'unmatched'
  match_method: string
  match_confidence: number | null
  couple_id: string | null
}

const ACTION_TO_METHOD: Record<LinkAction, string> = {
  attached: 'spine_attached',
  minted: 'spine_minted',
  candidate_medium: 'spine_candidate',
  candidate_low: 'spine_candidate',
  fragment: 'spine_fragment',
  duplicate: 'spine_duplicate',
  cold_start: 'spine_cold_start',
}

/**
 * A row counts as matched only when the spine gave it a couple. A
 * candidate is in review, a fragment is waiting for an identity; neither
 * is a match, and calling them one is how the old matcher lied.
 */
export function mapLinkResultToOutcome(result: LinkResult): SocialOutcome {
  const coupleId = result.matched_couple_id ?? null
  const matched =
    coupleId !== null && (result.action === 'attached' || result.action === 'minted' || result.action === 'cold_start')
  return {
    match_status: matched ? 'matched' : 'unmatched',
    match_method: ACTION_TO_METHOD[result.action] ?? 'spine_unknown',
    match_confidence: result.matcher_score ?? null,
    couple_id: coupleId,
  }
}

/**
 * Plain English for the coordinator, derived from what is stored on the
 * row. Deliberately refuses to call a candidate or a fragment a match.
 */
export function describeSocialOutcome(
  matchStatus: string,
  matchMethod: string | null,
  coupleName: string | null,
): string {
  if (matchStatus === 'pending') return 'Not yet through the linker'
  if (matchStatus === 'matched') {
    const who = coupleName ?? 'a couple'
    return matchMethod === 'spine_minted' ? `New couple from this handle: ${who}` : `Attached to ${who}`
  }
  if (matchMethod === 'spine_candidate') return 'In review'
  if (matchMethod === 'spine_duplicate') return 'Already on the spine'
  if (matchMethod === null) return 'Not yet through the linker'
  return 'Fragment awaiting identity'
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface SocialLinkSummary {
  /** Rows read. */
  scanned: number
  /** Rows that became a signal. */
  processed: number
  /** Rows skipped before any write, by reason. */
  skipped: number
  skipped_reasons: Record<SocialSkipReason, number>
  outcomes: Record<LinkAction, number>
  /** Rows whose social_engagements row now names a couple. */
  matched: number
  unmatched: number
  errors: string[]
}

export interface SocialSample {
  handle: string
  display_name: string | null
  couple_id: string | null
  couple_name: string | null
  outcome: LinkAction
  occurred_at: string
  match_status: 'matched' | 'unmatched'
}

export interface LinkSocialEngagementsArgs {
  supabase: SupabaseClient
  venueId: string
  /** Limit to one capture. Omit to sweep the venue. */
  captureId?: string | null
  /** Cap rows per call. Default 1000. */
  limit?: number
  /** Shape and link but write nothing back to social_engagements. The
   *  linker itself is still the only writer of spine rows, so a true
   *  dry run has to stop before calling it — see `shapeOnly`. */
  dryRun?: boolean
  /** Shape the signals and report, without calling linkSignal at all.
   *  This is what the replay script's default run does. */
  shapeOnly?: boolean
  /** Telemetry label on the tracer_run_events row. */
  source?: string
  /** How many samples to hand back for the operator UI. Default 50. */
  sampleLimit?: number
}

export interface LinkSocialEngagementsResult extends SocialLinkSummary {
  samples: SocialSample[]
}

interface StoredEngagementRow {
  id: string
  venue_id: string
  social_capture_id: string
  platform: string
  metric_type: string
  handle: string
  display_name: string | null
  engagement_at: string | null
  post_id: string | null
}

function emptySummary(): SocialLinkSummary {
  return {
    scanned: 0,
    processed: 0,
    skipped: 0,
    skipped_reasons: {
      handle_normalisation_failed: 0,
      unsupported_platform: 0,
      unmapped_action: 0,
      missing_capture: 0,
    },
    outcomes: {
      attached: 0,
      candidate_medium: 0,
      candidate_low: 0,
      minted: 0,
      fragment: 0,
      duplicate: 0,
      cold_start: 0,
    },
    matched: 0,
    unmatched: 0,
    errors: [],
  }
}

/**
 * Read social_engagements rows, shape them, run them through
 * `linkSignal`, and write the spine outcome back onto each row.
 *
 * Used by the capture route with a `captureId` (the live path) and by
 * the replay script without one (the historical sweep). Both are the
 * same code, which is the point: reconstruction is the live path
 * replayed over history.
 */
export async function linkSocialEngagements(
  args: LinkSocialEngagementsArgs,
): Promise<LinkSocialEngagementsResult> {
  const { supabase, venueId } = args
  const limit = Math.min(Math.max(args.limit ?? 1000, 1), 5000)
  const sampleLimit = args.sampleLimit ?? 50
  const summary = emptySummary()
  const samples: SocialSample[] = []

  let query = supabase
    .from('social_engagements')
    .select('id, venue_id, social_capture_id, platform, metric_type, handle, display_name, engagement_at, post_id')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (args.captureId) query = query.eq('social_capture_id', args.captureId)

  const { data: rowsRaw, error: readErr } = await query
  if (readErr) {
    summary.errors.push(`social_engagements read: ${readErr.message}`)
    return { ...summary, samples }
  }
  const rows = (rowsRaw ?? []) as StoredEngagementRow[]
  summary.scanned = rows.length
  if (rows.length === 0) return { ...summary, samples }

  // Captures, for captured_at. One read, whatever the row count.
  const captureIds = Array.from(new Set(rows.map((r) => r.social_capture_id)))
  const { data: capturesRaw, error: capErr } = await supabase
    .from('social_captures')
    .select('id, captured_at')
    .in('id', captureIds)
  if (capErr) {
    summary.errors.push(`social_captures read: ${capErr.message}`)
    return { ...summary, samples }
  }
  const captureById = new Map(
    ((capturesRaw ?? []) as Array<{ id: string; captured_at: string }>).map((c) => [c.id, c]),
  )

  // Shape first, so a dry run can report without touching the linker.
  const shaped: Array<{ row: StoredEngagementRow; signal: NormalizedSignal }> = []
  for (const row of rows) {
    const capture = captureById.get(row.social_capture_id)
    if (!capture) {
      summary.skipped += 1
      summary.skipped_reasons.missing_capture += 1
      continue
    }
    const outcome = buildSocialSignal(
      {
        id: row.id,
        platform: row.platform,
        metric_type: row.metric_type,
        handle: row.handle,
        display_name: row.display_name,
        engagement_at: row.engagement_at,
        post_id: row.post_id,
      },
      { id: capture.id, captured_at: capture.captured_at },
    )
    if (!outcome.ok) {
      summary.skipped += 1
      summary.skipped_reasons[outcome.reason] += 1
      continue
    }
    shaped.push({ row, signal: outcome.signal })
  }
  summary.processed = shaped.length

  if (args.shapeOnly || shaped.length === 0) {
    for (const s of shaped.slice(0, sampleLimit)) {
      samples.push({
        handle: String(s.signal.raw_payload.handle ?? s.row.handle),
        display_name: s.signal.primary_name ?? null,
        couple_id: null,
        couple_name: null,
        outcome: 'fragment',
        occurred_at: s.signal.occurred_at,
        match_status: 'unmatched',
      })
    }
    return { ...summary, samples }
  }

  // Drop the stale couples cache once, then let the batch share the
  // fresh load. Bypassing per signal would reload every couple at the
  // venue four hundred times for one followers paste, and a capture is
  // one burst: the 60s TTL is exactly the right shape for it.
  invalidateCouplesCache(venueId)

  const { results } = await linkSignalBatch({
    supabase,
    venueId,
    signals: shaped.map((s) => s.signal),
    source: args.source ?? 'social_capture',
  })

  // linkSignalBatch drops a signal that threw, so results can be shorter
  // than the input. Pair by index only while the lengths agree; if they
  // do not, say so rather than mis-attributing an outcome to a handle.
  if (results.length !== shaped.length) {
    summary.errors.push(
      `linker returned ${results.length} results for ${shaped.length} signals; outcomes not written`,
    )
    return { ...summary, samples }
  }

  const coupleIds = new Set<string>()
  const writes: Array<{ row: StoredEngagementRow; signal: NormalizedSignal; outcome: SocialOutcome; action: LinkAction }> = []
  for (let i = 0; i < shaped.length; i++) {
    const result = results[i]
    const outcome = mapLinkResultToOutcome(result)
    summary.outcomes[result.action] += 1
    if (outcome.match_status === 'matched') summary.matched += 1
    else summary.unmatched += 1
    if (outcome.couple_id) coupleIds.add(outcome.couple_id)
    writes.push({ row: shaped[i].row, signal: shaped[i].signal, outcome, action: result.action })
  }

  // Couple names come from the spine, never from people.
  const nameById = await loadCoupleNames(supabase, Array.from(coupleIds))

  const now = new Date().toISOString()
  for (const w of writes) {
    if (!args.dryRun) {
      const patch: Record<string, unknown> = {
        match_status: w.outcome.match_status,
        match_method: w.outcome.match_method,
        match_confidence: w.outcome.match_confidence,
        matched_at: now,
      }
      // A duplicate re-fire tells us nothing new about the couple, so it
      // must not blank a couple_id an earlier run established.
      if (w.outcome.couple_id) patch.couple_id = w.outcome.couple_id
      const { error: updErr } = await supabase
        .from('social_engagements')
        .update(patch)
        .eq('id', w.row.id)
      if (updErr) summary.errors.push(`update ${w.row.id}: ${updErr.message}`)
    }
    if (samples.length < sampleLimit) {
      samples.push({
        handle: String(w.signal.raw_payload.handle ?? w.row.handle),
        display_name: w.signal.primary_name ?? null,
        couple_id: w.outcome.couple_id,
        couple_name: w.outcome.couple_id ? (nameById.get(w.outcome.couple_id) ?? null) : null,
        outcome: w.action,
        occurred_at: w.signal.occurred_at,
        match_status: w.outcome.match_status,
      })
    }
  }

  // Keep the capture counters honest for the platform-card recency dot.
  if (!args.dryRun && args.captureId) {
    const { error: capUpdErr } = await supabase
      .from('social_captures')
      .update({ matched_count: summary.matched, unmatched_count: summary.unmatched + summary.skipped })
      .eq('id', args.captureId)
    if (capUpdErr) summary.errors.push(`capture counters: ${capUpdErr.message}`)
  }

  return { ...summary, samples }
}

/** Display names for the spine couples a batch landed on. */
async function loadCoupleNames(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const { data, error } = await supabase
    .from('couples')
    .select('id, primary_contact_name, partner_contact_name')
    .in('id', ids)
  if (error) return out
  for (const c of (data ?? []) as Array<{
    id: string
    primary_contact_name: string | null
    partner_contact_name: string | null
  }>) {
    const name = [c.primary_contact_name, c.partner_contact_name].filter(Boolean).join(' & ')
    if (name) out.set(c.id, name)
  }
  return out
}

/**
 * Replay every social engagement at a venue through the spine. Idempotent
 * on `external_id`: a second run returns 'duplicate' for every row that
 * already has a touchpoint.
 */
export async function replaySocialEngagements(args: {
  supabase: SupabaseClient
  venueId: string
  limit?: number
  dryRun?: boolean
  shapeOnly?: boolean
}): Promise<LinkSocialEngagementsResult> {
  return linkSocialEngagements({
    supabase: args.supabase,
    venueId: args.venueId,
    limit: args.limit ?? 5000,
    dryRun: args.dryRun,
    shapeOnly: args.shapeOnly,
    source: 'social_replay',
    sampleLimit: 25,
  })
}
