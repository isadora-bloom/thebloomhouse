'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { MODES, modeForPath, type NavMode } from './nav-config'

/**
 * Mode strip — horizontal top-nav that replaces the legacy Inbox/Pipeline/
 * Intel/Portal/Settings flat list. Four modes (Agent · Weddings · Intel ·
 * Sage's Brain). Active mode highlights based on the current URL via
 * modeForPath() in nav-config (longest-prefix wins, so /portal/weddings
 * resolves to Weddings even though /portal config pages belong to Sage's
 * Brain).
 *
 * Org admin isn't in this strip — it lives in the gear icon (see
 * GearMenu) and only appears for users with the matching role.
 */
export function ModeStrip() {
  const pathname = usePathname()
  const active = modeForPath(pathname)
  return (
    <nav className="flex items-center gap-1">
      {MODES.map((m) => {
        const isActive = active === m.mode
        const Icon = m.icon
        return (
          <Link
            key={m.mode}
            href={m.defaultHref}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              isActive
                ? 'bg-sage-100 text-sage-900'
                : 'text-sage-600 hover:bg-sage-50 hover:text-sage-900'
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon className="w-4 h-4" />
            <span className="hidden md:inline">{m.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export type { NavMode }
