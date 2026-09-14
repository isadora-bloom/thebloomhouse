/**
 * POST /api/admin/lifecycle/apply
 *
 * Wave 11 — manually trigger applyLifecycleTransition for one wedding.
 * Used by the coordinator UI "recompute lifecycle stage" button and
 * by ops scripts re-applying the state machine after a bug fix.
 *
 * Body: { weddingId: string }
 *
 * Auth: dual — getPlatformAuth (coordinator) OR CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, refuseDemo } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyCronAuth } from '@/lib/cron-auth'
import { applyLifecycleTransition } from '@/lib/services/lifecycle/transition'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    const cron = verifyCronAuth(request, { jobName: 'lifecycle_apply' })
    if (!cron.ok) {
      return NextResponse.json(
        { error: 'unauthorized' },
        { status: cron.status ?? 401 },
      )
    }
  }

  // The demo identity is an anonymous visitor. A cron caller has no auth
  // object and passes straight through.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal

  let body: { weddingId?: string }
  try {
    body = (await request.json()) as { weddingId?: string }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.weddingId) {
    return NextResponse.json({ error: 'weddingId required' }, { status: 400 })
  }

  // weddingId is whatever the caller sent, and applyLifecycleTransition
  // writes the wedding row and an audit transition as service role. On
  // the coordinator path, confirm the wedding is theirs — the same check
  // the sibling override endpoint has always had. The cron path (auth
  // null) is trusted by its secret and sweeps across venues by design.
  if (auth) {
    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      // legacy-read-ok: an authorisation lookup, not an intelligence read.
      // Same one-column ownership check the sibling override endpoint does.
      .from('weddings')
      .select('id, venue_id')
      .eq('id', body.weddingId)
      .maybeSingle()
    if (!wedding) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    if ((wedding as { venue_id: string }).venue_id !== auth.venueId) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  const result = await applyLifecycleTransition({ weddingId: body.weddingId })
  return NextResponse.json({ ok: true, result })
}
