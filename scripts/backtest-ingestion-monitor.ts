// ---------------------------------------------------------------------------
// backtest-ingestion-monitor.ts — replay the per-channel ingestion-volume
// detector over 2026-04-01 .. 2026-06-30 for Rixey and print, per ISO week,
// which channels would have alerted.
//
// REMEDIATION-PLAN-2026-07-07.md R2: "Backtest against Apr-Jun data; must
// fire on the Knot regression or it isn't done."
//
// READ-ONLY. Runs the exact detector core the cron uses
// (computeChannelVolumeStats from src/lib/services/ingestion-volume-monitor)
// against historical rows; writes nothing.
//
// TIME-AXIS CAVEAT (verified empirically 2026-07-07): the 2026-07-03 Gmail
// re-sync stamped EVERY historical interactions row with created_at
// 2026-07-03, so an ingest-time (created_at <= asOf) reconstruction of the
// table is impossible — and between the 2026-05-14 Rixey wipe and the
// re-import the live table was near-empty anyway. The replay therefore
// filters on event time (timestamp <= asOf), i.e. the event-time series as
// it exists today. For the Knot channel this is a faithful proxy: the
// emails the regression dropped were never ingested at all, so Apr-Jun Knot
// counts are still depressed today (8 / 4 / 9 inbound vs a ~30-40/month
// baseline) even after the 76-wedding backfill (which minted weddings from
// rows that DID exist, it did not add interactions with new timestamps).
//
// USAGE
//   npx tsx scripts/backtest-ingestion-monitor.ts [venueId]
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  computeChannelVolumeStats,
  LOOKBACK_DAYS,
  RECENT_WINDOW_DAYS,
  MIN_BASELINE_MEDIAN,
  ALERT_RATIO,
  CRITICAL_RATIO,
  type IngestionEventRow,
  type ChannelVolumeStat,
} from '../src/lib/services/ingestion-volume-monitor'

// ---------------------------------------------------------------------------
// Env — mirror .env.local onto process.env (same pattern as run-battery.ts)
// ---------------------------------------------------------------------------

function loadEnv(): void {
  if (!existsSync('.env.local')) {
    console.error('[backtest] .env.local not found in cwd. Run from the repo root.')
    process.exit(1)
  }
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  ) as Record<string, string>
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
}

loadEnv()

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const venueId = process.argv[2] ?? RIXEY

const BACKTEST_START = new Date('2026-04-01T12:00:00Z')
const BACKTEST_END = new Date('2026-06-30T12:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } },
)

async function fetchRows(): Promise<IngestionEventRow[]> {
  const sinceIso = new Date(
    BACKTEST_START.getTime() - LOOKBACK_DAYS * DAY_MS,
  ).toISOString()
  const untilIso = BACKTEST_END.toISOString()
  const rows: IngestionEventRow[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('interactions')
      .select('timestamp, from_email, type')
      .eq('venue_id', venueId)
      .eq('direction', 'inbound')
      .gte('timestamp', sinceIso)
      .lte('timestamp', untilIso)
      .order('timestamp', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[backtest] Query error:', error.message)
      process.exit(1)
    }
    rows.push(...((data ?? []) as IngestionEventRow[]))
    if (!data || data.length < PAGE) break
  }
  return rows
}

/** ISO week key like 2026-W14 (Monday-based). */
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

interface WeekAgg {
  weekStart: string
  daysAlerted: Map<string, number> // channel -> alerting day count
  worstSeverity: Map<string, string>
  sampleStat: Map<string, ChannelVolumeStat> // last day's stat that week
  totalDays: number
}

