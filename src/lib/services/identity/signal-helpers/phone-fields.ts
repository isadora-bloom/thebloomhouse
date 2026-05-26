/**
 * Phase 1 Batch 2 — Pbatch2-2: derivePhoneFields.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-2.
 *
 * Shared phone-direction logic for the per-channel signal builders
 * (`sms-to-signal.ts` + `voice-to-signal.ts`). Replicates the
 * direction-aware "external party is the couple" rule already in
 * `ingestion/openphone.ts:~852-853`:
 *
 *   inbound  → couple = sender (`externalPhone`)
 *   outbound → couple = recipient (`externalPhone`)
 *
 * In both cases the `externalPhone` is the couple-side number — the
 * caller is responsible for picking it (Twilio/OpenPhone already do).
 * The helper exists so the SMS + voice builders normalise the result
 * the same way and never put a venue line into `primary_phone`.
 *
 * Partner phone is always null today — phone channels are 1:1, the
 * partner number arrives via a separate signal (email signature,
 * intake form, etc.). The slot is reserved so future group-SMS /
 * Zoom-roster paths (OQ-B-Multi-Person) can wire through one helper.
 *
 * Normalisation matches `identity/resolver.ts:normalizePhone`:
 * E.164 with `+1` US default. We DO NOT use the openphone-local
 * 10-digit normaliser — the spine writes E.164 (mig 346 + downstream
 * matcher reads). Cross-channel reconciliation requires one format.
 *
 * Pure: no DB / network.
 */

import { normalizePhone } from '../resolver'

export interface DerivePhoneFieldsArgs {
  /** Direction of the underlying message. */
  direction: 'inbound' | 'outbound'
  /** The couple-side phone (sender on inbound, recipient on outbound).
   *  Caller-resolved — see openphone.ts:~852 + twilio/route.ts:~206. */
  externalPhone: string | null
  /** The venue line. Accepted for symmetry + future multi-line
   *  routing; not written into any signal slot today. */
  venuePhone: string | null
}

export interface DerivedPhoneFields {
  /** The couple's primary phone. E.164 normalised. */
  primary_phone: string | null
  /** Reserved for future group-SMS / roster paths. Always null today. */
  partner_phone: string | null
}

export function derivePhoneFields(args: DerivePhoneFieldsArgs): DerivedPhoneFields {
  // `direction` + `venuePhone` accepted today for forward-compat with
  // group-SMS / Zoom-roster (OQ-B-Multi-Person) and multi-line venues;
  // current rule is direction-agnostic because the caller already picked
  // the couple-side number per the openphone.ts:~852 convention.
  void args.direction
  void args.venuePhone

  return {
    primary_phone: normalizePhone(args.externalPhone),
    partner_phone: null,
  }
}
