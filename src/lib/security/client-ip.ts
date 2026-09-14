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
 * 2026-09-14 security review, item 6. The round-2 fix cured the
 * bucket-collapse but kept reading the LEFTMOST entry of
 * `x-forwarded-for`, and that value is written by the caller. A script
 * sending `X-Forwarded-For: <random>` on every request gets a fresh
 * rate-limit bucket every time, which is not a partial bypass of the
 * public sage-preview limit — it is a complete one, because the limit is
 * keyed on nothing else.
 *
 * The rule an X-Forwarded-For chain actually supports is that only the
 * hops your own infrastructure appended can be trusted, and those are at
 * the RIGHT-hand end. Vercel additionally publishes the client address in
 * `x-vercel-forwarded-for`, which it sets itself and which a caller
 * cannot forge, so that is checked first. The ordering below is therefore:
 * platform-set single-value headers, then the rightmost hop of the chain,
 * then the runtime's own view of the socket, then a per-request UUID.
 *
 * The UUID fallback is deliberate and unchanged: an unattributable caller
 * gets its own bucket rather than sharing one with everybody else. It
 * fails open on rate-limiting, but it cannot be used to lock other people
 * out, and on Vercel it is unreachable in practice.
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

/**
 * Headers the platform sets itself and a caller cannot influence. A
 * client-sent copy of any of these is overwritten at the edge before the
 * function sees it, which is the whole reason to prefer them over the
 * forwarded-for chain.
 */
const PLATFORM_CLIENT_IP_HEADERS = [
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
  'x-real-ip',
] as const

/**
 * The rightmost entry of an X-Forwarded-For chain: the hop appended by
 * the proxy closest to us, and the only entry in the list that our own
 * infrastructure wrote. Everything to its left was supplied by whoever
 * was talking to that proxy and is not evidence of anything.
 */
function rightmostForwardedHop(chain: string): string {
  const parts = chain.split(',')
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = normalizeIp(parts[i] ?? '')
    if (candidate) return candidate
  }
  return ''
}

export function clientIpForRateLimit(request: NextRequest): string {
  for (const header of PLATFORM_CLIENT_IP_HEADERS) {
    // x-vercel-forwarded-for is normally a single address, but treat it
    // as a chain anyway: if a future edge config makes it one, the
    // rightmost hop is still the trusted end.
    const value = request.headers.get(header)
    if (value) {
      const ip = rightmostForwardedHop(value)
      if (ip) return ip
    }
  }
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const trusted = rightmostForwardedHop(xff)
    if (trusted) return trusted
  }
  // NextRequest.ip is deprecated in Next 16 but may still be present
  // depending on runtime. Try it via duck-typing without TS complaint.
  const maybeIp = (request as unknown as { ip?: string }).ip
  if (typeof maybeIp === 'string' && maybeIp.length > 0) return normalizeIp(maybeIp)
  // Last-resort: per-request UUID. Each unattributable call gets its
  // own bucket — fail-open on rate-limit, but no bucket-collapse.
  return `anon:${randomUUID()}`
}
