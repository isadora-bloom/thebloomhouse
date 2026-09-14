/**
 * Platform-shift tool source (NOVEMBER-PLAN.md wave 7, W48).
 *
 * The question this exists to answer: "is engagement moving from Instagram
 * to TikTok?" Brain-dump screenshots already land per platform in
 * engagement_events as event_type='marketing_metric' rows (see
 * src/lib/services/ingestion/storefront-analytics.ts) — but nothing rolled
 * them up by month or compared platforms against each other, so this
 * question always got an honest refusal even though the data existed.
 *
 * marketing_metric rows never enter the acquisition funnel
 * (touchpoints.ts's engagementToTouchType returns null for them — they are
 * platform-side observations, not a couple taking a step) so this source
 * reads engagement_events directly rather than through a canonical reader.
 *
 * Design choices, stated so a later reader doesn't have to reverse them:
 *   - 'volume' sums every non-spend metric value recorded for a platform in
 *     a month. Screenshots carry different metrics per platform (likes,
 *     followers, sessions, impressions...) and mixing them is a real
 *     simplification, but a venue coordinator drops one dashboard at a
 *     time and the source names exactly which metrics it summed
 *     (`metricsIncluded`) so the number is auditable, not hidden maths.
 *   - `spend` is excluded — it's a cost, not engagement, and folding it in
 *     would corrupt the figure the question is actually asking about.
 *   - A platform with zero rows in a given month is `volume: null`, never
 *     a fake 0 (INTEL-CANONICAL-API.md honesty contract, types.ts). Share
 *     and month-over-month share change are null wherever the volume they
 *     would be built from is null.
 *   - Google rolls up google / google_analytics / google_business /
 *     google_ads into one figure — a shift question wants one Google
 *     number, not three (the same collapsing /intel/reach does per-metric
 *     but a shift comparison needs at the platform level).
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { labelToDay } from '@/lib/services/intel/correlation-engine'
import type { IntelToolSource, ToolSourceDeps } from './types'

export const TOOL_GET_PLATFORM_SHIFT = 'get_platform_engagement_shift'

/** The five platforms this source tracks, and the metadata.source keys
 *  that roll up into each. */
export const PLATFORM_GROUPS: Record<string, readonly string[]> = {
  instagram: ['instagram'],
  tiktok: ['tiktok'],
  facebook: ['facebook'],
  pinterest: ['pinterest'],
  google: ['google', 'google_analytics', 'google_business', 'google_ads'],
}

export const PLATFORM_ORDER = Object.keys(PLATFORM_GROUPS)

export const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook/Meta',
  pinterest: 'Pinterest',
  google: 'Google',
}

/** Cost metrics, not engagement. Excluded from the volume sum. */
const NON_ENGAGEMENT_METRICS = new Set(['spend'])

const DEFAULT_MONTHS = 6
const MIN_MONTHS = 1
const MAX_MONTHS = 24

export interface RawMarketingMetricRow {
  source: string
  metric: string
  label: string
  value: number
}

export interface PlatformMonthPoint {
  /** Calendar month, 'YYYY-MM'. */
  month: string
  /** Sum of non-spend metric values for this platform this month. Null —
   *  never 0 — when no marketing_metric row landed for this platform in
   *  this month. */
  volume: number | null
  /** volume / (sum of every tracked platform's volume this month). Null
   *  when volume is null, or when no tracked platform had any data this
   *  month (nothing to divide by). */
  share: number | null
  /** share minus the immediately preceding month's share. Null unless
   *  both this month and the prior month have a known share — a gap
   *  never gets silently bridged over. */
  shareChangeFromPriorMonth: number | null
}

export interface PlatformShiftSeries {
  platform: string
  label: string
  /** True when at least one marketing_metric row exists for this platform
   *  anywhere in the covered window. False means "no data for this
   *  platform", stated honestly rather than showing an all-zero chart. */
  hasData: boolean
  /** Which metric keys (likes, followers, sessions...) were summed into
   *  volume, so the figure is auditable rather than opaque. */
  metricsIncluded: string[]
  months: PlatformMonthPoint[]
}

