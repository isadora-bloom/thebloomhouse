/**
 * Couple-portal provisioning.
 *
 * When a wedding is booked, the coordinator should be able to open and
 * hold its portal from day one — and be able to invite the couple
 * whenever they choose. Provisioning makes a wedding portal-ready:
 *
 *   1. event_code — the code a couple types to register. Without it
 *      the couple can't be invited. Generated unique-per-venue on
 *      demand (a CRM-imported booked couple has no code until now).
 *   2. wedding_details shell — a single row so the coordinator opens a
 *      real portal record, not a blank insert-on-first-write.
 *
 * Idempotent: a wedding that already has an event_code + a
 * wedding_details row is left untouched. Safe to call on every booked
 * transition and again at invite time.
 *
 * Never throws — provisioning is best-effort; a failure here must not
 * fail the booking or the invite.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface ProvisionResult {
  event_code: string | null
  wedding_details_created: boolean
}

function codePrefix(slug: string | null | undefined): string {
  const letters = (slug ?? '').replace(/[^a-zA-Z]/g, '')
  return (letters.slice(0, 3) || 'BLM').toUpperCase()
}

export async function provisionCouplePortal(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<ProvisionResult> {
  const result: ProvisionResult = {
    event_code: null,
    wedding_details_created: false,
  }
  try {
    const { data: wedding } = await supabase
      .from('weddings')
      .select('id, venue_id, event_code')
      .eq('id', weddingId)
      .maybeSingle()
    if (!wedding) return result

    const venueId = wedding.venue_id as string
    result.event_code = (wedding.event_code as string | null) ?? null

    // 1. Ensure a unique event_code.
    if (!result.event_code) {
      const { data: venue } = await supabase
        .from('venues')
        .select('slug')
        .eq('id', venueId)
        .maybeSingle()
      const prefix = codePrefix((venue as { slug?: string } | null)?.slug)
      for (let attempt = 0; attempt < 25; attempt++) {
        const candidate = `${prefix}-${Math.floor(100 + Math.random() * 900)}`
        // .is('event_code', null) guard: if a concurrent write set the
        // code first, this updates 0 rows and we re-read below.
        const { error } = await supabase
          .from('weddings')
          .update({ event_code: candidate })
          .eq('id', weddingId)
          .is('event_code', null)
        if (!error) {
          result.event_code = candidate
          break
        }
        // 23505 = the candidate collided with another wedding's code;
        // loop and try a fresh one.
        if (error.code !== '23505') break
      }
      // If a concurrent write won the race, pick up its value.
      if (!result.event_code) {
        const { data: reread } = await supabase
          .from('weddings')
          .select('event_code')
          .eq('id', weddingId)
          .maybeSingle()
        result.event_code =
          (reread as { event_code?: string } | null)?.event_code ?? null
      }
    }

    // 2. Ensure the wedding_details shell row.
    const { data: details } = await supabase
      .from('wedding_details')
      .select('id')
      .eq('wedding_id', weddingId)
      .maybeSingle()
    if (!details) {
      const { error } = await supabase
        .from('wedding_details')
        .insert({ venue_id: venueId, wedding_id: weddingId })
      if (!error) result.wedding_details_created = true
    }

    return result
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'portal.provision_failed',
      data: {
        wedding_id: weddingId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return result
  }
}
