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
import { asContractStatus, canVoid } from '@/lib/services/contracts/status'
import { CONTRACTS_BUCKET } from '@/lib/services/contracts/generate'
import { mintSignedUrl } from '@/lib/storage/signed-url'

/**
 * /api/portal/contracts/status
 *
 * GET  ?weddingId=…  — the generated contracts for one wedding, newest
 *                      first, with their status trail.
 * POST { contractId, action: 'void' }
 *                    — withdraw one. A signed contract stays on the record
 *                      and is refused.
 *
 * The status column is shared with uploads, so the read filters on
 * kind='generated'. Timestamps come back as the real event columns
 * (sent_at, viewed_at, signed_at), never created_at: a coordinator asking
 * "when did they sign" must not be shown when the row was written.
 */

const LIST_COLUMNS =
  'id, filename, status, template_key, file_url, storage_path, ' +
  'sent_at, viewed_at, signed_at, signed_name, generated_from'

export async function GET(req: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const weddingId = req.nextUrl.searchParams.get('weddingId')?.trim() ?? ''
    if (!weddingId) return badRequest('weddingId is required')

    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      // legacy-read-ok: an authorisation lookup, not an intelligence read.
      // The one column is venue_id, so the scope check derives the venue
      // from the row rather than trusting the query string.
      .from('weddings')
      .select('venue_id')
      .eq('id', weddingId)
      .maybeSingle()

    if (!wedding) return NextResponse.json({ error: 'Wedding not found' }, { status: 404 })

    const decision = await assertCanAccessVenue(auth, wedding.venue_id as string)
    if (!decision.ok) return forbidden(`wedding ${decision.reason}`)

    const { data, error } = await supabase
      .from('contracts')
      .select(LIST_COLUMNS)
      .eq('wedding_id', weddingId)
      .eq('venue_id', wedding.venue_id as string)
      .eq('kind', 'generated')
      // created-at-ok: newest-first ordering only. Every timestamp the
      // coordinator reads comes from sent_at / viewed_at / signed_at.
      .order('created_at', { ascending: false })
      .limit(25)

    if (error) throw error

    // S5 (2026-09-14 audit item 6). contracts.file_url used to hold a
    // signed URL minted at generate time with a one-year TTL — a bearer
    // credential for the PDF, sitting in a column, unrevocable. The row
    // now carries only the storage path and the link is minted here, at
    // the moment the coordinator loads the panel, for sixty seconds.
    // Legacy rows may still carry a stored file_url; the freshly minted
    // one wins so a stale credential is never what the UI hands out.
    const contracts = await Promise.all(
      (data ?? []).map(async (row) => {
        const r = row as unknown as Record<string, unknown>
        const signed = await mintSignedUrl(
          supabase,
          CONTRACTS_BUCKET,
          r.storage_path as string | null,
        )
        return { ...r, file_url: signed ?? null }
      }),
    )

    return NextResponse.json({ contracts })
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = await req.json().catch(() => null)
    const contractId = typeof body?.contractId === 'string' ? body.contractId.trim() : ''
    if (!contractId) return badRequest('contractId is required')
    if (body?.action !== 'void') return badRequest("action must be 'void'")

    const supabase = createServiceClient()
    const { data: row } = await supabase
      .from('contracts')
      .select('id, venue_id, kind, status')
      .eq('id', contractId)
      .maybeSingle()

    if (!row) return NextResponse.json({ error: 'Contract not found' }, { status: 404 })

    const decision = await assertCanAccessVenue(auth, row.venue_id as string)
    if (!decision.ok) return forbidden(`contract ${decision.reason}`)

    if (row.kind !== 'generated') {
      return NextResponse.json(
        { error: 'Only a contract Bloom generated can be withdrawn here.' },
        { status: 409 },
      )
    }

    const permission = canVoid(asContractStatus(row.status))
    if (!permission.ok) {
      return NextResponse.json({ error: permission.reason }, { status: 409 })
    }

    // Clearing sign_token retires the link the couple was sent, so
    // withdrawing actually withdraws rather than just relabelling.
    const { error } = await supabase
      .from('contracts')
      .update({ status: 'void', sign_token: null })
      .eq('id', contractId)
      .eq('venue_id', row.venue_id as string)

    if (error) throw error

    return NextResponse.json({ voided: true })
  } catch (err) {
    return serverError(err)
  }
}
