/**
 * Couple photo — write side. W65 of NOVEMBER-PLAN.md wave 9.
 *
 * `couple_photo_url` lives on the legacy `weddings` row with no spine
 * equivalent (it is a media asset, not an identity fact). Reading it is
 * covered by `getWeddingRecord`; this is the matching write, kept out of
 * `src/app` so the couple-photo page's `.from('weddings')` update does
 * not sit in the legacy-reads ratchet the same way its read used to.
 *
 * Not a spine write — `couples` never carries a photo column, so there
 * is nothing here for `linkSignal` to own.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export async function setCouplePhotoUrl(
  supabase: SupabaseClient,
  weddingId: string,
  venueId: string,
  publicUrl: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('weddings')
    .update({ couple_photo_url: publicUrl })
    .eq('id', weddingId)
    .eq('venue_id', venueId)
  return { error: error?.message ?? null }
}
