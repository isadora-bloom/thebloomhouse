/**
 * POST /api/onboarding/project/readiness
 *   body: { projectId: string }
 *
 * Runs the readiness gate (14 structural invariants + 4 smoke tests,
 * src/lib/services/onboarding/readiness.ts) against the project's
 * venue and PERSISTS the verdict via recordReadinessEvaluation. This
 * is the first caller recordReadinessEvaluation has ever had — it
 * shipped with zero writers, so readiness_passed_at could never be
 * set and Go Live could never unlock outside the founder pasting a
 * CLI run's verdict into a coordinator note by hand.
 *
 * Coordinator-only (getPlatformAuth), same venue-ownership check as
 * /api/onboarding/project/activate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { evaluateReadiness } from '@/lib/services/onboarding/readiness'
import { recordReadinessEvaluation } from '@/lib/services/onboarding/project'

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

  const report = await evaluateReadiness(supabase, projectVenueId)

  await recordReadinessEvaluation(supabase, body.projectId, {
    state: { invariants: report.invariants, smoke: report.smoke, evaluated_at: report.evaluatedAt },
    failures: report.invariants.filter((i) => i.count > 0),
    passed: report.readyForGoLive,
  })

  return NextResponse.json({ ok: true, report })
}
