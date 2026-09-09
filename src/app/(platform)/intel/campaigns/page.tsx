import { redirect } from 'next/navigation'

/**
 * Legacy redirect: /intel/campaigns was manual campaign CRUD.
 * Redirect to /intel/sources (the attribution view supersedes manual campaigns).
 *
 * Removed from nav 2026-05-03 (Stream ZZZ). Old bookmarks and direct links
 * redirect to the sources surface, which provides multi-touch attribution.
 */
export default function LegacyCampaignsPage() {
  redirect('/intel/sources')
}
