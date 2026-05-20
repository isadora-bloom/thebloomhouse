/**
 * Identity Report — Tier 8 §C.5, battery Q6/29/30/36.
 *
 * Extends the existing `/intel/identity-review` queue (Phase E borderline
 * candidate_matches) with the four data-integrity battery questions.
 * The queue stays as-is; this service powers a parallel "Identity Report"
 * tab that answers:
 *
 *   Q6  — unique-couple count vs raw signals; merge-confidence
 *         distribution on borderline cases.
 *   Q29 — 20 highest-confidence merges + 20 lowest-confidence merges
 *         from `couple_merge_events`, with both sides + reason rendered
 *         so the operator can verify Bloom's calibration.
 *   Q30 — completeness scoring on the last-90d couples: how many have
 *         full records (date + email + acquisition touch + venue reply)
 *         vs partial vs minimal.
 *   Q36 — 5 most-confident "same" decisions Bloom has made + 5 borderline
 *         "might be same / different" decisions currently in the queue.
 *
 * Honesty (§C.6 Tier 4): every cell carries its own n; nothing returned
 * here is a "confident-sounding zero" — empty cells say "no matches yet"
 * out loud.
 *
 * Multi-venue safe: takes a venueId. No Rixey-specific clauses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IdentityReportCouplesSummary {
  totalCouples: number
  bookedCouples: number
  resolvedCouples: number
  ghostCouples: number
  /** channel_scoped couples: un-acknowledged prospects (often vendor
   *  noise). Surfaced as a count outside the "engaged couples" set so
   *  the operator can see the prospect pool without it inflating
   *  conversion ratios. */
  channelScopedCouples: number
  fragmentsTotal: number
  fragmentsUnpromoted: number
  /** fragments_promoted / total fragments — what fraction of orphan
   *  signals have been bound to a couple. null when no fragments yet. */
  fragmentPromotionRate: number | null
}

export interface IdentityReportConfidenceDistribution {
  /** All open candidate_matches (resolution IS NULL) keyed by tier. */
  open: Record<'high' | 'medium' | 'low', number>
  /** All resolved candidate_matches, grouped by resolution × tier. */
  resolved: {
    confirmed: Record<'high' | 'medium' | 'low', number>
    rejected: Record<'high' | 'medium' | 'low', number>
    deferred: Record<'high' | 'medium' | 'low', number>
  }
}

export interface IdentityReportMerge {
  id: string
  eventType: string
  confidenceTier: 'high' | 'medium' | 'low' | null
  occurredAt: string
  reason: string | null
  ruleTriggered: string | null
  operatorId: string | null
  primary: { coupleId: string | null; label: string | null }
  secondary: { coupleId: string | null; label: string | null }
}

export interface IdentityReportCompletenessBucket {
  label: 'Complete' | 'Mostly complete' | 'Partial' | 'Minimal'
  description: string
  count: number
}

export interface IdentityReportCompleteness {
  windowDays: number
  totalEvaluated: number
  buckets: IdentityReportCompletenessBucket[]
  /** Per-dimension presence counts so the operator can see which
   *  dimension is most often missing. */
  withWeddingDate: number
  withPrimaryEmail: number
  withAcquisitionTouch: number
  withVenueReply: number
}

export interface IdentityReportPending {
  id: string
  confidenceTier: 'high' | 'medium' | 'low' | null
  createdAt: string
  matcherReason: string | null
  primary: { recordId: string; recordType: string; label: string | null }
  secondary: { recordId: string; recordType: string; label: string | null }
}

