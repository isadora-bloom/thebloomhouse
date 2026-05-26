/**
 * Phase 1 Batch 2 — Pbatch2-2: deriveIdentityHint.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-2.
 *
 * The `NormalizedSignal.identity_hint` is the free-text label fragments
 * carry when no structured identity attached. Existing call sites
 * re-implement the same fallback chain inline:
 *
 *   - `mint-couple.ts:113-119` — name → hint → email → phone → placeholder
 *   - `email-to-signal.ts:104`  — name ?? email ?? null
 *   - inline at `webhooks/calendly/route.ts:442` — name ?? email ?? null
 *
 * The shared chain: `name ?? email ?? phone ?? handle ?? null`.
 * The "Unnamed couple" placeholder in `mint-couple.ts` is NOT part of
 * this helper — that's a couple-row column constraint (`couples.
 * primary_contact_name` NOT NULL) and belongs to the minting code,
 * not the signal-construction code. Signals are allowed `null` hints
 * (`fragments.identity_hint` is nullable).
 *
 * Pure: no DB / network.
 */

export interface DeriveIdentityHintArgs {
  name?: string | null
  email?: string | null
  phone?: string | null
  /** Handle (Instagram `@user`, Knot username, ...). Placed last so it
   *  loses to any of the contact identifiers when both are present. */
  handle?: string | null
}

export function deriveIdentityHint(args: DeriveIdentityHintArgs): string | null {
  const name = args.name?.trim() || null
  const email = args.email?.trim() || null
  const phone = args.phone?.trim() || null
  const handle = args.handle?.trim() || null
  return name ?? email ?? phone ?? handle ?? null
}
