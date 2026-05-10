/**
 * Wave 6A — connector sync trigger endpoint.
 *
 * Dispatches a configured connector for the venue. For Wave 6A every
 * connector returns a stub result; the endpoint shape lands now so
 * 6A2 can drop in real connectors without breaking callers.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * POST body:
 *   {
 *     venueId?: string,            // required on cron path
 *     connector: 'google_ads' | 'meta_ads' | 'tiktok_ads',
 *     since?: string,              // YYYY-MM-DD
 *     until?: string               // YYYY-MM-DD
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  dispatchConnectorSync,
  type ConnectorName,
} from '@/lib/services/marketing-spend'

export const maxDuration = 60

const VALID_CONNECTORS: readonly ConnectorName[] = [
  'google_ads',
  'meta_ads',
  'tiktok_ads',
] as const

interface PostBody {
  venueId?: string
  connector?: string
  since?: string
  until?: string
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
  if (auth.isDemo) return forbidden('demo cannot trigger connector sync')
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

  if (
    !body.connector ||
    !VALID_CONNECTORS.includes(body.connector as ConnectorName)
  ) {
    return badRequest(
      `connector required (one of ${VALID_CONNECTORS.join(', ')})`,
    )
  }

  const result = await dispatchConnectorSync({
    venueId,
    connector: body.connector as ConnectorName,
    since: body.since,
    until: body.until,
  })

  return NextResponse.json({
    ok: true,
    venueId,
    connector: body.connector,
    result,
  })
}
