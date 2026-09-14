/**
 * GET /api/couple/day-outlook
 *
 * Two things for the couple portal home, in one round trip: what the
 * weather is likely to do on their wedding day, and at most one nudge
 * about their own planning.
 *
 * W52 of NOVEMBER-PLAN.md wave 7. The couple pages are client components,
 * so a card that needs server-side reads needs a route; this is that
 * route and nothing else lives in it. All the deciding happens in
 * `@/lib/services/couple-portal/day-outlook` and
 * `@/lib/intel/adapters/couple-nudge`, both of which are unit-tested
 * without a database.
 *
 * Scope: `getCoupleAuth()` binds both the venue and the wedding. Nothing
 * is taken from the query string, so a couple cannot ask about anybody
 * else's day.
 *
 * Reads: `couples` (the spine, for their own wedding date) and
 * `guest_list` (their own guest list). Never `weddings`.
 *
 * No writes.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'
import { buildDayOutlookCard, loadDayOutlook } from '@/lib/services/couple-portal/day-outlook'
import { buildRsvpNudge, getRsvpPaceCohort } from '@/lib/intel/adapters/couple-nudge'
import { nowMs } from '@/lib/utils/clock'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const { venueId, weddingId } = auth
    const supabase = createServiceClient()
    const now = nowMs()

    // Their own wedding date, off the spine rather than the legacy
    // weddings table. A couple with no spine row yet simply gets no
    // cards, which is the honest outcome rather than a guessed date.
    const { data: coupleRow } = await supabase
      .from('couples')
      .select('wedding_date')
      .eq('venue_id', venueId)
      .eq('source_wedding_id', weddingId)
      .is('merged_into_id', null)
      .maybeSingle<{ wedding_date: string | null }>()

    const weddingDate = coupleRow?.wedding_date ?? null

    const { data: guestRows } = await supabase
      .from('guest_list')
      .select('rsvp_status')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .limit(5000)

    const guests = (guestRows ?? []) as { rsvp_status: string | null }[]
    const guestsTotal = guests.length
    const guestsReplied = guests.filter(
      (g) => (g.rsvp_status ?? '').trim().toLowerCase() !== 'pending' && !!g.rsvp_status,
    ).length

    const [outlookFacts, cohort] = await Promise.all([
      loadDayOutlook(venueId, weddingDate, now),
      getRsvpPaceCohort(venueId, now, weddingId).catch(() => null),
    ])

    const nudge = cohort
      ? buildRsvpNudge({ weddingDate, guestsTotal, guestsReplied, cohort, now })
      : null

    return NextResponse.json({
      weather: buildDayOutlookCard(outlookFacts),
      nudge,
    })
  } catch (err) {
    return serverError(err)
  }
}