async function main(): Promise<void> {
  console.log(`Ingestion-volume monitor backtest — venue ${venueId}`)
  console.log(
    `Rule: trailing ${RECENT_WINDOW_DAYS}d count vs median ${RECENT_WINDOW_DAYS}d count ` +
      `over prior ~90d; alert when baseline >= ${MIN_BASELINE_MEDIAN} AND ` +
      `recent < ${ALERT_RATIO * 100}% of baseline (critical < ${CRITICAL_RATIO * 100}%).`,
  )
  console.log(
    `Replaying as-of each day ${BACKTEST_START.toISOString().slice(0, 10)} .. ` +
      `${BACKTEST_END.toISOString().slice(0, 10)} on event time (see header caveat).\n`,
  )

  const rows = await fetchRows()
  console.log(`Loaded ${rows.length} inbound interactions (read-only).\n`)

  const weeks = new Map<string, WeekAgg>()
  const allChannels = new Set<string>()

  for (
    let t = BACKTEST_START.getTime();
    t <= BACKTEST_END.getTime();
    t += DAY_MS
  ) {
    const asOf = new Date(t)
    const stats = computeChannelVolumeStats(rows, asOf)
    const wk = isoWeekKey(asOf)
    let agg = weeks.get(wk)
    if (!agg) {
      agg = {
        weekStart: asOf.toISOString().slice(0, 10),
        daysAlerted: new Map(),
        worstSeverity: new Map(),
        sampleStat: new Map(),
        totalDays: 0,
      }
      weeks.set(wk, agg)
    }
    agg.totalDays++
    for (const s of stats) {
      allChannels.add(s.channel)
      agg.sampleStat.set(s.channel, s)
      if (s.alerted) {
        agg.daysAlerted.set(s.channel, (agg.daysAlerted.get(s.channel) ?? 0) + 1)
        if (s.severity === 'critical' || !agg.worstSeverity.has(s.channel)) {
          agg.worstSeverity.set(s.channel, s.severity as string)
        }
      }
    }
  }

  // ---- Per-week table -----------------------------------------------------
  const channels = [...allChannels].sort()
  const header =
    'week      (start)     | ' + channels.map((c) => c.padEnd(14)).join('| ')
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const [wk, agg] of [...weeks.entries()].sort()) {
    const cells = channels.map((c) => {
      const days = agg.daysAlerted.get(c) ?? 0
      if (days === 0) return '.'.padEnd(14)
      const sev = agg.worstSeverity.get(c) === 'critical' ? 'CRIT' : 'warn'
      return `${sev} ${days}/${agg.totalDays}d`.padEnd(14)
    })
    console.log(`${wk} (${agg.weekStart}) | ${cells.join('| ')}`)
  }

  // ---- Knot detail --------------------------------------------------------
  console.log('\nKnot channel detail (last replay day of each week):')
  console.log('week      | recent 21d | baseline 21d | ratio  | alert')
  for (const [wk, agg] of [...weeks.entries()].sort()) {
    const s = agg.sampleStat.get('knot')
    if (!s) continue
    const ratio = s.ratio !== null ? `${Math.round(s.ratio * 100)}%` : 'n/a'
    console.log(
      `${wk}  | ${String(s.recentCount).padStart(10)} | ${String(s.baselineMedian).padStart(12)} | ` +
        `${ratio.padStart(6)} | ${s.alerted ? (s.severity === 'critical' ? 'CRITICAL' : 'warning') : '-'}`,
    )
  }

  // ---- Hard requirement check --------------------------------------------
  const knotWeeksAlerted = [...weeks.values()].filter(
    (a) => (a.daysAlerted.get('knot') ?? 0) > 0,
  ).length
  const totalWeeks = weeks.size
  console.log(
    `\nKnot alerted in ${knotWeeksAlerted}/${totalWeeks} weeks of the regression window.`,
  )
  if (knotWeeksAlerted === 0) {
    console.error('BACKTEST FAILED: detector never fired on the Knot regression.')
    process.exit(1)
  }
  console.log('BACKTEST PASSED: detector fires on the Knot regression shape.')
}

main().catch((err) => {
  console.error('[backtest] Fatal:', err)
  process.exit(1)
})
