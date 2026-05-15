/**
 * POST /api/admin/identity/resurrection
 *
 * Operator disputes a ghost resurrection. Anchor:
 * IDENTITY-FIRST-ARCHITECTURE.md §9 ("Resurrection dispute flow").
 *
 * When the Forwards Linker resurrects a Ghost couple on a high-tier
 * signal, an inline banner appears on the couple page. If the operator
 * presses "Not them", this endpoint flips the couple back to 'ghost',
 * blacklists the disputed identifier(s) so the same signal never
 * re-resurrects the same Ghost, and records a resurrection_rejected
 * audit event.
 *
 * A "confirm" is a no-op at the API level: the resurrection already
 * happened and was correct, the couple_merge_events 'resurrection'
 * row is the permanent record, and the banner ages out on its own.
 * So this endpoint only handles the reject path.
 *
 * Body
 * ----
 *   {
 *     couple_id: string,
 *     reason: string,                       // required
 *     identifiers?: Array<{ value, kind }>  // emails/phones to blacklist
 *   }
 *
 * When identifiers is omitted we look the couple's own contact
 * email/phone up and blacklist those — the common case where the
 * recycled identifier is the couple's stored contact.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { rejectResurrection } from '@/lib/services/identity/resurrection'
import { invalidateCouplesCache } from '@/lib/services/identity/forwards-linker'
import { normalizeEmail, normalizePhone } from '@/lib/services/identity/resolver'

interface Body {
  couple_id?: string
  reason?: string
  identifiers?: Array<{ value: string; kind: 'email' | 'phone' | 'other' }>
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as Body
  if (!body.couple_id) {
    return NextResponse.json({ error: 'couple_id required' }, { status: 400 })
  }
  if (!body.reason || body.reason.trim().length === 0) {
    return NextResponse.json(
      { error: 'reason is required to dispute a resurrection' },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()
  const { data: couple } = await supabase
    .from('couples')
    .select('id, venue_id, primary_contact_email, primary_contact_phone, partner_contact_email, partner_contact_phone')
    .eq('id', body.couple_id)
    .maybeSingle()
  if (!couple) {
    return NextResponse.json({ error: 'couple_not_found' }, { status: 404 })
  }
  const c = couple as {
    id: string
    venue_id: string
    primary_contact_email: string | null
    primary_contact_phone: string | null
    partner_contact_email: string | null
    partner_contact_phone: string | null
  }

  const role = (auth.role ?? 'coordinator') as string
  const isSuperOrOrg =
    auth.isDemo || role === 'super_admin' || role === 'org_admin'
  if (!isSuperOrOrg && c.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Resolve which identifiers to blacklist. Operator-supplied list
  // wins; otherwise blacklist the couple's own contact email + phone
  // (the recycled-identifier common case).
  let identifiers = body.identifiers ?? []
  if (identifiers.length === 0) {
    const derived: Array<{ value: string; kind: 'email' | 'phone' | 'other' }> = []
    for (const e of [c.primary_contact_email, c.partner_contact_email]) {
      const n = normalizeEmail(e)
      if (n) derived.push({ value: n, kind: 'email' })
    }
    for (const p of [c.primary_contact_phone, c.partner_contact_phone]) {
      const n = normalizePhone(p)
      if (n) derived.push({ value: n, kind: 'phone' })
    }
    identifiers = derived
  }

  const result = await rejectResurrection({
    supabase,
    venueId: c.venue_id,
    coupleId: c.id,
    identifiers,
    reason: body.reason.trim(),
    operatorId: auth.userId ?? null,
  })

  if (!result.ok) {
    return NextResponse.json({ error: 'reject_failed' }, { status: 500 })
  }

  invalidateCouplesCache(c.venue_id)
  return NextResponse.json({
    ok: true,
    blacklisted: identifiers.length,
  })
}
