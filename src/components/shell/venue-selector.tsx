'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { ChevronDown, Plus, Check, Building2 } from 'lucide-react'

interface Venue {
  id: string
  name: string
  is_active: boolean
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-500',
  inactive: 'bg-gray-400',
}

export function VenueSelector() {
  const [venues, setVenues] = useState<Venue[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  // Load venues for current user's org
  useEffect(() => {
    async function loadVenues() {
      const supabase = createClient()

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        return
      }

      // Get user's org membership
      const { data: membership } = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id)
        .single()

      if (!membership) {
        setLoading(false)
        return
      }

      const { data: venueData } = await supabase
        .from('venues')
        .select('id, name, is_active')
        .eq('org_id', membership.org_id)
        .order('name', { ascending: true })

      const venueList = (venueData ?? []) as Venue[]
      setVenues(venueList)

      // Restore selected venue from cookie or pick first
      const stored = document.cookie
        .split('; ')
        .find((c) => c.startsWith('bloom_venue='))
        ?.split('=')[1]

      if (stored && venueList.some((v) => v.id === stored)) {
        setSelectedId(stored)
      } else if (venueList.length > 0) {
        setSelectedId(venueList[0].id)
        document.cookie = `bloom_venue=${venueList[0].id}; path=/; max-age=${60 * 60 * 24 * 365}`
      }

      setLoading(false)
    }

    loadVenues()
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function selectVenue(id: string) {
    setSelectedId(id)
    setOpen(false)
    document.cookie = `bloom_venue=${id}; path=/; max-age=${60 * 60 * 24 * 365}`
    // Reload to re-fetch data for the new venue
    window.location.reload()
  }

  const selected = venues.find((v) => v.id === selectedId)

  if (loading) {
    return (
      <div className="px-3 py-2">
        <div className="h-9 bg-sage-100 rounded-lg animate-pulse" />
      </div>
    )
  }

  if (venues.length === 0) {
    return (
      <div className="px-3 py-2">
        <Link
          href="/onboarding"
          className="flex items-center gap-2 px-3 py-2 text-sm text-sage-600 hover:text-sage-800 rounded-lg hover:bg-sage-50 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Venue
        </Link>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative px-3 py-2">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm transition-colors',
          'bg-sage-50 hover:bg-sage-100 text-sage-800'
        )}
      >
        <Building2 className="w-4 h-4 shrink-0 text-sage-500" />
        <span className="flex-1 text-left truncate font-medium">
          {selected?.name ?? 'Select venue'}
        </span>
        <span
          className={cn(
            'w-2 h-2 rounded-full shrink-0',
            selected?.is_active ? STATUS_COLORS.active : STATUS_COLORS.inactive
          )}
        />
        <ChevronDown
          className={cn(
            'w-4 h-4 shrink-0 text-sage-400 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 bg-surface border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="py-1 max-h-60 overflow-y-auto">
            {venues.map((venue) => (
              <button
                key={venue.id}
                onClick={() => selectVenue(venue.id)}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors',
                  venue.id === selectedId
                    ? 'bg-sage-100 text-sage-800'
                    : 'text-sage-600 hover:bg-sage-50 hover:text-sage-800'
                )}
              >
                <span className="flex-1 text-left truncate">{venue.name}</span>
                <span
                  className={cn(
                    'w-2 h-2 rounded-full shrink-0',
                    venue.is_active ? STATUS_COLORS.active : STATUS_COLORS.inactive
                  )}
                />
                {venue.id === selectedId && (
                  <Check className="w-3.5 h-3.5 shrink-0 text-sage-600" />
                )}
              </button>
            ))}
          </div>

          <div className="border-t border-border py-1">
            <Link
              href="/onboarding"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-sage-500 hover:text-sage-800 hover:bg-sage-50 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Venue
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
