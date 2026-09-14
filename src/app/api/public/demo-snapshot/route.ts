/**
 * GET /api/public/demo-snapshot — W58 (NOVEMBER-PLAN.md Wave 8).
 *
 * The Bloom-side hook the marketing site's live demo polls. No auth, no
 * cookies, no request body. Serves a read-only snapshot of ONE fixed
 * venue — the Crestwood demo venue (`PUBLIC_DEMO_VENUE_ID`, currently
 * Hawthorne Manor) — never a venue named by the caller. There is no
 * `venueId` request parameter anywhere in this file: the id is a
 * server-side constant, so there is nothing in the request a caller
 * could tamper with to reach a real venue's data.
 *
 * Belt AND braces: even with a hardcoded id, `loadDemoSnapshot` re-checks
 * `venues.is_demo` on every call before reading anything else. If that
 * constant is ever pointed at a non-demo venue (a bug, a bad edit), the
 * route refuses rather than serving real-venue data. That refusal path
 * is exercised directly in the tests by calling `loadDemoSnapshot` with
 * a venue id a fake `is_demo=false`.
 *
 * Composition only — every number here comes from an existing canonical
 * reader or adapter, unmodified:
 *   - `loadDailyList`            (`@/lib/intel/canonical`)            — the four /today blocks
 *   - `loadMonthlyStory` + `buildMonthlyStoryView` (`@/lib/intel/adapters/monthly-story`) — the monthly-story panels
 *   - `loadCohortData` + `buildHeatReport` (`@/lib/services/cohort/{data,heat}`) — the heat distribution
 *   - `listExistingNarrations`   (`@/lib/services/insights/correlation-narration`) — correlation insights (READ-ONLY, no LLM call, no write)
 *
 * Names in the response are whatever is stored against the demo venue
 * (the fictional Crestwood roster — see `scripts/demo-reseed/roster.ts`).
 * Nothing here generates or rewrites a name.
 *
 * Cross-origin: the marketing site is a different origin, so this route
 * echoes back the request's Origin header only when it is present in the
 * comma-separated `PUBLIC_DEMO_ALLOWED_ORIGINS` allow-list. Any other
 * origin (including none listed) gets refused before any DB read.
 *
 * Rate limit: generous — this is a public marketing surface meant to be
 * polled, not a per-couple data endpoint. 60/min per IP via the existing
 * durable limiter (`@/lib/rate-limit`).
 *
 * Cache: `public, s-maxage=300, stale-while-revalidate=600` — the repo
 * has no existing cache-header pattern for API routes (checked), so this
 * follows NOVEMBER-PLAN.md's fallback directly. `generated_at` /
 * `next_refresh_at` in the body let the marketing site know when to poll
 * again without a second push channel.
 */

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'
import { DEMO_VENUE_ID } from '@/lib/services/demo-token'
import { loadDailyList, type DailyListItem, type TourRef } from '@/lib/intel/canonical'
import { loadMonthlyStory, buildMonthlyStoryView } from '@/lib/intel/adapters/monthly-story'
import { loadCohortData } from '@/lib/services/cohort/data'
import { buildHeatReport, type HeatBandCell } from '@/lib/services/cohort/heat'
import { listExistingNarrations } from '@/lib/services/insights/correlation-narration'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ---------------------------------------------------------------------------
// Config — the ONE venue this route will ever serve. Never read from the
// request. See the module doc above for why this is checked twice: once
// by being the only id in scope, and once again by `loadDemoSnapshot`'s
// live `is_demo` read.
// ---------------------------------------------------------------------------

export const PUBLIC_DEMO_VENUE_ID = DEMO_VENUE_ID

const CACHE_WINDOW_SEC = 300
const RATE_LIMIT_PER_MIN = 60

// Rows shown per /today block. NOVEMBER-PLAN.md W58: "top three rows".
const TOP_ROWS = 3
// Insight narrations shown. NOVEMBER-PLAN.md W58: "three recent
// correlation insights". listExistingNarrations already caps + orders
// by surface_priority desc, so slicing the first three here matches.
const TOP_INSIGHTS = 3

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export interface DemoSnapshotTodayRow {
  id: string
  names: string | null
}

export interface DemoSnapshotTourRow extends DemoSnapshotTodayRow {
  scheduledAt: string
}

export interface DemoSnapshotTodayBlock<Row> {
  count: number
  topRows: Row[]
}

export interface DemoSnapshotMonthlyPanelRow {
  label: string
  value: string
  note: string | null
}

export interface DemoSnapshotMonthlyPanel {
  key: string
  title: string
  headline: string
  isFinding: boolean
  rows: DemoSnapshotMonthlyPanelRow[]
  empty: string | null
}

export interface DemoSnapshotInsight {
  title: string
  body: string
}

export interface DemoSnapshot {
  generated_at: string
  next_refresh_at: string
  venue: { name: string; slug: string }
  today: {
    needsReply: DemoSnapshotTodayBlock<DemoSnapshotTodayRow>
    goingCold: DemoSnapshotTodayBlock<DemoSnapshotTodayRow>
    toursThisWeek: DemoSnapshotTodayBlock<DemoSnapshotTourRow>
    highIntent: DemoSnapshotTodayBlock<DemoSnapshotTodayRow>
  }
  monthlyStory: DemoSnapshotMonthlyPanel[]
  heat: { bands: HeatBandCell[] }
  insights: DemoSnapshotInsight[]
}

