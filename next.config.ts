import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
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
    ]
  },
}

export default nextConfig
