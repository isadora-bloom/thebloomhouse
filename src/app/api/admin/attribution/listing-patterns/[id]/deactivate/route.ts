/**
 * Wave 23 — Operator pattern-curation endpoint (soft-deactivate).
 *
 * POST /api/admin/attribution/listing-patterns/[id]/deactivate
 *
 * Soft-disable a pattern that's producing false positives. We never
 * hard-delete patterns — keeping the row enables audit (which pattern
 * was scoring before the coordinator killed it) and lets a future
 * re-enable be a single UPDATE rather than a re-insert with a new id.
 *
 * Body: optional { reason?: string } — appended to source for audit.
 *
 * Auth: same dual-auth as add/list — CRON_SECRET requires venueId in
 * body; coordinator UI takes venueId from auth. Super-admin can
 * deactivate globals; coordinators can only deactivate their venue's
 * own rows. Attempting to deactivate a global as a non-super-admin
 * returns 403.
 *
 * Anchor docs:
 *   - listing-platform-detector.ts (detector reads enabled=true only,
 *     so soft-disable instantly removes the pattern from scoring)
 *   - bloom-constitution.md (forensic: never lose evidence — flip the
 *     bit, don't drop the row)
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

export const maxDuration = 30

interface DeactivateBody {
  venueId?: string
  reason?: string
}

interface AuthCtx {
  isCron: boolean
  isSuperAdmin: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: DeactivateBody,
): Promise<{ ctx: AuthCtx } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    return { ctx: { isCron: true, isSuperAdmin: false, venueId: body.venueId } }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot curate listing patterns')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return {
    ctx: {
      isCron: false,
      isSuperAdmin: auth.role === 'super_admin',
      venueId: auth.venueId,
    },
  }
}

interface PatternRow {
  id: string
  venue_id: string | null
  platform: string
  source: string | null
  enabled: boolean
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id || typeof id !== 'string') {
    return badRequest('pattern id required in path')
  }

  let body: DeactivateBody = {}
  try {
    body = (await req.json()) as DeactivateBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const ctx = authResolved.ctx

  const sb = createServiceClient()

  // Load the target row so we can authorise + assemble the audit
  // source label.
  const { data: row } = await sb
    .from('listing_platform_patterns')
    .select('id, venue_id, platform, source, enabled')
    .eq('id', id)
    .maybeSingle()
  if (!row) return notFound('pattern')
  const pattern = row as PatternRow

  // Authorise. Coordinators can only flip their own venue's rows.
  // Super-admin can flip anything including globals.
  if (!ctx.isSuperAdmin) {
    if (pattern.venue_id === null) {
      return forbidden('global patterns are super_admin only')
    }
    if (pattern.venue_id !== ctx.venueId) {
      return forbidden('pattern belongs to another venue')
    }
  }

  if (!pattern.enabled) {
    // Already disabled — return 200 with idempotent flag rather than
    // 409 so retries are safe. Detector treats both states identically.
    return NextResponse.json({ ok: true, alreadyDisabled: true, pattern })
  }

  const reason = body.reason && typeof body.reason === 'string'
    ? body.reason.slice(0, 200)
    : null
  // Append a deactivation audit suffix to source so re-enable later
  // shows who/why killed it. Keep the original source prefix intact.
  const newSource = reason
    ? `${pattern.source ?? ''}|deactivated:${reason}`.slice(0, 256)
    : `${pattern.source ?? ''}|deactivated`.slice(0, 256)

  const { data: updated, error } = await sb
    .from('listing_platform_patterns')
    .update({ enabled: false, source: newSource })
    .eq('id', id)
    .select('id, venue_id, platform, pattern_type, pattern_value, weight, source, enabled, created_at')
    .single()

  if (error) {
    return NextResponse.json(
      { ok: false, error: `update failed: ${error.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, alreadyDisabled: false, pattern: updated })
}
