/**
 * Server-only helper to read the current user's platform role.
 *
 * Anchor: Round 2 audit TIER 3 (2026-05-14). Before this helper the
 * /admin and /super-admin routes had NO server-side layout gate —
 * each page guarded itself, or didn't. Anyone authed who guessed
 * the URL could land on the merge-audit / observability / consumer-
 * requests surface and see their org's data through the page's own
 * Supabase queries (RLS still scoped them, but the surface itself
 * leaked engineering vocabulary + UX that's meant for the platform
 * team).
 *
 * Use in a server-component layout to redirect non-elevated users
 * before the page renders.
 */

import { cache } from 'react'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { isDemoMode } from '@/lib/api/auth-helpers'

export type PlatformRole =
  | 'coordinator'
  | 'manager'
  | 'org_admin'
  | 'super_admin'
  | null

async function _getPlatformRole(): Promise<PlatformRole> {
  // Demo cookie -> always 'coordinator'. Demo accounts cannot reach
  // admin surfaces. The layout gates redirect them away.
  if (await isDemoMode()) return 'coordinator'

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const service = createServiceClient()
  const { data: profile } = await service
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role as PlatformRole) ?? null
  return role
}

// React.cache: same request, multiple layouts (root + nested) → one
// DB roundtrip.
export const getPlatformRole = cache(_getPlatformRole)
