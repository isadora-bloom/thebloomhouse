/**
 * Wave 6A — manual marketing-spend entry endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required
 *     in body so the operator picks the target venue explicitly.
 *   - else getPlatformAuth (coordinator UI). venueId pulled from auth;
 *     any explicit body.venueId is ignored.
 *
 * POST body:
 *   {
 *     venueId?: string,     // required on cron path; ignored otherwise
 *     channel: string,      // 'google_ads' | 'meta_ads' | etc (free-text)
 *     campaignId?: string,
 *     campaignName?: string,
 *     spendDate: string,    // YYYY-MM-DD
 *     amountCents: number,  // integer, non-negative
 *     currency?: string,    // defaults to USD
 *     notes?: string
 *   }
 *
 * Behaviour:
 *   - Calls recordManualSpend → recordSpend → idempotent INSERT.
 *   - Duplicate (venue, channel, campaign, date) returns 200 with
 *     inserted=false reason=duplicate.
 *   - Validation failure returns 400.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { recordManualSpend } from '@/lib/services/marketing-spend'

export const maxDuration = 30

interface PostBody {
  venueId?: string
  channel?: string
  campaignId?: string
  campaignName?: string
  spendDate?: string
  amountCents?: number
  currency?: string
  notes?: string
  /** Wave 6E. Optional agency tag for ROI rollups. */
  agencyId?: string | null
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
  if (auth.isDemo) return forbidden('demo cannot record manual spend')
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

  if (!body.channel || typeof body.channel !== 'string') {
    return badRequest('channel required')
  }
  if (!body.spendDate || typeof body.spendDate !== 'string') {
    return badRequest('spendDate required (YYYY-MM-DD)')
  }
  if (
    typeof body.amountCents !== 'number' ||
    !Number.isInteger(body.amountCents) ||
    body.amountCents < 0
  ) {
    return badRequest('amountCents required (non-negative integer)')
  }

  const result = await recordManualSpend({
    venueId,
    channel: body.channel,
    campaignId: body.campaignId ?? null,
    campaignName: body.campaignName ?? null,
    spendDate: body.spendDate,
    amountCents: body.amountCents,
    currency: body.currency,
    notes: body.notes ?? null,
    agencyId:
      typeof body.agencyId === 'string' && body.agencyId.length > 0
        ? body.agencyId
        : null,
  })

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 400 },
    )
  }

  return NextResponse.json({
    ok: true,
    venueId,
    inserted: result.inserted,
    id: result.inserted ? result.id : null,
    reason: result.inserted ? null : result.reason,
  })
}
