'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useAiName } from '@/lib/hooks/use-ai-name'
import { MODES, modeForPath, type NavMode } from './nav-config'

/**
 * Mode strip — horizontal top-nav that replaces the legacy Inbox/Pipeline/
 * Intel/Portal/Settings flat list. Four modes (Agent · Weddings · Intel ·
 * the venue's AI brain). Active mode highlights based on the current URL
 * via modeForPath() in nav-config (longest-prefix wins, so /portal/weddings
 * resolves to Weddings even though /portal config pages belong to the
 * brain mode).
 *
 * Mode labels run through `useAiName()` so a venue with ai_name='Ivy' sees
 * "Ivy's Brain" rather than the literal "Sage's Brain" baked into
 * nav-config (T5-β.2).
 */
export function ModeStrip() {
  const pathname = usePathname()
  const aiName = useAiName()
  const active = modeForPath(pathname)
  return (
    <nav className="flex items-center gap-1">
      {MODES.map((m) => {
        const isActive = active === m.mode
        const Icon = m.icon
        const label = m.label.replace(/\bSage\b/g, aiName)
        return (
          <Link
            key={m.mode}
            href={m.defaultHref}
            className={cn(
              // Tier-B #60 — mobile tap targets meet Apple HIG 44px min.
              // Desktop keeps the tighter density via md: overrides.
              'inline-flex items-center justify-center gap-1.5 px-3 min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:py-1.5 rounded-md text-sm font-medium transition-colors',
              isActive
                ? 'bg-sage-100 text-sage-900'
                : 'text-sage-600 hover:bg-sage-50 hover:text-sage-900'
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon className="w-4 h-4" />
            <span className="hidden md:inline">{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export type { NavMode }
