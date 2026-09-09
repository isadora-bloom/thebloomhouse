/**
 * The post-login landing route.
 *
 * This used to render the full platform dashboard. It now decides where
 * a coordinator should actually start and sends them there:
 *
 *   no venue in scope        → /setup   (the layout does this too)
 *   onboarding not finished  → /onboarding
 *   otherwise                → /today
 *
 * The dashboard itself moved to /dashboard, whole and unchanged, and
 * /today links to it. Nothing was deleted.
 *
 * The redirect decision runs on the server so the coordinator never sees
 * a flash of one page before being moved to another — the old client-side
 * version rendered the whole dashboard, then pushed to /onboarding.
 */

import { redirect } from 'next/navigation'
import { resolvePlatformScope } from '@/lib/api/resolve-platform-scope'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

export default async function PlatformIndexPage() {
  const scope = await resolvePlatformScope()
  if (!scope) redirect('/setup')

  // Onboarding gate, carried over from the previous client-side version.
  // Best-effort: a missing or unreadable config row must not trap someone
  // on a blank screen, so anything other than an explicit `false` lets
  // them through to /today.
  let onboardingComplete = true
  try {
    const { data } = await createServiceClient()
      .from('venue_config')
      .select('onboarding_completed')
      .eq('venue_id', scope.venueId)
      .maybeSingle<{ onboarding_completed: boolean | null }>()
    if (data && data.onboarding_completed === false) onboardingComplete = false
  } catch {
    // fall through to /today
  }

  if (!onboardingComplete) redirect('/onboarding')
  redirect('/today')
}
