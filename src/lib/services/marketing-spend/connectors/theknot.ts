/**
 * Wave 6A — The Knot fee connector.
 *
 * Knot / WeddingWire fees are typically known monthly costs (storefront
 * tier + click fees) — manual entry is fine for tier 1 onboarding. This
 * connector wraps the manual-entry shape so calling code can use a
 * connector dispatch path uniformly.
 *
 * Wave 6A2 may add a real Knot/WW reporting API connector if their API
 * stabilises; for now manual entry is the source of truth.
 */

import { recordSpend, type RecordSpendResult } from '../ingest'

export interface KnotFeeInput {
  venueId: string
  /** YYYY-MM-DD — first of the month is fine for monthly fees. */
  spendDate: string
  amountCents: number
  currency?: string
  /** 'theknot_fee' (default) or 'weddingwire_fee'. */
  channel?: 'theknot_fee' | 'weddingwire_fee'
  notes?: string | null
}

export async function recordKnotFee(
  input: KnotFeeInput,
): Promise<RecordSpendResult> {
  return recordSpend({
    venueId: input.venueId,
    channel: input.channel ?? 'theknot_fee',
    campaignId: null,
    campaignName: 'storefront_fee',
    spendDate: input.spendDate,
    amountCents: input.amountCents,
    currency: input.currency,
    sourcePayload: input.notes
      ? { notes: input.notes, fee_type: 'storefront' }
      : { fee_type: 'storefront' },
    ingestedBy: 'theknot_manual',
  })
}
