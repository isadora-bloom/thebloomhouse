/**
 * Bounds for server-side fetches: how big a response we are willing to
 * read, and which hosts count as "our own storage".
 *
 * S5 (2026-09-14 security audit, item 9).
 *
 * safeFetch already refuses a URL that resolves somewhere private. It
 * says nothing about how much comes back. `await res.arrayBuffer()` on a
 * response with no Content-Length and an endless body is a memory
 * exhaustion primitive that needs no privileged network position at all,
 * just a slow attacker-controlled endpoint. These helpers read with a
 * ceiling and stop.
 *
 * Kept in its own module rather than bolted onto safe-fetch.ts so the
 * SSRF logic stays one concern and this stays another.
 */

/** Cap for a photo we are about to attach to an outbound email. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024

/** Cap for a page we are about to hand to an LLM as text. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024

/**
 * The hosts a legacy URL-paste row is allowed to point at: the project's
 * own Supabase origin, plus the generic suffix as a fallback when the env
 * var is missing (a build-time read that can be empty in a worker).
 */
export function supabaseStorageHosts(): string[] {
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
    if (u.hostname) return [u.hostname]
  } catch {
    // fall through
  }
  return ['supabase.co']
}

/** Thrown when a response is larger than the caller is willing to read. */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`response exceeded ${maxBytes} bytes`)
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Read a response body up to `maxBytes`, then give up.
 *
 * Checks the declared Content-Length first (cheap refusal for an honest
 * server) and then counts what actually arrives, because Content-Length
 * is a claim and not a promise. Streams where the runtime gives us a
 * reader; falls back to a buffered read with a post-hoc length check
 * where it does not.
 */
export async function readCappedBody(
  res: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseTooLargeError(maxBytes)
  }

  const reader = res.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new ResponseTooLargeError(maxBytes)
    return buf
  }

  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ResponseTooLargeError(maxBytes)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

/** Same ceiling, decoded as UTF-8 text. */
export async function readCappedText(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const buf = await readCappedBody(res, maxBytes)
  return buf.toString('utf8')
}