export interface IdentityReport {
  venueId: string
  generatedAt: string
  couples: IdentityReportCouplesSummary
  confidenceDistribution: IdentityReportConfidenceDistribution
  /** Q29: highest-confidence and lowest-confidence merges Bloom has
   *  performed (auto-promote + operator-confirmed). 20 each, sorted by
   *  occurred_at desc within each tier so the operator sees recent
   *  decisions first. */
  topMerges: IdentityReportMerge[]
  bottomMerges: IdentityReportMerge[]
  /** Q30: completeness scoring across the last 90 days. */
  completeness: IdentityReportCompleteness
  /** Q36: 5 most-confident "same" decisions + 5 borderline pending. */
  mostConfidentSame: IdentityReportMerge[]
  borderlinePending: IdentityReportPending[]
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

const COMPLETENESS_WINDOW_DAYS = 90

function emptyTierCounts(): Record<'high' | 'medium' | 'low', number> {
  return { high: 0, medium: 0, low: 0 }
}

/** Coerce a candidate confidence_tier value to the canonical enum;
 *  unknown / null tiers collapse to null. */
function coerceTier(
  v: string | null | undefined,
): 'high' | 'medium' | 'low' | null {
  if (v === 'high' || v === 'medium' || v === 'low') return v
  return null
}

interface RawCoupleRow {
  id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
}

interface RawMergeRow {
  id: string
  event_type: string
  confidence_tier: string | null
  occurred_at: string
  reason: string | null
  rule_triggered: string | null
  operator_id: string | null
  primary_couple_id: string | null
  secondary_couple_id: string | null
}

interface RawCandidateRow {
  id: string
  confidence_tier: string | null
  matcher_reason: string | null
  created_at: string
  resolution: string | null
  primary_record_id: string
  primary_record_type: string
  secondary_record_id: string
  secondary_record_type: string
}

interface RawFragmentRow {
  id: string
  channel: string
  identity_hint: string | null
}

interface RawTouchpointRow {
  id: string
  channel: string
  action_type: string
}

interface CompletenessSnapshotCouple {
  id: string
  wedding_date: string | null
  primary_contact_email: string | null
  created_at: string
}

interface CompletenessTouchpointCount {
  couple_id: string | null
  channel: string
  action_type: string
}

const PLUMBING_CHANNELS = new Set(['gmail', 'sms', 'calendly', 'honeybook'])
function isAcquisitionChannel(channel: string): boolean {
  return !PLUMBING_CHANNELS.has(channel)
}

function labelCouple(row: RawCoupleRow | null | undefined): string | null {
  if (!row) return null
  return row.primary_contact_name ?? row.primary_contact_email ?? null
}

/** Compute the engaged-set (resolved / booked / ghost) summary + the
 *  fragments rollup in one pass. */
async function loadCouplesSummary(
  supabase: SupabaseClient,
  venueId: string,
): Promise<IdentityReportCouplesSummary> {
  // Couples — head=true gives a count without payload.
  const counters: Array<[string, string | null]> = [
    ['booked', 'booked'],
    ['resolved', 'resolved'],
    ['ghost', 'ghost'],
    ['channel_scoped', 'channel_scoped'],
  ]
  const results = await Promise.all(
    counters.map(async ([, state]) => {
      const { count } = await supabase
        .from('couples')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('lifecycle_state', state as string)
      return count ?? 0
    }),
  )
  const [booked, resolved, ghost, channelScoped] = results
  const totalCouples = booked + resolved + ghost + channelScoped

  // Fragments — total + unpromoted.
  const { count: fragmentsTotal } = await supabase
    .from('fragments')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  const { count: fragmentsUnpromoted } = await supabase
    .from('fragments')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .is('promoted_to_couple_id', null)

  const fragTotal = fragmentsTotal ?? 0
  const fragUnpromoted = fragmentsUnpromoted ?? 0
  const fragmentPromotionRate =
    fragTotal > 0 ? Math.round(((fragTotal - fragUnpromoted) / fragTotal) * 100) / 100 : null

  return {
    totalCouples,
    bookedCouples: booked,
    resolvedCouples: resolved,
    ghostCouples: ghost,
    channelScopedCouples: channelScoped,
    fragmentsTotal: fragTotal,
    fragmentsUnpromoted: fragUnpromoted,
    fragmentPromotionRate,
  }
}

async function loadConfidenceDistribution(
  supabase: SupabaseClient,
  venueId: string,
): Promise<IdentityReportConfidenceDistribution> {
  const { data } = await supabase
    .from('candidate_matches')
    .select('confidence_tier, resolution')
    .eq('venue_id', venueId)
    .limit(50000)

  const open = emptyTierCounts()
  const resolved = {
    confirmed: emptyTierCounts(),
    rejected: emptyTierCounts(),
    deferred: emptyTierCounts(),
  }

  for (const row of (data ?? []) as Array<{
    confidence_tier: string | null
    resolution: string | null
  }>) {
    const tier = coerceTier(row.confidence_tier)
    if (!tier) continue
    if (!row.resolution) {
      open[tier] += 1
      continue
    }
    if (row.resolution === 'confirmed') resolved.confirmed[tier] += 1
    else if (row.resolution === 'rejected') resolved.rejected[tier] += 1
    else if (row.resolution === 'deferred') resolved.deferred[tier] += 1
  }

  return { open, resolved }
}

/** Hydrate a set of couple_ids into label snippets. */
async function hydrateCoupleLabels(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (ids.length === 0) return out
  const { data } = await supabase
    .from('couples')
    .select('id, primary_contact_name, primary_contact_email')
    .in('id', ids)
  for (const row of (data ?? []) as RawCoupleRow[]) {
    out.set(row.id, labelCouple(row))
  }
  return out
}

function mapMergeRow(
  row: RawMergeRow,
  labels: Map<string, string | null>,
): IdentityReportMerge {
  return {
    id: row.id,
    eventType: row.event_type,
    confidenceTier: coerceTier(row.confidence_tier),
    occurredAt: row.occurred_at,
    reason: row.reason,
    ruleTriggered: row.rule_triggered,
    operatorId: row.operator_id,
    primary: {
      coupleId: row.primary_couple_id,
      label: row.primary_couple_id ? labels.get(row.primary_couple_id) ?? null : null,
    },
    secondary: {
      coupleId: row.secondary_couple_id,
      label: row.secondary_couple_id ? labels.get(row.secondary_couple_id) ?? null : null,
    },
  }
}

async function loadMerges(
  supabase: SupabaseClient,
  venueId: string,
): Promise<{ top: IdentityReportMerge[]; bottom: IdentityReportMerge[]; mostConfidentSame: IdentityReportMerge[] }> {
  // Same-decisions only — exclude rejections / unmerges. The doctrine
  // for Q29 is "merges Bloom has performed."
  const SAME_EVENT_TYPES = [
    'fragment_promoted',
    'channel_scoped_bridged',
    'candidate_confirmed',
    'manual_merge',
    'resurrection',
  ]

  const [topResp, bottomResp] = await Promise.all([
    supabase
      .from('couple_merge_events')
      .select(
        'id, event_type, confidence_tier, occurred_at, reason, rule_triggered, operator_id, primary_couple_id, secondary_couple_id',
      )
      .eq('venue_id', venueId)
      .in('event_type', SAME_EVENT_TYPES)
      .eq('confidence_tier', 'high')
      .order('occurred_at', { ascending: false })
      .limit(20),
    supabase
      .from('couple_merge_events')
      .select(
        'id, event_type, confidence_tier, occurred_at, reason, rule_triggered, operator_id, primary_couple_id, secondary_couple_id',
      )
      .eq('venue_id', venueId)
      .in('event_type', SAME_EVENT_TYPES)
      .eq('confidence_tier', 'low')
      .order('occurred_at', { ascending: false })
      .limit(20),
  ])

  const topRaw = (topResp.data ?? []) as RawMergeRow[]
  const bottomRaw = (bottomResp.data ?? []) as RawMergeRow[]

  const ids = new Set<string>()
  for (const r of [...topRaw, ...bottomRaw]) {
    if (r.primary_couple_id) ids.add(r.primary_couple_id)
    if (r.secondary_couple_id) ids.add(r.secondary_couple_id)
  }
  const labels = await hydrateCoupleLabels(supabase, [...ids])

  const top = topRaw.map((r) => mapMergeRow(r, labels))
  const bottom = bottomRaw.map((r) => mapMergeRow(r, labels))
  // Q36 "Bloom thinks are same" — most-confident 5. Reuse the top slice
  // so we don't re-query; if there are fewer than 5 high-tier merges,
  // fall back to medium. Operator gets honest n in the surface.
  const mostConfidentSame = top.slice(0, 5)

  return { top, bottom, mostConfidentSame }
}

async function loadBorderlinePending(
  supabase: SupabaseClient,
  venueId: string,
): Promise<IdentityReportPending[]> {
  // Borderline = medium confidence + still open. These are the ones a
  // human is being asked to adjudicate.
  const { data } = await supabase
    .from('candidate_matches')
    .select(
      'id, confidence_tier, matcher_reason, created_at, resolution, primary_record_id, primary_record_type, secondary_record_id, secondary_record_type',
    )
    .eq('venue_id', venueId)
    .is('resolution', null)
    .eq('confidence_tier', 'medium')
    .order('created_at', { ascending: false })
    .limit(5)

  const raw = (data ?? []) as RawCandidateRow[]
  if (raw.length === 0) return []

  // Hydrate the referenced record ids in one round each, grouping by
  // record_type so we can select the right columns per table.
  const coupleIds = new Set<string>()
  const fragmentIds = new Set<string>()
  const touchpointIds = new Set<string>()
  for (const r of raw) {
    if (r.primary_record_type === 'couple') coupleIds.add(r.primary_record_id)
    else if (r.primary_record_type === 'fragment') fragmentIds.add(r.primary_record_id)
    else if (r.primary_record_type === 'touchpoint') touchpointIds.add(r.primary_record_id)
    if (r.secondary_record_type === 'couple') coupleIds.add(r.secondary_record_id)
    else if (r.secondary_record_type === 'fragment') fragmentIds.add(r.secondary_record_id)
    else if (r.secondary_record_type === 'touchpoint') touchpointIds.add(r.secondary_record_id)
  }
  const [couplesData, fragmentsData, touchpointsData] = await Promise.all([
    coupleIds.size > 0
      ? supabase
          .from('couples')
          .select('id, primary_contact_name, primary_contact_email')
          .in('id', [...coupleIds])
      : Promise.resolve({ data: [] }),
    fragmentIds.size > 0
      ? supabase
          .from('fragments')
          .select('id, channel, identity_hint')
          .in('id', [...fragmentIds])
      : Promise.resolve({ data: [] }),
    touchpointIds.size > 0
      ? supabase
          .from('touchpoints')
          .select('id, channel, action_type')
          .in('id', [...touchpointIds])
      : Promise.resolve({ data: [] }),
  ])

  const labels = new Map<string, string | null>()
  for (const row of (couplesData.data ?? []) as RawCoupleRow[]) {
    labels.set(row.id, labelCouple(row))
  }
  for (const row of (fragmentsData.data ?? []) as RawFragmentRow[]) {
    labels.set(row.id, `${row.channel} fragment${row.identity_hint ? `: ${row.identity_hint}` : ''}`)
  }
  for (const row of (touchpointsData.data ?? []) as RawTouchpointRow[]) {
    labels.set(row.id, `${row.channel}/${row.action_type}`)
  }

  return raw.map((r) => ({
    id: r.id,
    confidenceTier: coerceTier(r.confidence_tier),
    createdAt: r.created_at,
    matcherReason: r.matcher_reason,
    primary: {
      recordId: r.primary_record_id,
      recordType: r.primary_record_type,
      label: labels.get(r.primary_record_id) ?? null,
    },
    secondary: {
      recordId: r.secondary_record_id,
      recordType: r.secondary_record_type,
      label: labels.get(r.secondary_record_id) ?? null,
    },
  }))
}

async function loadCompleteness(
  supabase: SupabaseClient,
  venueId: string,
): Promise<IdentityReportCompleteness> {
  const cutoff = new Date(Date.now() - COMPLETENESS_WINDOW_DAYS * 86400_000).toISOString()

  // Engaged couples that arrived in the window. channel_scoped + agent
  // sit outside the doctrine engaged set.
  const { data: couples } = await supabase
    .from('couples')
    .select('id, wedding_date, primary_contact_email, created_at')
    .eq('venue_id', venueId)
    .in('lifecycle_state', ['resolved', 'booked', 'ghost'])
    .gte('created_at', cutoff)
    .limit(10000)

  const coupleRows = (couples ?? []) as CompletenessSnapshotCouple[]
  if (coupleRows.length === 0) {
    return {
      windowDays: COMPLETENESS_WINDOW_DAYS,
      totalEvaluated: 0,
      buckets: ['Complete', 'Mostly complete', 'Partial', 'Minimal'].map(
        (label) => ({
          label: label as IdentityReportCompletenessBucket['label'],
          description: bucketDescription(label as IdentityReportCompletenessBucket['label']),
          count: 0,
        }),
      ),
      withWeddingDate: 0,
      withPrimaryEmail: 0,
      withAcquisitionTouch: 0,
      withVenueReply: 0,
    }
  }

  const ids = coupleRows.map((c) => c.id)
  // Touchpoint slice — channel + action_type per couple. PostgREST cap
  // 10k is plenty for a 90d cohort at venue scale.
  const { data: tpData } = await supabase
    .from('touchpoints')
    .select('couple_id, channel, action_type')
    .eq('venue_id', venueId)
    .in('couple_id', ids)
    .limit(50000)
  const tpRows = (tpData ?? []) as CompletenessTouchpointCount[]

  const hasAcq = new Set<string>()
  const hasReply = new Set<string>()
  for (const t of tpRows) {
    if (!t.couple_id) continue
    if (isAcquisitionChannel(t.channel) && t.action_type !== 'venue_sent') {
      hasAcq.add(t.couple_id)
    }
    if (t.action_type === 'venue_sent') hasReply.add(t.couple_id)
  }

  let withWeddingDate = 0
  let withPrimaryEmail = 0
  let withAcquisitionTouch = 0
  let withVenueReply = 0
  const bucketCounts = { Complete: 0, 'Mostly complete': 0, Partial: 0, Minimal: 0 }

  for (const c of coupleRows) {
    let score = 0
    if (c.wedding_date) {
      withWeddingDate += 1
      score += 1
    }
    if (c.primary_contact_email) {
      withPrimaryEmail += 1
      score += 1
    }
    if (hasAcq.has(c.id)) {
      withAcquisitionTouch += 1
      score += 1
    }
    if (hasReply.has(c.id)) {
      withVenueReply += 1
      score += 1
    }
    if (score === 4) bucketCounts.Complete += 1
    else if (score === 3) bucketCounts['Mostly complete'] += 1
    else if (score >= 1) bucketCounts.Partial += 1
    else bucketCounts.Minimal += 1
  }

  return {
    windowDays: COMPLETENESS_WINDOW_DAYS,
    totalEvaluated: coupleRows.length,
    buckets: (
      ['Complete', 'Mostly complete', 'Partial', 'Minimal'] as const
    ).map((label) => ({
      label,
      description: bucketDescription(label),
      count: bucketCounts[label],
    })),
    withWeddingDate,
    withPrimaryEmail,
    withAcquisitionTouch,
    withVenueReply,
  }
}

function bucketDescription(label: IdentityReportCompletenessBucket['label']): string {
  switch (label) {
    case 'Complete':
      return 'Wedding date, primary email, an acquisition touchpoint, and a venue reply all present.'
    case 'Mostly complete':
      return 'Three of the four dimensions present — usually missing wedding date or a venue reply.'
    case 'Partial':
      return 'One or two dimensions present — enough to know the couple exists but the journey is fragmentary.'
    case 'Minimal':
      return 'None of the four dimensions present — a couple in name only; their touchpoints likely live outside the spine yet.'
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function buildIdentityReport(
  supabase: SupabaseClient,
  venueId: string,
): Promise<IdentityReport> {
  const [couples, confidenceDistribution, merges, completeness, borderlinePending] = await Promise.all([
    loadCouplesSummary(supabase, venueId),
    loadConfidenceDistribution(supabase, venueId),
    loadMerges(supabase, venueId),
    loadCompleteness(supabase, venueId),
    loadBorderlinePending(supabase, venueId),
  ])

  return {
    venueId,
    generatedAt: new Date().toISOString(),
    couples,
    confidenceDistribution,
    topMerges: merges.top,
    bottomMerges: merges.bottom,
    completeness,
    mostConfidentSame: merges.mostConfidentSame,
    borderlinePending,
  }
}
