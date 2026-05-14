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
      { source: '/intel/identity-backtrack', destination: '/admin/identity-backtrack', permanent: true },
      { source: '/intel/calibration', destination: '/admin/calibration', permanent: true },
      { source: '/intel/disagreements', destination: '/admin/disagreements', permanent: true },
      { source: '/intel/sources/parity', destination: '/admin/sources-parity', permanent: true },
    ]
  },
}

export default nextConfig
