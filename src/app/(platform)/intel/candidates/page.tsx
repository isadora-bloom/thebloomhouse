import { redirect } from 'next/navigation'

/**
 * Legacy redirect: /intel/candidates was the pre-identity-first candidate review.
 * Redirect to /intel/identity-review (the modern identity reconciliation surface).
 *
 * Removed from nav 2026-09-08 as part of W9 consolidation hygiene pass.
 * This redirect ensures old bookmarks and direct links still work.
 */
export default function LegacyCandidatesPage() {
  redirect('/intel/identity-review')
}
