/**
 * POST /api/admin/lifecycle/sweep
 *
 * Wave 11 — run the lifecycle sweep for one venue or all venues.
 *
 * Body: { venueId?: string }
 *
 * Auth: dual — getPlatformAuth (coordinator) OR CRON_SECRET.
 *
 * TODO(reconciliation): register a cron entry for this route as job
 * 'lifecycle_sweep' (daily 04:00 UTC) when vercel.json / cron route
 * are next touched.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { verifyCronAuth } from '@/lib/cron-auth'
import { runLifecycleSweep } from '@/lib/services/lifecycle/sweep'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  let scopedVenueId: string | null = auth?.venueId ?? null
  if (!auth) {
    const cron = verifyCronAuth(request, { jobName: 'lifecycle_sweep' })
    if (!cron.ok) {
      return NextResponse.json(
        { error: 'unauthorized' },
        { status: cron.status ?? 401 },
      )
    }
  }

  let body: { venueId?: string } = {}
  try {
    body = (await request.json().catch(() => ({}))) as { venueId?: string }
  } catch {
    body = {}
  }

  // Coordinator can only sweep their own venue. Cron path (no auth)
  // may pass any venueId or omit.
  const venueId = auth
    ? (scopedVenueId ?? body.venueId ?? undefined)
    : body.venueId

  if (auth && body.venueId && body.venueId !== scopedVenueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const result = await runLifecycleSweep({ venueId })
  return NextResponse.json({ ok: true, result })
}
