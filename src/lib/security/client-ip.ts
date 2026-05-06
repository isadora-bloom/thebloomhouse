import type { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'

/**
 * Extract a client identifier for rate-limit keying.
 *
 * Per round-2 audit: the previous helpers fell back to the literal
 * string 'unknown' when x-forwarded-for was missing. Every anonymous
 * caller then bucketed into a single shared rate-limit key, so anyone
 * could DOS legitimate anon traffic by hitting the limit themselves.
 *
 * On Vercel x-forwarded-for is reliable, but defense-in-depth is
 * cheap: try multiple headers, fall back to the request's remote
 * address if exposed, and finally to a per-request UUID (each
 * unidentified call gets its own bucket — fail open on rate-limit
 * but never collapse).
 */
export function clientIpForRateLimit(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = request.headers.get('x-real-ip')?.trim()
  if (real) return real
  const cf = request.headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  // NextRequest.ip is deprecated in Next 16 but may still be present
  // depending on runtime. Try it via duck-typing without TS complaint.
  const maybeIp = (request as unknown as { ip?: string }).ip
  if (typeof maybeIp === 'string' && maybeIp.length > 0) return maybeIp
  // Last-resort: per-request UUID. This means EACH unattributable
  // call gets its own bucket — the rate limit doesn't fire for them.
  // Acceptable: the alternative ('unknown' shared bucket) is worse
  // because legitimate anon callers all share one limit.
  return `anon:${randomUUID()}`
}
