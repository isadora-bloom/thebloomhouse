/**
 * POST /api/agent/instagram/reply — stub.
 *
 * Wave 4 W30. Sending Instagram replies is out of scope for this wave —
 * see the outbound note at the foot of
 * src/lib/services/ingestion/instagram-dm.ts and `sendInstagramReply` in
 * src/lib/services/integrations/instagram-meta.ts, which names the Graph
 * endpoint (`POST {GRAPH_BASE}/{ig_business_id}/messages`) a real send
 * would call. This route exists so the audio-inbox reply notice, and any
 * future compose UI, has one endpoint to call rather than nothing —
 * always answers 501 with a message explaining why, gated behind the
 * same INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / INSTAGRAM_VERIFY_TOKEN
 * env check the inbound webhook uses.
 *
 * Body: { venueId: string, senderIgsid: string, text: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { sendInstagramReply } from '@/lib/services/integrations/instagram-meta'

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}) as Record<string, unknown>)
  const venueId = typeof body.venueId === 'string' ? body.venueId : ''
  const senderIgsid = typeof body.senderIgsid === 'string' ? body.senderIgsid : ''
  const text = typeof body.text === 'string' ? body.text : ''

  const result = sendInstagramReply({ venueId, senderIgsid, text })
  return NextResponse.json(result, { status: 501 })
}
