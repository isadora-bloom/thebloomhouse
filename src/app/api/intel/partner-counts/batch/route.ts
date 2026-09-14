/**
 * POST /api/intel/partner-counts/batch
 *
 * Wave 2D (2026-05-09). Batch read of `weddings.partner_count` for the
 * inbox / leads "Solo" pill. Used the same way as
 * /api/intel/auto-context/batch-chips: one POST per page, deduped IDs in,
 * map keyed by wedding id out.
 *
 * Defensive — the API only ever returns the value for weddings whose
 * `partner_count` is exactly 1. Everything else (NULL / 2 / future
 * values) is reported as null. The "Solo" pill must NOT render on
 * unknown rows.
 *
 * Body: { weddingIds: string[] } — capped at MAX_BATCH (200).
 * Response: { counts: { [weddingId]: 1 | null } }
 *
 * Auth: getPlatformAuth — coordinator's venueId scopes the query so a
 * coordinator can't read another venue's data.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, isDemoMode, isDemoVenueAllowed } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { redact } from '@/lib/observability/redact'
import { loadCouplesByWeddings, partnerCount } from '@/lib/intel/readers/couple-by-wedding'

const MAX_BATCH = 200
const UUID_RE = /^[0-9a-f-]{36}$/i

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  let body: { weddingIds?: unknown }
  try {
    body = (await request.json()) as { weddingIds?: unknown }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!Array.isArray(body.weddingIds)) {
    return NextResponse.json({ error: 'weddingIds must be an array' }, { status: 400 })
  }

  const seen = new Set<string>()
  const weddingIds: string[] = []
  for (const raw of body.weddingIds) {
    if (typeof raw !== 'string') continue
    if (!UUID_RE.test(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    weddingIds.push(raw)
    if (weddingIds.length >= MAX_BATCH) break
  }

  if (weddingIds.length === 0) {
    return NextResponse.json({ counts: {} })
  }

  const supabase = createServiceClient()
  const demo = await isDemoMode()

  let venueId: string | null = null
  if (demo) {
    venueId = request.nextUrl.searchParams.get('venueId')
    if (!venueId) {
      return NextResponse.json({ error: 'venueId required in demo' }, { status: 400 })
    }
    if (!isDemoVenueAllowed(venueId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const platform = await getPlatformAuth()
    if (!platform) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    venueId = platform.venueId
  }

  const counts: Record<string, 1 | null> = {}
  for (const wid of weddingIds) counts[wid] = null

  try {
    // W66: "is this a solo contact?" is a spine question. `couples` holds
    // the partner name, so a partner on file means two, and no partner
    // name means one. Only 1 is surfaced: a wedding with no mirrored
    // couple stays null so the UI hides the pill rather than calling
    // someone solo on the strength of a missing row.
    const mirrors = await loadCouplesByWeddings(supabase, weddingIds, venueId)
    for (const [weddingId, couple] of mirrors) {
      if (partnerCount(couple) === 1) counts[weddingId] = 1
    }
  } catch (err) {
    console.error('[partner-counts/batch] unexpected error:', err)
    return NextResponse.json({ counts })
  }

  return NextResponse.json({ counts })
}
