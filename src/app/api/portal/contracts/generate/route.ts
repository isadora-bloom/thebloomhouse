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
import {
  generateContract,
  loadPackageSnapshot,
  previewContract,
} from '@/lib/services/contracts/generate'
import { DEFAULT_CONTRACT_TEMPLATE } from '@/lib/services/contracts/templates'

/**
 * POST /api/portal/contracts/generate
 *
 * Body: { weddingId: string, preview?: boolean }
 *
 * preview=true renders and returns the HTML without writing anything, so
 * the coordinator can read the contract before it exists. Without it, the
 * PDF goes to storage and a `contracts` row lands as a draft.
 *
 * Coordinator-only, venue-scoped the same way the wedding page's other
 * routes are (see ../../weddings/[id]/priorities/route.ts): platform auth,
 * then the venue is derived from the wedding row rather than trusted from
 * the body, then assertCanAccessVenue.
 */

export async function POST(req: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = await req.json().catch(() => null)
    const weddingId = typeof body?.weddingId === 'string' ? body.weddingId.trim() : ''
    if (!weddingId) return badRequest('weddingId is required')

    const preview = body?.preview === true

    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      // legacy-read-ok: an authorisation lookup, not an intelligence read.
      // The one column is venue_id, so the scope check derives the venue
      // from the row rather than trusting the body. Same shape as the
      // priorities and finalisations routes on this wedding.
      .from('weddings')
      .select('venue_id')
      .eq('id', weddingId)
      .maybeSingle()

    if (!wedding) return NextResponse.json({ error: 'Wedding not found' }, { status: 404 })

    const decision = await assertCanAccessVenue(auth, wedding.venue_id as string)
    if (!decision.ok) return forbidden(`wedding ${decision.reason}`)

    if (preview) {
      const load = await loadPackageSnapshot(weddingId, supabase)
      if (!load.ok || !load.snapshot) {
        return NextResponse.json(
          {
            error:
              load.failure === 'not_booked'
                ? 'Contracts are generated from a booked wedding. This one is not booked yet.'
                : 'That wedding could not be found.',
          },
          { status: load.failure === 'not_booked' ? 409 : 404 },
        )
      }
      const { html } = previewContract(
        load.template ?? DEFAULT_CONTRACT_TEMPLATE,
        load.snapshot,
      )
      return NextResponse.json({ preview: true, html, snapshot: load.snapshot })
    }

    const result = await generateContract({
      weddingId,
      actorId: auth.userId ?? null,
      db: supabase,
    })

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message ?? 'The contract could not be generated.' },
        { status: result.failure === 'not_booked' ? 409 : 500 },
      )
    }

    return NextResponse.json({
      contractId: result.contractId,
      html: result.html,
      snapshot: result.snapshot,
    })
  } catch (err) {
    return serverError(err)
  }
}
