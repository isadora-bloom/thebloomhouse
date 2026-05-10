/**
 * Wave 6D — flag detector endpoint.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (Wave 6D auto-flags
 * underperforming + reinforce winners — never auto-executes).
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required
 *     in body.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth.
 *
 * POST body:
 *   { venueId?: string }
 *
 * Behaviour:
 *   - Calls detectMarketingFlags. Idempotent at the writer layer
 *     (re-detecting an active condition updates last_confirmed_at).
 *   - Returns counts + diagnostics.
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
import { detectMarketingFlags } from '@/lib/services/marketing-spend/loop'

// Detector is forensic-deterministic — no LLM call — but loads several
// tables. 60s is plenty.
export const maxDuration = 60

interface PostBody {
  venueId?: string
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
    return forbidden('demo cannot detect marketing flags')
  }
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

  const supabase = createServiceClient()

  // Confirm venue exists.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  try {
    const result = await detectMarketingFlags({ venueId, supabase })
    return NextResponse.json({
      ok: true,
      venueId,
      flagsCreated: result.flagsCreated,
      flagsConfirmed: result.flagsConfirmed,
      flagsResolved: result.flagsResolved,
      diagnostics: result.diagnostics,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[marketing-loop/detect-flags] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