export interface PlatformShiftResult {
  n: number
  enoughData: boolean
  reason?: string
  monthsCovered: string[]
  platforms: PlatformShiftSeries[]
  /** Labels of the tracked platforms with no data at all in the window —
   *  named explicitly so a "no data for platform X" reads as a fact, not
   *  a silence. */
  absentPlatforms: string[]
  generatedAt: string
}

function normalizePlatform(source: string): string | null {
  const s = source.toLowerCase().trim()
  for (const platform of PLATFORM_ORDER) {
    if (PLATFORM_GROUPS[platform]!.includes(s)) return platform
  }
  return null
}

function clampMonths(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_MONTHS
  return Math.min(MAX_MONTHS, Math.max(MIN_MONTHS, Math.round(n)))
}

/** Last `n` calendar months ending at the month of `today`, oldest first. */
function lastNMonths(today: string, n: number): string[] {
  const [y, m] = today.split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

function shareFor(volume: number | null, total: number): number | null {
  if (volume === null || total <= 0) return null
  return volume / total
}

/**
 * Pure computation over already-fetched marketing_metric rows. No I/O — the
 * tool source and the /intel/sources card both call this, so they can never
 * disagree (a second derivation of the same question is exactly the bug
 * INTEL-CANONICAL-API.md's "surfaces are dumb renderers" rule exists to
 * prevent).
 */
export function computePlatformShift(
  rows: readonly RawMarketingMetricRow[],
  today: string,
  monthsArg?: unknown,
): PlatformShiftResult {
  const months = clampMonths(monthsArg)
  const monthList = lastNMonths(today, months)
  const monthSet = new Set(monthList)

  const byPlatform = new Map<string, Map<string, number>>()
  const metricsByPlatform = new Map<string, Set<string>>()
  let consideredN = 0

  for (const r of rows) {
    const platform = normalizePlatform(r.source)
    if (!platform) continue
    const metric = r.metric.toLowerCase().trim()
    if (NON_ENGAGEMENT_METRICS.has(metric)) continue
    if (!Number.isFinite(r.value)) continue
    const day = labelToDay(r.label)
    if (!day) continue
    const monthKey = day.slice(0, 7)
    if (!monthSet.has(monthKey)) continue

    consideredN++
    if (!byPlatform.has(platform)) byPlatform.set(platform, new Map())
    const m = byPlatform.get(platform)!
    m.set(monthKey, (m.get(monthKey) ?? 0) + r.value)

    if (!metricsByPlatform.has(platform)) metricsByPlatform.set(platform, new Set())
    metricsByPlatform.get(platform)!.add(metric)
  }

  // Total tracked-platform volume per month, for share. Only platforms with
  // a real row that month contribute — an absent platform never drags the
  // denominator down to a fabricated shape.
  const totalByMonth = new Map<string, number>()
  for (const monthMap of byPlatform.values()) {
    for (const [month, v] of monthMap) {
      totalByMonth.set(month, (totalByMonth.get(month) ?? 0) + v)
    }
  }

  const platforms: PlatformShiftSeries[] = PLATFORM_ORDER.map((platform) => {
    const monthMap = byPlatform.get(platform)
    const hasData = Boolean(monthMap && monthMap.size > 0)

    const monthsOut: PlatformMonthPoint[] = monthList.map((month, i) => {
      const hasVolume = monthMap?.has(month) ?? false
      const volume = hasVolume ? monthMap!.get(month)! : null
      const total = totalByMonth.get(month) ?? 0
      const share = shareFor(volume, total)

      let shareChangeFromPriorMonth: number | null = null
      if (i > 0 && share !== null) {
        const prevMonth = monthList[i - 1]!
        const prevHasVolume = monthMap?.has(prevMonth) ?? false
        const prevVolume = prevHasVolume ? monthMap!.get(prevMonth)! : null
        const prevTotal = totalByMonth.get(prevMonth) ?? 0
        const prevShare = shareFor(prevVolume, prevTotal)
        if (prevShare !== null) shareChangeFromPriorMonth = share - prevShare
      }

      return { month, volume, share, shareChangeFromPriorMonth }
    })

    return {
      platform,
      label: PLATFORM_LABELS[platform]!,
      hasData,
      metricsIncluded: Array.from(metricsByPlatform.get(platform) ?? []).sort(),
      months: monthsOut,
    }
  })

  const absentPlatforms = platforms.filter((p) => !p.hasData).map((p) => p.label)

  return {
    n: consideredN,
    enoughData: consideredN > 0,
    reason:
      consideredN === 0
        ? `No marketing_metric rows for any tracked platform (${PLATFORM_ORDER.map((p) => PLATFORM_LABELS[p]).join(', ')}) in the last ${months} month${months === 1 ? '' : 's'}. Drop a platform-dashboard screenshot into the capture tool to start tracking.`
        : undefined,
    monthsCovered: monthList,
    platforms,
    absentPlatforms,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Fetch + normalise this venue's marketing_metric rows. Shared by the tool
 * source and the /intel/sources API route so both call the exact same
 * computation over the exact same rows.
 *
 * direction='inbound' matches correlation-engine.ts's buildSeries — every
 * marketing_metric row the storefront-analytics importer writes is
 * couple-side platform activity (INV-16), never venue-outbound.
 */
export async function fetchMarketingMetricRows(
  supabase: SupabaseClient,
  venueId: string,
): Promise<RawMarketingMetricRow[]> {
  const { data, error } = await supabase
    .from('engagement_events')
    .select('metadata')
    .eq('venue_id', venueId)
    .eq('event_type', 'marketing_metric')
    .eq('direction', 'inbound')
  if (error) throw new Error(`platform-shift: ${error.message}`)

  const rows: RawMarketingMetricRow[] = []
  for (const r of (data ?? []) as Array<{ metadata: unknown }>) {
    const md = (r.metadata ?? {}) as Record<string, unknown>
    const source = typeof md.source === 'string' ? md.source : null
    const metric = typeof md.metric === 'string' ? md.metric : null
    const label = typeof md.label === 'string' ? md.label : null
    const value = Number(md.value)
    if (!source || !metric || !label || !Number.isFinite(value)) continue
    rows.push({ source, metric, label, value })
  }
  return rows
}

async function run(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<PlatformShiftResult> {
  const rows = await fetchMarketingMetricRows(deps.supabase, venueId)
  return computePlatformShift(rows, deps.today, args.months)
}

const tool: Anthropic.Tool = {
  name: TOOL_GET_PLATFORM_SHIFT,
  description:
    'Monthly engagement volume per marketing platform (Instagram, TikTok, Facebook/Meta, Pinterest, Google), each platform\'s share of tracked engagement, and the change in that share month over month. Built from screenshots the coordinator has dropped into the capture tool. ' +
    'Use this for "is engagement moving from Instagram to TikTok", "which platform is growing", "what is our platform mix", or any question comparing platform engagement over time. ' +
    'A platform with no uploaded data in a month reports as absent, never as a zero.',
  input_schema: {
    type: 'object',
    properties: {
      months: {
        type: 'number',
        description:
          'How many trailing calendar months to cover, ending with the current month. Defaults to 6.',
      },
    },
    additionalProperties: false,
  },
}

export const platformShiftSource: IntelToolSource = {
  tool,
  subjects: [
    'platform engagement volume by month (Instagram, TikTok, Facebook/Meta, Pinterest, Google)',
    'whether engagement is shifting from one platform to another',
    'each platform\'s share of engagement and how that share changed month over month',
  ],
  batteryQuestions: ['42'],
  run,
}
