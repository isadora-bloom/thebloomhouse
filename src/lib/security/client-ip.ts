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
/**
 * Normalize a header-derived IP value so two proxy chains that
 * preserve vs strip port end up in the same rate-limit bucket. Per
 * round-3 audit:
 *   "1.2.3.4:5678" → "1.2.3.4"
 *   "[2001:db8::1]:8080" → "2001:db8::1"
 *   "[::1]" → "::1"
 *   "2001:db8::1" → "2001:db8::1"  (unchanged, already canonical)
 */
function normalizeIp(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  // Bracketed IPv6, optionally with :port — [::1]:8080 or [::1].
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) return bracketed[1]
  // Looks like IPv4 with port — exactly 3 dots, ends with :port.
  // (Pure IPv6 has many colons; we don't strip those.)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(trimmed)) {
    return trimmed.split(':')[0]
  }
  return trimmed
}

export function clientIpForRateLimit(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = normalizeIp(xff.split(',')[0] ?? '')
    if (first) return first
  }
  const real = normalizeIp(request.headers.get('x-real-ip') ?? '')
  if (real) return real
  const cf = normalizeIp(request.headers.get('cf-connecting-ip') ?? '')
  if (cf) return cf
  // NextRequest.ip is deprecated in Next 16 but may still be present
  // depending on runtime. Try it via duck-typing without TS complaint.
  const maybeIp = (request as unknown as { ip?: string }).ip
  if (typeof maybeIp === 'string' && maybeIp.length > 0) return normalizeIp(maybeIp)
  // Last-resort: per-request UUID. Each unattributable call gets its
  // own bucket — fail-open on rate-limit, but no bucket-collapse.
  return `anon:${randomUUID()}`
}
