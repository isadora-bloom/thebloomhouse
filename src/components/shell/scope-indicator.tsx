'use client'
import { Building2, Layers, MapPin } from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'
import { useVenueScope } from '@/lib/contexts/venue-scope-context'

/**
 * Scope indicator pill in the platform top bar.
 *
 * Previously used useScope() alone, which reads the bloom_scope cookie via
 * document.cookie. That returns null on SSR (no document) so the first
 * render always showed "Viewing venue: Venue", and then hydration swapped
 * in the real name — a loud hydration mismatch warning on every platform
 * page load.
 *
 * Fix: read the venue-level name from VenueScopeProvider, which is
 * populated server-side in the platform layout from resolvePlatformScope.
 * That lets SSR and CSR agree on the venue-level case (the common one).
 * Group/company-level scope still comes from useScope since the server
 * layout doesn't know which level the user selected — those cases fall
 * back to a generic label on first paint and fill in on mount, same as
 * before.
 */
export function ScopeIndicator() {
  const clientScope = useScope()
  const serverScope = useVenueScope()

  // Group-level scope: comes from cookie only. Brief flicker on first
  // paint while useScope resolves; same behaviour as pre-fix.
  if (clientScope.level === 'group') {
    return (
      <Pill
        icon={Layers}
        label="Viewing group"
        name={clientScope.groupName ?? 'Group'}
        bg="bg-teal-50 border-teal-200 text-teal-900"
      />
    )
  }

  // Company-level: the platform layout knows orgName server-side, so we
  // prefer that — falls back to cookie companyName if the provider
  // doesn't carry it.
  if (clientScope.level === 'company') {
    return (
      <Pill
        icon={Building2}
        label="Viewing all venues"
        name={serverScope.orgName ?? clientScope.companyName ?? 'Company'}
        bg="bg-gold-50 border-gold-200 text-gold-900"
      />
    )
  }

  // Venue-level (common case). Prefer the SSR-resolved venueName so the
  // first paint and the hydrated paint agree. Fall back to cookie-scope
  // name only if the server couldn't look it up.
  return (
    <Pill
      icon={MapPin}
      label="Viewing venue"
      name={serverScope.venueName ?? clientScope.venueName ?? 'Venue'}
      bg="bg-sage-50 border-sage-200 text-sage-900"
    />
  )
}

function Pill({
  icon: Icon,
  label,
  name,
  bg,
}: {
  icon: typeof MapPin
  label: string
  name: string
  bg: string
}) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-xs ${bg}`}>
      <Icon className="w-3.5 h-3.5" />
      <span className="font-medium">{label}:</span>
      <span className="font-semibold">{name}</span>
    </div>
  )
}
