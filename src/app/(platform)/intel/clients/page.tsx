import { redirect } from 'next/navigation'

/**
 * Legacy redirect: /intel/clients was the pre-identity-first couples view.
 * Redirect to /intel/couples (the identity-first, consolidated view).
 *
 * Removed from nav 2026-09-08 as part of W9 consolidation hygiene pass.
 * This redirect ensures old bookmarks and direct links still work.
 */
export default function LegacyClientsPage() {
  redirect('/intel/couples')
}
