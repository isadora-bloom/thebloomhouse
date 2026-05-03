/**
 * Wedding-detail hydration for the identity-reconciliation card UI.
 *
 * GET /api/onboarding/identity-reconciliation/details?ids=uuid,uuid,...
 *
 * Returns a flat shape: id + partner1 + key dedup-relevant fields. The
 * cluster-card UI uses this to render the candidate list — the cluster
 * payload itself is intentionally compact (just ids + conflict
 * reasons), so a separate detail call avoids bloating the reconcile
 * preview.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const idsParam = new URL(request.url).searchParams.get('ids') ?? ''
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0) return NextResponse.json({ weddings: [] })
  if (ids.length > 200) return NextResponse.json({ error: 'too_many_ids' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: weddings, error } = await supabase
    .from('weddings')
    .select(`
      id, venue_id, inquiry_date, wedding_date, source, lead_source,
      crm_source, estimated_guests, guest_count_estimate,
      people!people_wedding_id_fkey (
        id, role, first_name, last_name, email, phone
      )
    `)
    .eq('venue_id', auth.venueId)
    .in('id', ids)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const out = ((weddings ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const people = (r.people as Array<Record<string, unknown>>) ?? []
    const p1 = people.find((p) => p.role === 'partner1') ?? people[0]
    const p1Name = p1
      ? [p1.first_name, p1.last_name].filter(Boolean).join(' ').trim() || null
      : null
    return {
      id: String(r.id ?? ''),
      inquiry_date: (r.inquiry_date as string | null) ?? null,
      wedding_date: (r.wedding_date as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      lead_source: (r.lead_source as string | null) ?? null,
      crm_source: (r.crm_source as string | null) ?? null,
      estimated_guests: (r.estimated_guests as number | null) ?? null,
      guest_count_estimate: (r.guest_count_estimate as number | null) ?? null,
      partner1_name: p1Name ?? '(unnamed)',
      partner1_email: (p1?.email as string | null) ?? null,
      partner1_phone: (p1?.phone as string | null) ?? null,
    }
  })

  return NextResponse.json({ weddings: out })
}
