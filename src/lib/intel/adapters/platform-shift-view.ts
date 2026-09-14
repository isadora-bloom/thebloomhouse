/**
 * Platform-shift view model — the ONE shape the /intel/sources card and the
 * `get_platform_engagement_shift` tool both stand behind.
 *
 * Pure: takes a PlatformShiftResult (src/lib/intel/tool-sources/platform-
 * shift.ts) and turns it into display-ready rows plus one headline sentence.
 * Nothing here touches a database or recomputes a rate — it re-labels,
 * formats, and picks the two platforms furthest apart in share movement so
 * the card can say something plainer than "here are five numbers."
 *
 * Pure. Unit-tested in ./__tests__/platform-shift-view.test.ts.
 */

import type { PlatformShiftResult, PlatformShiftSeries } from '@/lib/intel/tool-sources/platform-shift'

/** Smallest share-window a platform needs on both ends before its movement
 *  counts toward the headline. Guards against a single stray screenshot
 *  ("Pinterest went from 1% to 3%") reading as a meaningful shift. */
const MIN_SHARE_FOR_HEADLINE = 0.05

export interface PlatformShiftMonthView {
  month: string
  /** 'Jan 2026' style label for display. */
  monthLabel: string
  volumeText: string
  shareText: string
  shareChangeText: string
}

export interface PlatformShiftRowView {
  platform: string
  label: string
  hasData: boolean
  metricsIncluded: string[]
  months: PlatformShiftMonthView[]
  /** Share on the earliest month this platform has data, within the window. */
  earliestShare: number | null
  /** Share on the latest month this platform has data, within the window. */
  latestShare: number | null
  /** latestShare - earliestShare, when both are known. The number the
   *  headline is built from. */
  shareDelta: number | null
}

export interface PlatformShiftView {
  monthsCovered: string[]
  monthLabels: string[]
  rows: PlatformShiftRowView[]
  absentPlatforms: string[]
  headline: string
  enoughData: boolean
  reason?: string
  generatedAt: string
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1))
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function pct(v: number | null): string {
  if (v === null) return '—'
  return `${Math.round(v * 100)}%`
}

function signedPct(v: number | null): string {
  if (v === null) return '—'
  const rounded = Math.round(v * 100)
  if (rounded === 0) return '0pp'
  return `${rounded > 0 ? '+' : ''}${rounded}pp`
}

function buildRow(series: PlatformShiftSeries): PlatformShiftRowView {
  const withShare = series.months.filter((m) => m.share !== null)
  const earliestShare = withShare.length > 0 ? withShare[0]!.share : null
  const latestShare = withShare.length > 0 ? withShare[withShare.length - 1]!.share : null
  const shareDelta =
    earliestShare !== null && latestShare !== null ? latestShare - earliestShare : null

  return {
    platform: series.platform,
    label: series.label,
    hasData: series.hasData,
    metricsIncluded: series.metricsIncluded,
    months: series.months.map((m) => ({
      month: m.month,
      monthLabel: monthLabel(m.month),
      volumeText: m.volume === null ? 'no data' : m.volume.toLocaleString(),
      shareText: pct(m.share),
      shareChangeText: signedPct(m.shareChangeFromPriorMonth),
    })),
    earliestShare,
    latestShare,
    shareDelta,
  }
}

/** One sentence naming the biggest gainer and biggest loser, when their
 *  movement is real enough to say something about. Honest fallbacks when
 *  there isn't enough to compare. */
function buildHeadline(result: PlatformShiftResult, rows: PlatformShiftRowView[]): string {
  if (!result.enoughData) {
    return result.reason ?? 'No platform engagement data yet.'
  }

  const comparable = rows.filter(
    (r) => r.shareDelta !== null && (r.earliestShare! >= MIN_SHARE_FOR_HEADLINE || r.latestShare! >= MIN_SHARE_FOR_HEADLINE),
  )
  if (comparable.length < 2) {
    const dataLabels = rows.filter((r) => r.hasData).map((r) => r.label)
    if (dataLabels.length === 0) return 'No platform engagement data yet.'
    if (dataLabels.length === 1) {
      return `Only ${dataLabels[0]} has data in this window — not enough platforms to compare a shift.`
    }
    return `Data exists for ${dataLabels.join(', ')}, but not enough overlapping months yet to call a shift either way.`
  }

  const gainer = [...comparable].sort((a, b) => (b.shareDelta ?? 0) - (a.shareDelta ?? 0))[0]!
  const loser = [...comparable].sort((a, b) => (a.shareDelta ?? 0) - (b.shareDelta ?? 0))[0]!

  if (gainer.platform === loser.platform || gainer.shareDelta === null || loser.shareDelta === null) {
    return 'Platform shares have held roughly steady across the window.'
  }

  const gainerMoved = Math.abs(gainer.shareDelta) >= 0.03
  const loserMoved = Math.abs(loser.shareDelta) >= 0.03
  if (!gainerMoved && !loserMoved) {
    return 'Platform shares have held roughly steady across the window.'
  }

  return (
    `Engagement is shifting from ${loser.label} to ${gainer.label}: ` +
    `${loser.label}'s share went from ${pct(loser.earliestShare)} to ${pct(loser.latestShare)}, ` +
    `while ${gainer.label}'s went from ${pct(gainer.earliestShare)} to ${pct(gainer.latestShare)}.`
  )
}

export function buildPlatformShiftView(result: PlatformShiftResult): PlatformShiftView {
  const rows = result.platforms.map(buildRow)
  return {
    monthsCovered: result.monthsCovered,
    monthLabels: result.monthsCovered.map(monthLabel),
    rows,
    absentPlatforms: result.absentPlatforms,
    headline: buildHeadline(result, rows),
    enoughData: result.enoughData,
    reason: result.reason,
    generatedAt: result.generatedAt,
  }
}
