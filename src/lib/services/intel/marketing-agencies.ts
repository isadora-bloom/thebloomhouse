/**
 * Bloom House: Marketing Agencies (Wave 6E)
 *
 * The "is Hawthorn paying off?" service. Reads marketing_agencies +
 * venue_agency_engagements + marketing_spend_records + attribution_events
 * to answer the headline TBH Report question: did this agency drive
 * actual bookings, and at what real CAC?
 *
 * Migration 304 owns the entity. Migration 305 wires agency_id onto
 * marketing_spend_records and managed_by_agency_id onto marketing_channels
 * so this service can join cleanly without runtime triple-joins.
 *
 * Pressure-tested honesty (see investigation notes): the headline claim
 * ("Hawthorn brought 47 leads but only 17 net-new") is achievable IFF
 * three operator-side actions are in place — pixel installed (Layer C,
 * not yet built), agency UTM cooperation OR Google Ads OAuth (not yet
 * built), Calendly Q&A parser (partial). This service computes what is
 * computable TODAY from the existing attribution_events + spend stack.
 * Future layers feed it stronger signals; the API contract doesn't
 * change.
 *
 * What this service does NOT do (deferred):
 *   - Forensic role classification (Wave 7B owns)
 *   - Conflict detection vs agency-claimed numbers (needs agency-report
 *     ingest, which doesn't exist yet)
 *   - LLM-generated TBH Report copy (separate module)
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketingAgencyRow {
  id: string
  orgId: string | null
  venueId: string | null
  name: string
  website: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  defaultMonthlyRetainerCents: number | null
  performanceFeePct: number | null
  services: string[]
  notes: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface AgencyEngagementRow {
  id: string
  venueId: string
  agencyId: string
  startedAt: string
  endedAt: string | null
  monthlyFeeCents: number
  managedChannels: string[]
  scopeDescription: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface AgencyROISummary {
  agencyId: string
  agencyName: string
  windowDays: number
  /** Sum of spend rows tagged to this agency in the window. Cents. */
  spendCents: number
  /** Sum of monthly retainer fees for active engagements in the window. Cents. */
  retainerSpendCents: number
  /** Combined spend (direct + retainer). Cents. */
  totalSpendCents: number
  /** Number of attribution_events with is_first_touch=true and
   *  source_platform in any managed_channels across all engagements,
   *  within the window. */
  firstTouchLeads: number
  /** Of those leads, how many advanced to tour_completed status. */
  firstTouchTours: number
  /** Of those leads, how many advanced to booked status. */
  firstTouchBookings: number
  /** Total revenue (estimated_value cents) across the booked leads. */
  bookedRevenueCents: number
  /** True CAC = totalSpendCents / firstTouchBookings (null when no bookings). */
  costPerBookingCents: number | null
  /** Cost per first-touch lead. */
  costPerLeadCents: number | null
  /** Engagement metadata for the agency, scoped to the venues asked about. */
  engagements: AgencyEngagementRow[]
  /** Venues considered in this compute. */
  venueIds: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 90
const MAX_WINDOW_DAYS = 3650

function clampWindow(days: number | undefined): number {
  const n = Number.isFinite(days) ? Number(days) : DEFAULT_WINDOW_DAYS
  return Math.min(Math.max(n, 1), MAX_WINDOW_DAYS)
}

function windowStart(windowDays: number): string {
  const ms = Date.now() - windowDays * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().slice(0, 10) // YYYY-MM-DD
}

