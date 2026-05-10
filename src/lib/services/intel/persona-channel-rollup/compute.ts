/**
 * Wave 6B — persona × channel × revenue rollup compute service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6 closes the forensic loop: ROI per
 *     persona per channel reveals what aggregate-channel ROI hides)
 *   - bloom-wave4-5-6-master-plan.md (6B spec: read attribution_events.
 *     persona_overlay (mig 263) + marketing_spend_records (mig 263) +
 *     weddings.booking_value (mig 181); write persona_channel_rollups
 *     (mig 266))
 *   - bloom-phase-b-decisions.md (attribution_events is the source of
 *     truth for first-touch — Wave 6B only READS, never modifies)
 *   - feedback_parallel_stream_safety.md (Wave 6B does NOT touch
 *     attribution_events.role — that's Wave 7B's column; we read
 *     persona_overlay only)
 *
 * What this module does
 * ---------------------
 * For one venue, recompute the persona × channel × time-window rollup
 * across three windows (30d / 90d / 365d) in a single call. For each
 * (channel, persona_label) pair it sums spend, counts inquiries / tours /
 * bookings / losses, sums booked contract value, and derives CAC,
 * conversion%, ROI, payback months. Cohort-size threshold (n ≥ 10) is
 * enforced at write time — smaller cells get NULL'd numerics and the
 * n_too_small flag set so the dashboard cannot accidentally render a
 * misleading 50% conversion off a 2-wedding cohort.
 *
 * Why three windows in one call
 * -----------------------------
 * The dashboard's window selector (30d / 90d / 365d) needs all three
 * present at the same `computed_at` to compare. Computing them
 * separately leaves stale windows that look fresh; computing them
 * together keeps the matrix consistent.
 *
 * Idempotent
 * ----------
 * Re-running on unchanged data returns the same output. The unique
 * constraint on (venue, channel, persona_label, window_start,
 * window_end) lets the upsert REPLACE all numeric values + computed_at
 * without growing rows. This rollup is point-in-time, not cumulative.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { CANONICAL_CHANNELS } from '@/lib/services/marketing-spend'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComputePersonaChannelRollupsInput {
  venueId: string
  /**
   * Optional override for the primary window length. The compute always
   * runs three windows (30 / 90 / 365); when set, the primary window is
   * REPLACED with this value (the other two windows still compute at the
   * defaults).
   */
  windowDays?: number
  supabase?: SupabaseClient
}

export interface ComputePersonaChannelRollupsResult {
  ok: true
  venueId: string
  rolledUp: number
  cellsWritten: number
  windowsComputed: number[]
  diagnostics: {
    spendRowsScanned: number
    attributionEventsScanned: number
    weddingsScanned: number
    channels: number
    personas: number
  }
}

// ---------------------------------------------------------------------------
// Window math
// ---------------------------------------------------------------------------

const COHORT_SIZE_THRESHOLD = 10
const DEFAULT_WINDOWS = [30, 90, 365] as const

function isoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function windowBounds(windowDays: number): {
  startIso: string
  endIso: string
  startDate: string
  endDate: string
  startMs: number
  endMs: number
} {
  const endMs = Date.now()
  const startMs = endMs - windowDays * 86_400_000
  const startDate = isoDate(new Date(startMs))
  const endDate = isoDate(new Date(endMs))
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    startDate,
    endDate,
    startMs,
    endMs,
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface SpendRow {
  channel: string
  amount_cents: number
  spend_date: string
}

interface AttributionRow {
  wedding_id: string
  source_platform: string
  persona_overlay: { persona_label?: string } | null
  decided_at: string
}

interface WeddingRow {
  id: string
  status: string | null
  inquiry_date: string | null
  booked_at: string | null
  lost_at: string | null
  tour_date: string | null
  booking_value: number | null
}

async function loadSpend(
  supabase: SupabaseClient,
  venueId: string,
  startDate: string,
  endDate: string,
): Promise<SpendRow[]> {
  const { data, error } = await supabase
    .from('marketing_spend_records')
    .select('channel, amount_cents, spend_date')
    .eq('venue_id', venueId)
    .gte('spend_date', startDate)
    .lte('spend_date', endDate)
  if (error) {
    console.warn('[persona-channel-rollup] loadSpend failed', {
      venueId,
      error: error.message,
    })
    return []
  }
  return (data ?? []) as SpendRow[]
}

async function loadAttributionEvents(
  supabase: SupabaseClient,
  venueId: string,
  startIso: string,
  endIso: string,
): Promise<AttributionRow[]> {
  // First-touch attributions only — the cell credits the channel that
  // ACQUIRED the lead, not the nurture-bucket touchpoints. reverted_at
  // IS NULL filters out reversed rows. decided_at falls inside the
  // window.
  const { data, error } = await supabase
    .from('attribution_events')
    .select('wedding_id, source_platform, persona_overlay, decided_at')
    .eq('venue_id', venueId)
    .eq('is_first_touch', true)
    .is('reverted_at', null)
    .gte('decided_at', startIso)
    .lte('decided_at', endIso)
  if (error) {
    console.warn('[persona-channel-rollup] loadAttributionEvents failed', {
      venueId,
      error: error.message,
    })
    return []
  }
  return (data ?? []) as AttributionRow[]
}

const ID_BATCH_SIZE = 100

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}