export type DemoSnapshotResult =
  | { ok: true; snapshot: DemoSnapshot }
  | { ok: false; reason: 'not_a_demo_venue' | 'venue_not_found' }

function toTodayRow(item: DailyListItem): DemoSnapshotTodayRow {
  return { id: item.id, names: item.names }
}

function toTourRow(item: TourRef): DemoSnapshotTourRow {
  return { id: item.id, names: item.names ?? null, scheduledAt: item.scheduledAt }
}

function toBlock<T, R>(rows: T[], map: (row: T) => R): DemoSnapshotTodayBlock<R> {
  return { count: rows.length, topRows: rows.slice(0, TOP_ROWS).map(map) }
}

/**
 * Injectable core — same shape as `canonical.ts`'s loadXxx / getXxx split.
 * Tested directly with a fake client, no server, no HTTP.
 *
 * `venueId` is a parameter (not read from module state) so the
 * "config points at a non-demo venue" refusal is testable by simply
 * passing an id whose `is_demo` row the fake returns false for — the
 * production route only ever calls this with `PUBLIC_DEMO_VENUE_ID`.
 */
export async function loadDemoSnapshot(
  supabase: SupabaseClient,
  venueId: string,
): Promise<DemoSnapshotResult> {
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name, slug, is_demo')
    .eq('id', venueId)
    .maybeSingle()

  if (!venueRow) return { ok: false, reason: 'venue_not_found' }
  if (venueRow.is_demo !== true) return { ok: false, reason: 'not_a_demo_venue' }

  const generatedAt = new Date()
  const nextRefreshAt = new Date(generatedAt.getTime() + CACHE_WINDOW_SEC * 1000)

  const [daily, monthlyFacts, cohortData, narrations] = await Promise.all([
    loadDailyList(supabase, venueId),
    loadMonthlyStory(supabase, venueId),
    loadCohortData(supabase, venueId, {}),
    listExistingNarrations(supabase, venueId),
  ])

  const monthlyView = buildMonthlyStoryView(monthlyFacts)
  const heatReport = buildHeatReport(cohortData)

  const snapshot: DemoSnapshot = {
    generated_at: generatedAt.toISOString(),
    next_refresh_at: nextRefreshAt.toISOString(),
    venue: {
      name: (venueRow.name as string | null) ?? '',
      slug: (venueRow.slug as string | null) ?? '',
    },
    today: {
      needsReply: toBlock(daily.needsReply, toTodayRow),
      goingCold: toBlock(daily.goingCold, toTodayRow),
      toursThisWeek: toBlock(daily.toursThisWeek, toTourRow),
      highIntent: toBlock(daily.highIntent, toTodayRow),
    },
    monthlyStory: monthlyView.panels.map((p) => ({
      key: p.key,
      title: p.title,
      headline: p.headline,
      isFinding: p.isFinding,
      rows: p.rows.map((r) => ({ label: r.label, value: r.value, note: r.note })),
      empty: p.empty,
    })),
    heat: { bands: heatReport.bands },
    insights: narrations.slice(0, TOP_INSIGHTS).map((n) => ({ title: n.title, body: n.body })),
  }

  return { ok: true, snapshot }
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function allowedOrigins(): string[] {
  return (process.env.PUBLIC_DEMO_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
}

/** Returns the CORS headers for `origin`, or null when it is not allowed
 *  (no `PUBLIC_DEMO_ALLOWED_ORIGINS` set, or the origin isn't in it). */
function corsHeadersFor(origin: string | null): HeadersInit | null {
  if (!origin) return null
  const allowed = allowedOrigins()
  if (!allowed.includes(origin)) return null
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  }
}

export function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin')
  const headers = corsHeadersFor(origin)
  if (!headers) {
    return new NextResponse(null, { status: 403 })
  }
  return new NextResponse(null, {
    status: 204,
    headers: { ...headers, 'Access-Control-Max-Age': '86400' },
  })
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin')
  const cors = corsHeadersFor(origin)
  // Browsers only send Origin on cross-origin requests; a same-origin or
  // non-browser caller (curl, server-to-server) has no Origin header at
  // all and is let through with no CORS headers attached (nothing to
  // restrict — there's no browser page reading the response). A caller
  // that DOES send an Origin not on the allow-list is refused outright.
  if (origin && !cors) {
    return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
  }

  const ip = clientIpForRateLimit(request)
  const rl = await checkRateLimit({
    key: `public-demo-snapshot:${ip}`,
    limit: RATE_LIMIT_PER_MIN,
    windowSec: 60,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: {
          ...(cors ?? {}),
          'Retry-After': String(secondsUntil(rl.resetAt)),
        },
      },
    )
  }

  const result = await loadDemoSnapshot(createServiceClient(), PUBLIC_DEMO_VENUE_ID)
  if (!result.ok) {
    // Never leak which case this is beyond "not available" — both
    // reasons mean the same thing to a caller: nothing to serve.
    console.error(`[api/public/demo-snapshot] refused: ${result.reason}`)
    return NextResponse.json(
      { error: 'Demo snapshot is not available' },
      { status: 503, headers: cors ?? {} },
    )
  }

  return NextResponse.json(result.snapshot, {
    status: 200,
    headers: {
      ...(cors ?? {}),
      'Cache-Control': `public, s-maxage=${CACHE_WINDOW_SEC}, stale-while-revalidate=600`,
    },
  })
}
