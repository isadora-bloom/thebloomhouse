/**
 * Lead board reader — the spine behind /agent/leads and /agent/pipeline.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Both surfaces used to open with `supabase.from('weddings')` in the
 * browser, join `people` for names, and fetch `wedding_heat` for a
 * temperature. Three legacy tables, two pages, two slightly different
 * ideas of what a lead is. Each carried a `legacy-read-ok` tag whose
 * stated reason was that the spine's six lifecycle states could not
 * express the thirteen-stage pipeline. W37 shipped the mapping
 * (`src/lib/services/lifecycle/vocabulary.ts`), so that reason expired,
 * and this reader is what replaces the queries.
 *
 * WHAT IT READS
 * -------------
 * The row set is the spine and only the spine:
 *   - `couples`                   one row per couple, merged-away excluded
 *   - `touchpoints`               the ribbon: first channel, last activity, heat
 *   - `couple_progression_events` the inbound anchors (tour booked, toured,
 *                                 contract signed) used to place a couple
 *                                 when the machine has never run on it
 *   - `fragments`                 an aggregate count of signals that never
 *                                 attached to anybody, so the page can say
 *                                 the list is incomplete rather than imply
 *                                 it is everything
 *
 * THE ONE MIRROR SEAM
 * -------------------
 * `loadMirrorAttributes` joins the mirrored wedding row for the handful of
 * per-wedding attributes the spine has no column for. This is the same
 * seam `getCoupleJourney` already opens in `canonical.ts` (it reads
 * `weddings.lifecycle_stage / booked_at / status` for exactly this
 * purpose, tagged "enrichment, not a gate"), widened by four display
 * columns and kept in ONE place so the pages do not each grow their own.
 * Every column is listed with the reason the spine cannot answer it in
 * `MIRROR_COLUMNS` below; shrinking that list is how this seam closes.
 *
 * It is enrichment in the strict sense: a couple with no mirrored wedding,
 * or a mirror read that fails outright, still produces a row. Nothing in
 * the row set, the counts, the stage or the heat depends on it, and the
 * one stage input it does supply (`machineStage`) has a spine-evidence
 * fallback in the adapter.
 *
 * Injectable core (`loadLeadBoard` takes the client) so the unit tests
 * drive it with a plain mock, the same seam the canonical readers use.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildHeatWhy, type HeatWhy } from '@/lib/intel/adapters/heat-why'
import type { HeatTouchpoint } from '@/lib/services/identity/heat-score'
import type { LifecycleStage } from '@/lib/services/lifecycle/state-machine'

// ---------------------------------------------------------------------------
// The mirror seam, written down
// ---------------------------------------------------------------------------

/**
 * Every `weddings` column this reader joins, and why the spine cannot
 * answer it yet. Exported so an audit can diff it rather than re-reading
 * the query, and so closing the seam is a visible deletion.
 */
