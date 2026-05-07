/**
 * GET  /api/onboarding/backfill?venueId=...
 *   → backfill status for the venue: per-category coverage + score.
 *
 * POST /api/onboarding/backfill
 *   body: { category: 'weather' | 'search_trends' | 'fred' }
 *   → triggers the External Context fetcher for the requested category.
 *     Internal Context categories (marketing_spend, pricing_history,
 *     etc.) are coordinator-entered through the existing admin UIs;
 *     this endpoint only handles the auto-fetchable external ones.
 *
 * POST /api/onboarding/backfill?action=skip
 *   body: { category, reason }
 *   → coordinator marks a category as skipped (e.g., venue has no
 *     historical pricing because brand-new).
 *
 * Auth: getPlatformAuth — coordinator must be signed in. Org admins
 * can target any venue in their org via ?venueId=; coordinators only
 * their own.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  refreshBackfillStatus,
  computeBackfillScore,
  skipBackfillCategory,
  type BackfillCategory,
} from '@/lib/services/onboarding-backfill'
import { fetchTrendsForVenue } from '@/lib/services/intel/trends'
import { fetchAllDefaultFredSeries } from '@/lib/services/external-context/fred-fetch'
import { fetchHistoricalWeather } from '@/lib/services/intel/weather'

const VALID_CATEGORIES: ReadonlyArray<BackfillCategory> = [
  'email_history', 'marketing_spend', 'pricing_history',
  'absences', 'property_state', 'marketing_channels',
  'weather', 'search_trends', 'fred', 'cultural_moments',
]

async function resolveVenueId(request: NextRequest): Promise<{ ok: true; venueId: string; userId: string | null } | { ok: false; status: number; error: string }> {
  const auth = await getPlatformAuth()
  if (!auth) return { ok: false, status: 401, error: 'unauthorized' }

  const queryVenueId = request.nextUrl.searchParams.get('venueId')
  if (!queryVenueId) return { ok: true, venueId: auth.venueId, userId: auth.userId }

  if (queryVenueId === auth.venueId) return { ok: true, venueId: queryVenueId, userId: auth.userId }

  // Cross-venue access requires org-admin role + same org.
  if (auth.role !== 'org_admin' && auth.role !== 'super_admin') {
    return { ok: false, status: 403, error: 'forbidden' }
  }
  const supabase = createServiceClient()
  const { data: target } = await supabase
    .from('venues')
    .select('id, org_id')
    .eq('id', queryVenueId)
    .maybeSingle()
  if (!target) return { ok: false, status: 404, error: 'venue_not_found' }
  if (auth.orgId && (target.org_id as string | null) !== auth.orgId) {
    return { ok: false, status: 403, error: 'forbidden_other_org' }
  }
  return { ok: true, venueId: queryVenueId, userId: auth.userId }
}

export async function GET(request: NextRequest) {
  const resolved = await resolveVenueId(request)
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }
  const supabase = createServiceClient()
  const { score, coverages, categoriesRequired } = await computeBackfillScore(supabase, resolved.venueId)
  return NextResponse.json({
    venueId: resolved.venueId,
    score,
    coverages,
    categoriesRequired,
  })
}

export async function POST(request: NextRequest) {
  const resolved = await resolveVenueId(request)
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }

  let body: { category?: string; reason?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const category = body.category as BackfillCategory | undefined
  if (!category || !VALID_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: 'invalid_category' }, { status: 400 })
  }

  const action = request.nextUrl.searchParams.get('action')
  const supabase = createServiceClient()

  // Skip path.
  if (action === 'skip') {
    if (!body.reason || body.reason.trim().length < 4) {
      return NextResponse.json({ error: 'reason_required' }, { status: 400 })
    }
    await skipBackfillCategory(supabase, {
      venueId: resolved.venueId,
      category,
      reason: body.reason.trim().slice(0, 500),
      skippedBy: resolved.userId,
    })
    const { score, coverages } = await computeBackfillScore(supabase, resolved.venueId)
    return NextResponse.json({ ok: true, action: 'skipped', score, coverages })
  }

  // Trigger path. Only the External Context categories are auto-
  // fetchable; Internal categories require coordinator data entry.
  if (category === 'weather') {
    const startDate = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
    const endDate = new Date().toISOString().slice(0, 10)
    const records = await fetchHistoricalWeather(resolved.venueId, startDate, endDate)
    const fresh = await refreshBackfillStatus(supabase, resolved.venueId)
    return NextResponse.json({ ok: true, category, fetched: records.length, coverages: fresh })
  }

  if (category === 'search_trends') {
    const upserted = await fetchTrendsForVenue(resolved.venueId, { dateRange: 'today 12-m' })
    const fresh = await refreshBackfillStatus(supabase, resolved.venueId)
    return NextResponse.json({ ok: true, category, upserted, coverages: fresh })
  }

  if (category === 'fred') {
    const results = await fetchAllDefaultFredSeries()
    const fresh = await refreshBackfillStatus(supabase, resolved.venueId)
    return NextResponse.json({ ok: true, category, results, coverages: fresh })
  }

  // Internal categories: just refresh status — the coordinator's
  // data-entry on the admin pages is the actual backfill action.
  const fresh = await refreshBackfillStatus(supabase, resolved.venueId)
  return NextResponse.json({
    ok: true,
    category,
    note: 'Internal Context category — coordinator must enter rows via the admin UI; this endpoint only re-evaluates status.',
    coverages: fresh,
  })
}
