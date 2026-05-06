/**
 * SSRF defense for server-side URL fetching.
 *
 * Blocks server-side fetches that would resolve to private / link-local
 * / loopback IPs — including the cloud-metadata endpoint at
 * 169.254.169.254 that exposes instance credentials. Per 2026-05-06
 * audit Lens 8 (top-3 fix #2):
 *
 * > "fetchAndExtractUrl in src/lib/services/brain-dump-url.ts. fetch
 * >  (fileUrl) in src/app/api/portal/sage/route.ts:201-234. Both fetch
 * >  arbitrary URLs from authenticated callers with no private-IP
 * >  filter. Add explicit deny on 127/8, 10/8, 172.16/12, 192.168/16,
 * >  169.254/16, and limit to https://-only with allowlisted hosts for
 * >  fileUrl (Supabase Storage CDN + known couple-portal upload origins)."
 *
 * Threat model:
 *   - Coordinator (or compromised coordinator) pasting an internal URL
 *     into brain-dump → server proxies to internal service or cloud
 *     metadata → SSRF.
 *   - Couple supplying a fileUrl to /api/portal/sage that points at
 *     attacker.example/redirect → 169.254.169.254 → metadata exfil via
 *     server-side response.
 *   - TOCTOU on redirect chains: initial URL is public, redirects to
 *     private. Every hop must be re-validated.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type SafeFetchProtocol = 'https:' | 'http:'

export type AssertSafeUrlOptions = {
  /** Protocols allowed. Defaults to https-only. */
  allowedProtocols?: readonly SafeFetchProtocol[]
  /**
   * If set, the URL's hostname must end with one of these suffixes.
   * Use for fileUrl which should ONLY come from Supabase Storage.
   */
  hostAllowlist?: readonly string[]
}

export class UnsafeUrlError extends Error {
  constructor(public reason: string, public url: string) {
    super(`Unsafe URL (${reason}): ${url}`)
    this.name = 'UnsafeUrlError'
  }
}

const DEFAULT_PROTOCOLS: readonly SafeFetchProtocol[] = ['https:']

/**
 * Validate a URL is safe to fetch from a server context. Throws
 * UnsafeUrlError on any failure mode. Network roundtrip: one DNS
 * lookup per call (cached by the OS resolver — cheap).
 *
 * NOTE: this does NOT mitigate DNS-rebinding attacks. For that you
 * additionally need to pin the resolved IP and pass it to fetch via
 * a custom agent. We accept the residual risk for now because the
 * Vercel runtime doesn't expose a clean way to pin the agent and
 * the immediate threat (cloud metadata + loopback exfil) is closed
 * by the simple resolution check.
 */
export async function assertSafeUrl(
  rawUrl: string,
  options: AssertSafeUrlOptions = {},
): Promise<void> {
  const allowedProtocols = options.allowedProtocols ?? DEFAULT_PROTOCOLS

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError('not a valid URL', rawUrl)
  }

  if (!allowedProtocols.includes(parsed.protocol as SafeFetchProtocol)) {
    throw new UnsafeUrlError(
      `protocol ${parsed.protocol} not allowed (allowed: ${allowedProtocols.join(', ')})`,
      rawUrl,
    )
  }

  if (options.hostAllowlist && options.hostAllowlist.length > 0) {
    const host = parsed.hostname.toLowerCase()
    const ok = options.hostAllowlist.some((suffix) => {
      const s = suffix.toLowerCase()
      return host === s || host.endsWith(`.${s}`)
    })
    if (!ok) {
      throw new UnsafeUrlError(
        `host ${parsed.hostname} not in allowlist`,
        rawUrl,
      )
    }
  }

  // Resolve hostname to an IP. If the hostname IS already an IP literal,
  // skip the DNS lookup but still check it.
  const hostname = parsed.hostname
  const ipFamily = isIP(hostname)
  const addresses: { address: string; family: 4 | 6 }[] = []
  if (ipFamily) {
    addresses.push({ address: hostname, family: ipFamily as 4 | 6 })
  } else {
    try {
      const all = await lookup(hostname, { all: true })
      for (const a of all) {
        addresses.push({ address: a.address, family: a.family as 4 | 6 })
      }
    } catch (err) {
      throw new UnsafeUrlError(
        `DNS lookup failed: ${err instanceof Error ? err.message : 'unknown'}`,
        rawUrl,
      )
    }
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError('hostname resolved to no addresses', rawUrl)
  }

  for (const { address, family } of addresses) {
    if (family === 4) {
      if (isPrivateIPv4(address)) {
        throw new UnsafeUrlError(`resolves to private IPv4 ${address}`, rawUrl)
      }
    } else {
      if (isPrivateIPv6(address)) {
        throw new UnsafeUrlError(`resolves to private IPv6 ${address}`, rawUrl)
      }
    }
  }
}

