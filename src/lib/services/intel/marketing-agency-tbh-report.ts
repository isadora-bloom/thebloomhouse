/**
 * Bloom House — Wave 6E depth pass: TBH Reports.
 *
 * TBH = "to be honest" — the brand asset that anchors Bloom's
 * truth-vs-claim positioning vs marketing agencies. A TBH Report is a
 * forensic agency-performance review combining:
 *
 *   - 90-day ROI snapshot (computeAgencyROI)
 *   - 12-month breakdown + trend (computeAgencyBreakdown)
 *   - KPI truth-vs-claim (computeKpiPerformance)
 *   - Activity highlights from the engagement
 *   - Coverage disclosure (what Bloom can and cannot see)
 *   - LLM-generated executive summary + conflict findings + recommendations
 *
 * Two modes per bloom-tbh-brand-asset.md:
 *   internal  — sharp framing for venue operators ("Hawthorn says X, we
 *               find Y; the gap is mostly brand search and IG cross-
 *               device, which they cannot see"). Surfaces conflicts
 *               directly.
 *   shareable — softer framing designed to send to the agency. Same
 *               numbers, different rhetoric ("we want to align our
 *               attribution view with yours; here is what we observed").
 *
 * Reports are persisted to public.tbh_reports (migration 308) so the
 * LLM bill stays bounded. Operator triggers regeneration explicitly
 * when they want a fresh view.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import {
  computeAgencyROI,
  computeAgencyBreakdown,
  listEngagementsForAgency,
  type AgencyROISummary,
  type AgencyBreakdownResult,
  type AgencyEngagementRow,
} from './marketing-agencies'
import { computeKpiPerformance, type KpiPerformanceRow } from './marketing-agency-kpi-performance'

// ---------------------------------------------------------------------------
// Prompt versioning + cost tracking
// ---------------------------------------------------------------------------

export const TBH_REPORT_PROMPT_VERSION = 'tbh-report.prompt.v1.0'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoverageDisclosure {
  /** Was the venue's marketing-site pixel installed by the period start?
   *  Today this is always 'not_installed' — the pixel ships in a later
   *  phase. Recorded explicitly so the report never silently claims
   *  attribution coverage we don't have. */
  pixel: 'installed' | 'not_installed' | 'partial'
  pixelInstalledAt: string | null
  /** Google Ads OAuth — required for GCLID + keyword data. */
  googleAdsOAuth: 'connected' | 'not_connected'
  /** Calendly Q&A capture for "where did you hear about us" answers. */
  calendlyQa: 'capturing' | 'webhook_only' | 'not_connected'
  /** Date of the earliest attribution_event we have for this agency. */
  attributionStart: string | null
  /** Free-text caveats to surface in the report. */
  notes: string[]
}

export interface ActivityHighlight {
  occurredAt: string
  kind: string
  summary: string
  body: string | null
}

export interface TbhReportSnapshot {
  agencyName: string
  periodStart: string
  periodEnd: string
  windowDays: number
  roi: Pick<
    AgencyROISummary,
    | 'totalSpendCents'
    | 'spendCents'
    | 'retainerSpendCents'
    | 'firstTouchLeads'
    | 'firstTouchTours'
    | 'firstTouchBookings'
    | 'bookedRevenueCents'
    | 'costPerBookingCents'
    | 'costPerLeadCents'
  >
  breakdown: {
    perChannel: AgencyBreakdownResult['perChannel']
    monthlyTrend: AgencyBreakdownResult['monthlyTrend']
    personaCounts: Record<string, number>
  }
  kpiPerformance: KpiPerformanceRow[]
  coverage: CoverageDisclosure
  activityHighlights: ActivityHighlight[]
  engagements: AgencyEngagementRow[]
}

export interface TbhReportRow {
  id: string
  agencyId: string
  agencyName: string
  venueId: string | null
  shortCode: string
  periodStart: string
  periodEnd: string
  mode: 'internal' | 'shareable'
  executiveSummary: string | null
  conflictFindings: string | null
  recommendations: string | null
  notesForAgency: string | null
  snapshot: TbhReportSnapshot
  promptVersion: string | null
  llmModel: string | null
  llmCostCents: number
  generatedAt: string
}

