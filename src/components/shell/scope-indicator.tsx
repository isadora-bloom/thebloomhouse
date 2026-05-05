'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Building2, Layers, MapPin, Check, ChevronDown, Globe } from 'lucide-react'
import {
  useVenueScope,
  useScopeMutator,
} from '@/lib/contexts/venue-scope-context'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

/**
 * Interactive scope switcher for the platform top bar.
 *
 * Reads SSR-resolved scope from `VenueScopeProvider` for the trigger
 * pill (no SSR/CSR hydration mismatch). Selecting an option calls
 * `setScope({...})` from the same provider which:
 *   - updates the in-memory store synchronously, so every consumer of
 *     `useVenueScope()` re-renders instantly with the new venueId
 *     (no `window.location.reload()`, no white flash, no GAP-09 race)
 *   - writes the bloom_scope + bloom_venue cookies for SSR continuity
 *   - schedules a `router.refresh()` so server components re-render
 *     against the new cookie
 *
 * Edge case: enterprise / org-admin users may switch into a scope that
 * the current path can't render against (e.g. switching from a venue
 * page to company scope on a venue-only config page). When the new
 * level isn't 'venue' and the current pathname is a `/portal/*-config`
 * route, we navigate back to the dashboard. Pages have their own RSC
 * gates downstream, but this avoids a confusing "blank config" state.
 */

interface VenueRow {
  id: string
  name: string
}

interface VenueGroupRow {
  id: string
  name: string
}

const DEMO_ORG_ID = '11111111-1111-1111-1111-111111111111'

/**
 * Routes that are venue-only (per-venue resource config). When the
 * user switches to group / company scope while on one of these, push
 * them somewhere coherent so they don't see an empty config UI.
 */
const VENUE_ONLY_PREFIXES = ['/portal/', '/agent/inbox', '/agent/drafts']

