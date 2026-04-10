'use client'

import { MapPin } from 'lucide-react'

interface VenueChipProps {
  venueName: string | null | undefined
  size?: 'xs' | 'sm'
}

/**
 * Small venue badge for use on list items / cards at company/group scope.
 * Renders nothing if venueName is null/empty.
 *
 * Usage: pages should query the venue name via a join (e.g.
 * `venues:venue_id(name)`) and pass it in. Pages should conditionally
 * render this only at company/group scope:
 *
 *   {scope.level !== 'venue' && <VenueChip venueName={row.venue?.name} />}
 */
export function VenueChip({ venueName, size = 'xs' }: VenueChipProps) {
  if (!venueName) return null

  const sizeClasses = size === 'xs'
    ? 'text-[10px] px-1.5 py-0.5'
    : 'text-xs px-2 py-0.5'

  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-sage-50 text-sage-700 border border-sage-200 font-medium whitespace-nowrap ${sizeClasses}`}>
      <MapPin className="w-2.5 h-2.5" />
      {venueName}
    </span>
  )
}