interface TbhReportRowFromDb {
  id: string
  agency_id: string
  venue_id: string | null
  short_code: string
  period_start: string
  period_end: string
  mode: string
  executive_summary: string | null
  conflict_findings: string | null
  recommendations: string | null
  notes_for_agency: string | null
  snapshot: unknown
  prompt_version: string | null
  llm_model: string | null
  llm_cost_cents: number
  generated_at: string
}

function rowToTbh(
  row: TbhReportRowFromDb,
  agencyName: string,
): TbhReportRow {
  const snapshot = (row.snapshot ?? {}) as unknown as TbhReportSnapshot
  return {
    id: row.id,
    agencyId: row.agency_id,
    agencyName,
    venueId: row.venue_id,
    shortCode: row.short_code,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    mode: row.mode === 'shareable' ? 'shareable' : 'internal',
    executiveSummary: row.executive_summary,
    conflictFindings: row.conflict_findings,
    recommendations: row.recommendations,
    notesForAgency: row.notes_for_agency,
    snapshot,
    promptVersion: row.prompt_version,
    llmModel: row.llm_model,
    llmCostCents: row.llm_cost_cents,
    generatedAt: row.generated_at,
  }
}

// ---------------------------------------------------------------------------
// Short code generation
// ---------------------------------------------------------------------------

function quarterLabel(periodStart: string): string {
  const d = new Date(`${periodStart}T00:00:00.000Z`)
  const year = d.getUTCFullYear()
  const q = Math.floor(d.getUTCMonth() / 3) + 1
  return `${year}-Q${q}`
}

function randomCode(): string {
  // 5-char base36, uppercase. Collision space ≈ 60M. Unique index on
  // tbh_reports.short_code catches dupes; we retry on conflict.
  return Math.floor(Math.random() * 36 ** 5)
    .toString(36)
    .toUpperCase()
    .padStart(5, '0')
}

function generateShortCode(periodStart: string): string {
  return `TBH-${quarterLabel(periodStart)}-${randomCode()}`
}

// ---------------------------------------------------------------------------
// Coverage disclosure
// ---------------------------------------------------------------------------

