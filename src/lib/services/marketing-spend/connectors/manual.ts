/**
 * Wave 6A — manual spend entry connector.
 *
 * Coordinator types a row in the /intel/marketing-spend form and POST
 * /api/admin/marketing-spend/manual lands here. Validates the input,
 * forwards to recordSpend with ingestedBy='manual'.
 */

import { recordSpend, type RecordSpendResult } from '../ingest'

export interface ManualSpendInput {
  venueId: string
  channel: string
  campaignName?: string | null
  campaignId?: string | null
  spendDate: string
  amountCents: number
  currency?: string
  notes?: string | null
}

export async function recordManualSpend(
  input: ManualSpendInput,
): Promise<RecordSpendResult> {
  return recordSpend({
    venueId: input.venueId,
    channel: input.channel,
    campaignId: input.campaignId ?? null,
    campaignName: input.campaignName ?? null,
    spendDate: input.spendDate,
    amountCents: input.amountCents,
    currency: input.currency,
    sourcePayload: input.notes
      ? { notes: input.notes, entered_via: 'manual_form' }
      : { entered_via: 'manual_form' },
    ingestedBy: 'manual',
  })
}
