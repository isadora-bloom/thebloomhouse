/**
 * Platform-signals importer — universal path for CSV → the spine.
 *
 * One code path serves every platform CSV: Knot visitor activities,
 * WeddingWire engagements, Instagram followers, Pinterest saves, Google
 * Business interactions, Facebook page activity. A detector recognises
 * the export and maps each row to a `UniversalSignalRow`; this file turns
 * that row into a `NormalizedSignal` and hands it to `linkSignal`.
 *
 * W68 (wave 9): it used to insert into `tangential_signals` instead, and
 * then the brain-dump route ran the Phase B clusterer and resolver over
 * the rows it had just written, and THEN pushed the same rows through
 * `linkSignalBatch` in "shadow mode". One CSV, two identity systems, two
 * answers to the same question — the exact condition HANDLE-IDENTITY-
 * SPEC.md §5 and migration 400 set out to end, still live on the widest
 * ingestion path in the platform. Now there is one writer and one answer.
 *
 * What lands where
 * ----------------
 * A follower list, a saves export and a views rollup are all partial
 * identities: a display name, sometimes a handle, almost never a
 * reachable address. So `hasSufficientIdentity` refuses to mint a couple
 * from them (a handle is deliberately not sufficient — spec §2/§3), the
 * cascade lands each as a fragment carrying its handles, and the fragment
 * sweep promotes it onto a couple the moment that same handle turns up
 * on a real inquiry. That promotion is what the tangential pool never
 * had. Rows that DO carry an email are minted or attached like any other
 * signal.
 *
 * Rerun safety
 * ------------
 * `external_id` is derived from (platform, action, name, day), so
 * `UNIQUE(venue_id, channel, external_id)` on touchpoints and fragments
 * makes a re-upload a no-op at the database level. That replaces the old
 * paginated pre-read of `tangential_signals` and its
 * (action|name|date) key. Within-batch duplicates — the ~250 anonymised
 * ' .' rows on one date in a real Knot export — collapse on the same key
 * before anything is sent.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlatformDetector, UniversalSignalRow } from '../platform-detectors/types'
import { linkSignalBatch } from '@/lib/services/identity/forwards-linker'
import { getVenueSocialHandles, normalizeHandle, stripVenueHandles } from '@/lib/services/identity/handles'
import type { HandlePlatform, NormalizedSignal } from '@/lib/services/identity/sources/types'

export interface PlatformSignalsImportSummary {
  /** Signals accepted by the spine (duplicates excluded). */
  inserted: number
  skipped_duplicate: number
  skipped_unparseable_date: number
  skipped_empty_name: number
  errors: string[]
  /** Per action_class breakdown for sanity in the import summary UI. */
  by_action: Record<string, number>
  /** Per signal_type-future-bridge: which actions had a parsed signal_date
   *  vs not. Used to decide whether the import is good-enough for ROI. */
  date_parse_rate: { parsed: number; unparseable: number }
  /** W68: the legacy Phase B chain (clusterer → candidate-resolver) ran
   *  off the ids of freshly-inserted `tangential_signals` rows. There are
   *  no such rows any more, so this stays empty and the chain no-ops. Kept
   *  on the shape rather than deleted because the brain-dump route and two
   *  selfreview scripts read it; emptying it is what retires the second
   *  identity system without editing a route this workstream does not own. */
  inserted_signal_ids: string[]
  /** W68: likewise empty. The route used this to push a shadow-mode copy
   *  of every row through `linkSignalBatch` after the fact. The rows have
   *  already been through `linkSignal` by the time this returns, so a
   *  second pass would be a duplicate by construction. */
  inserted_signals: Array<{
    id: string
    source_platform: string
    action_class: string
    signal_date: string | null
    extracted_identity: Record<string, unknown>
  }>
  /** What the cascade did with the batch, for the import summary. */
  spine: {
    attached: number
    minted: number
    fragments: number
    candidates: number
    duplicates: number
  }
}

interface ImportArgs {
  supabase: SupabaseClient
  venueId: string
  detector: PlatformDetector
  headers: readonly string[]
  rows: readonly string[][]
  /** Optional brain_dump_entries.id — stored for audit trail and re-runs. */
  brainDumpEntryId?: string
}

/**
 * Map a UniversalSignalRow.action_class to the touchpoint verb the spine
 * stores as `touchpoints.action_type`. This used to squeeze the value
 * into `tangential_signals.signal_type`'s CHECK enum (migration 085),
 * which is why views, saves and clicks all collapsed into
 * 'analytics_entry'. The spine column is free text, so the precise
 * action_class now survives and only the platform-specific bridges stay.
 */
function actionTypeFor(actionClass: string, platform: string): string {
  if (platform === 'instagram') {
    if (actionClass === 'follow') return 'follow'
    if (['like', 'comment', 'mention'].includes(actionClass)) return actionClass
  }
  if (actionClass === 'review') return 'review_left'
  return actionClass || 'other'
}

/** Canonical detector key → handle namespace. A platform absent from this
 *  map has no handle namespace, so a username on it is a display string,
 *  not an identifier. Mirrors the map in ingestion/tangential-signals.ts. */
const PLATFORM_TO_HANDLE: Record<string, HandlePlatform> = {
  the_knot: 'knot',
  wedding_wire: 'weddingwire',
  zola: 'zola',
  instagram: 'instagram',
  facebook: 'facebook',
  pinterest: 'pinterest',
  tiktok: 'tiktok',
}

/** Detector key → touchpoint channel. Anything else rides as 'web'. */
const PLATFORM_TO_CHANNEL: Record<string, string> = {
  the_knot: 'knot',
  wedding_wire: 'weddingwire',
  zola: 'zola',
  instagram: 'instagram',
  facebook: 'facebook',
  pinterest: 'pinterest',
  tiktok: 'tiktok',
  google_business: 'review',
}

