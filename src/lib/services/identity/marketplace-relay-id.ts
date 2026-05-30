/**
 * WeddingWire + Zola per-prospect relay-key extractors.
 *
 * Sibling of `knot-sender-id.ts` (`extractKnotPersonId`). Same problem,
 * same contract: a marketplace sends MORE THAN ONE notification email for
 * a SINGLE inquiry, each from a slightly different relay address. At the
 * raw-string level they look like different people, so the exact-email
 * cascade stage misses and the resolver mints a duplicate person + the
 * pipeline drafts a duplicate Sage reply. The fix is to pull the
 * platform's own stable per-prospect token out of the address and compare
 * THAT, identically to how the Knot personId stage (1b) works.
 *
 * Relay shapes (grounded in live samples + form-relay-parsers.ts):
 *   - WeddingWire: `user-{token}@reply.weddingwire.com`
 *                  `auth-{token}@reply.weddingwire.com`   (role prefix varies)
 *                  `authsolic-{token}@weddingwire.bloom-relay.invalid`
 *                      (synthetic placeholder we mint when WW exposes
 *                       neither a personal email nor a routable relay)
 *   - Zola:        `connect-{uuid}@zola.com`
 *                  `connect-{uuid}@vmkt-message.zola.com`  (Zola moved the
 *                       per-prospect relay onto a subdomain — match any)
 *
 * SAFETY — why this can only HELP, never over-merge:
 *   The returned key is the platform's per-prospect-UNIQUE token / uuid.
 *   Two distinct prospects never share a token, so equal keys ⇒ same
 *   prospect (the merge is always correct). A miss (platform reused a
 *   token we didn't capture, or used two unrelated tokens for one person)
 *   simply falls through to the existing behaviour — never a wrong fuse.
 *   This is the OPPOSITE of the Knot v1 error (it keyed on the venue's
 *   SHARED listing id, collapsing every prospect at a venue — see
 *   `knot-sender-id.ts` header). We deliberately strip only the ROLE
 *   prefix (`user-`/`auth-`), which is not part of identity, and never a
 *   shared component.
 *
 * Namespacing: keys are returned prefixed (`ww:`, `zola:`) so a WW token
 * can never accidentally equal a Zola uuid (or a Knot prefix). Treat the
 * return value as an opaque black-box equality key — do NOT split it.
 *
 * Multi-venue safe — no venue-specific clauses.
 *
 * Doctrine fit: `[[bloom-identity-first-doctrine]]`,
 * `bloom-identity-resolution-doctrine.md` (deterministic identifiers run
 * before fuzzy scoring), and the cascade's own "Marketplace-relay
 * addresses (Knot / Zola / WeddingWire) are MEDIUM tier" note.
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * WeddingWire per-prospect relay. The role prefix (`user` / `auth`) is a
 * routing role, not identity, and is stripped so the initial + auth + any
 * reminder variant of ONE prospect collapse to a single key. The synthetic
 * `authsolic-{token}@weddingwire.bloom-relay.invalid` placeholder (minted in
 * form-relay-parsers.ts) carries WW's own per-prospect authsolic token and
 * is keyed the same way.
 */
const WW_RELAY_RE = /^(?:user|auth)-([a-z0-9]+)@reply\.weddingwire\.com$/i
const WW_SYNTHETIC_RE = /^authsolic-([a-z0-9]+)@weddingwire\.bloom-relay\.invalid$/i

/**
 * Zola per-prospect relay. `connect-{uuid}@<any-subdomain>.zola.com`. The
 * uuid is the per-prospect routing token; we capture it verbatim
 * (lower-cased). Matches both the bare `zola.com` and the newer
 * `vmkt-message.zola.com` subdomain shapes.
 */
const ZOLA_RELAY_RE = /^connect-([a-f0-9][a-f0-9-]{5,})@(?:[\w-]+\.)*zola\.com$/i

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract WeddingWire's per-prospect key from a relay / synthetic address.
 * Returns `ww:<token>` (lower-cased) or null. Pure + idempotent; safe on
 * garbage. Shared relays (`messages@weddingwire.com`,
 * `notifications@weddingwire.com`) → null.
 */
export function extractWeddingWirePersonId(
  email: string | null | undefined,
): string | null {
  if (!email) return null
  const e = email.trim().toLowerCase()
  if (!e) return null
  const m = WW_RELAY_RE.exec(e) ?? WW_SYNTHETIC_RE.exec(e)
  return m ? `ww:${m[1]}` : null
}

/**
 * Extract Zola's per-prospect key from a `connect-{uuid}` relay address.
 * Returns `zola:<uuid>` (lower-cased) or null. Shared relays
 * (`weddingvendors@zola.com`) → null.
 */
export function extractZolaPersonId(
  email: string | null | undefined,
): string | null {
  if (!email) return null
  const e = email.trim().toLowerCase()
  if (!e) return null
  const m = ZOLA_RELAY_RE.exec(e)
  return m ? `zola:${m[1]}` : null
}

/**
 * Unified WeddingWire + Zola per-prospect key. Returns a namespaced,
 * opaque equality key or null. (The Knot equivalent lives in
 * `knot-sender-id.ts` / cascade stage 1b; this covers the other two
 * marketplaces so each platform keeps its own grounded doctrine.)
 */
export function extractMarketplacePersonId(
  email: string | null | undefined,
): string | null {
  return extractWeddingWirePersonId(email) ?? extractZolaPersonId(email)
}

/**
 * Collect every distinct marketplace per-prospect key visible across a
 * list of emails (a candidate person's primary email + alias_emails).
 * Empty set when none are recognised marketplace relays.
 */
export function marketplacePersonIdsFromEmails(
  emails: ReadonlyArray<string | null | undefined>,
): Set<string> {
  const ids = new Set<string>()
  for (const e of emails) {
    const id = extractMarketplacePersonId(e)
    if (id) ids.add(id)
  }
  return ids
}
