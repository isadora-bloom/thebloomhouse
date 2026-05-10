/**
 * Wave 4 Identity Reconstruction — admin endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; this endpoint produces the substrate every read surface
 *     reads from)
 *   - bloom-wave4-identity-reconstruction.md (this endpoint is the
 *     manual / ops trigger for the reconstruct service; Phase 2 wires
 *     pipeline + cron triggers on top)
 *
 * Auth (mirrors /api/admin/identity/rebuild-names):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, weddingId in body
 *   - else getPlatformAuth (coordinator UI), venueId from session,
 *     and we validate the requested wedding belongs to that venue.
 *
 * POST body:
 *   { weddingId: string, force?: boolean }
 *
 * Behaviour:
 *   - force=false (default): if a profile exists AND last_reconstructed_at
 *     is within the last 24h, return cached profile, do NOT spend LLM.
 *   - force=true OR no profile OR stale: run reconstructCoupleIdentity
 *     (one Sonnet call), upsert, return the fresh profile.
 *
 * GET ?weddingId=X:
 *   Returns the stored profile or 404. No LLM call. Used by Phase 3
 *   read surfaces to fetch the canonical record.
 *
 * Phase scope: this is the FOUNDATION endpoint. Phase 2 will add the
 * bulk endpoint (sweep N weddings) and the cron sweep. Phase 4 retires
 * heuristic detectors.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import {
  reconstructCoupleIdentity,
  getStoredCoupleIdentityProfile,
  IDENTITY_RECONSTRUCTION_PROMPT_VERSION,
} from '@/lib/services/identity/reconstruct'

// One reconstruction is one Sonnet call (~10-30s typical). Pad for
// evidence-load latency.
export const maxDuration = 120

const CACHE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PostBody {
  weddingId?: string
  force?: boolean
}

interface AuthContext {
  isCron: boolean
  /** Venue the caller is allowed to operate against. For coordinator
   *  callers this is auth.venueId. For CRON_SECRET callers this is
   *  derived from the wedding row itself. */
  venueId: string | null
}

async function resolveAuth(
  req: NextRequest,
  weddingId: string | null,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!weddingId) {
      return badRequest('CRON_SECRET path requires weddingId')
    }
    // Look up the venue from the wedding row itself.
    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      .from('weddings')
      .select('venue_id, merged_into_id')
      .eq('id', weddingId)
      .maybeSingle()
    if (!wedding) return notFound('wedding')
    const w = wedding as { venue_id: string; merged_into_id: string | null }
    if (w.merged_into_id) {
      return badRequest('wedding is tombstoned (merged_into_id set)')
    }
    return { ctx: { isCron: true, venueId: w.venue_id } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run identity reconstruction')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  // Coordinator path: validate the requested wedding belongs to the
  // caller's venue (defense in depth — RLS protects the read but the
  // service-role client used by reconstructCoupleIdentity bypasses
  // RLS, so we do the check ourselves).
  if (weddingId) {
    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      .from('weddings')
      .select('venue_id, merged_into_id')
      .eq('id', weddingId)
      .maybeSingle()
    if (!wedding) return notFound('wedding')
    const w = wedding as { venue_id: string; merged_into_id: string | null }
    if (w.venue_id !== auth.venueId) {
      return forbidden('wedding does not belong to your venue')
    }
    if (w.merged_into_id) {
      return badRequest('wedding is tombstoned (merged_into_id set)')
    }
  }
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function isFresh(stored: { lastReconstructedAt: string }): boolean {
  const last = Date.parse(stored.lastReconstructedAt)
  if (!Number.isFinite(last)) return false
  return Date.now() - last < CACHE_WINDOW_MS
}

// ---------------------------------------------------------------------------
// POST — run (or return cached) reconstruction
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const weddingId = typeof body.weddingId === 'string' ? body.weddingId : null
  const force = body.force === true

  if (!weddingId) {
    return badRequest('weddingId required')
  }

  const authResolved = await resolveAuth(req, weddingId)
  if (authResolved instanceof NextResponse) return authResolved

  const supabase = createServiceClient()

  // Cache-hit path.
  if (!force) {
    const stored = await getStoredCoupleIdentityProfile(weddingId, { supabase })
    if (stored && isFresh(stored)) {
      return NextResponse.json({
        ok: true,
        cached: true,
        weddingId,
        venueId: stored.venueId,
        profile: stored.profile,
        evidenceSummary: stored.evidenceSummary,
        promptVersion: stored.promptVersion,
        reconstructionCount: stored.reconstructionCount,
        lastReconstructedAt: stored.lastReconstructedAt,
        lastSignalAt: stored.lastSignalAt,
        cumulativeCostCents: stored.costCents,
      })
    }
  }

  // Run a fresh reconstruction.
  let result
  try {
    result = await reconstructCoupleIdentity(weddingId, { supabase })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[reconstruct] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: IDENTITY_RECONSTRUCTION_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    cached: false,
    weddingId,
    profile: result.profile,
    evidenceSummary: result.evidenceSummary,
    promptVersion: result.promptVersion,
    costCents: result.costCents,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    reconstructionCount: result.reconstructionCount,
    lastSignalAt: result.lastSignalAt,
  })
}

// ---------------------------------------------------------------------------
// GET — read stored profile (no LLM call)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const weddingId = url.searchParams.get('weddingId')
  if (!weddingId) return badRequest('weddingId query param required')

  const authResolved = await resolveAuth(req, weddingId)
  if (authResolved instanceof NextResponse) return authResolved

  const stored = await getStoredCoupleIdentityProfile(weddingId)
  if (!stored) return notFound('couple_identity_profile')

  return NextResponse.json({
    ok: true,
    weddingId: stored.weddingId,
    venueId: stored.venueId,
    profile: stored.profile,
    evidenceSummary: stored.evidenceSummary,
    promptVersion: stored.promptVersion,
    reconstructionCount: stored.reconstructionCount,
    lastReconstructedAt: stored.lastReconstructedAt,
    lastSignalAt: stored.lastSignalAt,
    cumulativeCostCents: stored.costCents,
  })
}
