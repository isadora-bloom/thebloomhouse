/**
 * Vendor-added cascade.
 *
 * Fires when a venue adds a vendor to its preferred-vendor list.
 *
 * Current state: there is no single canonical "venue_vendor_list" table
 * in the schema. Vendors surface across:
 *   - venue_vendor_domains (mig 258) — vendor domains for email
 *     auto-classification (auto-recognize vendor outbound)
 *   - wedding_relationships (mig 255) — vendor *contacts* associated
 *     with a wedding (couple's florist, planner, etc.)
 *   - drafts / interactions — vendor mentions in body text
 *
 * Until consolidated, this cascade defines the WIRING surface so the
 * downstream behaviour is clear when a venue-level vendor list lands:
 *
 *   1. Re-scan active weddings for body-mention of the new vendor and
 *      stamp wedding.vendor_mentions[] for surfaceable insight.
 *   2. Refresh the venue_vendor_domains classifier so outbound from
 *      the new vendor gets recognised as a vendor not a couple.
 *
 * Today this is a stub that logs the intended fire but does no work.
 * When `venue_vendor_list` (or equivalent) lands, fill in the body.
 *
 * Contract: fire-and-forget. Never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface VendorAddedCascadeArgs {
  venueId: string
  vendorId: string
  vendorName?: string | null
  supabase: SupabaseClient
  correlationId?: string | null
}

export interface VendorAddedCascadeResult {
  weddingsRescanned: number
  mentionsDetected: number
  domainsRefreshed: number
  errors: string[]
  latencyMs: number
}

export async function triggerVendorAddedCascade(
  args: VendorAddedCascadeArgs,
): Promise<VendorAddedCascadeResult> {
  const { venueId, vendorId, vendorName, correlationId } = args
  const started = Date.now()
  const result: VendorAddedCascadeResult = {
    weddingsRescanned: 0,
    mentionsDetected: 0,
    domainsRefreshed: 0,
    errors: [],
    latencyMs: 0,
  }

  // STUB — see file-header comment. Wire when canonical vendor table
  // consolidates.

  result.latencyMs = Date.now() - started

  logEvent({
    level: 'info',
    msg: 'cascade.vendor_added',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'cascade.vendor_added',
    outcome: 'ok',
    latency_ms: result.latencyMs,
    data: {
      vendor_id: vendorId,
      vendor_name: vendorName ?? null,
      stub: true,
    },
  })

  return result
}
