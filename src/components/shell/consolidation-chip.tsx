'use client'

/**
 * ConsolidationChip — small admin-only badge in the platform top bar
 * pointing operators at /system/consolidation-status.
 *
 * Anchor: PHASE-1-BATCH-2.md §7 "Operator-facing additions" item 2
 * (optional UX add). Rationale: the status page only helps if the
 * operator KNOWS the page exists. A persistent chip in the chrome is
 * the cheapest discoverability lever.
 *
 * Visibility rules — narrow by design:
 *   - Hidden in demo mode (Crestwood seed; consolidation is irrelevant).
 *   - Hidden for coordinator / manager — engineering vocabulary, would
 *     confuse not help.
 *   - Hidden when there is no in-flight phase (controlled by the
 *     CONSOLIDATION_IN_FLIGHT constant below — flip to `false` once
 *     the consolidation finishes; component becomes a no-op).
 *   - Hidden on the status page itself (don't link a page to itself).
 *
 * Multi-venue safe: shows the same thing for every venue / org / scope
 * because the consolidation state is a property of the deploy, not the
 * venue. If we ever ship per-venue cutovers, the chip should poll a
 * scope-aware endpoint instead of being a static constant.
 *
 * Maintenance: when /system/consolidation-status is updated, decide
 * whether to keep `CONSOLIDATION_IN_FLIGHT = true`. When the phased
 * rollout completes, flip to `false` and the chip disappears
 * everywhere automatically.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AlertCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useVenueScope } from '@/lib/contexts/venue-scope-context'

const CONSOLIDATION_IN_FLIGHT = true
const STATUS_HREF = '/system/consolidation-status'

export function ConsolidationChip() {
  const pathname = usePathname()
  const { isDemo } = useVenueScope()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false

    if (!CONSOLIDATION_IN_FLIGHT) return
    if (isDemo) return

    async function checkRole() {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (cancelled) return
      if (!user) {
        setIsAdmin(false)
        return
      }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
      if (cancelled) return

      const role = (profile?.role as string | undefined) ?? null
      setIsAdmin(role === 'org_admin' || role === 'super_admin')
    }

    checkRole()
    return () => {
      cancelled = true
    }
  }, [isDemo])

  if (!CONSOLIDATION_IN_FLIGHT) return null
  if (isDemo) return null
  if (!isAdmin) return null
  if (pathname?.startsWith(STATUS_HREF)) return null

  return (
    <Link
      href={STATUS_HREF}
      className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 transition-colors shrink-0"
      title="Phase 1 consolidation is in flight — open the status page"
    >
      <AlertCircle className="h-3 w-3" aria-hidden />
      Consolidation in flight
    </Link>
  )
}
