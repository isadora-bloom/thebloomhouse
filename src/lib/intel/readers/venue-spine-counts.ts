/**
 * Per-venue counts, read off the identity spine (W63, wave 9).
 *
 * The four coordinator surfaces this wave migrates all wanted the same
 * shape of answer and all derived it differently:
 *
 *   - /dashboard counted `weddings` by `status`, once for the stat tiles
 *     and again per venue for the breakdown table.
 *   - /super-admin/pipeline-health counted inbound `interactions` in a
 *     24-hour window, then again for the prior 24 hours to draw a delta.
 *
 * Both questions are spine questions. `couples.lifecycle_state` is what
 * a wedding's `status` became, and `touchpoints` is what `interactions`
 * became, so the counts live here and every caller gets the same number.
 *
 * Three readers, each SPINE-ONLY (`couples` + `touchpoints`, nothing
 * from the legacy stack) and each with an injectable client so the unit
 * test drives it with a fake Supabase and no database anywhere near it.
 * The exported `get*` wrappers add the service client, matching the
 * shape of `loadDailyList` / `getDailyList` in canonical.ts.
 *
 * Every count excludes merged-away couples (`merged_into_id IS NULL`),
 * consistent with `getVenueOverview` and `getDailyList`. A merged couple
 * is a tombstone, not a second couple.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { LifecycleState } from '@/lib/intel/canonical'

/** Hard cap on any single spine fetch. A venue past this is reading a
 *  truncated answer, and every result below says so rather than quietly
 *  under-counting. */
const ROW_FETCH_LIMIT = 20000

/** The channels that carry a message someone actually wrote — the spine
 *  equivalent of `interactions.type = 'email'`. Calendly bookings and
 *  web-form pings land on `touchpoints` too, and counting them as email
 *  would inflate every ingestion number on the operator dashboards. */
export const MESSAGE_CHANNELS: readonly string[] = [
  'gmail',
  'knot',
  'weddingwire',
  'zola',
  'sms',
] as const

const ZERO_LIFECYCLE: Record<LifecycleState, number> = {
  channel_scoped: 0,
  resolved: 0,
  booked: 0,
  completed: 0,
  ghost: 0,
  agent: 0,
}

// ─────────────────────────────────────────────────────────────────────
// 1. Couples per venue, by lifecycle
// ─────────────────────────────────────────────────────────────────────

export interface VenueCoupleCounts {
  venueId: string
  total: number
  byLifecycle: Record<LifecycleState, number>
}

export interface VenueCoupleCountsResult {
  byVenue: VenueCoupleCounts[]
  /** True when the fetch hit `ROW_FETCH_LIMIT`, so the counts are a
   *  floor rather than a total. Surfaces on the page. */
  truncated: boolean
  generatedAt: string
}

/**
 * Couples per venue, split by lifecycle state. Replaces /dashboard's
 * per-venue `weddings` aggregate: one read for every venue in scope
 * instead of one query per venue, and the same lifecycle vocabulary the
 * rest of the app already uses.
 */
export async function loadVenueCoupleCounts(
  supabase: SupabaseClient,
  venueIds: string[],
): Promise<VenueCoupleCountsResult> {
  const generatedAt = new Date().toISOString()
  if (venueIds.length === 0) return { byVenue: [], truncated: false, generatedAt }

  const { data, error } = await supabase
    .from('couples')
    .select('venue_id, lifecycle_state')
    .in('venue_id', venueIds)
    .is('merged_into_id', null)
    .limit(ROW_FETCH_LIMIT)
  if (error) throw new Error(`loadVenueCoupleCounts: couples ${error.message}`)

  const rows = (data ?? []) as Array<{ venue_id: string; lifecycle_state: string }>
  const byVenue = new Map<string, VenueCoupleCounts>()
  for (const id of venueIds) {
    byVenue.set(id, { venueId: id, total: 0, byLifecycle: { ...ZERO_LIFECYCLE } })
  }
  for (const row of rows) {
    const entry = byVenue.get(row.venue_id)
    if (!entry) continue
    entry.total += 1
    const state = row.lifecycle_state as LifecycleState
    if (state in entry.byLifecycle) entry.byLifecycle[state] += 1
  }

  return {
    byVenue: [...byVenue.values()],
    truncated: rows.length >= ROW_FETCH_LIMIT,
    generatedAt,
  }
}

export async function getVenueCoupleCounts(
  venueIds: string[],
): Promise<VenueCoupleCountsResult> {
  if (venueIds.length === 0) {
    return { byVenue: [], truncated: false, generatedAt: new Date().toISOString() }
  }
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadVenueCoupleCounts(createServiceClient(), venueIds)
}

// ─────────────────────────────────────────────────────────────────────
// 2. Weddings coming up
// ─────────────────────────────────────────────────────────────────────

export interface UpcomingWeddingCounts {
  /** Couples with a wedding date inside the window. */
  count: number
  /** The window the count was taken over, echoed back so the page can
   *  say what "upcoming" means rather than assuming the reader knows. */
  fromDate: string
  toDate: string
  generatedAt: string
}

