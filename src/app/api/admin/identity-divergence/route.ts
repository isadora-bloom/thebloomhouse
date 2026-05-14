/**
 * GET /api/admin/identity-divergence
 *
 * Phase A divergence dashboard for the Identity-First Architecture.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §8 (Phase A) — "divergence
 * dashboard that compares inquiry-derived metrics to person-derived
 * metrics nightly and alerts on drift > 5%". Required deliverable
 * per Appendix B stop condition #1.
 *
 * What this measures
 * ------------------
 * For each venue (scoped to the caller's venue unless super-admin):
 *
 *   weddings_total    — count(weddings) at the venue.
 *   couples_mirrored  — count(couples WHERE source_wedding_id NOT NULL).
 *   drift_count       — weddings_total − couples_mirrored.
 *   drift_pct         — drift_count / weddings_total (0 if weddings_total == 0).
 *
 * A non-zero drift means a wedding exists with no corresponding
 * couples row — either the backfill missed it, the dual-write hook
 * dropped it, or someone bypassed mintWedding entirely. drift_pct
 * > 5% trips the `alerting` flag.
 *
 * Also surfaces identity-quality metrics on the couples side:
 *   couples_with_email — couples WHERE primary_contact_email NOT NULL
 *   couples_placeholder_name — couples WHERE primary_contact_name LIKE '(Unknown%'
 *
 * These don't trip alerts (placeholder names are expected until
 * Phase B Tracer fills them) but they reveal how much identity
 * recovery work Phase B has ahead of it.
 *
 * Auth: getPlatformAuth(). Returns 401 otherwise. Super-admins see
 * every venue; venue users see only their own.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

interface VenueDivergence {
  venue_id: string
  venue_name: string | null
  weddings_total: number
  couples_mirrored: number
  drift_count: number
  drift_pct: number
  alerting: boolean
  couples_with_email: number
  couples_placeholder_name: number
}

interface DivergenceResponse {
  scope: { super_admin: boolean; venue_id: string | null }
  alert_threshold_pct: number
  generated_at: string
  per_venue: VenueDivergence[]
  totals: {
    venues: number
    weddings_total: number
    couples_mirrored: number
    drift_count: number
    drift_pct: number
    alerting_venues: number
  }
}

const ALERT_THRESHOLD = 0.05

async function loadVenueDivergence(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  venueName: string | null,
): Promise<VenueDivergence> {
  const [weddings, mirrored, withEmail, placeholders] = await Promise.all([
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId),
    supabase
      .from('couples')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .not('source_wedding_id', 'is', null),
    supabase
      .from('couples')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .not('primary_contact_email', 'is', null),
    supabase
      .from('couples')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .like('primary_contact_name', '(Unknown%'),
  ])

  const weddings_total = weddings.count ?? 0
  const couples_mirrored = mirrored.count ?? 0
  const drift_count = Math.max(0, weddings_total - couples_mirrored)
  const drift_pct = weddings_total > 0 ? drift_count / weddings_total : 0

  return {
    venue_id: venueId,
    venue_name: venueName,
    weddings_total,
    couples_mirrored,
    drift_count,
    drift_pct,
    alerting: drift_pct > ALERT_THRESHOLD,
    couples_with_email: withEmail.count ?? 0,
    couples_placeholder_name: placeholders.count ?? 0,
  }
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Determine venue scope. Super-admin + org-admin + demo user see all
  // venues; coordinator/manager see only their own venue. The demo
  // user is included so the seeded Crestwood Collection demonstrates
  // the divergence view across multiple venues.
  const role = (auth.role ?? 'coordinator') as string
  const seesAllVenues =
    auth.isDemo || role === 'super_admin' || role === 'org_admin'
  let venueQuery = supabase.from('venues').select('id, name').order('name')
  if (!seesAllVenues && auth.venueId) {
    venueQuery = venueQuery.eq('id', auth.venueId)
  }
  const { data: venues, error: vErr } = await venueQuery
  if (vErr) {
    return NextResponse.json(
      { error: 'venue_lookup_failed', detail: vErr.message },
      { status: 500 },
    )
  }

  const per_venue = await Promise.all(
    (venues ?? []).map((v) => loadVenueDivergence(supabase, v.id, v.name)),
  )

  const weddings_total = per_venue.reduce((s, v) => s + v.weddings_total, 0)
  const couples_mirrored = per_venue.reduce((s, v) => s + v.couples_mirrored, 0)
  const drift_count = Math.max(0, weddings_total - couples_mirrored)
  const drift_pct = weddings_total > 0 ? drift_count / weddings_total : 0
  const alerting_venues = per_venue.filter((v) => v.alerting).length

  const response: DivergenceResponse = {
    scope: { super_admin: seesAllVenues, venue_id: seesAllVenues ? null : auth.venueId },
    alert_threshold_pct: ALERT_THRESHOLD,
    generated_at: new Date().toISOString(),
    per_venue: per_venue.sort((a, b) => b.drift_pct - a.drift_pct),
    totals: {
      venues: per_venue.length,
      weddings_total,
      couples_mirrored,
      drift_count,
      drift_pct,
      alerting_venues,
    },
  }

  return NextResponse.json(response)
}
