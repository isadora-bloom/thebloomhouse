import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * GET /api/intel/sources/wedding-rollup
 *
 * Server-side aggregation of `weddings` (status IN booked/completed,
 * merged_into_id IS NULL) grouped by (source, venue_id). Backs the
 * Total Revenue / Total Bookings tiles + Source Comparison HoneyBook
 * row on /intel/sources.
 *
 * Why this exists (T5-Rixey-JJJ): the page previously read weddings
 * via the BROWSER anon supabase client, which RLS denies for logged-out
 * / cross-venue users. The page silently received zero rows so Total
 * Revenue showed $0 even though the database had $794K of HoneyBook
 * revenue. This endpoint uses the service-role client so the math is
 * computed against the truth.
 *
 * The merged_into_id IS NULL filter prevents double-counting deduped
 * HoneyBook rows (matches scripts/rixey-load/check-source-attribution.sql
 * semantics).
 *
 * Query params (all optional):
 *   ?venue_id=UUID    — single venue (defaults to auth.venueId)
 *   ?group_id=UUID    — every venue in this venue_group
 *   ?org_id=UUID      — every venue in this org
 *
 * Response:
 *   {
 *     rows: Array<{
 *       source_key: string         // snake_case — never coordinator-formatted
 *       venue_id: string
 *       venue_name: string
 *       bookings: number
 *       revenue_cents: number
 *     }>,
 *     totals: { bookings, revenue_cents }
 *   }
 *
 * NULL `weddings.source` is returned as `source_key: 'unknown'` to
 * match the page's existing convention.
 *
 * Gated behind the `intelligence` plan tier.
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = request.nextUrl.searchParams
  const venueIdParam = sp.get('venue_id')
  const groupIdParam = sp.get('group_id')
  const orgIdParam = sp.get('org_id')

  const sb = createServiceClient()

  try {
    // ---- Resolve target venue IDs based on scope ----
    // Same pattern the funnel route uses inline (no shared helper at
    // src/lib/services/scope.ts as of this stream).
    let venueIds: string[] = []
    if (groupIdParam) {
      const { data: members } = await sb
        .from('venue_group_members')
        .select('venue_id')
        .eq('group_id', groupIdParam)
      venueIds = (members ?? []).map((m) => m.venue_id as string)
    } else if (orgIdParam) {
      const { data: orgVenues } = await sb
        .from('venues')
        .select('id')
        .eq('org_id', orgIdParam)
      venueIds = (orgVenues ?? []).map((v) => v.id as string)
    } else if (venueIdParam) {
      venueIds = [venueIdParam]
    } else {
      venueIds = [auth.venueId]
    }
    if (venueIds.length === 0) {
      return NextResponse.json({ rows: [], totals: { bookings: 0, revenue_cents: 0 } })
    }

    // ---- Venue name lookup so each row carries the human label ----
    const { data: venueRows } = await sb
      .from('venues')
      .select('id, name')
      .in('id', venueIds)
    const venueNameById = new Map<string, string>()
    for (const v of venueRows ?? []) {
      venueNameById.set(v.id as string, ((v.name as string | null) ?? '') as string)
    }

    // ---- Read weddings (terminal statuses + non-merged only) ----
    // status IN booked/completed: in-flight inquiries are not revenue.
    // merged_into_id IS NULL: dedupe survivors only — stops double-counting
    // the HoneyBook rows that were merged into existing weddings.
    const { data: weddings, error } = await sb
      .from('weddings')
      .select('venue_id, source, booking_value')
      .in('status', ['booked', 'completed'])
      .is('merged_into_id', null)
      .in('venue_id', venueIds)
    if (error) throw error

    // ---- Aggregate to one row per (source_key, venue_id) ----
    // Server keeps the snake_case source_key — the coordinator-facing
    // label transformation happens client-side (formatSourceLabel).
    interface AggCell {
      source_key: string
      venue_id: string
      venue_name: string
      bookings: number
      revenue_cents: number
    }
    const cells = new Map<string, AggCell>()
    let totalBookings = 0
    let totalRevenueCents = 0
    for (const w of (weddings ?? []) as Array<{
      venue_id: string
      source: string | null
      booking_value: number | null
    }>) {
      const sourceKey = ((w.source ?? '').toString().trim().toLowerCase()) || 'unknown'
      const venueId = w.venue_id
      const key = `${sourceKey}|${venueId}`
      let cell = cells.get(key)
      if (!cell) {
        cell = {
          source_key: sourceKey,
          venue_id: venueId,
          venue_name: venueNameById.get(venueId) ?? '',
          bookings: 0,
          revenue_cents: 0,
        }
        cells.set(key, cell)
      }
      cell.bookings += 1
      const cents = Number(w.booking_value ?? 0)
      cell.revenue_cents += Number.isFinite(cents) ? cents : 0
      totalBookings += 1
      totalRevenueCents += Number.isFinite(cents) ? cents : 0
    }

    return NextResponse.json({
      rows: Array.from(cells.values()),
      totals: { bookings: totalBookings, revenue_cents: totalRevenueCents },
    })
  } catch (err) {
    console.error('[api/intel/sources/wedding-rollup]', err)
    return NextResponse.json({ error: 'Failed to compute wedding rollup' }, { status: 500 })
  }
}
