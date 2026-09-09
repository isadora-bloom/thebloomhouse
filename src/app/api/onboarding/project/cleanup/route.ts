/**
 * POST /api/onboarding/project/cleanup
 *   body: { projectId: string, apply?: boolean }
 *
 * Runs the six-step onboarding data-cleanup pipeline
 * (src/lib/services/onboarding/cleanup/) against the project's venue.
 * apply defaults to false — a dry-run preview that computes every
 * count without writing. Pass apply:true to actually write.
 *
 * Previously this pipeline was scripts/onboard-data-cleanup.ts,
 * founder-CLI only, spawning six sibling scripts against production
 * by hand. This route lets a coordinator preview then apply from the
 * onboarding-project UI with no terminal.
 *
 * Coordinator-only (getPlatformAuth), same venue-ownership check as
 * /api/onboarding/project/activate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { runCleanupPipeline } from '@/lib/services/onboarding/cleanup'

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { projectId?: string; apply?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.projectId || !/^[0-9a-f-]{36}$/i.test(body.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 })
  }
  const apply = body.apply === true

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

  const result = await runCleanupPipeline(supabase, projectVenueId, apply)
  return NextResponse.json({ ok: true, result })
}
