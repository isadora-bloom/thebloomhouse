/**
 * Manual trigger for the booked-data recovery sweep against a single
 * venue. Mirrors the daily cron (T5-Rixey-MMM) but lets a coordinator
 * (or an onboarding tech) kick it off on demand instead of waiting
 * for 03:00 UTC.
 *
 * Auth model — service-role gated via CRON_SECRET (or
 * TEST_HARNESS_SECRET when set). Same convention as the test harness
 * route so existing service-role tooling can call it without a new
 * secret. Production deploys keep CRON_SECRET set, which means a
 * misuse from outside still requires the secret.
 *
 * Method: POST
 *   Header: Authorization: Bearer <CRON_SECRET | TEST_HARNESS_SECRET>
 *   Body:   { venueId: string }
 *
 * Returns the per-venue RecoveryReport (recovered / merged / no_match /
 * errors counts + per-wedding details). Useful for:
 *   - Onboarding readiness check ("how many of my booked weddings
 *     would the recovery sweep find data for?")
 *   - Re-running after a fresh email backfill picks up new
 *     calculator-estimate emails that weren't in the inbox at the
 *     prior sweep.
 *   - Dry-checking a venue's data before flipping their status to
 *     'live'.
 */

import { NextRequest, NextResponse } from 'next/server'
import { recoverBookedDataForVenue } from '@/lib/services/booked-data-recovery'
import { createServiceClient } from '@/lib/supabase/service'

function resolveSecret(): string | null {
  const harnessSecret = process.env.TEST_HARNESS_SECRET
  if (harnessSecret) return harnessSecret
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET
  return null
}

export async function POST(request: NextRequest) {
  const expected = resolveSecret()
  if (!expected) {
    return NextResponse.json(
      { error: 'Service-role secret unset (CRON_SECRET / TEST_HARNESS_SECRET)' },
      { status: 501 },
    )
  }
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: { venueId?: string }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const venueId = payload.venueId
  if (!venueId || typeof venueId !== 'string') {
    return NextResponse.json({ error: 'venueId (string) is required' }, { status: 400 })
  }

  try {
    const supabase = createServiceClient()
    const report = await recoverBookedDataForVenue(supabase, venueId)
    return NextResponse.json({ ok: true, report })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'unknown',
      },
      { status: 500 },
    )
  }
}
