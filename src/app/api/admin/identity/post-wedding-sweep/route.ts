/**
 * Post-wedding sweep endpoint - Tier 8 §C.3 (2026-05-20 update).
 *
 * POST { venueId?, limit? }
 *   Flips couples whose lifecycle_state = 'booked' AND wedding_date <
 *   today to 'completed'. Idempotent.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { sweepPastWeddingsToCompleted } from '@/lib/services/identity/post-wedding-sweep'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    venueId?: string
    limit?: number
  }

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string | null = null
  if (cronAuth) {
    if (!body.venueId) {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    venueId = body.venueId
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  const supabase = createServiceClient()
  const limit =
    typeof body.limit === 'number' && body.limit > 0
      ? Math.min(body.limit, 5000)
      : 1000

  try {
    const result = await sweepPastWeddingsToCompleted(supabase, venueId, {
      limit,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[post-wedding-sweep] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
