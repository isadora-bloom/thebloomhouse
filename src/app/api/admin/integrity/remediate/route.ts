/**
 * Wave 9 — POST /api/admin/integrity/remediate
 *
 * Anchor docs:
 *   - bloom-data-integrity-sweep.md (detector lives in
 *     src/lib/services/data-integrity.ts; this endpoint runs the
 *     remediation sibling for one invariant or all four)
 *   - feedback_deep_fix_vs_bandaid.md (structural fix; operator clicks
 *     one button, idempotent fix runs, audit row written)
 *
 * Auth: dual — CRON_SECRET ops path OR getPlatformAuth coordinator
 * path. Coordinator path requires the caller to either pass a venueId
 * the caller owns, or omit it (defaults to the caller's resolved
 * venue). Demo callers are forbidden.
 *
 * POST body:
 *   {
 *     venueId?: string,             // defaults to caller's venue
 *     invariantId?: string,         // one of SUPPORTED_INVARIANT_IDS,
 *                                   //   omit to run all four
 *     mode?: 'dry_run' | 'apply',   // defaults to 'dry_run' unless
 *                                   //   force=true is set
 *     force?: boolean,              // skip the implicit dry_run-first
 *                                   //   guardrail (force apply directly)
 *   }
 *
 * Behaviour:
 *   - mode omitted + force false → run dry_run only (preview path).
 *   - mode='apply' + force true   → run apply only. Caller is asserting
 *     they've already seen the dry-run preview.
 *   - mode='apply' + force false  → run dry_run THEN apply. Returns
 *     both results.
 *
 * Each run writes an integrity_remediations row (one per
 * invariant × mode). The dry-run-then-apply path produces two rows
 * per invariant — the audit history reads chronologically.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  runRemediation,
  runAllRemediations,
  persistRemediationRun,
  isSupportedInvariantId,
  SUPPORTED_INVARIANT_IDS,
  type RemediationMode,
  type RemediationResult,
} from '@/lib/services/data-integrity/remediation'

export const maxDuration = 300

interface PostBody {
  venueId?: string
  invariantId?: string
  mode?: RemediationMode
  force?: boolean
}

interface AuthContext {
  isCron: boolean
  venueId: string
  operatorId: string | null
}

async function resolveAuth(req: NextRequest, requestedVenueId: string | null): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!requestedVenueId) return badRequest('CRON_SECRET path requires venueId')
    // Validate venue exists (defense in depth).
    const sb = createServiceClient()
    const { data: v } = await sb.from('venues').select('id').eq('id', requestedVenueId).maybeSingle()
    if (!v) return badRequest('venue not found')
    return { ctx: { isCron: true, venueId: requestedVenueId, operatorId: null } }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run integrity remediation')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  const effective = requestedVenueId ?? auth.venueId
  if (effective !== auth.venueId) {
    return forbidden('cannot remediate a venue you do not own')
  }
  return { ctx: { isCron: false, venueId: effective, operatorId: auth.userId } }
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const requestedVenueId = typeof body.venueId === 'string' ? body.venueId : null
  const authResolved = await resolveAuth(req, requestedVenueId)
  if (authResolved instanceof NextResponse) return authResolved
  const { ctx } = authResolved

  const invariantId = typeof body.invariantId === 'string' ? body.invariantId : null
  if (invariantId && !isSupportedInvariantId(invariantId)) {
    return badRequest(
      `Unsupported invariantId: ${invariantId}. Supported: ${SUPPORTED_INVARIANT_IDS.join(', ')}`,
    )
  }

  const requestedMode: RemediationMode | null = body.mode === 'apply' || body.mode === 'dry_run' ? body.mode : null
  const force = body.force === true

  // Decide which passes to run.
  //   - mode omitted + !force      → dry_run only.
  //   - mode='dry_run'             → dry_run only.
  //   - mode='apply' + force       → apply only.
  //   - mode='apply' + !force      → dry_run + apply.
  const passes: RemediationMode[] = (() => {
    if (!requestedMode) return ['dry_run']
    if (requestedMode === 'dry_run') return ['dry_run']
    return force ? ['apply'] : ['dry_run', 'apply']
  })()

  const responseRuns: Array<{
    invariantId: string
    mode: RemediationMode
    result: RemediationResult
    auditId: string | null
  }> = []

  for (const mode of passes) {
    const startedAt = new Date().toISOString()
    const args = { venueId: ctx.venueId, mode }
    const results = invariantId
      ? [await runRemediation(invariantId, args)]
      : await runAllRemediations(args)
    for (const r of results) {
      const { id } = await persistRemediationRun({
        venueId: ctx.venueId,
        result: r,
        operatorId: ctx.operatorId,
        startedAt,
      })
      responseRuns.push({ invariantId: r.invariantId, mode, result: r, auditId: id })
    }
  }

  return NextResponse.json({
    ok: true,
    venueId: ctx.venueId,
    invariantId: invariantId ?? '*',
    passes,
    runs: responseRuns,
  })
}
