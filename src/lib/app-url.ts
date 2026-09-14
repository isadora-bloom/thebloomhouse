/**
 * Get the canonical app URL for use in email links, invite links, OAuth callbacks, and webhooks.
 *
 * Precedence (highest to lowest):
 * 1. APP_CANONICAL_HOST (optional, set by operator when custom domain is active)
 * 2. NEXT_PUBLIC_APP_URL (typically set in .env.local, used as fallback)
 * 3. VERCEL_URL (automatically set by Vercel deployments)
 *
 * This ensures that:
 * - Email links point to the canonical domain, not a preview URL
 * - OAuth callbacks work after domain cutover
 * - Webhook callbacks resolve correctly
 */
export function appUrl(path: string): string {
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http'

  // Prefer canonical host if set
  if (process.env.APP_CANONICAL_HOST) {
    return `${protocol}://${process.env.APP_CANONICAL_HOST}${path}`
  }

  // Then prefer explicit app URL (developer-set in .env.local)
  if (process.env.NEXT_PUBLIC_APP_URL) {
    const url = process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')
    return `${url}${path}`
  }

  // Fall back to Vercel deployment URL (automatic in production)
  if (process.env.VERCEL_URL) {
    return `${protocol}://${process.env.VERCEL_URL}${path}`
  }

  // Last resort for local development
  return `${protocol}://localhost:3000${path}`
}
