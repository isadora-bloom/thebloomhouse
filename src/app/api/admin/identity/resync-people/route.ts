/**
 * POST /api/admin/identity/resync-people
 *
 * Pass G follow-up (2026-05-13). After the profile-to-people-sync gate
 * was loosened from `name_quality === 'high' || 'medium'` to also
 * accept 'low', historical weddings whose judge graded name_quality as
 * 'low' (but had a confident individual partner claim like
 * partner2='Dale Settle' at 85%) need a one-shot retro-sync.
 *
 * This endpoint pulls every couple_identity_profile row for a venue
 * and re-fires syncProfileToPeople on each, with NO LLM cost — sync
 * is a pure projection of existing profile data. The Pass G code
 * decides per-partner whether to write.
 *
 * Idempotent. syncProfileToPeople's idempotency guards skip rows
 * that don't need updating.
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId in body
 *     or query.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth.
 *
 * Body:
 *   { venueId?: string, limit?: number, offset?: number }
 *
 * Limit caps at 1000; default 500. Operator paginates for venues with
 * >1000 profiles.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { syncProfileToPeople } from '@/lib/services/identity/profile-to-people-sync'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  // ---- Auth ----
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const isCron = !!(
    authHeader &&
    cronSecret &&
    authHeader === `Bearer ${cronSecret}`
  )

  let venueId: string | null = null
  if (!isCron) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    venueId = auth.venueId ?? null
  }

  const body = (await req.json().catch(() => ({}))) as {
    venueId?: string
    limit?: number
    offset?: number
  }

  if (isCron) {
    const fromBody = body.venueId ?? null
    const fromQuery = req.nextUrl.searchParams.get('venueId') ?? null
    venueId = fromBody ?? fromQuery
    if (!venueId) {
      return badRequest('venueId required when authenticating via CRON_SECRET')
    }
  }
  if (!venueId) return badRequest('No venue in scope')

  const limit = Math.min(Math.max(body.limit ?? 500, 1), 1000)
  const offset = Math.max(body.offset ?? 0, 0)

  const supabase = createServiceClient()

  const { data: profiles, error: profErr } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id, profile, last_reconstructed_at')
    .eq('venue_id', venueId)
    .order('last_reconstructed_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)
  if (profErr) {
    return NextResponse.json({ error: profErr.message }, { status: 500 })
  }
  if (!profiles || profiles.length === 0) {
    return NextResponse.json({
      venueId,
      offset,
      limit,
      scanned: 0,
      synced: 0,
      skipped: 0,
      errors: [],
    })
  }

  let synced = 0
  let skipped = 0
  const errors: Array<{ weddingId: string; reason: string }> = []
  // name_quality breakdown for the operator's visibility.
  const qualityCounts: Record<string, number> = {}
  for (const p of profiles) {
    const q = (p.profile as { names?: { name_quality?: string } } | null)?.names?.name_quality ?? 'missing'
    qualityCounts[q] = (qualityCounts[q] ?? 0) + 1
  }

  for (const p of profiles) {
    const wid = p.wedding_id as string
    try {
      const result = await syncProfileToPeople(wid, { supabase })
      if (result.ok) {
        if (result.updated.length > 0) synced += 1
        else skipped += 1
      } else {
        skipped += 1
        // Don't surface the boring "no profile to sync" / "no partners
        // yet" reasons; those aren't operator-actionable.
        const benign = /^(no-profile|partners-load-failed:.*does not exist)/i
        if (!benign.test(result.reason)) {
          errors.push({ weddingId: wid, reason: result.reason })
        }
      }
    } catch (err) {
      errors.push({
        weddingId: wid,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return NextResponse.json({
    venueId,
    offset,
    limit,
    scanned: profiles.length,
    synced,
    skipped,
    qualityCounts,
    errors: errors.slice(0, 50),
    errorCount: errors.length,
    nextOffset: profiles.length === limit ? offset + limit : null,
  })
}
