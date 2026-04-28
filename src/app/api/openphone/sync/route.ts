/**
 * POST /api/openphone/sync
 *
 * Triggers an OpenPhone (Quo) poll for the authenticated venue. Pulls
 * recent SMS, voicemails, and call summaries, dedupes against
 * processed_sms_messages, and writes new rows into interactions so the
 * Agent inbox shows phone activity alongside email.
 *
 * Body (optional): { sinceHours?: number }   default 24
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { syncMessages } from '@/lib/services/openphone'

// Polling several phone numbers + three endpoints each can take a while —
// give ourselves the full Vercel Pro budget so a multi-line workspace
// doesn't time out.
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let sinceHours: number | undefined
  try {
    const body = await request.json().catch(() => null)
    if (body && typeof body.sinceHours === 'number' && body.sinceHours > 0) {
      sinceHours = Math.min(24 * 14, Math.floor(body.sinceHours))
    }
  } catch {
    // Body is optional — ignore parse errors.
  }

  try {
    const result = await syncMessages(auth.venueId, { sinceHours })
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[api/openphone/sync] error:', err)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
