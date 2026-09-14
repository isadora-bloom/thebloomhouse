/**
 * Daily sending-domain status sweep (W55, NOVEMBER-PLAN.md wave 8).
 *
 * Refreshes venue_config.sending_domain_status for venues that added a
 * domain but aren't verified yet, so a venue that fixed their DNS days
 * ago flips to verified on its own rather than staying stuck until a
 * coordinator remembers to click "check now" on the settings page.
 *
 * Piggybacks on the heat_decay cron tick (see src/app/api/cron/route.ts)
 * rather than getting its own vercel.json entry — cron budget is at
 * 49/49. Only venues NOT already verified are refreshed: a verified
 * domain doesn't need a daily re-check to stay verified (Resend would
 * flip transport.ts's fallback on its own if a domain later broke, and
 * that's a rarer, lower-urgency case than "just fixed the DNS, waiting
 * to go live").
 *
 * Batched (BATCH_SIZE per tick) and ordered oldest-checked-first so
 * every unverified venue gets a turn across a few days rather than the
 * same handful winning every tick.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { refreshSendingDomainStatus, type SendingDomainStatus } from './sending-domain'

const BATCH_SIZE = 25

export interface SendingDomainSweepResult {
  checked: number
  updated: number
  errors: number
}

interface SweepRow {
  venue_id: string
  resend_domain_id: string
  sending_domain_status: SendingDomainStatus | null
}

export async function sweepSendingDomainStatuses(): Promise<SendingDomainSweepResult> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_config')
    .select('venue_id, resend_domain_id, sending_domain_status')
    .not('resend_domain_id', 'is', null)
    .neq('sending_domain_status', 'verified')
    .order('sending_domain_checked_at', { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE)

  if (error || !data) {
    return { checked: 0, updated: 0, errors: error ? 1 : 0 }
  }

  const rows = data as SweepRow[]
  let updated = 0
  let errors = 0

  for (const row of rows) {
    const result = await refreshSendingDomainStatus(row.resend_domain_id, row.venue_id)
    if (!result.ok) {
      errors += 1
      continue
    }

    const nowIso = new Date().toISOString()
    const nextStatus = result.status ?? row.sending_domain_status ?? 'unverified'
    const { data: updatedRow, error: updateErr } = await supabase
      .from('venue_config')
      .update({ sending_domain_status: nextStatus, sending_domain_checked_at: nowIso })
      .eq('venue_id', row.venue_id)
      .select('venue_id')
      .maybeSingle()

    // .select() after .update() so a PostgREST 0-rows-matched (no error,
    // no row) reads as a failure instead of silently passing — the row
    // could theoretically have been deleted between the read above and
    // this write.
    if (updateErr || !updatedRow) {
      errors += 1
      continue
    }
    if (nextStatus !== row.sending_domain_status) updated += 1
  }

  return { checked: rows.length, updated, errors }
}
