/**
 * POST /api/onboarding/project/activate
 *   body: { projectId: string }
 *
 * Wraps activateLive() so the gate (readiness_passed_at + paid-venue
 * backfill score >= 80) runs server-side. Pre-fix the
 * /onboarding/project page did a direct supabase.update bypassing
 * the gate entirely — paid venues could go live with score=0.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { activateLive } from '@/lib/services/onboarding/project'

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

  // Verify caller owns the project's venue (or is org-admin in same org).
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

  const result = await activateLive(supabase, body.projectId)
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        backfill_score: result.backfillScore ?? null,
        missing_categories: result.missingCategories ?? [],
      },
      { status: 409 },
    )
  }
  return NextResponse.json({ ok: true })
}
