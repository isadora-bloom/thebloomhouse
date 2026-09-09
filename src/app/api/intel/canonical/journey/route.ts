/**
 * Canonical reader endpoint — getCoupleJourney, scope-aware, plus the
 * two presentation extras the ribbon needs.
 *
 * Why this exists next to the admin twin: the admin route answers for
 * `auth.venueId` alone, so an org admin looking at a couple in the venue
 * they have currently scoped to (but which is not their home venue) got
 * `couple: null`. This route walks the venues the chosen scope covers —
 * `resolveScopeVenueIds` has already validated the group and the org —
 * and returns the first venue that owns the couple. A couple outside the
 * scope resolves empty, exactly as the reader intends; nothing leaks.
 *
 * Presentation extras
 * -------------------
 * `TouchpointRibbon` (canonical.ts) carries id / channel / actionType /
 * occurredAt / cascadeStage / cascadeReason. The JourneyRibbon component
 * additionally draws `signal_tier` and `confidence_tier`, and the heat
 * explanation needs `signal_tier` to reproduce the score. Those are the
 * SAME touchpoint rows with two more columns selected — no second
 * derivation, no second opinion about which touchpoints exist. The
 * canonical ribbon stays the ordering authority; this read only decorates
 * it. See the patch note in the W2 report: the tidy fix is for
 * TouchpointRibbon to carry signalTier + confidenceTier, at which point
 * this supplementary select goes away.
 *
 * GET ?coupleId=X → { ok, journey, venueId, ribbonFields, heat }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleJourney, type CoupleJourney } from '@/lib/intel/canonical'
import { buildHeatWhy, type HeatWhy } from '@/lib/intel/adapters/heat-why'

export const maxDuration = 60

const MAX_VENUES = 12

interface RibbonField {
  id: string
  signal_tier: string
  confidence_tier: string | null
  raw_payload: Record<string, unknown> | null
}

/** Contact details the couple header prints. `CoupleIdentity` carries
 *  id / names / lifecycle / heat, which is what the reader needs to
 *  answer questions; a header also needs an email address to put under
 *  the name. Same spine row, more columns — not a second identity. */
interface CoupleContact {
  venue_id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  partner_contact_name: string | null
  partner_contact_email: string | null
  partner_contact_phone: string | null
  wedding_date: string | null
  source_wedding_id: string | null
  last_progression_at: string | null
}

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const coupleId = new URL(req.url).searchParams.get('coupleId')
  if (!coupleId) return badRequest('coupleId param required')

  const venueIds = (await resolveScopeVenueIds()).slice(0, MAX_VENUES)
  if (venueIds.length === 0) {
    return NextResponse.json({ ok: false, error: 'no venue in scope' }, { status: 400 })
  }

  try {
    // Walk the scoped venues until one owns the couple. Sequential on
    // purpose: the first venue is the operator's own in the overwhelming
    // majority of calls, so the loop usually runs once.
    let journey: CoupleJourney | null = null
    let ownerVenueId: string | null = null
    for (const venueId of venueIds) {
      const j = await getCoupleJourney(venueId, coupleId)
      if (j.couple) {
        journey = j
        ownerVenueId = venueId
        break
      }
    }

    if (!journey || !ownerVenueId) {
      return NextResponse.json({
        ok: true,
        journey: null,
        venueId: null,
        contact: null,
        ribbonFields: [],
        heat: null,
      })
    }

    const service = createServiceClient()
    const [fieldRes, contactRes] = await Promise.all([
      service
        .from('touchpoints')
        .select('id, signal_tier, confidence_tier, raw_payload')
        .eq('couple_id', coupleId)
        .eq('venue_id', ownerVenueId)
        .limit(1000),
      service
        .from('couples')
        .select(
          'venue_id, primary_contact_name, primary_contact_email, primary_contact_phone, partner_contact_name, partner_contact_email, partner_contact_phone, wedding_date, source_wedding_id, last_progression_at',
        )
        .eq('id', coupleId)
        .eq('venue_id', ownerVenueId)
        .maybeSingle(),
    ])
    const ribbonFields = (fieldRes.data ?? []) as RibbonField[]
    const contact = (contactRes.data ?? null) as CoupleContact | null

    // Heat, with the working shown. Built from the same touchpoints the
    // canonical ribbon lists, so the explanation cannot describe a
    // different set of signals than the ribbon draws.
    const tierById = new Map(ribbonFields.map((f) => [f.id, f.signal_tier]))
    const heat: HeatWhy = buildHeatWhy(
      journey.ribbon
        .map((t) => ({
          signal_tier: tierById.get(t.id) ?? '',
          occurred_at: t.occurredAt,
        }))
        .filter((t) => t.signal_tier !== ''),
    )

    return NextResponse.json({
      ok: true,
      journey,
      venueId: ownerVenueId,
      contact,
      ribbonFields,
      heat,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intel/canonical/journey] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
