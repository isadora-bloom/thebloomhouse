import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { findBacktraceCandidates, applyBacktrace } from '@/lib/services/source-backtrace'

/**
 * Source-backtrace endpoints.
 *
 *   GET  /api/intel/sources/backtrace
 *     Returns the list of weddings whose first-touch source is a
 *     scheduling tool (calendly/acuity/honeybook/dubsado) along with
 *     a suggested real first-touch source derived from the venue's
 *     email history. Two-pass search: local interactions first, then
 *     live Gmail for older weddings outside the onboarding backfill
 *     window.
 *
 *     Query params:
 *       ?venue_id=UUID    — single venue (defaults to auth.venueId)
 *       ?live=false       — skip live Gmail (preview without quota)
 *
 *   POST /api/intel/sources/backtrace
 *     Body: { weddingId, newSource }
 *     Applies an approved correction. Updates weddings.source AND the
 *     wedding's inquiry touchpoint, with audit metadata.
 *
 * Both gated by the `intelligence` plan, scoped to the requester's
 * venue (no cross-venue rewrites).
 */

export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = request.nextUrl.searchParams
  const venueIdParam = sp.get('venue_id')
  const liveParam = sp.get('live')
  const venueId = venueIdParam || auth.venueId
  if (venueId !== auth.venueId) {
    // Only let the requester backtrace their own venue. Cross-venue
    // backtrace would need an explicit org-admin check we don't
    // implement here.
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const candidates = await findBacktraceCandidates(venueId, {
      useLiveGmail: liveParam !== 'false',
    })
    return NextResponse.json({ candidates })
  } catch (err) {
    console.error('[api/intel/sources/backtrace GET]', err)
    return NextResponse.json({ error: 'Failed to compute backtrace' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { weddingId?: string; newSource?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { weddingId, newSource } = body
  if (!weddingId || !newSource) {
    return NextResponse.json({ error: 'Missing weddingId or newSource' }, { status: 400 })
  }

  try {
    const result = await applyBacktrace(auth.venueId, weddingId, newSource, auth.userId ?? null)
    if (!result.ok) {
      return NextResponse.json({ error: 'Wedding not found or wrong venue' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, oldSource: result.oldSource, newSource })
  } catch (err) {
    console.error('[api/intel/sources/backtrace POST]', err)
    return NextResponse.json({ error: 'Failed to apply backtrace' }, { status: 500 })
  }
}
