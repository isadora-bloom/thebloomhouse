/**
 * Signed storage URLs, minted at the moment of use.
 *
 * S5 (2026-09-14 security audit, item 6).
 *
 * Four places used to mint a signed URL with a one-year TTL and then
 * write it into a database column: the generated-contract path in
 * contracts/generate.ts, the couple's chat attachment upload, the vendor
 * contract upload, and the contract library upload. A signed Supabase
 * Storage URL is a bearer credential. Persisted for a year it becomes:
 *
 *   - a row-read away from being anybody's. Anyone who can read the
 *     column, through an over-broad select, a support export, a backup,
 *     a logged query, has the file itself, not a reference to it.
 *   - unrevocable. Deleting the contract row does not invalidate the URL;
 *     it stays live in whatever inbox or browser history it reached.
 *   - long-lived in referrers and share sheets. A couple forwarding a
 *     "here is your contract" link forwards the credential with it.
 *
 * The fix is the shape the agency-documents download route already uses:
 * store the PATH, mint a 60-second URL when someone actually asks. Sixty
 * seconds is enough for a browser to follow a redirect or start a
 * download and short enough that a leaked link is worthless by the time
 * it has been leaked.
 *
 * Works with the browser client and the service client alike — both
 * expose the same `storage.from(bucket).createSignedUrl` surface, which
 * is all this touches.
 */

/** Long enough to follow a redirect, short enough to be worthless later. */
export const SHORT_SIGNED_URL_TTL_SECONDS = 60

/**
 * Slightly longer window for a file the server is about to fetch on the
 * couple's behalf (the Sage chat attachment). Still minutes, not months.
 */
export const HANDOFF_SIGNED_URL_TTL_SECONDS = 300

type StorageLike = {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (
        path: string,
        expiresIn: number,
        options?: { download?: string | boolean },
      ) => Promise<{ data: { signedUrl: string } | null; error: unknown }>
    }
  }
}

/**
 * Mint a short-lived signed URL, or null if the object is gone or the
 * caller is not allowed to sign for it. Callers show "that file is no
 * longer available" rather than a stack trace.
 */
export async function mintSignedUrl(
  client: StorageLike,
  bucket: string,
  path: string | null | undefined,
  options: { ttlSeconds?: number; downloadAs?: string } = {},
): Promise<string | null> {
  if (!path) return null
  const ttl = options.ttlSeconds ?? SHORT_SIGNED_URL_TTL_SECONDS
  try {
    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUrl(path, ttl, options.downloadAs ? { download: options.downloadAs } : undefined)
    if (error || !data?.signedUrl) return null
    return data.signedUrl
  } catch {
    return null
  }
}
