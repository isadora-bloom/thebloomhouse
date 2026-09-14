import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  badRequest,
  forbidden,
  serverError,
} from '@/lib/api/auth-helpers'
import { sendContract } from '@/lib/services/contracts/send'

/**
 * POST /api/portal/contracts/send
 *
 * Body: { contractId: string }
 *
 * Emails the couple their contract and moves it to sent. A signed contract
 * is refused here rather than at the button, because the button is a page
 * that may have been open for an hour.
 *
 * Same auth shape as the generate route: platform auth, venue derived from
 * the contract row, assertCanAccessVenue.
 */

export async function POST(req: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = await req.json().catch(() => null)
    const contractId = typeof body?.contractId === 'string' ? body.contractId.trim() : ''
    if (!contractId) return badRequest('contractId is required')

    const supabase = createServiceClient()
    const { data: row } = await supabase
      .from('contracts')
      .select('venue_id')
      .eq('id', contractId)
      .maybeSingle()

    if (!row) return NextResponse.json({ error: 'Contract not found' }, { status: 404 })

    const venueId = row.venue_id as string
    const decision = await assertCanAccessVenue(auth, venueId)
    if (!decision.ok) return forbidden(`contract ${decision.reason}`)

    const result = await sendContract({ contractId, venueId, db: supabase })

    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 409 })
    }

    return NextResponse.json({
      sent: true,
      note: result.reason ?? null,
      signUrl: result.signUrl,
      recipients: result.recipients ?? [],
    })
  } catch (err) {
    return serverError(err)
  }
}
