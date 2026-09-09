/**
 * POST /api/onboarding/project/recover-booked-data
 *   body: { projectId: string }
 *
 * Coordinator-facing trigger for the booked-data recovery sweep
 * (src/lib/services/booked-data-recovery.ts, shared with the daily
 * cron and the service-role-only /api/admin/recover-booked-data
 * route). This is a separate, coordinator-authed entry point rather
 * than reusing the admin route — that one is gated on CRON_SECRET /
 * TEST_HARNESS_SECRET and was never reachable from the onboarding-
 * project UI (a coordinator has neither secret).
 *
 * Same venue-ownership check as /api/onboarding/project/activate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { recoverBookedDataForVenue } from '@/lib/services/booked-data-recovery'

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { projectId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.projectId || !/^[0-9a-f-]{36}$/i.test(body.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: project } = await supabase
    .from('onboarding_projects')
    .select('venue_id')
    .eq('id', body.projectId)
    .maybeSingle()
  if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 })
  const projectVenueId = project.venue_id as string

  if (projectVenueId !== auth.venueId) {
    if (auth.role !== 'org_admin' && auth.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const { data: venue } = await supabase
      .from('venues')
      .select('org_id')
      .eq('id', projectVenueId)
      .maybeSingle()
    if (!venue || (auth.orgId && (venue.org_id as string | null) !== auth.orgId)) {
      return NextResponse.json({ error: 'forbidden_other_org' }, { status: 403 })
    }
  }

  const report = await recoverBookedDataForVenue(supabase, projectVenueId)
  return NextResponse.json({ ok: true, report })
}
