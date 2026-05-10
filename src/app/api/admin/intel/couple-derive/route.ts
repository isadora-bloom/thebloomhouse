/**
 * Wave 5A — per-couple intel derive endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5A: action layer derived from forensic
 *     identity record)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5A spec)
 *
 * Auth (mirrors /api/admin/identity/reconstruct):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, weddingId in body
 *   - else getPlatformAuth (coordinator UI), venueId from session, and
 *     we validate the requested wedding belongs to that venue.
 *
 * POST body:
 *   { weddingId: string, force?: boolean }
 *
 * Behaviour:
 *   - force=false (default): if intel exists AND last_derived_at is
 *     within the last 24h, return cached intel, do NOT spend LLM.
 *   - force=true OR no intel OR stale: run deriveCoupleIntel (one
 *     Sonnet call), upsert, return the fresh intel.
 *
 * GET ?weddingId=X:
 *   Returns the stored intel or 404. No LLM call. Used by the
 *   CoupleIntelPanel to fetch the canonical record.
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
  deriveCoupleIntel,
  getStoredCoupleIntel,
  COUPLE_INTEL_DERIVE_PROMPT_VERSION,
} from '@/lib/services/intel/per-couple-derive'

// One derive is one Sonnet call (~10-30s typical). Pad for evidence-load
// latency.
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
  /** Venue the caller is allowed to operate against. */
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
  if (auth.isDemo) return forbidden('demo cannot run couple intel derive')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  // Coordinator path: validate the requested wedding belongs to the
  // caller's venue.
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

function isFresh(stored: { lastDerivedAt: string }): boolean {
  const last = Date.parse(stored.lastDerivedAt)
  if (!Number.isFinite(last)) return false
  return Date.now() - last < CACHE_WINDOW_MS
}

// ---------------------------------------------------------------------------
// POST — run (or return cached) intel derive
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
    const stored = await getStoredCoupleIntel(weddingId, { supabase })
    if (stored && isFresh(stored)) {
      return NextResponse.json({
        ok: true,
        cached: true,
        weddingId,
        venueId: stored.venueId,
        intel: stored.intel,
        predictedCloseProbabilityPct: stored.predictedCloseProbabilityPct,
        personaLabel: stored.personaLabel,
        promptVersion: stored.promptVersion,
        deriveCount: stored.deriveCount,
        lastDerivedAt: stored.lastDerivedAt,
        sourceProfileAt: stored.sourceProfileAt,
        cumulativeCostCents: stored.costCents,
      })
    }
  }

  // Run a fresh derive.
  let result
  try {
    result = await deriveCoupleIntel(weddingId, { supabase })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[couple-derive] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: COUPLE_INTEL_DERIVE_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    cached: false,
    weddingId,
    intel: result.intel,
    predictedCloseProbabilityPct: result.predictedCloseProbabilityPct,
    personaLabel: result.personaLabel,
    promptVersion: result.promptVersion,
    costCents: result.costCents,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    deriveCount: result.deriveCount,
    sourceProfileAt: result.sourceProfileAt,
  })
}

// ---------------------------------------------------------------------------
// GET — read stored intel (no LLM call)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const weddingId = url.searchParams.get('weddingId')
  if (!weddingId) return badRequest('weddingId query param required')

  const authResolved = await resolveAuth(req, weddingId)
  if (authResolved instanceof NextResponse) return authResolved

  const stored = await getStoredCoupleIntel(weddingId)
  if (!stored) return notFound('couple_intel')

  return NextResponse.json({
    ok: true,
    weddingId: stored.weddingId,
    venueId: stored.venueId,
    intel: stored.intel,
    predictedCloseProbabilityPct: stored.predictedCloseProbabilityPct,
    personaLabel: stored.personaLabel,
    promptVersion: stored.promptVersion,
    deriveCount: stored.deriveCount,
    lastDerivedAt: stored.lastDerivedAt,
    sourceProfileAt: stored.sourceProfileAt,
    cumulativeCostCents: stored.costCents,
  })
}
