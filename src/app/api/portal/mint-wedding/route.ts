/**
 * POST /api/portal/mint-wedding
 *
 * Server endpoint that the coordinator "New Booking" modal posts to.
 * Replaces the legacy browser-side direct weddings INSERT in
 * portal/weddings/page.tsx. The browser cannot call mintWedding
 * directly because mint-wedding.ts imports server-only code.
 *
 * Contract:
 *   POST body: {
 *     venueId: string,
 *     partner1: { firstName, lastName, email, phone? },
 *     partner2?: { firstName, lastName, email?, phone? },
 *     weddingDate?: string | null,           // yyyy-mm-dd
 *     guestCount?: number | null,
 *     source?: string | null,                // already normalised on the client
 *     estimatedValue?: number | null,        // Cents
 *     notes?: string | null,
 *     status?: string,                       // defaults 'booked'
 *     eventCode?: string,                    // coordinator-generated
 *     sendInvite?: boolean,
 *   }
 *
 *   Returns: { weddingId, personId, eventCode, isNew }
 *
 * Migrated to mintWedding 2026-05-12. See docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { mintWedding } from '@/lib/services/identity/mint-wedding'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
} from '@/lib/api/auth-helpers'

interface PartnerInput {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
}

interface MintWeddingPostBody {
  venueId: string
  partner1: PartnerInput
  partner2?: PartnerInput | null
  weddingDate?: string | null
  guestCount?: number | null
  source?: string | null
  estimatedValue?: number | null
  notes?: string | null
  status?: string
  eventCode?: string
}

function fullNameOrNull(p: PartnerInput | null | undefined): string | null {
  if (!p) return null
  const parts = [p.firstName, p.lastName].map((x) => (x ?? '').trim()).filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}

export async function POST(request: Request) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = (await request.json()) as MintWeddingPostBody
    const { venueId } = body
    if (!venueId) {
      return NextResponse.json({ error: 'venueId required' }, { status: 400 })
    }

    const decision = await assertCanAccessVenue(auth, venueId)
    if (!decision.ok) return forbidden(`mint-wedding ${decision.reason}`)

    const partner1Email = body.partner1?.email?.trim() || null
    const partner1Phone = body.partner1?.phone?.trim() || null
    if (!partner1Email && !partner1Phone) {
      return NextResponse.json(
        { error: 'partner1.email or partner1.phone required' },
        { status: 400 },
      )
    }
    if (!body.partner1?.firstName || !body.partner1?.lastName) {
      return NextResponse.json(
        { error: 'partner1.firstName and partner1.lastName required' },
        { status: 400 },
      )
    }

    const supabase = createServiceClient()

    const partner1FullName = fullNameOrNull(body.partner1)
    const partner2FullName = fullNameOrNull(body.partner2 ?? null)

    // Mint through the canonical chokepoint. The resolver finds-or-
    // creates the partner1 person + wedding atomically and fires the
    // identity cascade.
    const minted = await mintWedding({
      venueId,
      source: 'portal_ui',
      reason: 'portal_ui',
      supabase,
      signals: {
        email: partner1Email,
        phone: partner1Phone,
        fullName: partner1FullName,
        partner1Name: partner1FullName,
        partner2Name: partner2FullName,
        weddingDate: body.weddingDate ?? null,
        inquiryDate: new Date().toISOString(),
        guestCount: body.guestCount ?? null,
      },
    })

    // Stamp the coordinator-supplied fields the resolver doesn't carry:
    // booked status, booking_value, source, notes, event_code,
    // couple_invited_at. Coordinator-entered values are authoritative:
    // overwrite even if the wedding already existed (a coordinator
    // re-running "New Booking" for a known couple is updating, not
    // duplicating).
    const status = body.status ?? 'booked'
    const portalUpdate: Record<string, unknown> = {
      status,
      wedding_date: body.weddingDate ?? null,
      guest_count_estimate: body.guestCount ?? null,
      source: body.source ?? null,
      booking_value: body.estimatedValue ?? null,
      notes: body.notes ?? null,
    }
    if (body.eventCode) portalUpdate.event_code = body.eventCode

    // event_code may collide on the venues' unique index; retry once
    // with a regenerated code so the coordinator gets a working booking.
    let { error: updateErr } = await supabase
      .from('weddings')
      .update(portalUpdate)
      .eq('id', minted.weddingId)
    let finalEventCode = body.eventCode ?? null
    if (updateErr && (updateErr.message?.includes('unique') || updateErr.message?.includes('duplicate'))) {
      const prefix = (body.eventCode ?? 'BLM').split('-')[0] ?? 'BLM'
      const retryCode = `${prefix}-${Math.floor(100 + Math.random() * 900)}`
      portalUpdate.event_code = retryCode
      const retryRes = await supabase
        .from('weddings')
        .update(portalUpdate)
        .eq('id', minted.weddingId)
      updateErr = retryRes.error
      if (!retryRes.error) finalEventCode = retryCode
    }
    if (updateErr) {
      return NextResponse.json(
        { error: `wedding update failed: ${updateErr.message}` },
        { status: 500 },
      )
    }

    // Partner2: the resolver doesn't create a partner2 people row. If
    // the coordinator entered a partner2, insert it now. Idempotent:
    // skip if a non-tombstoned partner2 already exists for this wedding
    // (mintWedding may have attached to an existing wedding that
    // already had a partner2 from a prior intake).
    if (body.partner2 && body.partner2.firstName) {
      const { data: existingP2 } = await supabase
        .from('people')
        .select('id')
        .eq('wedding_id', minted.weddingId)
        .eq('role', 'partner2')
        .is('merged_into_id', null)
        .maybeSingle()
      if (!existingP2) {
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: minted.weddingId,
          role: 'partner2',
          first_name: body.partner2.firstName.trim(),
          last_name: (body.partner2.lastName ?? '').trim() || null,
          email: body.partner2.email?.trim() || null,
          phone: body.partner2.phone?.trim() || null,
        })
      }
    }

    return NextResponse.json({
      ok: true,
      weddingId: minted.weddingId,
      personId: minted.personId,
      isNew: minted.isNew,
      resolvedVia: minted.resolvedVia,
      eventCode: finalEventCode,
    })
  } catch (err) {
    console.error('[/api/portal/mint-wedding] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
