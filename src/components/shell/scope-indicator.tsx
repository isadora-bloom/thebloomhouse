'use client'

import { useEffect, useRef, useState } from 'react'
import { Building2, Layers, MapPin, Check, ChevronDown, Globe } from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'
import { useVenueScope } from '@/lib/contexts/venue-scope-context'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

/**
 * Interactive scope switcher for the platform top bar.
 *
 * The V2 nav (bloom_nav_v2 cookie) replaces the V1 sidebar's full
 * ScopeSelector card with this pill. Originally it was display-only
 * (a coloured chip showing the current scope) and there was no way to
 * change scope from V2 — the user reported this as missing affordance
 * "in the new dashboard in beta there's no way to switch between
 * venues or company". Fixed by making the pill a clickable trigger
 * that opens a popover with the same Company / Groups / Venues list
 * the sidebar selector exposes. Selecting an option writes
 * bloom_scope (and bloom_venue when a single venue is picked) and
 * reloads so the platform layout's server-side scope re-resolves.
 *
 * Reads the SSR-resolved scope from VenueScopeProvider for the
 * initial pill text (avoids the cookie/SSR hydration mismatch). The
 * popover-mode data (venues, groups, org name) is fetched on mount
 * via the browser supabase client — same query shape as
 * ScopeSelector.
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

function setScopeCookie(scope: {
  level: 'venue' | 'group' | 'company'
  venueId?: string
  groupId?: string
  orgId?: string
  venueName?: string
  groupName?: string
  companyName?: string
}) {
  document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify(scope))}; path=/; max-age=${60 * 60 * 24 * 365}`
  if (scope.venueId) {
    document.cookie = `bloom_venue=${scope.venueId}; path=/; max-age=${60 * 60 * 24 * 365}`
  }
}

export function ScopeIndicator() {
  const clientScope = useScope()
  const serverScope = useVenueScope()
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [venues, setVenues] = useState<VenueRow[]>([])
  const [groups, setGroups] = useState<VenueGroupRow[]>([])
  const [orgName, setOrgName] = useState<string>('Company')
  const [orgId, setOrgId] = useState<string | null>(null)

  // Prefer server-resolved level for the trigger pill (avoids SSR/CSR
  // mismatch). Fall back to client cookie when the provider doesn't
  // carry it (group/company-level the layout doesn't pre-resolve).
  const level = serverScope.level ?? clientScope.level
  const triggerName =
    level === 'group'
      ? serverScope.groupName ?? clientScope.groupName ?? 'Group'
      : level === 'company'
      ? serverScope.orgName ?? clientScope.companyName ?? 'Company'
      : serverScope.venueName ?? clientScope.venueName ?? 'Venue'

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
      const isDemo = document.cookie.split('; ').some((c) => c === 'bloom_demo=true')

      let userOrgId: string | null = null
      if (isDemo) {
        userOrgId = DEMO_ORG_ID
      } else {
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
      let orgQuery = supabase.from('organisations').select('name').limit(1)
      if (userOrgId) orgQuery = orgQuery.eq('id', userOrgId)
      const { data: orgRow } = await orgQuery.maybeSingle()
      if (cancelled) return
      if (orgRow?.name) setOrgName(orgRow.name as string)

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
  }, [open])

  function selectVenue(v: VenueRow) {
    setScopeCookie({
      level: 'venue',
      venueId: v.id,
      orgId: orgId ?? undefined,
      venueName: v.name,
      companyName: orgName,
    })
    setOpen(false)
    window.location.reload()
  }

  function selectGroup(g: VenueGroupRow) {
    setScopeCookie({
      level: 'group',
      groupId: g.id,
      orgId: orgId ?? undefined,
      groupName: g.name,
      companyName: orgName,
    })
    setOpen(false)
    window.location.reload()
  }

  function selectCompany() {
    setScopeCookie({
      level: 'company',
      orgId: orgId ?? undefined,
      companyName: orgName,
    })
    setOpen(false)
    window.location.reload()
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
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 border rounded-lg text-xs transition-colors',
          pillStyle,
          'hover:ring-2 hover:ring-sage-200'
        )}
      >
        <TriggerIcon className="w-3.5 h-3.5" />
        <span className="font-medium">{triggerLabel}:</span>
        <span className="font-semibold">{triggerName}</span>
        <ChevronDown
          className={cn('w-3.5 h-3.5 transition-transform shrink-0', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden">
          {/* Company */}
          <div className="p-2 border-b border-border">
            <button
              onClick={selectCompany}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-colors',
                level === 'company' ? 'bg-gold-50 text-gold-800' : 'hover:bg-sage-50 text-sage-600'
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
                    level === 'group' && clientScope.groupId === g.id
                      ? 'bg-teal-50 text-teal-800'
                      : 'hover:bg-sage-50 text-sage-600'
                  )}
                >
                  <Layers className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{g.name}</span>
                  {level === 'group' && clientScope.groupId === g.id && (
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
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors',
                    level === 'venue' && (serverScope.venueId === v.id || clientScope.venueId === v.id)
                      ? 'bg-sage-100 text-sage-800'
                      : 'hover:bg-sage-50 text-sage-600'
                  )}
                >
                  <MapPin className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{v.name}</span>
                  {level === 'venue' &&
                    (serverScope.venueId === v.id || clientScope.venueId === v.id) && (
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
