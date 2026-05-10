/**
 * Wave 5C — external-match scan endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5C external-signal matching)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5C spec)
 *
 * Auth (mirrors /api/admin/intel/cohort-rollup):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required
 *     in body.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth;
 *     any explicit body.venueId is ignored.
 *
 * POST body:
 *   { venueId?: string, weddingId?: string, force?: boolean }
 *
 * Behaviour:
 *   - Always runs findAndStoreExternalMatches (forensic rules + LLM
 *     scoring for cohort-fit signals). Idempotent at the writer layer
 *     via 30-day digest dedup.
 *   - force=true triggers an admin_backfill enqueue when the inline
 *     scan can't run (e.g. caller wants the queue path).
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
  findAndStoreExternalMatches,
  EXTERNAL_MATCH_PROMPT_VERSION,
} from '@/lib/services/intel/external-match'
import { enqueueExternalMatch } from '@/lib/services/intel/enqueue-external-match'

// External-match scan can run several Sonnet calls (one per cultural
// moment + one regional benchmark). 280s budget mirrors Wave 5B.
export const maxDuration = 300

interface PostBody {
  venueId?: string
  weddingId?: string
  force?: boolean
  /** When true, enqueue rather than running inline. */
  enqueue?: boolean
}

interface AuthContext {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: PostBody,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    return { ctx: { isCron: true, venueId: body.venueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run external match scan')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx
  const weddingId =
    typeof body.weddingId === 'string' && body.weddingId.length > 0
      ? body.weddingId
      : null

  const supabase = createServiceClient()

  // Confirm venue exists.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  // Enqueue path — used by callers who don't want to wait for the LLM
  // round-trip. Queue dispatcher picks it up.
  if (body.enqueue === true) {
    const r = await enqueueExternalMatch({
      venueId,
      weddingId,
      triggerSignal: body.force ? 'manual_force' : 'admin_backfill',
      supabase,
    })
    if (r.skipped) {
      return NextResponse.json({ ok: true, enqueued: false, reason: r.reason })
    }
    return NextResponse.json({ ok: true, enqueued: true, jobId: r.jobId })
  }

  // Inline path — run findAndStoreExternalMatches.
  try {
    const result = await findAndStoreExternalMatches(
      { venueId, weddingId },
      { supabase },
    )
    return NextResponse.json({
      ok: true,
      venueId,
      weddingId,
      stored: result.stored,
      skippedDedupe: result.skippedDedupe,
      errors: result.errors,
      candidates: result.matches.length,
      costCents: result.costCents,
      promptVersion: result.promptVersion,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[external-match-scan] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: EXTERNAL_MATCH_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }
}