export const MIRROR_COLUMNS: Readonly<Record<string, string>> = {
  lifecycle_stage:
    'The thirteen-stage machine (migration 278) is a per-wedding column. The spine has no stage column of any width; the adapter falls back to deriving one from couple_progression_events when this is null.',
  lifecycle_stage_set_at:
    'When the stage last moved. "Days in stage" used to come off weddings.updated_at, which every bulk import bumps to now.',
  booked_at:
    'A signed booking is a fact deriveOperatorStage needs. couples.lifecycle_state = booked covers most of it, but a booking recorded before the mirror ran only exists here.',
  status:
    'Read ONLY as a second witness for hasBooking, matching getCoupleJourney. Never used to place a card.',
  code_extension:
    'The suffix on a Bloom number. client_codes holds the code, the extension sits on the wedding.',
  confidence_flag:
    'Whether the record arrived live, from a CRM export, from a Gmail backfill or by hand. Provenance of a wedding row, which the spine does not carry.',
  import_warnings:
    'Import-time parse problems, e.g. a couple name the CRM could not split. Raised against the imported wedding row.',
  guest_count_estimate:
    'Guest estimate. A wedding detail, not an identity fact.',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportWarning {
  field: string
  issue: string
  value?: string | null
}

/** What the last touchpoint on the ribbon was. */
export interface LastSignal {
  at: string
  channel: string
  actionType: string
}

/** The inbound anchors from `couple_progression_events`, reduced. */
export interface ProgressionAnchors {
  tourBookedAt: string | null
  tourAttendedAt: string | null
  contractSignedAt: string | null
  /** Any inbound progression at all, newest first. */
  lastEventType: string | null
  lastEventAt: string | null
  count: number
}

/** One couple, as both surfaces need it. Spine facts first, mirror
 *  attributes last and clearly named. */
export interface LeadBoardRow {
  coupleId: string
  venueId: string
  venueName: string | null
  /** `couples.source_wedding_id`. The link target for the existing
   *  /intel/clients/[id] route and the drag write. Null for a couple
   *  minted from a fragment, which is a real and growing case. */
  weddingId: string | null
  names: string | null
  primaryName: string | null
  partnerName: string | null
  lifecycleState: string | null
  channelScope: string | null
  weddingDate: string | null
  lastProgressionAt: string | null
  decayWindowDays: number | null
  /** Earliest touchpoint of any kind. The honest replacement for
   *  `weddings.inquiry_date`. */
  firstSeenAt: string | null
  /** `couples.point_zero_at` — first known by name AND reachable. */
  pointZeroAt: string | null
  /** Channel of the earliest touchpoint. The honest replacement for
   *  `weddings.source`, which was a hand-set column. */
  firstChannel: string | null
  lastSignal: LastSignal | null
  touchpointCount: number
  progression: ProgressionAnchors
  /** Null when the touchpoint read failed for this batch. Null means
   *  unknown, never zero — the distinction the W17 banner rests on. */
  heat: HeatWhy | null
  clientCode: string | null

  // ---- mirror attributes (see MIRROR_COLUMNS) ----
  machineStage: LifecycleStage | null
  machineStageSetAt: string | null
  hasBooking: boolean
  codeExtension: string | null
  confidenceFlag: string | null
  importWarnings: ImportWarning[] | null
  guestCountEstimate: number | null
}

export interface LeadBoardResult {
  rows: LeadBoardRow[]
  venueIds: string[]
  /** False when the touchpoint read failed. Every `heat` is null and the
   *  surface must say "unknown", not draw a cold badge. */
  heatAvailable: boolean
  /** Signals in this venue that never attached to a couple. The list
   *  below is not everything that happened, and this is how it says so. */
  unattachedFragments: number | null
  /** True when a row cap was hit, so a surface can say the list is
   *  partial rather than quietly short. */
  truncated: boolean
  /** Non-fatal problems, in operator English. */
  warnings: string[]
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Couples per load. A venue past this is paging territory, not a board. */
const COUPLE_LIMIT = 5000
/** Touchpoints per load. Matches the daily-list route's own cap. */
const TOUCHPOINT_LIMIT = 50000
/** Progression events per load. */
const PROGRESSION_LIMIT = 20000
/** PostgREST `.in()` list size. Same chunking the pipeline page used. */
const IN_CHUNK = 500

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function coupleNames(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

// ---------------------------------------------------------------------------
// Raw row shapes
// ---------------------------------------------------------------------------

interface RawCoupleRow {
  id: string
  venue_id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  lifecycle_state: string | null
  channel_scope: string | null
  wedding_date: string | null
  heat_score: number | null
  last_progression_at: string | null
  decay_window_days: number | null
  source_wedding_id: string | null
  merged_into_id: string | null
  first_seen_at: string | null
  point_zero_at: string | null
}

interface RawTouchpointRow {
  couple_id: string | null
  channel: string
  action_type: string
  signal_tier: string
  occurred_at: string
}

interface RawProgressionRow {
  couple_id: string
  event_type: string
  occurred_at: string
}

interface RawMirrorRow {
  id: string
  status: string | null
  booked_at: string | null
  lifecycle_stage: string | null
  lifecycle_stage_set_at: string | null
  code_extension: string | null
  confidence_flag: string | null
  import_warnings: unknown
  guest_count_estimate: number | null
}

/** What `loadMirrorAttributes` hands back per wedding id. */
export interface MirrorAttributes {
  machineStage: LifecycleStage | null
  machineStageSetAt: string | null
  hasBooking: boolean
  codeExtension: string | null
  confidenceFlag: string | null
  importWarnings: ImportWarning[] | null
  guestCountEstimate: number | null
}

const EMPTY_MIRROR: MirrorAttributes = {
  machineStage: null,
  machineStageSetAt: null,
  hasBooking: false,
  codeExtension: null,
  confidenceFlag: null,
  importWarnings: null,
  guestCountEstimate: null,
}

const EMPTY_PROGRESSION: ProgressionAnchors = {
  tourBookedAt: null,
  tourAttendedAt: null,
  contractSignedAt: null,
  lastEventType: null,
  lastEventAt: null,
  count: 0,
}

// ---------------------------------------------------------------------------
// The mirror seam
// ---------------------------------------------------------------------------

/**
 * The per-wedding attributes with no spine column, for the weddings the
 * spine points at. Never throws: a failure here costs chips and a stage
 * hint, not rows.
 *
 * Exported so the seam is testable on its own and so an audit can find
 * every mirror read by finding this function's callers.
 */
export async function loadMirrorAttributes(
  supabase: SupabaseClient,
  venueIds: string[],
  weddingIds: string[],
): Promise<{ byWedding: Map<string, MirrorAttributes>; ok: boolean }> {
  const byWedding = new Map<string, MirrorAttributes>()
  if (weddingIds.length === 0 || venueIds.length === 0) {
    return { byWedding, ok: true }
  }
  let ok = true
  for (const slice of chunk(weddingIds, IN_CHUNK)) {
    try {
      const { data, error } = await supabase
        // The one mirror seam. See MIRROR_COLUMNS for the per-column
        // reason and canonical.ts loadCoupleJourney for the precedent.
        .from('weddings')
        .select(
          'id, status, booked_at, lifecycle_stage, lifecycle_stage_set_at, code_extension, confidence_flag, import_warnings, guest_count_estimate',
        )
        .in('id', slice)
        .in('venue_id', venueIds)
      if (error) {
        ok = false
        continue
      }
      for (const raw of (data ?? []) as RawMirrorRow[]) {
        const warnings = Array.isArray(raw.import_warnings)
          ? (raw.import_warnings as ImportWarning[])
          : null
        byWedding.set(raw.id, {
          machineStage: (raw.lifecycle_stage as LifecycleStage | null) ?? null,
          machineStageSetAt: raw.lifecycle_stage_set_at ?? null,
          hasBooking:
            Boolean(raw.booked_at) || raw.status?.toLowerCase() === 'booked',
          codeExtension: raw.code_extension ?? null,
          confidenceFlag: raw.confidence_flag ?? null,
          importWarnings: warnings,
          guestCountEstimate: raw.guest_count_estimate ?? null,
        })
      }
    } catch {
      ok = false
    }
  }
  return { byWedding, ok }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * Every couple on the spine for these venues, with the facts both lead
 * surfaces render. Venue-scoped, merged-away couples excluded (they are
 * tombstones — the pointer, not the couple).
 *
 * Honest-empty on no venues. Never throws: a failed sub-read degrades one
 * field and says so in `warnings`, because a board that renders nothing
 * because the heat view was slow is the bug this wave exists to remove.
 */
export async function loadLeadBoard(
  supabase: SupabaseClient,
  venueIds: string[],
  now: number = Date.now(),
): Promise<LeadBoardResult> {
  const generatedAt = new Date(now).toISOString()
  const warnings: string[] = []
  if (venueIds.length === 0) {
    return {
      rows: [],
      venueIds: [],
      heatAvailable: true,
      unattachedFragments: null,
      truncated: false,
      warnings: [],
      generatedAt,
    }
  }

  // ---- 1. The row set: couples ------------------------------------------
  const { data: coupleData, error: coupleError } = await supabase
    .from('couples')
    .select(
      'id, venue_id, primary_contact_name, partner_contact_name, lifecycle_state, channel_scope, wedding_date, heat_score, last_progression_at, decay_window_days, source_wedding_id, merged_into_id, first_seen_at, point_zero_at',
    )
    .in('venue_id', venueIds)
    .is('merged_into_id', null)
    .limit(COUPLE_LIMIT)

  if (coupleError) {
    return {
      rows: [],
      venueIds,
      heatAvailable: false,
      unattachedFragments: null,
      truncated: false,
      warnings: [`Could not read couples: ${coupleError.message}`],
      generatedAt,
    }
  }
  const couples = (coupleData ?? []) as RawCoupleRow[]
  const truncated = couples.length >= COUPLE_LIMIT
  if (truncated) {
    warnings.push(
      `Showing the first ${COUPLE_LIMIT} couples. This venue has more than one board can hold.`,
    )
  }
  const coupleIds = couples.map((c) => c.id)

  // ---- 2. Touchpoints: first channel, last signal, heat ------------------
  const tpByCouple = new Map<
    string,
    { first: RawTouchpointRow; last: RawTouchpointRow; heat: HeatTouchpoint[] }
  >()
  let heatAvailable = true
  {
    const { data, error } = await supabase
      .from('touchpoints')
      .select('couple_id, channel, action_type, signal_tier, occurred_at')
      .in('venue_id', venueIds)
      .not('couple_id', 'is', null)
      .order('occurred_at', { ascending: false })
      .limit(TOUCHPOINT_LIMIT)
    if (error) {
      // Heat is unknown for this batch, not zero. Every surface reading
      // this must say so rather than draw a confident cold badge.
      heatAvailable = false
      warnings.push(
        'Could not read the touchpoint ribbon, so interest levels are unknown rather than cold.',
      )
    } else {
      for (const t of (data ?? []) as RawTouchpointRow[]) {
        if (!t.couple_id) continue
        const bucket = tpByCouple.get(t.couple_id)
        if (!bucket) {
          tpByCouple.set(t.couple_id, { first: t, last: t, heat: [t] })
          continue
        }
        // Rows arrive newest-first, so the first row per couple is the
        // latest and every later row is older than the running first.
        bucket.first = t
        bucket.heat.push(t)
      }
      if ((data ?? []).length >= TOUCHPOINT_LIMIT) {
        warnings.push(
          'The touchpoint read hit its cap, so the oldest signals are not counted in interest levels.',
        )
      }
    }
  }

  // ---- 3. Progression anchors -------------------------------------------
  const progByCouple = new Map<string, ProgressionAnchors>()
  if (coupleIds.length > 0) {
    for (const slice of chunk(coupleIds, IN_CHUNK)) {
      const { data, error } = await supabase
        .from('couple_progression_events')
        .select('couple_id, event_type, occurred_at')
        .in('couple_id', slice)
        .order('occurred_at', { ascending: false })
        .limit(PROGRESSION_LIMIT)
      if (error) {
        warnings.push(
          'Could not read progression events, so couples without a pipeline stage are placed on their record state alone.',
        )
        break
      }
      for (const row of (data ?? []) as RawProgressionRow[]) {
        const existing = progByCouple.get(row.couple_id) ?? { ...EMPTY_PROGRESSION }
        existing.count += 1
        // Newest first, so the first sighting of each kind is the latest.
        if (!existing.lastEventAt) {
          existing.lastEventAt = row.occurred_at
          existing.lastEventType = row.event_type
        }
        if (
          (row.event_type === 'tour_booked' || row.event_type === 'tour_rescheduled') &&
          !existing.tourBookedAt
        ) {
          existing.tourBookedAt = row.occurred_at
        }
        if (row.event_type === 'tour_attended' && !existing.tourAttendedAt) {
          existing.tourAttendedAt = row.occurred_at
        }
        if (row.event_type === 'contract_signed' && !existing.contractSignedAt) {
          existing.contractSignedAt = row.occurred_at
        }
        progByCouple.set(row.couple_id, existing)
      }
    }
  }

  // ---- 4. Fragments: what never attached to anybody ----------------------
  let unattachedFragments: number | null = null
  {
    const { count, error } = await supabase
      .from('fragments')
      .select('id', { count: 'exact', head: true })
      .in('venue_id', venueIds)
      .is('promoted_to_couple_id', null)
    if (!error) unattachedFragments = count ?? 0
  }

  // ---- 5. Venue names ----------------------------------------------------
  const venueNames = new Map<string, string>()
  {
    const { data } = await supabase.from('venues').select('id, name').in('id', venueIds)
    for (const v of (data ?? []) as Array<{ id: string; name: string | null }>) {
      if (v.name) venueNames.set(v.id, v.name)
    }
  }

  // ---- 6. The mirror seam ------------------------------------------------
  const weddingIds = couples
    .map((c) => c.source_wedding_id)
    .filter((id): id is string => Boolean(id))
  const { byWedding: mirror, ok: mirrorOk } = await loadMirrorAttributes(
    supabase,
    venueIds,
    weddingIds,
  )
  if (!mirrorOk) {
    warnings.push(
      'Some pipeline stages could not be read, so those couples are placed on their record and their inbound history alone.',
    )
  }

  // ---- 7. Client codes ---------------------------------------------------
  const codeByWedding = new Map<string, string>()
  for (const slice of chunk(weddingIds, IN_CHUNK)) {
    const { data } = await supabase
      .from('client_codes')
      .select('wedding_id, code')
      .in('wedding_id', slice)
    for (const row of (data ?? []) as Array<{ wedding_id: string; code: string }>) {
      if (!codeByWedding.has(row.wedding_id)) codeByWedding.set(row.wedding_id, row.code)
    }
  }

  // ---- 8. Assemble -------------------------------------------------------
  const rows: LeadBoardRow[] = couples.map((c) => {
    const tp = tpByCouple.get(c.id)
    const m = (c.source_wedding_id ? mirror.get(c.source_wedding_id) : null) ?? EMPTY_MIRROR
    const progression = progByCouple.get(c.id) ?? EMPTY_PROGRESSION
    return {
      coupleId: c.id,
      venueId: c.venue_id,
      venueName: venueNames.get(c.venue_id) ?? null,
      weddingId: c.source_wedding_id ?? null,
      names: coupleNames(c.primary_contact_name, c.partner_contact_name),
      primaryName: c.primary_contact_name ?? null,
      partnerName: c.partner_contact_name ?? null,
      lifecycleState: c.lifecycle_state ?? null,
      channelScope: c.channel_scope ?? null,
      weddingDate: c.wedding_date ?? null,
      lastProgressionAt: c.last_progression_at ?? null,
      decayWindowDays: c.decay_window_days ?? null,
      firstSeenAt: c.first_seen_at ?? tp?.first.occurred_at ?? null,
      pointZeroAt: c.point_zero_at ?? null,
      firstChannel: tp?.first.channel ?? c.channel_scope ?? null,
      lastSignal: tp
        ? {
            at: tp.last.occurred_at,
            channel: tp.last.channel,
            actionType: tp.last.action_type,
          }
        : null,
      touchpointCount: tp?.heat.length ?? 0,
      progression,
      heat: heatAvailable ? buildHeatWhy(tp?.heat ?? [], now) : null,
      clientCode: c.source_wedding_id
        ? codeByWedding.get(c.source_wedding_id) ?? null
        : null,
      machineStage: m.machineStage,
      machineStageSetAt: m.machineStageSetAt,
      hasBooking: m.hasBooking || c.lifecycle_state === 'booked',
      codeExtension: m.codeExtension,
      confidenceFlag: m.confidenceFlag,
      importWarnings: m.importWarnings,
      guestCountEstimate: m.guestCountEstimate,
    }
  })

  return {
    rows,
    venueIds,
    heatAvailable,
    unattachedFragments,
    truncated,
    warnings,
    generatedAt,
  }
}

/** Service-client wrapper, the same shape `getDailyList` uses. */
export async function getLeadBoard(venueIds: string[]): Promise<LeadBoardResult> {
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadLeadBoard(createServiceClient(), venueIds)
}
