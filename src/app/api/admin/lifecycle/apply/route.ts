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
import { getPlatformAuth } from '@/lib/api/auth-helpers'
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

  let body: { weddingId?: string }
  try {
    body = (await request.json()) as { weddingId?: string }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.weddingId) {
    return NextResponse.json({ error: 'weddingId required' }, { status: 400 })
  }

  const result = await applyLifecycleTransition({ weddingId: body.weddingId })
  return NextResponse.json({ ok: true, result })
}
