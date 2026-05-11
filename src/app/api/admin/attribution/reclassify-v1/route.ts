/**
 * Wave 22 — operator-triggered re-classification of v1-prompt-classified
 * attribution_events rows.
 *
 * Anchor docs:
 *   - PROMPT-BIAS-AUDIT.md (Wave 21) — findings #4 + #18 (critical):
 *     channel-role-classifier.prompt.v1 and inquiry-intent-judge.prompt.v1
 *     contained direction-loaded language. Wave 22 ships v2 prompts with
 *     symmetric evidence weighting; this endpoint lets the operator
 *     re-run the LLM judges on rows that were classified under v1.
 *   - feedback_measure_dont_assume.md — re-measure under neutral framing
 *   - feedback_audit_agents_overclaim.md — report actual verdict shift,
 *     not what we hoped for
 *
 * Auth (mirrors /api/admin/attribution/reclassify-roles):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, venueId REQUIRED
 *     in body. Not currently used by any cron; reserved for explicit
 *     ops scripts.
 *   - else getPlatformAuth (coordinator UI). venueId taken from auth;
 *     any explicit body.venueId is ignored. demo blocked.
 *
 * POST body:
 *   {
 *     venueId?: string,    // required when using CRON_SECRET
 *     limit?: number,      // default 20 (Wave 22 audit sample size)
 *     dryRun?: boolean     // default false. When true, returns the
 *                          //   candidate-count only (no LLM calls).
 *   }
 *
 * Response: ReclassifyV1Summary from
 *   src/lib/services/attribution-roles/reclassify-v1-sweep.ts
 * Includes per-row v1 vs v2 verdict shifts so the operator UI can show
 * "X% of your bias-suspect classifications changed verdict under v2".
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
import { reclassifyV1AttributionsSweep } from '@/lib/services/attribution-roles/reclassify-v1-sweep'

export const maxDuration = 300

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200

interface ReclassifyV1Body {
  venueId?: string
  limit?: number
  dryRun?: boolean
}

interface AuthCtx {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: ReclassifyV1Body,
): Promise<{ ctx: AuthCtx } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    return { ctx: { isCron: true, venueId: body.venueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run reclassify-v1 sweep')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

export async function POST(req: NextRequest) {
  let body: ReclassifyV1Body = {}
  try {
    body = (await req.json()) as ReclassifyV1Body
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const limit = clampLimit(body.limit ?? DEFAULT_LIMIT)
  const dryRun = body.dryRun === true

  const sb = createServiceClient()

  // Confirm the venue exists.
  const { data: venueRow } = await sb
    .from('venues')
    .select('id')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  try {
    const summary = await reclassifyV1AttributionsSweep({
      venueId,
      limit,
      dryRun,
      supabase: sb,
    })
    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    )
  }
}
