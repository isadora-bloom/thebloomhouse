/**
 * GET /api/admin/identity/profile-handles
 *
 * Wave 4 Phase 3 admin endpoint. Returns the cross-platform handles
 * collected by the forensic identity reconstructor, grouped per
 * wedding within the caller's venue. The handle-merges UI surfaces
 * these alongside the existing handle_merge_decisions queue so a
 * coordinator can see which platforms already converge on the same
 * couple at the LLM-judged level.
 *
 * Auth: getPlatformAuth — venue-scoped. CRON_SECRET path supported
 * for ops-side audits but restricted to a body-supplied venueId
 * (mirrors the reconstruct endpoint's CRON_SECRET shape).
 *
 * Query params:
 *   limit (optional, default 200, max 500) — cap on number of
 *   wedding rows returned. Sorted by last_reconstructed_at desc so
 *   the freshest profiles surface first.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

interface HandleClaim {
  platform: string
  handle: string
  evidence_quote: string
}

interface ProfileHandleRow {
  weddingId: string
  lastReconstructedAt: string
  handles: HandleClaim[]
  partner1Name: string | null
  partner2Name: string | null
}

export async function GET(req: NextRequest) {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string | null = null

  if (cronAuth) {
    const url = new URL(req.url)
    venueId = url.searchParams.get('venueId')
    if (!venueId) {
      return badRequest('CRON_SECRET path requires venueId query param')
    }
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) {
      // Demo can read demo-venue handles via the standard venue scope.
    }
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  const url = new URL(req.url)
  const rawLimit = url.searchParams.get('limit')
  const limit = Math.min(
    500,
    Math.max(1, rawLimit ? Number.parseInt(rawLimit, 10) || 200 : 200),
  )

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id, profile, last_reconstructed_at')
    .eq('venue_id', venueId)
    .order('last_reconstructed_at', { ascending: false })
    .limit(limit)
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }

  const out: ProfileHandleRow[] = []
  for (const r of (data ?? []) as Array<{
    wedding_id: string
    profile: {
      handles?: HandleClaim[]
      names?: {
        partner1?: { first?: string | null; last?: string | null } | null
        partner2?: { first?: string | null; last?: string | null } | null
      }
    } | null
    last_reconstructed_at: string
  }>) {
    const handles = Array.isArray(r.profile?.handles) ? r.profile.handles : []
    if (handles.length === 0) continue
    const partner1 = r.profile?.names?.partner1
    const partner2 = r.profile?.names?.partner2
    out.push({
      weddingId: r.wedding_id,
      lastReconstructedAt: r.last_reconstructed_at,
      handles,
      partner1Name: partner1
        ? [partner1.first, partner1.last].filter(Boolean).join(' ').trim() || null
        : null,
      partner2Name: partner2
        ? [partner2.first, partner2.last].filter(Boolean).join(' ').trim() || null
        : null,
    })
  }

  return NextResponse.json({
    ok: true,
    venueId,
    rowsReturned: out.length,
    rows: out,
  })
}