/**
 * fetch() wrapper that calls assertSafeUrl first AND on every redirect
 * hop. Sets redirect: 'manual' so the runtime cannot transparently
 * follow a 302 into a private IP — every Location header is re-
 * validated through assertSafeUrl before the next request fires.
 *
 * Throws UnsafeUrlError if the original URL or any redirect target
 * fails the SSRF check. Throws on redirect chains longer than
 * MAX_REDIRECTS (default 5) to avoid infinite loops.
 *
 * Use this for ANY user-influenced URL on the server. The pre-2026-
 * 05-06 sage route called bare fetch(fileUrl) after assertSafeUrl —
 * that's a bandaid (audit Lens 8 round 2). The right shape is one
 * fetcher that handles both up-front and redirect validation.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: AssertSafeUrlOptions & { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5
  let currentUrl = url
  let hops = 0
  while (true) {
    await assertSafeUrl(currentUrl, options)
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' })
    // Manual redirect: 3xx with a Location header. We re-validate the
    // target before issuing the next request.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new UnsafeUrlError(`redirect ${response.status} without Location header`, currentUrl)
      }
      hops++
      if (hops > maxRedirects) {
        throw new UnsafeUrlError(`exceeded max redirects (${maxRedirects})`, url)
      }
      // Resolve relative redirects against currentUrl.
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    return response
  }
}

// ----------------------------------------------------------------------
// IP range checks. Implemented inline to avoid an extra dependency on
// ipaddr.js — the set of private ranges we block is small and stable.
// ----------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    // Malformed — treat as unsafe.
    return true
  }
  const [a, b] = parts

  // 0.0.0.0/8 — "this network"
  if (a === 0) return true
  // 10.0.0.0/8 — RFC 1918
  if (a === 10) return true
  // 100.64.0.0/10 — carrier-grade NAT (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 127.0.0.0/8 — loopback
  if (a === 127) return true
  // 169.254.0.0/16 — link-local (cloud metadata 169.254.169.254 lives here)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 — RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.0.0.0/24 — IETF assignments (includes 192.0.0.171 DNS64)
  if (a === 192 && b === 0 && parts[2] === 0) return true
  // 192.168.0.0/16 — RFC 1918
  if (a === 192 && b === 168) return true
  // 198.18.0.0/15 — benchmark
  if (a === 198 && (b === 18 || b === 19)) return true
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true
  // 240.0.0.0/4 — reserved + 255.255.255.255 broadcast
  if (a >= 240) return true

  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // ::1 — loopback. ::/128 — unspecified.
  if (lower === '::1' || lower === '::') return true
  // fe80::/10 — link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
  // fc00::/7 — unique local (fc.. and fd..)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  // ff00::/8 — multicast
  if (lower.startsWith('ff')) return true

  // ::ffff:0:0/96 — IPv4-mapped IPv6. Two address forms:
  //   dotted-quad: ::ffff:127.0.0.1
  //   compact hex: ::ffff:7f00:1   (equivalent to 127.0.0.1)
  // Round-2 audit caught the missing hex-form check. Block the entire
  // /96 prefix for safety: any address starting ::ffff: is mapped IPv4
  // and should be evaluated against IPv4 private ranges. If parsing
  // the trailing portion fails we fail closed (treat as private).
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length)
    // Dotted-quad form?
    const dotted = tail.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (dotted) return isPrivateIPv4(dotted[1])
    // Compact hex form: aaaa:bbbb where aaaa and bbbb are 1-4 hex chars.
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const a = parseInt(hex[1], 16)
      const b = parseInt(hex[2], 16)
      if (Number.isNaN(a) || Number.isNaN(b)) return true
      const v4 = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`
      return isPrivateIPv4(v4)
    }
    // Unknown shape inside ::ffff: — fail closed.
    return true
  }

  // 64:ff9b::/96 — IPv4/IPv6 translation (NAT64). Block the whole prefix.
  if (lower.startsWith('64:ff9b:')) return true

  return false
}
