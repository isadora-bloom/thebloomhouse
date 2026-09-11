import { NextRequest, NextResponse } from 'next/server'
import {
  badRequest,
  getPlatformAuth,
  serverError,
  unauthorized,
} from '@/lib/api/auth-helpers'
import { disconnectInstagram } from '@/lib/services/integrations/instagram-meta'

/**
 * POST /api/integrations/instagram/disconnect
 *
 * Marks the venue's connection revoked and drops the stored page token.
 * The row stays for the audit trail, but a revoked connection that still
 * holds a credential is a trap, so the token goes.
 *
 * The webhook treats a revoked connection as absent, so ingestion stops
 * on the next event without a deploy.
 *
 * This does NOT revoke the grant on Meta's side. The operator removes
 * Bloom under Business Settings, Apps. The settings page says so.
 */
export async function POST(_request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('demo cannot change connections')
  try {
    await disconnectInstagram(auth.venueId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