/** Lower-case, punctuation-free slug for a derived external_id part. */
function idSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

/**
 * One mapped CSV row → one NormalizedSignal. Exported for the unit
 * tests: the contract of this importer lives here, and it is worth
 * asserting without a database.
 *
 * `primary_name` is set ONLY when the row carries a real surname. A
 * first name and a last initial ("Kara P.") reads as two tokens, and the
 * cascade's mint gate mints a couple for any two-token primary_name —
 * which is how a followers list would otherwise become 800 couples. The
 * partial name rides as `identity_hint`, which the matcher still scores
 * and a fragment row still stores.
 */
export function universalRowToSignal(
  ur: UniversalSignalRow,
  platform: string,
  brainDumpEntryId: string | null,
): NormalizedSignal {
  const occurredAt = ur.signal_date ?? new Date().toISOString()
  const channel = PLATFORM_TO_CHANNEL[platform] ?? 'web'
  const actionType = actionTypeFor(ur.action_class, platform)

  const handlePlatform = PLATFORM_TO_HANDLE[platform] ?? null
  const handle = handlePlatform ? normalizeHandle(handlePlatform, ur.username ?? '') : null
  const handles =
    handle && handlePlatform
      ? ({ [handlePlatform]: handle } as Partial<Record<HandlePlatform, string>>)
      : null

  const fullName =
    ur.first_name && ur.last_name ? `${ur.first_name} ${ur.last_name}`.trim() : null

  const rowKey = idSlug(
    [ur.name_raw ?? handle ?? 'anon', ur.action_class, occurredAt.slice(0, 10)].join('|'),
  )

  return {
    external_id: `platform:${platform}:${actionType}:${rowKey}`,
    channel,
    action_type: actionType,
    occurred_at: occurredAt,
    // A platform analytics row is one person's thumb on someone else's
    // website. It corroborates; it never attaches on its own.
    signal_tier: 'low',
    identity_hint: ur.name_raw ?? (handle ? `@${handle}` : null),
    primary_name: fullName,
    primary_email: ur.email,
    handles,
    raw_payload: {
      kind: 'platform_signal',
      platform,
      action_class: ur.action_class,
      name_raw: ur.name_raw,
      first_name: ur.first_name,
      last_initial: ur.last_initial,
      last_name: ur.last_name,
      username: ur.username,
      email: ur.email,
      city: ur.city,
      state: ur.state,
      country: ur.country,
      source_context: ur.source_context,
      source_entry_id: brainDumpEntryId,
      raw_row: ur.raw_row,
    },
  }
}

export async function importPlatformSignals(args: ImportArgs): Promise<PlatformSignalsImportSummary> {
  const { supabase, venueId, detector, headers, rows, brainDumpEntryId } = args
  const summary: PlatformSignalsImportSummary = {
    inserted: 0,
    skipped_duplicate: 0,
    skipped_unparseable_date: 0,
    skipped_empty_name: 0,
    errors: [],
    by_action: {},
    date_parse_rate: { parsed: 0, unparseable: 0 },
    inserted_signal_ids: [],
    inserted_signals: [],
    spine: { attached: 0, minted: 0, fragments: 0, candidates: 0, duplicates: 0 },
  }

  // Map every row first so we can see the parse rate before writing.
  const mapped: UniversalSignalRow[] = []
  for (const row of rows) {
    try {
      mapped.push(detector.mapRow(headers, row))
    } catch (err) {
      summary.errors.push(`row map failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Wave 5 W36: a platform export can catch the venue's own account (its
  // own follow-back, its own comment). Fetched once per batch.
  let venueHandles: Awaited<ReturnType<typeof getVenueSocialHandles>> | null = null
  try {
    venueHandles = await getVenueSocialHandles(supabase, venueId)
  } catch {
    // A missing venue_config row is not a reason to drop the import.
  }

  const signals: NormalizedSignal[] = []
  const seenInBatch = new Set<string>()

  for (const ur of mapped) {
    if (ur.signal_date) summary.date_parse_rate.parsed++
    else summary.date_parse_rate.unparseable++

    const signal = universalRowToSignal(ur, detector.key, brainDumpEntryId ?? null)

    // Within-batch dedup on the same key the spine's UNIQUE index uses,
    // so a single CSV does not send the same signal twice.
    if (seenInBatch.has(signal.external_id)) {
      summary.skipped_duplicate++
      continue
    }
    seenInBatch.add(signal.external_id)

    if (venueHandles && signal.handles) {
      signal.handles = stripVenueHandles(signal.handles, venueHandles)
    }

    signals.push(signal)
    summary.by_action[ur.action_class] = (summary.by_action[ur.action_class] ?? 0) + 1
  }

  if (signals.length === 0) return summary

  try {
    const { summary: linked } = await linkSignalBatch({
      supabase,
      venueId,
      signals,
      source: `platform_import:${detector.key}`,
      // A platform export is bulk partial identity. The LLM judge has
      // nothing to read on a follower row, and a 1500-row CSV would spend
      // real money proving it.
      judgeBudget: 0,
    })
    summary.spine = {
      attached: linked.attached,
      minted: linked.minted,
      fragments: linked.fragment + linked.cold_start,
      candidates: linked.candidate_medium + linked.candidate_low,
      duplicates: linked.duplicate,
    }
    summary.skipped_duplicate += linked.duplicate
    summary.inserted =
      linked.attached +
      linked.minted +
      linked.fragment +
      linked.cold_start +
      linked.candidate_medium +
      linked.candidate_low
  } catch (err) {
    summary.errors.push(
      `spine write: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return summary
}