/**
 * Couples whose wedding date falls inside `[fromDate, toDate]`.
 * `couples.wedding_date` is the spine's own date column (migration 346),
 * so this needs nothing from `weddings`.
 *
 * Dates in, dates out: both bounds are `YYYY-MM-DD`, matching the column
 * type. Booked and completed couples both count, because a wedding on
 * the books is a wedding on the books whatever the record says about the
 * paperwork.
 */
export async function loadUpcomingWeddings(
  supabase: SupabaseClient,
  venueIds: string[],
  fromDate: string,
  toDate: string,
): Promise<UpcomingWeddingCounts> {
  const generatedAt = new Date().toISOString()
  if (venueIds.length === 0) return { count: 0, fromDate, toDate, generatedAt }

  const { data, error } = await supabase
    .from('couples')
    .select('id, wedding_date')
    .in('venue_id', venueIds)
    .is('merged_into_id', null)
    .gte('wedding_date', fromDate)
    .lte('wedding_date', toDate)
    .limit(ROW_FETCH_LIMIT)
  if (error) throw new Error(`loadUpcomingWeddings: couples ${error.message}`)

  return { count: (data ?? []).length, fromDate, toDate, generatedAt }
}

export async function getUpcomingWeddings(
  venueIds: string[],
  fromDate: string,
  toDate: string,
): Promise<UpcomingWeddingCounts> {
  if (venueIds.length === 0) {
    return { count: 0, fromDate, toDate, generatedAt: new Date().toISOString() }
  }
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadUpcomingWeddings(createServiceClient(), venueIds, fromDate, toDate)
}

// ─────────────────────────────────────────────────────────────────────
// 3. Inbound message volume, windowed — the platform-health headline
// ─────────────────────────────────────────────────────────────────────

export interface InboundWindowCounts {
  /** Inbound messages inside the window. */
  current: number
  /** Inbound messages in the window immediately before it, same length.
   *  Null when no prior window was asked for. */
  prior: number | null
  /**
   * Messages in either window whose direction was never stamped.
   * Migration 381 stamps `touchpoints.direction` at write time and bans
   * inferring it at read time, so these are reported rather than guessed
   * into one side or the other.
   */
  unknownDirection: number
  /** Per-venue split of `current`, so the super-admin view can say which
   *  venue stopped ingesting rather than only that the total fell. */
  currentByVenue: Record<string, number>
  truncated: boolean
  generatedAt: string
}

export interface InboundWindowOpts {
  /** ISO timestamp — start of the window being reported. */
  fromIso: string
  /** ISO timestamp — end of that window. */
  toIso: string
  /** ISO timestamp — start of the comparison window. Its end is
   *  `fromIso`. Omit for no comparison. */
  priorFromIso?: string | null
  /** Restrict to these venues. Empty = every venue the client can see,
   *  which is what the super-admin surface wants. */
  venueIds?: string[] | null
}

/**
 * Inbound messages in a window, and in the window before it.
 *
 * Replaces /super-admin/pipeline-health's two `interactions` head-counts.
 * The spine equivalent is `touchpoints` filtered to the message channels
 * with `direction = 'inbound'` — the column migration 381 added and the
 * forwards-linker stamps, so nothing here infers a direction from an
 * action type.
 *
 * `occurred_at` is the event date, never `created_at`: a backfill that
 * imported six months of mail last night must not read as six months of
 * mail arriving last night.
 */
export async function loadInboundWindowCounts(
  supabase: SupabaseClient,
  opts: InboundWindowOpts,
): Promise<InboundWindowCounts> {
  const generatedAt = new Date().toISOString()
  const earliest = opts.priorFromIso ?? opts.fromIso

  let query = supabase
    .from('touchpoints')
    .select('venue_id, direction, occurred_at')
    .in('channel', [...MESSAGE_CHANNELS])
    .gte('occurred_at', earliest)
    .lt('occurred_at', opts.toIso)
    .limit(ROW_FETCH_LIMIT)
  if (opts.venueIds && opts.venueIds.length > 0) {
    query = query.in('venue_id', opts.venueIds)
  }

  const { data, error } = await query
  if (error) throw new Error(`loadInboundWindowCounts: touchpoints ${error.message}`)

  const rows = (data ?? []) as Array<{
    venue_id: string
    direction: string | null
    occurred_at: string
  }>

  let current = 0
  let prior = opts.priorFromIso ? 0 : null
  let unknownDirection = 0
  const currentByVenue: Record<string, number> = {}

  for (const row of rows) {
    if (row.direction === null || row.direction === undefined) {
      unknownDirection += 1
      continue
    }
    if (row.direction !== 'inbound') continue
    if (row.occurred_at >= opts.fromIso) {
      current += 1
      currentByVenue[row.venue_id] = (currentByVenue[row.venue_id] ?? 0) + 1
    } else if (prior !== null) {
      prior += 1
    }
  }

  return {
    current,
    prior,
    unknownDirection,
    currentByVenue,
    truncated: rows.length >= ROW_FETCH_LIMIT,
    generatedAt,
  }
}

export async function getInboundWindowCounts(
  opts: InboundWindowOpts,
): Promise<InboundWindowCounts> {
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadInboundWindowCounts(createServiceClient(), opts)
}
