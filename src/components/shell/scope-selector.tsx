'use client'

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  ChevronDown, Check, Building2, Layers, Globe,
  Plus, Settings,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Venue {
  id: string
  name: string
  slug: string
  status: string
}

interface VenueGroup {
  id: string
  name: string
  venue_ids: string[]
}

export type ScopeLevel = 'venue' | 'group' | 'company'

export interface Scope {
  level: ScopeLevel
  venueId?: string       // set when level='venue'
  groupId?: string       // set when level='group'
  venueName?: string
  groupName?: string
  companyName?: string
}

// Fallback org name (will be overridden from DB)
const DEMO_ORG_ID = '11111111-1111-1111-1111-111111111111'
const DEFAULT_ORG_NAME = 'The Crestwood Collection'

// No static fallback groups — real data comes from the venue_groups table.
// If the query fails or returns empty, the selector simply hides the Groups section.
const FALLBACK_GROUPS: VenueGroup[] = []

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function getScopeCookie(): Scope | null {
  try {
    const raw = document.cookie
      .split('; ')
      .find((c) => c.startsWith('bloom_scope='))
      ?.split('=')[1]
    return raw ? JSON.parse(decodeURIComponent(raw)) : null
  } catch {
    return null
  }
}

function setScopeCookie(scope: Scope) {
  document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify(scope))}; path=/; max-age=${60 * 60 * 24 * 365}`
  // Also set legacy venue cookie for pages that read it
  if (scope.venueId) {
    document.cookie = `bloom_venue=${scope.venueId}; path=/; max-age=${60 * 60 * 24 * 365}`
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SCOPE_ICONS = {
  venue: Building2,
  group: Layers,
  company: Globe,
}

const SCOPE_COLORS = {
  venue: 'text-sage-600',
  group: 'text-teal-600',
  company: 'text-gold-600',
}

const SCOPE_BG = {
  venue: 'bg-sage-50',
  group: 'bg-teal-50',
  company: 'bg-gold-50',
}

export function ScopeSelector() {
  const [venues, setVenues] = useState<Venue[]>([])
  const [groups, setGroups] = useState<VenueGroup[]>([])
  const [orgName, setOrgName] = useState(DEFAULT_ORG_NAME)
  const [scope, setScope] = useState<Scope | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function load() {
      const supabase = createClient()

      // Load venues
      const { data: venueData } = await supabase
        .from('venues')
        .select('id, name, slug, status')
        .order('name')

      setVenues((venueData ?? []) as Venue[])

      // Load org name
      const { data: orgData } = await supabase
        .from('organisations')
        .select('name')
        .limit(1)
        .maybeSingle()
      if (orgData?.name) setOrgName(orgData.name)

      // Load groups from DB (with fallback to static)
      const { data: groupData, error: groupErr } = await supabase
        .from('venue_groups')
        .select('id, name, venue_group_members(venue_id)')
        .order('name')

      if (!groupErr && groupData && groupData.length > 0) {
        const dbGroups: VenueGroup[] = groupData.map((g: any) => ({
          id: g.id,
          name: g.name,
          venue_ids: (g.venue_group_members ?? []).map((m: any) => m.venue_id),
        }))
        setGroups(dbGroups)
      } else {
        // Fallback to hardcoded groups if table doesn't exist yet
        setGroups(FALLBACK_GROUPS)
      }

      // Restore from cookie or default to first venue
      const saved = getScopeCookie()
      if (saved) {
        setScope({ ...saved, companyName: orgData?.name ?? DEFAULT_ORG_NAME })
      } else if (venueData && venueData.length > 0) {
        const first = venueData[0]
        setScope({
          level: 'venue',
          venueId: first.id,
          venueName: first.name,
          companyName: orgData?.name ?? DEFAULT_ORG_NAME,
        })
      }

      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function selectVenue(v: Venue) {
    const newScope: Scope = {
      level: 'venue',
      venueId: v.id,
      venueName: v.name,
      companyName: orgName,
    }
    setScope(newScope)
    setScopeCookie(newScope)
    setOpen(false)
    window.location.reload()
  }

  function selectGroup(g: VenueGroup) {
    const newScope: Scope = {
      level: 'group',
      groupId: g.id,
      groupName: g.name,
      companyName: orgName,
    }
    setScope(newScope)
    setScopeCookie(newScope)
    setOpen(false)
    window.location.reload()
  }

  function selectCompany() {
    const newScope: Scope = {
      level: 'company',
      companyName: orgName,
    }
    setScope(newScope)
    setScopeCookie(newScope)
    setOpen(false)
    window.location.reload()
  }

  if (loading || !scope) {
    return <div className="h-[72px] bg-sage-50/50 rounded-xl animate-pulse mx-3 mt-3" />
  }

  const ScopeIcon = SCOPE_ICONS[scope.level]
  const displayName = scope.level === 'venue'
    ? scope.venueName
    : scope.level === 'group'
      ? scope.groupName
      : scope.companyName

  const scopeLabel = scope.level === 'venue'
    ? 'Single Venue'
    : scope.level === 'group'
      ? 'Venue Group'
      : 'All Venues'

  return (
    <div ref={ref} className="relative mx-3 mt-3">
      {/* Scope badge + selector button */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-3 w-full px-3 py-3 rounded-xl text-left transition-all',
          SCOPE_BG[scope.level], 'hover:ring-2 hover:ring-sage-200'
        )}
      >
        <div className={cn('p-2 rounded-lg bg-white/80', SCOPE_COLORS[scope.level])}>
          <ScopeIcon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-sage-500">
            {scopeLabel}
          </p>
          <p className="text-sm font-semibold text-sage-800 truncate">
            {displayName}
          </p>
        </div>
        <ChevronDown className={cn(
          'w-4 h-4 text-sage-400 transition-transform shrink-0',
          open && 'rotate-180'
        )} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden">
          {/* Company level */}
          <div className="p-2 border-b border-border">
            <button
              onClick={selectCompany}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-colors',
                scope.level === 'company' ? 'bg-gold-50 text-gold-800' : 'hover:bg-sage-50 text-sage-600'
              )}
            >
              <Globe className="w-4 h-4 shrink-0" />
              <span className="flex-1 text-left font-medium">{orgName}</span>
              <span className="text-xs text-sage-400">{venues.length} venues</span>
              {scope.level === 'company' && <Check className="w-3.5 h-3.5" />}
            </button>
          </div>

          {/* Groups */}
          {groups.length > 0 && (
            <div className="p-2 border-b border-border">
              <p className="px-3 py-1 text-xs font-semibold uppercase text-sage-400">Groups</p>
              {groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => selectGroup(g)}
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors',
                    scope.level === 'group' && scope.groupId === g.id
                      ? 'bg-teal-50 text-teal-800'
                      : 'hover:bg-sage-50 text-sage-600'
                  )}
                >
                  <Layers className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{g.name}</span>
                  <span className="text-xs text-sage-400">{g.venue_ids.length} venues</span>
                  {scope.level === 'group' && scope.groupId === g.id && (
                    <Check className="w-3.5 h-3.5" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Individual venues */}
          <div className="p-2">
            <p className="px-3 py-1 text-xs font-semibold uppercase text-sage-400">Venues</p>
            {venues.map((v) => (
              <button
                key={v.id}
                onClick={() => selectVenue(v)}
                className={cn(
                  'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors',
                  scope.level === 'venue' && scope.venueId === v.id
                    ? 'bg-sage-100 text-sage-800'
                    : 'hover:bg-sage-50 text-sage-600'
                )}
              >
                <Building2 className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">{v.name}</span>
                <span className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  v.status === 'active' ? 'bg-emerald-500' : 'bg-gray-400'
                )} />
                {scope.level === 'venue' && scope.venueId === v.id && (
                  <Check className="w-3.5 h-3.5" />
                )}
              </button>
            ))}
          </div>

          {/* Manage groups */}
          <div className="p-2 border-t border-border flex gap-2">
            <button className="flex items-center gap-2 flex-1 px-3 py-2 text-xs text-sage-500 hover:text-sage-800 rounded-lg hover:bg-sage-50 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add Venue
            </button>
            <button className="flex items-center gap-2 flex-1 px-3 py-2 text-xs text-sage-500 hover:text-sage-800 rounded-lg hover:bg-sage-50 transition-colors">
              <Settings className="w-3.5 h-3.5" /> Manage Groups
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