async function buildCoverage(
  venueIds: string[],
  agencyId: string,
): Promise<CoverageDisclosure> {
  const service = createServiceClient()
  // Earliest attribution_event for this agency's managed channels.
  // Reads against engagements → managed_channels → attribution_events.
  const { data: engagements } = await service
    .from('venue_agency_engagements')
    .select('managed_channels')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
  const channelSet = new Set<string>()
  for (const e of engagements ?? []) {
    const c = (e.managed_channels as unknown[]) ?? []
    for (const k of c) if (typeof k === 'string') channelSet.add(k)
  }
  const channels = [...channelSet]

  let attributionStart: string | null = null
  if (channels.length > 0 && venueIds.length > 0) {
    const { data } = await service
      .from('attribution_events')
      .select('decided_at')
      .in('venue_id', venueIds)
      .in('source_platform', channels)
      .eq('is_first_touch', true)
      .order('decided_at', { ascending: true })
      .limit(1)
    attributionStart = (data?.[0]?.decided_at as string | null) ?? null
  }

  const notes: string[] = []
  notes.push(
    'Pixel-based cross-session attribution is not yet deployed. Single-session UTM is captured at form submission; cross-device journeys depend on forensic reconstruction.',
  )
  notes.push(
    'Google Ads OAuth is not connected. Brand-search vs non-brand split relies on utm_term values supplied at the campaign level.',
  )
  notes.push(
    'Pre-attribution-start leads are forensic-only, with ~40-60% confidence on first-touch.',
  )

  return {
    pixel: 'not_installed',
    pixelInstalledAt: null,
    googleAdsOAuth: 'not_connected',
    calendlyQa: 'webhook_only',
    attributionStart,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Activity highlights
// ---------------------------------------------------------------------------

const HIGHLIGHT_KINDS = new Set([
  'review',
  'decision',
  'escalation',
  'contract_renewed',
  'channel_change',
  'kpi_missed',
  'kpi_hit',
  'report_received',
])

async function buildActivityHighlights(
  agencyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ActivityHighlight[]> {
  const service = createServiceClient()
  const startIso = new Date(`${periodStart}T00:00:00.000Z`).toISOString()
  const endIso = new Date(`${periodEnd}T23:59:59.999Z`).toISOString()
  const { data } = await service
    .from('agency_activity_log')
    .select('occurred_at, kind, summary, body')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .gte('occurred_at', startIso)
    .lte('occurred_at', endIso)
    .order('occurred_at', { ascending: true })

  const highlights: ActivityHighlight[] = []
  for (const row of data ?? []) {
    if (HIGHLIGHT_KINDS.has((row.kind as string) ?? 'note')) {
      highlights.push({
        occurredAt: row.occurred_at as string,
        kind: row.kind as string,
        summary: row.summary as string,
        body: (row.body as string) ?? null,
      })
    }
  }
  return highlights
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(mode: 'internal' | 'shareable'): string {
  const sharedDoctrine = `
You are writing a TBH Report — a forensic marketing-agency performance review for The Bloom House (TBH = "to be honest"). The audience is a wedding-venue operator.

DOCTRINE — never violate:
1. Use ONLY the numbers in the structured snapshot provided in the user prompt. Do not invent or estimate values not present.
2. Cite specific channels by name (e.g. "google_ads", "meta_ads", "the_knot") rather than vague phrases.
3. When attribution coverage is incomplete, acknowledge it. Coverage notes are in snapshot.coverage.notes. Surface caveats next to the numbers they affect.
4. Currency is USD. Cents-precision math has already been done — you receive dollars. Format $X,XXX.
5. Names follow snapshot.agencyName.
6. Never claim a metric Bloom doesn't measure. snapshot.coverage.notes lists known gaps; respect them.
7. KPI status semantics: 'hit' (good), 'close' (within 10%), 'miss' (failed), 'too_early' (engagement too young), 'not_measurable' (Bloom can't see), 'no_data' (no events).
`.trim()

  const modeRules =
    mode === 'internal'
      ? `
TONE — internal mode (the operator alone reads this):
- Sharp, direct, conflict-forward.
- Lead conflict_findings with the most-damaging discrepancy.
- It is OK to say "Hawthorn's reported numbers diverge from ours" when the data supports it.
- recommendations should suggest concrete next steps (renegotiate fee, shift spend, end engagement, ask agency for X data).
- DO NOT generate notesForAgency. Set it to null.
`.trim()
      : `
TONE — shareable mode (the operator may forward this to the agency):
- Collaborative, working-relationship framing.
- Frame divergence as "different views of the same data" rather than accusation.
- conflict_findings is OK to keep specific but offers context ("we attribute differently because we can see post-form data the agency cannot").
- recommendations focus on JOINT next steps (shared review, data swap, alignment session).
- ALWAYS generate notesForAgency — a short cover note (2-3 sentences) suitable for the email body when the operator forwards the report.
`.trim()

  const outputShape = `
OUTPUT — return JSON exactly matching this shape:
{
  "executiveSummary": string,    // 3-4 sentences, period-specific
  "conflictFindings": string,    // markdown, 100-300 words
  "recommendations": string,     // markdown, 100-250 words, list format encouraged
  "notesForAgency": string|null  // null for internal mode, 2-3 sentences for shareable
}
`.trim()

  return `${sharedDoctrine}\n\n${modeRules}\n\n${outputShape}`
}

function buildUserPrompt(snapshot: TbhReportSnapshot, mode: 'internal' | 'shareable'): string {
  const fmt = (cents: number | null) =>
    cents === null ? '—' : `$${(cents / 100).toFixed(0)}`

  const trendSummary = snapshot.breakdown.monthlyTrend
    .slice(-6)
    .map(
      (m) =>
        `  ${m.month.slice(0, 7)}: spend ${fmt(m.totalCents)}, leads ${m.firstTouchLeads}, bookings ${m.firstTouchBookings}`,
    )
    .join('\n')

  const channelSummary = snapshot.breakdown.perChannel
    .map(
      (c) =>
        `  ${c.channelKey}: spend ${fmt(c.spendCents)}, leads ${c.firstTouchLeads}, tours ${c.firstTouchTours}, bookings ${c.firstTouchBookings}, $/lead ${fmt(c.costPerLeadCents)}, $/booking ${fmt(c.costPerBookingCents)}, revenue ${fmt(c.bookedRevenueCents)}`,
    )
    .join('\n')

  const personaSummary = Object.entries(snapshot.breakdown.personaCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `  ${p}: ${n} first-touch leads`)
    .join('\n')

  const kpiSummary = snapshot.kpiPerformance
    .map(
      (k) =>
        `  - ${k.metricDisplay} (target ${k.targetValue} ${k.targetUnit}/${k.targetWindow}): status=${k.status}, actual=${k.actualValue ?? 'n/a'} ${k.targetUnit}, gap=${k.gapPct === null ? 'n/a' : k.gapPct.toFixed(0) + '%'}, reason="${k.reasoning}"`,
    )
    .join('\n')

  const highlights = snapshot.activityHighlights
    .map((h) => `  ${h.occurredAt.slice(0, 10)} [${h.kind}] ${h.summary}`)
    .join('\n')

  const engagements = snapshot.engagements
    .map(
      (e) =>
        `  venue=${e.venueId}, started=${e.startedAt}, ended=${e.endedAt ?? 'active'}, monthly_fee=${fmt(e.monthlyFeeCents)}, channels=[${e.managedChannels.join(', ')}], cadence=${e.reportingCadence ?? '—'}`,
    )
    .join('\n')

  return [
    `AGENCY: ${snapshot.agencyName}`,
    `PERIOD: ${snapshot.periodStart} → ${snapshot.periodEnd} (${snapshot.windowDays} days)`,
    `MODE: ${mode}`,
    '',
    '=== ROI HEADLINE ===',
    `Total spend: ${fmt(snapshot.roi.totalSpendCents)}`,
    `  Direct spend (tagged rows): ${fmt(snapshot.roi.spendCents)}`,
    `  Retainer accrual: ${fmt(snapshot.roi.retainerSpendCents)}`,
    `First-touch leads: ${snapshot.roi.firstTouchLeads}`,
    `Tour-completed: ${snapshot.roi.firstTouchTours}`,
    `Bookings: ${snapshot.roi.firstTouchBookings}`,
    `Booked revenue: ${fmt(snapshot.roi.bookedRevenueCents)}`,
    `Cost per booking (CAC): ${fmt(snapshot.roi.costPerBookingCents)}`,
    `Cost per lead: ${fmt(snapshot.roi.costPerLeadCents)}`,
    '',
    '=== PER-CHANNEL BREAKDOWN ===',
    channelSummary || '  (none)',
    '',
    '=== RECENT 6-MONTH TREND ===',
    trendSummary || '  (insufficient data)',
    '',
    '=== PERSONA OVERLAY ===',
    personaSummary || '  (no persona data; Wave 5A coverage may be low)',
    '',
    '=== KPI TRUTH-VS-CLAIM ===',
    kpiSummary || '  (no commitments on file)',
    '',
    '=== ENGAGEMENTS ===',
    engagements || '  (none)',
    '',
    '=== ACTIVITY HIGHLIGHTS ===',
    highlights || '  (none recorded in period)',
    '',
    '=== COVERAGE DISCLOSURE ===',
    `Pixel: ${snapshot.coverage.pixel}`,
    `Google Ads OAuth: ${snapshot.coverage.googleAdsOAuth}`,
    `Calendly Q&A: ${snapshot.coverage.calendlyQa}`,
    `Earliest attribution: ${snapshot.coverage.attributionStart ?? 'no events on file'}`,
    'Notes:',
    snapshot.coverage.notes.map((n) => `  - ${n}`).join('\n'),
    '',
    'Now generate the TBH Report. Return JSON only.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComputeTbhReportArgs {
  agencyId: string
  venueIds: string[]
  periodStart: string // YYYY-MM-DD
  periodEnd: string // YYYY-MM-DD
  mode: 'internal' | 'shareable'
  generatedBy?: string | null
}

/**
 * Generate (or re-generate) a TBH Report. Persists to tbh_reports.
 * Always writes a NEW row, even if one exists for the same period+mode
 * — the operator wants to see what the report would look like NOW. The
 * latest row wins on subsequent reads.
 */
export async function computeTbhReport(
  args: ComputeTbhReportArgs,
): Promise<TbhReportRow> {
  const service = createServiceClient()

  // Compute the window from the period.
  const startMs = new Date(`${args.periodStart}T00:00:00.000Z`).getTime()
  const endMs = new Date(`${args.periodEnd}T23:59:59.999Z`).getTime()
  if (!(endMs > startMs)) {
    throw new Error('periodEnd must be after periodStart')
  }
  const windowDays = Math.max(
    1,
    Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)),
  )

  // Resolve the venue scope.
  if (args.venueIds.length === 0) {
    throw new Error('venueIds required (at least one)')
  }

  // Pull agency name for the snapshot.
  const { data: agencyRow } = await service
    .from('marketing_agencies')
    .select('name')
    .eq('id', args.agencyId)
    .is('deleted_at', null)
    .maybeSingle()
  const agencyName = (agencyRow?.name as string | undefined) ?? '(unknown)'

  // Gather all data substrates in parallel.
  const [roi, breakdown, kpiPerformance, engagements, activityHighlights, coverage] =
    await Promise.all([
      computeAgencyROI({
        agencyId: args.agencyId,
        venueIds: args.venueIds,
        windowDays,
      }),
      computeAgencyBreakdown({
        agencyId: args.agencyId,
        venueIds: args.venueIds,
        windowDays: Math.max(windowDays, 365),
      }),
      computeKpiPerformance({
        agencyId: args.agencyId,
        venueIds: args.venueIds,
        windowDays,
        includeRetired: false,
      }),
      listEngagementsForAgency(args.agencyId, { venueIds: args.venueIds }),
      buildActivityHighlights(args.agencyId, args.periodStart, args.periodEnd),
      buildCoverage(args.venueIds, args.agencyId),
    ])

  // Assemble snapshot.
  const snapshot: TbhReportSnapshot = {
    agencyName,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    windowDays,
    roi: {
      totalSpendCents: roi.totalSpendCents,
      spendCents: roi.spendCents,
      retainerSpendCents: roi.retainerSpendCents,
      firstTouchLeads: roi.firstTouchLeads,
      firstTouchTours: roi.firstTouchTours,
      firstTouchBookings: roi.firstTouchBookings,
      bookedRevenueCents: roi.bookedRevenueCents,
      costPerBookingCents: roi.costPerBookingCents,
      costPerLeadCents: roi.costPerLeadCents,
    },
    breakdown: {
      perChannel: breakdown.perChannel,
      monthlyTrend: breakdown.monthlyTrend,
      personaCounts: breakdown.personaCounts,
    },
    kpiPerformance,
    coverage,
    activityHighlights,
    engagements,
  }

  // LLM call. We're conservative: if there's no data of substance,
  // skip the LLM call and write a "not enough data" report.
  const hasAnyData =
    roi.totalSpendCents > 0 ||
    roi.firstTouchLeads > 0 ||
    kpiPerformance.length > 0 ||
    activityHighlights.length > 0

  let executiveSummary = ''
  let conflictFindings = ''
  let recommendations = ''
  let notesForAgency: string | null = null

  if (!hasAnyData) {
    executiveSummary = `No measurable spend, attribution, or KPI activity for ${agencyName} in the ${args.periodStart} → ${args.periodEnd} window. This usually means the engagement is new, channel keys are not yet mapped, or attribution coverage has gaps.`
    conflictFindings =
      'There is no measured data to contrast against agency claims. Once spend, attribution events, or KPI commitments land in this window, regenerate the report.'
    recommendations =
      '- Verify the engagement is configured with the right managed channels.\n- Confirm marketing_spend rows are being tagged with this agency.\n- If the engagement is brand-new, wait at least 30 days before requesting a fresh report.'
    if (args.mode === 'shareable') {
      notesForAgency =
        "We're still building up enough data to produce a meaningful performance review. Let's schedule a check-in once we have a full month of attributed activity."
    }
  } else {
    const systemPrompt = buildSystemPrompt(args.mode)
    const userPrompt = buildUserPrompt(snapshot, args.mode)
    const llmResponse = await callAIJson<{
      executiveSummary?: string
      conflictFindings?: string
      recommendations?: string
      notesForAgency?: string | null
    }>({
      systemPrompt,
      userPrompt,
      tier: 'sonnet',
      maxTokens: 1800,
      venueId: args.venueIds[0],
      taskType: 'tbh_report_narrative',
      promptVersion: TBH_REPORT_PROMPT_VERSION,
    })
    executiveSummary = llmResponse.executiveSummary ?? ''
    conflictFindings = llmResponse.conflictFindings ?? ''
    recommendations = llmResponse.recommendations ?? ''
    notesForAgency =
      args.mode === 'shareable'
        ? typeof llmResponse.notesForAgency === 'string' &&
          llmResponse.notesForAgency.trim().length > 0
          ? llmResponse.notesForAgency
          : null
        : null
  }

  // Persist. Retry on short_code collision (very rare).
  for (let attempt = 0; attempt < 4; attempt++) {
    const shortCode = generateShortCode(args.periodStart)
    const insert = await service
      .from('tbh_reports')
      .insert({
        agency_id: args.agencyId,
        venue_id: args.venueIds[0],
        short_code: shortCode,
        period_start: args.periodStart,
        period_end: args.periodEnd,
        mode: args.mode,
        executive_summary: executiveSummary,
        conflict_findings: conflictFindings,
        recommendations,
        notes_for_agency: notesForAgency,
        snapshot,
        prompt_version: TBH_REPORT_PROMPT_VERSION,
        llm_model: hasAnyData ? 'sonnet' : null,
        // cost recorded via api_costs separately by callAIJson.
        llm_cost_cents: 0,
        generated_by: args.generatedBy ?? null,
      })
      .select('*')
      .single()
    if (!insert.error && insert.data) {
      return rowToTbh(insert.data as TbhReportRowFromDb, agencyName)
    }
    // 23505 = unique violation. Retry with a new short_code.
    if (
      (insert.error as { code?: string } | null | undefined)?.code !== '23505'
    ) {
      throw new Error(
        `TBH report persist failed: ${insert.error?.message ?? 'unknown'}`,
      )
    }
  }
  throw new Error('TBH report persist failed after 4 short-code retries')
}

/**
 * Return the most recent TBH report for an agency in the requested
 * mode, or null. UI uses this for "show the latest" without
 * regenerating.
 */
export async function getLatestTbhReport(args: {
  agencyId: string
  mode: 'internal' | 'shareable'
}): Promise<TbhReportRow | null> {
  const service = createServiceClient()
  const { data: agencyRow } = await service
    .from('marketing_agencies')
    .select('name')
    .eq('id', args.agencyId)
    .is('deleted_at', null)
    .maybeSingle()
  const agencyName = (agencyRow?.name as string | undefined) ?? '(unknown)'
  const { data } = await service
    .from('tbh_reports')
    .select('*')
    .eq('agency_id', args.agencyId)
    .eq('mode', args.mode)
    .is('deleted_at', null)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? rowToTbh(data as TbhReportRowFromDb, agencyName) : null
}

export async function listTbhReports(args: {
  agencyId: string
  limit?: number
}): Promise<TbhReportRow[]> {
  const service = createServiceClient()
  const { data: agencyRow } = await service
    .from('marketing_agencies')
    .select('name')
    .eq('id', args.agencyId)
    .is('deleted_at', null)
    .maybeSingle()
  const agencyName = (agencyRow?.name as string | undefined) ?? '(unknown)'
  const { data } = await service
    .from('tbh_reports')
    .select('*')
    .eq('agency_id', args.agencyId)
    .is('deleted_at', null)
    .order('generated_at', { ascending: false })
    .limit(Math.min(Math.max(args.limit ?? 20, 1), 100))
  return (data ?? []).map((r) => rowToTbh(r as TbhReportRowFromDb, agencyName))
}