interface AgencyRowFromDb {
  id: string
  org_id: string | null
  venue_id: string | null
  name: string
  website: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  default_monthly_retainer_cents: number | null
  performance_fee_pct: number | null
  services: unknown
  notes: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function rowToAgency(row: AgencyRowFromDb): MarketingAgencyRow {
  return {
    id: row.id,
    orgId: row.org_id,
    venueId: row.venue_id,
    name: row.name,
    website: row.website,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    defaultMonthlyRetainerCents: row.default_monthly_retainer_cents,
    performanceFeePct: row.performance_fee_pct === null
      ? null
      : Number(row.performance_fee_pct),
    services: Array.isArray(row.services) ? row.services.filter((x): x is string => typeof x === 'string') : [],
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

interface EngagementRowFromDb {
  id: string
  venue_id: string
  agency_id: string
  started_at: string
  ended_at: string | null
  monthly_fee_cents: number
  managed_channels: unknown
  scope_description: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

function rowToEngagement(row: EngagementRowFromDb): AgencyEngagementRow {
  return {
    id: row.id,
    venueId: row.venue_id,
    agencyId: row.agency_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    monthlyFeeCents: row.monthly_fee_cents,
    managedChannels: Array.isArray(row.managed_channels)
      ? row.managed_channels.filter((x): x is string => typeof x === 'string')
      : [],
    scopeDescription: row.scope_description,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// List + read
// ---------------------------------------------------------------------------

/**
 * List agencies visible from a given venue scope:
 *   - agency.venue_id matches the venue, OR
 *   - agency.org_id matches the venue's org, OR
 *   - the venue has an engagement to the agency.
 *
 * Returns only non-deleted agencies. Sorted by name.
 */
export async function listAgenciesForVenue(
  venueId: string,
): Promise<MarketingAgencyRow[]> {
  const service = createServiceClient()

  const { data: venueRow } = await service
    .from('venues')
    .select('org_id')
    .eq('id', venueId)
    .maybeSingle()
  const orgId = (venueRow?.org_id as string | null) ?? null

  // Pull the agency IDs the venue has engagements to (active or historical).
  const { data: engagementRows } = await service
    .from('venue_agency_engagements')
    .select('agency_id')
    .eq('venue_id', venueId)
    .is('deleted_at', null)
  const engagementAgencyIds = new Set<string>(
    (engagementRows ?? []).map((r) => r.agency_id as string),
  )

  // Build the OR query for agencies. We do two queries (one by direct
  // owner, one by engagement) and union in-memory because Supabase
  // doesn't have a clean OR-across-different-columns query builder.
  const byOwner = await service
    .from('marketing_agencies')
    .select('*')
    .is('deleted_at', null)
    .or(
      orgId
        ? `venue_id.eq.${venueId},org_id.eq.${orgId}`
        : `venue_id.eq.${venueId}`,
    )

  let byEngagement: { data: AgencyRowFromDb[] | null } = { data: null }
  if (engagementAgencyIds.size > 0) {
    byEngagement = await service
      .from('marketing_agencies')
      .select('*')
      .is('deleted_at', null)
      .in('id', [...engagementAgencyIds])
  }

  const all = new Map<string, AgencyRowFromDb>()
  for (const r of (byOwner.data ?? []) as AgencyRowFromDb[]) all.set(r.id, r)
  for (const r of byEngagement.data ?? []) all.set(r.id, r)

  return [...all.values()]
    .map(rowToAgency)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getAgencyById(
  agencyId: string,
): Promise<MarketingAgencyRow | null> {
  const service = createServiceClient()
  const { data } = await service
    .from('marketing_agencies')
    .select('*')
    .eq('id', agencyId)
    .is('deleted_at', null)
    .maybeSingle()
  return data ? rowToAgency(data as AgencyRowFromDb) : null
}

export async function listEngagementsForAgency(
  agencyId: string,
  opts: { venueIds?: string[] } = {},
): Promise<AgencyEngagementRow[]> {
  const service = createServiceClient()
  let query = service
    .from('venue_agency_engagements')
    .select('*')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('started_at', { ascending: false })

  if (opts.venueIds && opts.venueIds.length > 0) {
    query = query.in('venue_id', opts.venueIds)
  }

  const { data } = await query
  return (data ?? []).map((r) => rowToEngagement(r as EngagementRowFromDb))
}

export async function listEngagementsForVenue(
  venueId: string,
): Promise<AgencyEngagementRow[]> {
  const service = createServiceClient()
  const { data } = await service
    .from('venue_agency_engagements')
    .select('*')
    .eq('venue_id', venueId)
    .is('deleted_at', null)
    .order('started_at', { ascending: false })
  return (data ?? []).map((r) => rowToEngagement(r as EngagementRowFromDb))
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

export interface CreateAgencyInput {
  orgId?: string | null
  venueId?: string | null
  name: string
  website?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  defaultMonthlyRetainerCents?: number | null
  performanceFeePct?: number | null
  services?: string[]
  notes?: string | null
  createdBy?: string | null
}

export async function createAgency(
  input: CreateAgencyInput,
): Promise<MarketingAgencyRow> {
  if (!input.name || !input.name.trim()) {
    throw new Error('agency name required')
  }
  if (!input.orgId && !input.venueId) {
    throw new Error('agency must have either orgId or venueId')
  }
  if (input.orgId && input.venueId) {
    throw new Error('agency cannot have both orgId and venueId set')
  }

  const service = createServiceClient()
  const payload = {
    org_id: input.orgId ?? null,
    venue_id: input.venueId ?? null,
    name: input.name.trim(),
    website: input.website ?? null,
    contact_name: input.contactName ?? null,
    contact_email: input.contactEmail ?? null,
    contact_phone: input.contactPhone ?? null,
    default_monthly_retainer_cents: input.defaultMonthlyRetainerCents ?? null,
    performance_fee_pct: input.performanceFeePct ?? null,
    services: input.services ?? [],
    notes: input.notes ?? null,
    created_by: input.createdBy ?? null,
  }

  const { data, error } = await service
    .from('marketing_agencies')
    .insert(payload)
    .select('*')
    .single()

  if (error) throw new Error(`create agency failed: ${error.message}`)
  return rowToAgency(data as AgencyRowFromDb)
}

export interface UpdateAgencyInput {
  name?: string
  website?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  defaultMonthlyRetainerCents?: number | null
  performanceFeePct?: number | null
  services?: string[]
  notes?: string | null
}

export async function updateAgency(
  agencyId: string,
  patch: UpdateAgencyInput,
): Promise<MarketingAgencyRow> {
  const service = createServiceClient()
  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) update.name = patch.name.trim()
  if (patch.website !== undefined) update.website = patch.website
  if (patch.contactName !== undefined) update.contact_name = patch.contactName
  if (patch.contactEmail !== undefined) update.contact_email = patch.contactEmail
  if (patch.contactPhone !== undefined) update.contact_phone = patch.contactPhone
  if (patch.defaultMonthlyRetainerCents !== undefined) {
    update.default_monthly_retainer_cents = patch.defaultMonthlyRetainerCents
  }
  if (patch.performanceFeePct !== undefined) {
    update.performance_fee_pct = patch.performanceFeePct
  }
  if (patch.services !== undefined) update.services = patch.services
  if (patch.notes !== undefined) update.notes = patch.notes

  const { data, error } = await service
    .from('marketing_agencies')
    .update(update)
    .eq('id', agencyId)
    .select('*')
    .single()
  if (error) throw new Error(`update agency failed: ${error.message}`)
  return rowToAgency(data as AgencyRowFromDb)
}

export async function softDeleteAgency(agencyId: string): Promise<void> {
  const service = createServiceClient()
  const { error } = await service
    .from('marketing_agencies')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', agencyId)
  if (error) throw new Error(`delete agency failed: ${error.message}`)
}

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

export interface UpsertEngagementInput {
  venueId: string
  agencyId: string
  startedAt: string // YYYY-MM-DD
  endedAt?: string | null
  monthlyFeeCents?: number
  managedChannels?: string[]
  scopeDescription?: string | null
  notes?: string | null
}

/**
 * Create-or-update the active engagement between a venue and an agency.
 * If an active engagement (ended_at IS NULL) exists, update it;
 * otherwise create a new row.
 */
export async function upsertEngagement(
  input: UpsertEngagementInput,
): Promise<AgencyEngagementRow> {
  const service = createServiceClient()

  const { data: existing } = await service
    .from('venue_agency_engagements')
    .select('id')
    .eq('venue_id', input.venueId)
    .eq('agency_id', input.agencyId)
    .is('ended_at', null)
    .is('deleted_at', null)
    .maybeSingle()

  const payload = {
    venue_id: input.venueId,
    agency_id: input.agencyId,
    started_at: input.startedAt,
    ended_at: input.endedAt ?? null,
    monthly_fee_cents: input.monthlyFeeCents ?? 0,
    managed_channels: input.managedChannels ?? [],
    scope_description: input.scopeDescription ?? null,
    notes: input.notes ?? null,
  }

  if (existing?.id) {
    const { data, error } = await service
      .from('venue_agency_engagements')
      .update(payload)
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) throw new Error(`update engagement failed: ${error.message}`)
    return rowToEngagement(data as EngagementRowFromDb)
  }

  const { data, error } = await service
    .from('venue_agency_engagements')
    .insert(payload)
    .select('*')
    .single()
  if (error) throw new Error(`create engagement failed: ${error.message}`)
  return rowToEngagement(data as EngagementRowFromDb)
}

export async function endEngagement(
  engagementId: string,
  endedAt: string,
): Promise<AgencyEngagementRow> {
  const service = createServiceClient()
  const { data, error } = await service
    .from('venue_agency_engagements')
    .update({ ended_at: endedAt })
    .eq('id', engagementId)
    .select('*')
    .single()
  if (error) throw new Error(`end engagement failed: ${error.message}`)
  return rowToEngagement(data as EngagementRowFromDb)
}

export async function softDeleteEngagement(engagementId: string): Promise<void> {
  const service = createServiceClient()
  const { error } = await service
    .from('venue_agency_engagements')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', engagementId)
  if (error) throw new Error(`delete engagement failed: ${error.message}`)
}

// ---------------------------------------------------------------------------
// ROI compute — the "is Hawthorn paying off?" answer
// ---------------------------------------------------------------------------

interface AttributionEventRow {
  wedding_id: string | null
  source_platform: string | null
}

interface WeddingRow {
  id: string
  status: string | null
  estimated_value: number | null
}

interface SpendRow {
  amount_cents: number
  channel: string
  agency_id: string | null
  spend_date: string
}

/**
 * Compute agency ROI within a window across one or more venues.
 *
 * Two spend paths are summed:
 *   1. marketing_spend_records where agency_id = agencyId AND
 *      spend_date >= window start.
 *   2. Retainer fee accrual: for each active-during-window engagement,
 *      months overlapping the window × monthly_fee_cents.
 *
 * Attribution path:
 *   - Union of managed_channels across all engagements in scope.
 *   - attribution_events where venue_id IN scope AND source_platform
 *     IN union AND is_first_touch = true AND reverted_at IS NULL AND
 *     decided_at >= window start.
 *   - Walk to wedding for status + revenue.
 *
 * Honest limitations baked in:
 *   - Attribution requires source_platform to match a managed channel
 *     by key. Channels not yet tagged to the agency are invisible.
 *   - First-touch logic relies on existing attribution_events; this
 *     service does NOT re-run the resolver.
 *   - "Net new" (vs brand-search) cannot be computed here — needs
 *     pixel + Google Ads OAuth (deferred). The number returned is
 *     ALL first-touch leads attributable to the agency's channels,
 *     not net-new.
 */
export async function computeAgencyROI(args: {
  agencyId: string
  venueIds: string[]
  windowDays?: number
}): Promise<AgencyROISummary> {
  const service = createServiceClient()
  const windowDays = clampWindow(args.windowDays)
  const startDate = windowStart(windowDays)
  const startIso = new Date(`${startDate}T00:00:00.000Z`).toISOString()

  const { data: agencyData } = await service
    .from('marketing_agencies')
    .select('id, name')
    .eq('id', args.agencyId)
    .is('deleted_at', null)
    .maybeSingle()

  const agencyName = (agencyData?.name as string | undefined) ?? '(unknown)'

  // Engagements scoped to the requested venues.
  let engQuery = service
    .from('venue_agency_engagements')
    .select('*')
    .eq('agency_id', args.agencyId)
    .is('deleted_at', null)
  if (args.venueIds.length > 0) {
    engQuery = engQuery.in('venue_id', args.venueIds)
  }
  const { data: engRows } = await engQuery
  const engagements = (engRows ?? []).map((r) =>
    rowToEngagement(r as EngagementRowFromDb),
  )

  // Union of managed channels across all engagements.
  const managedChannelSet = new Set<string>()
  for (const e of engagements) {
    for (const c of e.managedChannels) managedChannelSet.add(c)
  }
  const managedChannels = [...managedChannelSet]

  // Spend rows tagged directly to this agency.
  const { data: spendData } = await service
    .from('marketing_spend_records')
    .select('amount_cents, channel, agency_id, spend_date')
    .eq('agency_id', args.agencyId)
    .gte('spend_date', startDate)
  const spendCents = (spendData ?? []).reduce(
    (acc: number, row) => acc + ((row as SpendRow).amount_cents ?? 0),
    0,
  )

  // Retainer accrual — count months in the window per engagement.
  const now = new Date()
  const windowStartMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000
  const retainerSpendCents = engagements.reduce((acc, e) => {
    if (e.monthlyFeeCents <= 0) return acc
    const startMs = Math.max(
      new Date(`${e.startedAt}T00:00:00.000Z`).getTime(),
      windowStartMs,
    )
    const endMs = e.endedAt
      ? Math.min(new Date(`${e.endedAt}T00:00:00.000Z`).getTime(), now.getTime())
      : now.getTime()
    if (endMs <= startMs) return acc
    const overlapDays = (endMs - startMs) / (1000 * 60 * 60 * 24)
    const months = overlapDays / 30
    return acc + Math.round(months * e.monthlyFeeCents)
  }, 0)

  // Attribution events: managed_channels × in-scope venues × first-touch.
  let firstTouchLeads = 0
  let firstTouchTours = 0
  let firstTouchBookings = 0
  let bookedRevenueCents = 0

  if (managedChannels.length > 0 && args.venueIds.length > 0) {
    const { data: attRows } = await service
      .from('attribution_events')
      .select('wedding_id, source_platform')
      .in('venue_id', args.venueIds)
      .in('source_platform', managedChannels)
      .eq('is_first_touch', true)
      .is('reverted_at', null)
      .gte('decided_at', startIso)

    const weddingIds = new Set<string>()
    for (const r of (attRows ?? []) as AttributionEventRow[]) {
      if (r.wedding_id) weddingIds.add(r.wedding_id)
    }

    if (weddingIds.size > 0) {
      const { data: wRows } = await service
        .from('weddings')
        .select('id, status, estimated_value')
        .in('id', [...weddingIds])
      for (const w of (wRows ?? []) as WeddingRow[]) {
        firstTouchLeads += 1
        if (w.status === 'tour_completed' || w.status === 'proposal_sent' ||
            w.status === 'booked' || w.status === 'completed') {
          firstTouchTours += 1
        }
        if (w.status === 'booked' || w.status === 'completed') {
          firstTouchBookings += 1
          // estimated_value is dollars in the legacy schema — convert
          // to cents for consistency with spend.
          const val = Number(w.estimated_value ?? 0)
          if (Number.isFinite(val) && val > 0) {
            bookedRevenueCents += Math.round(val * 100)
          }
        }
      }
    }
  }

  const totalSpendCents = spendCents + retainerSpendCents
  const costPerBookingCents =
    firstTouchBookings > 0 ? Math.round(totalSpendCents / firstTouchBookings) : null
  const costPerLeadCents =
    firstTouchLeads > 0 ? Math.round(totalSpendCents / firstTouchLeads) : null

  return {
    agencyId: args.agencyId,
    agencyName,
    windowDays,
    spendCents,
    retainerSpendCents,
    totalSpendCents,
    firstTouchLeads,
    firstTouchTours,
    firstTouchBookings,
    bookedRevenueCents,
    costPerBookingCents,
    costPerLeadCents,
    engagements,
    venueIds: args.venueIds,
  }
}
