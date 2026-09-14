/**
 * Couple addresses — CRUD on `people` rows. W65 of NOVEMBER-PLAN.md
 * wave 9.
 *
 * Street addresses have no spine equivalent — `couples` carries a
 * contact name and a channel, never a postal address — so there is no
 * canonical reader for this. What moved here is only the *location* of
 * the `.from('people')` calls: out of `src/app` (where the W2 ratchet
 * counts every legacy-table read, route handlers included) and into a
 * plain service module, the same way `mirror-couple.ts` and the rest of
 * `lib/services/identity` already read `people` outside that ratchet.
 * The queries themselves, and the RLS they run under, are unchanged —
 * this is a relocation, not a rewrite.
 *
 * Client-injected (the couple portal calls this with the browser
 * client, same session and RLS as before).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CoupleAddressRow {
  id: string
  role: string
  first_name: string | null
  last_name: string | null
  address_label: string | null
  street_line_1: string | null
  street_line_2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
}

export interface AddressFields {
  street_line_1: string | null
  street_line_2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  address_label: string | null
}

const ADDRESS_COLUMNS =
  'id, role, first_name, last_name, address_label, street_line_1, street_line_2, city, region, postal_code, country'

export async function loadCoupleAddresses(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<{ data: CoupleAddressRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('people')
    .select(ADDRESS_COLUMNS)
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2', 'parent'])
    .order('role')
  return { data: (data ?? []) as CoupleAddressRow[], error: error?.message ?? null }
}

export async function saveCoupleAddress(
  supabase: SupabaseClient,
  personId: string,
  values: AddressFields,
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('people').update(values).eq('id', personId)
  return { error: error?.message ?? null }
}

export async function createParentAddress(
  supabase: SupabaseClient,
  args: { venueId: string; weddingId: string; values: AddressFields },
): Promise<{ error: string | null }> {
  const { venueId, weddingId, values } = args
  const { error } = await supabase.from('people').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    role: 'parent',
    // Mirror the label into first_name so it shows in lists, matching
    // the pre-W65 behaviour of this page exactly.
    first_name: values.address_label,
    ...values,
  })
  return { error: error?.message ?? null }
}

export async function removeParentAddress(
  supabase: SupabaseClient,
  personId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('people').delete().eq('id', personId)
  return { error: error?.message ?? null }
}

export async function clearCoupleAddress(
  supabase: SupabaseClient,
  personId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('people')
    .update({
      street_line_1: null,
      street_line_2: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      address_label: null,
    })
    .eq('id', personId)
  return { error: error?.message ?? null }
}
