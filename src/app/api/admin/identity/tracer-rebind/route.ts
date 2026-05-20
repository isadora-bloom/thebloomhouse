/**
 * Tracer rebind endpoint — D9 honesty-card backfill.
 *
 * POST { venueId?, coupleLimit? }
 *   Rebinds mirror-backfilled couples (those with source_wedding_id and
 *   zero touchpoints) by walking their source wedding's interactions and
 *   inserting touchpoints attached to the couple.
 *
 * Auth: CRON_SECRET path with venueId in body, or platform auth (the
 * caller's resolved venue is used). Mirrors the cohort-funnel pattern.
 *
 * Idempotent: rows are upserted on UNIQUE (venue_id, channel,
 * external_id); rerunning yields zero new inserts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { rebindMirrorBackfilledCouples } from '@/lib/services/identity/tracer-rebind'

export const maxDuration = 120

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    venueId?: string
    coupleLimit?: number
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
  const coupleLimit =
    typeof body.coupleLimit === 'number' && body.coupleLimit > 0
      ? Math.min(body.coupleLimit, 2000)
      : 200

  try {
    const result = await rebindMirrorBackfilledCouples(supabase, venueId, {
      coupleLimit,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[tracer-rebind] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
