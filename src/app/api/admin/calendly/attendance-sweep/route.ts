/**
 * Calendly attendance sweep — D9 outcome-classifier daily cron.
 *
 * POST { venueId?, bookingLimit? }
 *   Walks tour_booked touchpoints whose tour time is past + lag and
 *   have no terminal outcome (attended / no_show / cancelled). Inserts
 *   tour_attended per booking. Idempotent.
 *
 * Auth: CRON_SECRET (cron path, venueId in body) or platform-auth
 * (caller's venue is used). Same pattern as the cohort-funnel +
 * couple-attribution + tracer-rebind endpoints.
 *
 * Doctrine: this never assumes tour_no_show. No-show is operator-
 * marked. Defaulting attendance preserves real-world truth (most
 * booked tours actually happen).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { sweepPastBookingsForAttendance } from '@/lib/services/identity/calendly-outcomes'

export const maxDuration = 120

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    venueId?: string
    bookingLimit?: number
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
  const bookingLimit =
    typeof body.bookingLimit === 'number' && body.bookingLimit > 0
      ? Math.min(body.bookingLimit, 5000)
      : 500

  try {
    const result = await sweepPastBookingsForAttendance(supabase, venueId, {
      bookingLimit,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[calendly-attendance-sweep] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
