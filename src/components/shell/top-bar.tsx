'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Menu } from 'lucide-react'
import { UserMenu } from './user-menu'

interface TopBarProps {
  onToggleSidebar: () => void
}

export function TopBar({ onToggleSidebar }: TopBarProps) {
  const [venueName, setVenueName] = useState<string>('')

  useEffect(() => {
    async function loadVenueName() {
      const venueId = document.cookie
        .split('; ')
        .find((c) => c.startsWith('bloom_venue='))
        ?.split('=')[1]

      if (!venueId) return

      const supabase = createClient()
      const { data } = await supabase
        .from('venues')
        .select('name')
        .eq('id', venueId)
        .single()

      if (data) {
        setVenueName(data.name as string)
      }
    }

    loadVenueName()
  }, [])

  return (
    <div className="lg:hidden fixed top-0 left-0 right-0 h-14 bg-surface border-b border-border z-40 flex items-center px-4">
      {/* Hamburger menu */}
      <button
        onClick={onToggleSidebar}
        className="p-2 -ml-2 rounded-lg hover:bg-sage-50 transition-colors"
        aria-label="Toggle sidebar"
      >
        <Menu className="w-5 h-5 text-sage-600" />
      </button>

      {/* Venue name in center */}
      <div className="flex-1 text-center">
        <span className="font-heading text-sm font-semibold text-sage-800 truncate">
          {venueName || 'The Bloom House'}
        </span>
      </div>

      {/* User avatar on right */}
      <UserMenu compact />
    </div>
  )
}
