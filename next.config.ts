import type { NextConfig } from 'next'

/**
 * Content-Security-Policy shipped on every route.
 *
 * What this is and is not (S5, 2026-09-14 security audit item 1):
 *
 * This is a static CSP, not a nonce-based one. A per-request nonce has to
 * be minted in middleware and threaded onto every inline script tag, and
 * src/middleware.ts is owned by another workstream this round, so a nonce
 * pass would have collided. The directives below are therefore written to
 * be true of the app as it stands rather than aspirational:
 *
 *   - script-src keeps 'unsafe-inline' and 'unsafe-eval'. Next's own
 *     hydration bootstrap and its flight-data payload are inline scripts,
 *     and PostHog's recorder evaluates at runtime. Dropping either one
 *     white-screens the app, so claiming them here would be a CSP that
 *     gets turned off the first time someone hits a real page.
 *   - connect-src stays broad (https: / wss:) because the browser talks
 *     straight to Supabase, PostHog and the venue's own storage host,
 *     none of which are a fixed origin at build time.
 *
 * What the policy DOES buy, and what the audit asked for:
 *   - frame-ancestors 'none' — nothing may frame us. This is the clickjack
 *     defence for the public pages with no login (the wedding website,
 *     the vendor link pages), where a transparent overlay on an
 *     attacker's page is the whole attack. X-Frame-Options: DENY below says the same thing again
 *     for older browsers that never learned frame-ancestors.
 *   - object-src 'none' — no Flash/applet/plugin embedding.
 *   - base-uri 'self' — an injected <base> cannot re-point every relative
 *     script URL at an attacker host.
 *   - form-action 'self' — an injected form cannot post the couple's typed
 *     name somewhere else.
 *
 * Tightening script-src to a nonce is the follow-up, and it belongs with
 * whoever next owns middleware.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  // The couple portal loads the venue's chosen font pair from Google
  // Fonts (src/config/fonts.ts, linked from src/app/couple/[slug]/
  // layout.tsx). The S5 headers shipped without these two hosts, so
  // every couple page fell back to system fonts and logged a CSP
  // violation. Found by the §27 journey on 2026-09-15.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ')

/**
 * Permissions-Policy: deny the powerful features outright rather than
 * listing them as self. Nothing in the platform or the couple portal asks
 * for a camera, a microphone, geolocation or a payment handler, so an
 * empty allowlist costs nothing and shuts the door on anything injected.
 */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=(self)',
  'geolocation=()',
  'gyroscope=()',
  'interest-cohort=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ')

/**
 * Exported so the unit test can read the shipped values instead of
 * re-typing them. See src/lib/security/__tests__/security-headers.test.ts.
 */
export const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
  // Legacy, but free: stop a document served from here being treated as
  // same-origin by a cross-origin opener.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // S5 (2026-09-14): one header block for every route. `/:path*` matches
  // pages, API routes and static assets alike, which is what we want —
  // no public page may be frameable, and neither may anything else.
  async headers() {
    // The E2E harness serves a production build over plain http on
    // localhost:3100 (e2e/dev-server.ts sets E2E_HARNESS=1 for the build).
    // Chromium honours Strict-Transport-Security from that first response,
    // upgrades every later request to https, and the run dies in
    // ERR_SSL_PROTOCOL_ERROR (2026-09-15). Everything else in the block
    // stays as shipped; the unit test still reads SECURITY_HEADERS whole.
    //
    // `upgrade-insecure-requests` goes for the same reason: a production
    // bundle prefetches links, the middleware answers a prefetch of a
    // signed-out page with a redirect, and Chromium upgrades the redirect
    // target to https://localhost:3100. Dev never prefetches, which is why
    // the dev runs never saw it. Both directives are for the real host.
    const headers =
      process.env.E2E_HARNESS === '1'
        ? SECURITY_HEADERS.filter((h) => h.key !== 'Strict-Transport-Security').map((h) =>
            h.key === 'Content-Security-Policy'
              ? { ...h, value: h.value.replace(/;\s*upgrade-insecure-requests/, '') }
              : h
          )
        : SECURITY_HEADERS
    return [
      {
        source: '/:path*',
        headers,
      },
    ]
  },
  // Round 2 audit TIER 3 (2026-05-14): four engineering-mostly pages
  // moved from /intel/* to /admin/*. Old URLs redirect so bookmarks +
  // cross-page links keep working.
  async redirects() {
    return [
      // TIER 3 (2026-05-14): engineering surfaces moved from /intel to /admin
      { source: '/intel/identity-backtrack', destination: '/admin/identity-backtrack', permanent: true },
      { source: '/intel/calibration', destination: '/admin/calibration', permanent: true },
      { source: '/intel/disagreements', destination: '/admin/disagreements', permanent: true },
      { source: '/intel/sources/parity', destination: '/admin/sources-parity', permanent: true },
      // TIER 4 (2026-05-14): Voice DNA is brain config, not intelligence.
      { source: '/intel/voice-dna', destination: '/sage/voice-dna', permanent: true },
      // TIER 4b: Identity Backtrack becomes sub-route under /admin/identity.
      { source: '/admin/identity-backtrack', destination: '/admin/identity/backtrack', permanent: true },
      // TIER 4c: Briefings folded into Intelligence Dashboard.
      { source: '/intel/briefings', destination: '/intel/dashboard', permanent: true },
    ]
  },
}

export default nextConfig