async function loadWeddings(
  supabase: SupabaseClient,
  weddingIds: string[],
): Promise<Map<string, WeddingRow>> {
  if (weddingIds.length === 0) return new Map()
  const out = new Map<string, WeddingRow>()
  for (const batch of chunk(weddingIds, ID_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('weddings')
      .select(
        'id, status, inquiry_date, booked_at, lost_at, tour_date, booking_value',
      )
      .in('id', batch)
    if (error) {
      console.warn('[persona-channel-rollup] loadWeddings failed', {
        error: error.message,
      })
      continue
    }
    for (const row of (data ?? []) as WeddingRow[]) {
      out.set(row.id, row)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Channel normalisation
// ---------------------------------------------------------------------------
//
// attribution_events.source_platform vocabulary mostly overlaps with
// marketing_spend_records.channel but isn't identical (e.g. attribution
// uses 'theknot' while spend uses 'theknot_fee'; attribution uses
// 'instagram' while spend uses 'meta_ads'). Map to a unified vocabulary
// so the cell join is consistent.
//
// Wave 6B intentionally keeps this mapping permissive — when a platform
// string doesn't map cleanly we keep it verbatim so a new platform
// (Hitched, Bridebook) lands in the rollup as itself rather than
// disappearing into 'other'. Wave 7B's channel-role re-classification
// will refine this further.

function normaliseChannel(raw: string): string {
  if (!raw) return 'other'
  const lower = raw.trim().toLowerCase()
  // Attribution-side names → spend-side names (when there's a clear map).
  if (lower === 'theknot' || lower === 'the_knot') return 'theknot_fee'
  if (lower === 'weddingwire') return 'weddingwire_fee'
  if (lower === 'instagram' || lower === 'facebook' || lower === 'meta') {
    return 'meta_ads'
  }
  if (lower === 'tiktok') return 'tiktok_ads'
  if (lower === 'google' || lower === 'google_search') return 'google_ads'
  return lower
}

// ---------------------------------------------------------------------------
// Aggregation core
// ---------------------------------------------------------------------------

interface CellAccumulator {
  channel: string
  personaLabel: string | null
  spendCents: number
  inquiriesCount: number
  touringCount: number
  bookedCount: number
  lostCount: number
  totalBookedValueCents: number
}

function cellKey(channel: string, persona: string | null): string {
  return `${channel}::${persona ?? '__null__'}`
}

interface BuildCellsInput {
  spend: SpendRow[]
  attributions: AttributionRow[]
  weddings: Map<string, WeddingRow>
}

function buildCells(input: BuildCellsInput): Map<string, CellAccumulator> {
  const cells = new Map<string, CellAccumulator>()

  // Step 1: seed cells from attribution events. Each attribution credits
  // one (channel, persona) pair, and the wedding's status drives the
  // counters.
  for (const a of input.attributions) {
    const channel = normaliseChannel(a.source_platform)
    const persona = a.persona_overlay?.persona_label?.trim() || null
    const key = cellKey(channel, persona)
    let acc = cells.get(key)
    if (!acc) {
      acc = {
        channel,
        personaLabel: persona,
        spendCents: 0,
        inquiriesCount: 0,
        touringCount: 0,
        bookedCount: 0,
        lostCount: 0,
        totalBookedValueCents: 0,
      }
      cells.set(key, acc)
    }

    const wedding = input.weddings.get(a.wedding_id)
    if (!wedding) continue

    // Every attributed wedding counts as one inquiry for the cell.
    acc.inquiriesCount += 1

    const status = wedding.status ?? null
    if (
      status === 'tour_scheduled' ||
      status === 'tour_completed' ||
      status === 'proposal_sent'
    ) {
      acc.touringCount += 1
    }
    if (status === 'booked' || status === 'completed') {
      acc.bookedCount += 1
      const value = Number(wedding.booking_value ?? 0)
      if (Number.isFinite(value) && value > 0) {
        acc.totalBookedValueCents += Math.round(value)
      }
    }
    if (status === 'lost' || status === 'cancelled') {
      acc.lostCount += 1
    }
  }

  // Step 2: layer in spend per channel. Spend distributes across persona
  // cells in proportion to attribution share within the channel — same
  // approximation Wave 6A's summary endpoint uses, lifted into the
  // persistent rollup. Channels with spend but zero attributions roll
  // up under (channel, NULL) so the operator sees the un-attributed
  // spend rather than losing it.
  const spendByChannel = new Map<string, number>()
  for (const s of input.spend) {
    const norm = normaliseChannel(s.channel)
    spendByChannel.set(
      norm,
      (spendByChannel.get(norm) ?? 0) + (s.amount_cents || 0),
    )
  }

  for (const [channel, channelSpend] of spendByChannel.entries()) {
    // Find cells already created for this channel (from attribution).
    const channelCells: CellAccumulator[] = []
    for (const acc of cells.values()) {
      if (acc.channel === channel) channelCells.push(acc)
    }
    if (channelCells.length === 0) {
      // Spend with no attribution → un-attributed bucket.
      const key = cellKey(channel, null)
      cells.set(key, {
        channel,
        personaLabel: null,
        spendCents: channelSpend,
        inquiriesCount: 0,
        touringCount: 0,
        bookedCount: 0,
        lostCount: 0,
        totalBookedValueCents: 0,
      })
      continue
    }
    // Distribute spend by inquiry-share within the channel. Cells with
    // zero inquiries get an even split of the remainder so spend never
    // disappears.
    const totalInquiries = channelCells.reduce(
      (sum, c) => sum + c.inquiriesCount,
      0,
    )
    if (totalInquiries === 0) {
      const evenShare = channelSpend / channelCells.length
      for (const c of channelCells) {
        c.spendCents += Math.round(evenShare)
      }
      continue
    }
    let allocated = 0
    for (let i = 0; i < channelCells.length; i++) {
      const c = channelCells[i]
      const isLast = i === channelCells.length - 1
      const share = isLast
        ? channelSpend - allocated
        : Math.round((channelSpend * c.inquiriesCount) / totalInquiries)
      c.spendCents += share
      allocated += share
    }
  }

  return cells
}

// ---------------------------------------------------------------------------
// Derived metrics + cohort threshold
// ---------------------------------------------------------------------------

interface DerivedRow {
  venue_id: string
  channel: string
  persona_label: string | null
  time_window_start: string
  time_window_end: string
  spend_cents: number
  inquiries_count: number
  touring_count: number
  booked_count: number
  lost_count: number
  total_booked_value_cents: number
  cac_cents: number | null
  conversion_pct: number | null
  avg_booking_value_cents: number | null
  ltv_cents: number | null
  roi_pct: number | null
  payback_months: number | null
  n_too_small: boolean
  computed_at: string
}

function deriveRow(
  venueId: string,
  acc: CellAccumulator,
  windowDays: number,
  startDate: string,
  endDate: string,
  computedAt: string,
): DerivedRow {
  const cohortSize = acc.inquiriesCount + acc.bookedCount
  const tooSmall = cohortSize < COHORT_SIZE_THRESHOLD

  // Avg booking value is independent of cohort threshold — it's a
  // simple per-booking number that stands on its own. Suppressed only
  // when zero bookings.
  const avgBookingValueCents =
    acc.bookedCount > 0
      ? Math.round(acc.totalBookedValueCents / acc.bookedCount)
      : null

  // The remaining derived metrics are NULL'd when the cohort is too
  // small. This is the dashboard's safety net — render gray, never a
  // misleading number.
  let cacCents: number | null = null
  let conversionPct: number | null = null
  let roiPct: number | null = null
  let paybackMonths: number | null = null

  if (!tooSmall) {
    if (acc.bookedCount > 0) {
      cacCents = Math.round(acc.spendCents / acc.bookedCount)
    }
    if (acc.inquiriesCount > 0) {
      const pct = (acc.bookedCount / acc.inquiriesCount) * 100
      conversionPct = Math.round(pct * 100) / 100
    }
    if (acc.spendCents > 0) {
      const pct =
        ((acc.totalBookedValueCents - acc.spendCents) / acc.spendCents) * 100
      roiPct = Math.round(pct * 100) / 100
    }
    if (acc.spendCents > 0 && acc.totalBookedValueCents > 0) {
      const monthsInWindow = Math.max(1, windowDays / 30)
      const monthlyRevenue = acc.totalBookedValueCents / monthsInWindow
      if (monthlyRevenue > 0) {
        const months = acc.spendCents / monthlyRevenue
        paybackMonths = Math.round(months * 100) / 100
      }
    }
  }

  // LTV placeholder = avg_booking_value_cents until repeat-event
  // tracking lands. See migration 266 column comment for the upgrade
  // path.
  const ltvCents = avgBookingValueCents

  return {
    venue_id: venueId,
    channel: acc.channel,
    persona_label: acc.personaLabel,
    time_window_start: startDate,
    time_window_end: endDate,
    spend_cents: acc.spendCents,
    inquiries_count: acc.inquiriesCount,
    touring_count: acc.touringCount,
    booked_count: acc.bookedCount,
    lost_count: acc.lostCount,
    total_booked_value_cents: acc.totalBookedValueCents,
    cac_cents: cacCents,
    conversion_pct: conversionPct,
    avg_booking_value_cents: avgBookingValueCents,
    ltv_cents: ltvCents,
    roi_pct: roiPct,
    payback_months: paybackMonths,
    n_too_small: tooSmall,
    computed_at: computedAt,
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute persona × channel × revenue rollups for one venue across the
 * default three windows (30 / 90 / 365). Returns counts of cells
 * written. The unique constraint on
 * (venue, channel, persona, window_start, window_end) makes the upsert
 * point-in-time idempotent — re-running REPLACES all numerics + the
 * computed_at timestamp.
 */
export async function computePersonaChannelRollups(
  input: ComputePersonaChannelRollupsInput,
): Promise<ComputePersonaChannelRollupsResult> {
  const supabase = input.supabase ?? createServiceClient()
  const venueId = input.venueId

  // Build the window list. The default trio is (30, 90, 365). When a
  // caller passes windowDays, we replace the primary 90 with that value
  // so they can drill into a custom horizon while still keeping the
  // 30 + 365 reference windows.
  const windows: number[] = (() => {
    if (typeof input.windowDays === 'number' && input.windowDays > 0) {
      const days = Math.min(Math.floor(input.windowDays), 1000)
      const trio = new Set<number>([days, 30, 365])
      return Array.from(trio).sort((a, b) => a - b)
    }
    return Array.from(DEFAULT_WINDOWS)
  })()

  const computedAt = new Date().toISOString()

  let totalCellsWritten = 0
  let totalRolledUp = 0
  const diagnostics = {
    spendRowsScanned: 0,
    attributionEventsScanned: 0,
    weddingsScanned: 0,
    channels: 0,
    personas: 0,
  }
  const channelsSeen = new Set<string>()
  const personasSeen = new Set<string>()

  for (const windowDays of windows) {
    const bounds = windowBounds(windowDays)

    // Load all three sources for this window.
    const [spend, attributions] = await Promise.all([
      loadSpend(supabase, venueId, bounds.startDate, bounds.endDate),
      loadAttributionEvents(supabase, venueId, bounds.startIso, bounds.endIso),
    ])
    diagnostics.spendRowsScanned += spend.length
    diagnostics.attributionEventsScanned += attributions.length

    const weddingIds = Array.from(
      new Set(attributions.map((a) => a.wedding_id).filter(Boolean)),
    )
    const weddings = await loadWeddings(supabase, weddingIds)
    diagnostics.weddingsScanned += weddings.size

    const cells = buildCells({ spend, attributions, weddings })
    totalRolledUp += cells.size

    for (const acc of cells.values()) {
      channelsSeen.add(acc.channel)
      if (acc.personaLabel) personasSeen.add(acc.personaLabel)
    }

    // If the window has zero cells, skip the upsert — there's nothing
    // to write. (Don't insert empty placeholder rows; the dashboard
    // can render a "no rollup yet" empty state on read.)
    if (cells.size === 0) continue

    const rows: DerivedRow[] = []
    for (const acc of cells.values()) {
      rows.push(
        deriveRow(
          venueId,
          acc,
          windowDays,
          bounds.startDate,
          bounds.endDate,
          computedAt,
        ),
      )
    }

    // Idempotent write strategy: delete the existing (venue, window)
    // cell set, then insert the new rows. Cannot use plain upsert here
    // because the unique index uses COALESCE(persona_label, '') and
    // PostgreSQL won't accept an expression-on-COALESCE as an
    // ON CONFLICT target — so a stable PostgREST upsert is impossible.
    // Delete-then-insert reaches the same final state and remains
    // idempotent: re-running on unchanged data lands the same rows.
    // Wrapped in best-effort error handling per window so a single
    // failed window doesn't abort the rest.
    const { error: delErr } = await supabase
      .from('persona_channel_rollups')
      .delete()
      .eq('venue_id', venueId)
      .eq('time_window_start', bounds.startDate)
      .eq('time_window_end', bounds.endDate)
    if (delErr) {
      console.warn('[persona-channel-rollup] delete failed', {
        venueId,
        windowDays,
        error: delErr.message,
      })
      continue
    }
    const { error: insertErr } = await supabase
      .from('persona_channel_rollups')
      .insert(rows)
    if (insertErr) {
      console.warn('[persona-channel-rollup] insert failed', {
        venueId,
        windowDays,
        error: insertErr.message,
      })
      continue
    }

    totalCellsWritten += rows.length
  }

  diagnostics.channels = channelsSeen.size
  diagnostics.personas = personasSeen.size

  // Reference CANONICAL_CHANNELS to keep the import alive — used for
  // future-proofing the channel-vocabulary contract with Wave 6A.
  void CANONICAL_CHANNELS

  return {
    ok: true,
    venueId,
    rolledUp: totalRolledUp,
    cellsWritten: totalCellsWritten,
    windowsComputed: windows,
    diagnostics,
  }
}