function pathRequiresVenueScope(pathname: string): boolean {
  return VENUE_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

export function ScopeIndicator() {
  const serverScope = useVenueScope()
  const setScope = useScopeMutator()
  const router = useRouter()
  const pathname = usePathname()
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [venues, setVenues] = useState<VenueRow[]>([])
  const [groups, setGroups] = useState<VenueGroupRow[]>([])
  const [orgName, setOrgName] = useState<string>(serverScope.orgName ?? 'Company')
  const [orgId, setOrgId] = useState<string | null>(serverScope.orgId)

  const level = serverScope.level
  const triggerName =
    level === 'group'
      ? serverScope.groupName ?? 'Group'
      : level === 'company'
      ? serverScope.orgName ?? 'Company'
      : serverScope.venueName ?? 'Venue'

  // Click-outside dismiss.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) {
      document.addEventListener('mousedown', onClick)
      return () => document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  // Lazy-load venues + groups + org name when the popover first opens.
  // Re-fires only when the user explicitly opens; doesn't burn a query
  // on every page load.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      const supabase = createClient()
      const isDemo = serverScope.isDemo

      let userOrgId: string | null = serverScope.orgId
      if (isDemo) {
        userOrgId = DEMO_ORG_ID
      } else if (!userOrgId) {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data: profile } = await supabase
            .from('user_profiles')
            .select('org_id')
            .eq('id', user.id)
            .maybeSingle()
          userOrgId = (profile?.org_id as string | null) ?? null
        }
      }
      if (cancelled) return
      setOrgId(userOrgId)

      // Venues — filtered by org so we don't leak across organisations.
      let venueQuery = supabase.from('venues').select('id, name').order('name')
      if (userOrgId) venueQuery = venueQuery.eq('org_id', userOrgId)
      const { data: venueRows } = await venueQuery
      if (cancelled) return
      setVenues((venueRows ?? []) as VenueRow[])

      // Org name — for the Company option label.
      if (!serverScope.orgName) {
        let orgQuery = supabase.from('organisations').select('name').limit(1)
        if (userOrgId) orgQuery = orgQuery.eq('id', userOrgId)
        const { data: orgRow } = await orgQuery.maybeSingle()
        if (cancelled) return
        if (orgRow?.name) setOrgName(orgRow.name as string)
      }

      // Groups (optional — empty for venues without portfolios).
      let groupQuery = supabase.from('venue_groups').select('id, name').order('name')
      if (userOrgId) groupQuery = groupQuery.eq('org_id', userOrgId)
      const { data: groupRows } = await groupQuery
      if (cancelled) return
      setGroups((groupRows ?? []) as VenueGroupRow[])
    }
    load()
    return () => {
      cancelled = true
    }
  }, [open, serverScope.isDemo, serverScope.orgId, serverScope.orgName])

  function selectVenue(v: VenueRow) {
    setScope({
      level: 'venue',
      venueId: v.id,
      venueName: v.name,
      orgId: orgId,
      orgName: orgName,
      groupId: null,
      groupName: null,
    })
    setOpen(false)
  }

  function selectGroup(g: VenueGroupRow) {
    setScope({
      level: 'group',
      groupId: g.id,
      groupName: g.name,
      orgId: orgId,
      orgName: orgName,
    })
    setOpen(false)
    if (pathRequiresVenueScope(pathname)) router.push('/intel/dashboard')
  }

  function selectCompany() {
    setScope({
      level: 'company',
      orgId: orgId,
      orgName: orgName,
      groupId: null,
      groupName: null,
    })
    setOpen(false)
    if (pathRequiresVenueScope(pathname)) router.push('/intel/dashboard')
  }

  // Trigger pill colour scheme matches the previous read-only design.
  const pillStyle =
    level === 'group'
      ? 'bg-teal-50 border-teal-200 text-teal-900'
      : level === 'company'
      ? 'bg-gold-50 border-gold-200 text-gold-900'
      : 'bg-sage-50 border-sage-200 text-sage-900'
  const TriggerIcon = level === 'group' ? Layers : level === 'company' ? Building2 : MapPin
  const triggerLabel =
    level === 'group' ? 'Viewing group' : level === 'company' ? 'Viewing all venues' : 'Viewing venue'

  return (
    <div ref={ref} className="relative" data-testid="scope-indicator">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 border rounded-lg text-xs transition-colors',
          pillStyle,
          'hover:ring-2 hover:ring-sage-200',
        )}
        data-testid="scope-indicator-trigger"
      >
        <TriggerIcon className="w-3.5 h-3.5" />
        <span className="font-medium">{triggerLabel}:</span>
        <span className="font-semibold" data-testid="scope-indicator-name">
          {triggerName}
        </span>
        <ChevronDown
          className={cn('w-3.5 h-3.5 transition-transform shrink-0', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-72 bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden"
          data-testid="scope-indicator-menu"
        >
          {/* Company */}
          <div className="p-2 border-b border-border">
            <button
              onClick={selectCompany}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-colors',
                level === 'company' ? 'bg-gold-50 text-gold-800' : 'hover:bg-sage-50 text-sage-600',
              )}
            >
              <Globe className="w-4 h-4 shrink-0" />
              <span className="flex-1 text-left font-medium">{orgName}</span>
              <span className="text-xs text-sage-400">
                {venues.length} {venues.length === 1 ? 'venue' : 'venues'}
              </span>
              {level === 'company' && <Check className="w-3.5 h-3.5" />}
            </button>
          </div>

          {/* Groups */}
          {groups.length > 0 && (
            <div className="p-2 border-b border-border max-h-48 overflow-y-auto">
              <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-sage-400">
                Groups
              </p>
              {groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => selectGroup(g)}
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors',
                    level === 'group' && serverScope.groupId === g.id
                      ? 'bg-teal-50 text-teal-800'
                      : 'hover:bg-sage-50 text-sage-600',
                  )}
                >
                  <Layers className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{g.name}</span>
                  {level === 'group' && serverScope.groupId === g.id && (
                    <Check className="w-3.5 h-3.5" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Venues */}
          <div className="p-2 max-h-64 overflow-y-auto">
            <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-sage-400">
              Venues
            </p>
            {venues.length === 0 ? (
              <div className="px-3 py-2 text-sm text-sage-400">Loading…</div>
            ) : (
              venues.map((v) => (
                <button
                  key={v.id}
                  onClick={() => selectVenue(v)}
                  data-testid={`scope-indicator-venue-${v.id}`}
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors',
                    level === 'venue' && serverScope.venueId === v.id
                      ? 'bg-sage-100 text-sage-800'
                      : 'hover:bg-sage-50 text-sage-600',
                  )}
                >
                  <MapPin className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{v.name}</span>
                  {level === 'venue' && serverScope.venueId === v.id && (
                    <Check className="w-3.5 h-3.5" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
