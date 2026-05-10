/**
 * Wave 6D — build weekly digest endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * POST body:
 *   { venueId?: string, periodStart?: string, periodEnd?: string }
 *
 * Behaviour:
 *   - Calls buildWeeklyDigest. Idempotent on (venue, period) — re-runs
 *     replace digest_jsonb in place.
 *   - Returns digest jsonb + cost.
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
import { buildWeeklyDigest } from '@/lib/services/marketing-spend/loop'

// Sonnet call; pad for slow LLM responses.
export const maxDuration = 300

interface PostBody {
  venueId?: string
  periodStart?: string
  periodEnd?: string
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
  if (auth.isDemo) {
    return forbidden('demo cannot build marketing digests')
  }
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/

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

  const supabase = createServiceClient()

  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  const periodStart =
    typeof body.periodStart === 'string' && ISO_DATE_RX.test(body.periodStart)
      ? body.periodStart
      : undefined
  const periodEnd =
    typeof body.periodEnd === 'string' && ISO_DATE_RX.test(body.periodEnd)
      ? body.periodEnd
      : undefined

  // Both must be supplied together, or both omitted.
  if ((periodStart && !periodEnd) || (!periodStart && periodEnd)) {
    return badRequest(
      'periodStart and periodEnd must be supplied together (YYYY-MM-DD)',
    )
  }

  try {
    const result = await buildWeeklyDigest(venueId, {
      supabase,
      periodStart,
      periodEnd,
    })
    return NextResponse.json({
      ok: true,
      venueId,
      digestId: result.digestId,
      digest: result.digestJsonb,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      costCents: result.costCents,
      promptVersion: result.promptVersion,
      diagnostics: result.diagnostics,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[marketing-loop/digest/build] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
