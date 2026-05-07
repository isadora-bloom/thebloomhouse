'use client'

import { usePathname } from 'next/navigation'
import { SidebarV2 } from './sidebar-v2'
import { ModeStrip } from './mode-strip'
import { GearMenu } from './gear-menu'
import { DemoBanner } from './demo-banner'
import { ScopeIndicator } from './scope-indicator'
import { UserMenu } from './user-menu'
import { FloatingBrainDump } from './floating-brain-dump'
import { NotificationBell } from './notification-bell'
import { useVenueScope } from '@/lib/contexts/venue-scope-context'

/**
 * Client wrapper for the platform layout.
 * Hides the sidebar + shell chrome on standalone routes like /onboarding.
 *
 * The mode-based V2 nav is the only chrome now; V1 was retired (the
 * `bloom_nav_v2` feature flag and the legacy Sidebar + flat top bar
 * were removed). Standalone routes still render only a minimal top
 * bar with the user menu so users can sign out from inside a wizard.
 *
 * `isDemo` and `scopeLevel` are read from `VenueScopeProvider` (server-
 * resolved) instead of the previous empty-deps `useEffect` cookie read,
 * so a scope change via `useScopeMutator` propagates here without a
 * full reload (GAP-09).
 */
const STANDALONE_ROUTES = ['/onboarding', '/setup']

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { isDemo, level: scopeLevel, venueId } = useVenueScope()
  const isStandalone = STANDALONE_ROUTES.some((route) => pathname.startsWith(route))

  if (isStandalone) {
    // Standalone routes (/setup, /onboarding) don't get the sidebar, but a
    // user must always be able to sign out — otherwise they're trapped inside
    // the wizard. Render a minimal top bar with just the UserMenu.
    return (
      <>
        {isDemo && <DemoBanner />}
        <div
          className={`sticky z-30 bg-warm-white/90 backdrop-blur-sm border-b border-border px-6 lg:px-8 py-3 flex items-center justify-end ${
            isDemo ? 'top-10' : 'top-0'
          }`}
        >
          <UserMenu compact />
        </div>
        {children}
      </>
    )
  }

  return (
    <>
      {isDemo && <DemoBanner />}
      <SidebarV2 scopeLevel={scopeLevel} />
      <main className={`lg:pl-64 ${isDemo ? 'pt-24 lg:pt-10' : 'pt-14 lg:pt-0'}`}>
        {/* Tier-B #62 — top bar small-screen behavior. Tighter horizontal
            padding on mobile (px-3) so the right cluster doesn't overflow
            on iPhone SE width (375px). Right cluster gets `shrink-0` so
            mode-strip absorbs any squeeze first. */}
        <div
          className={`sticky z-30 bg-warm-white/90 backdrop-blur-sm border-b border-border px-3 lg:px-8 py-2 flex items-center justify-between gap-2 ${
            isDemo ? 'top-24 lg:top-10' : 'top-14 lg:top-0'
          }`}
        >
          <ModeStrip />
          <div className="flex items-center gap-1 lg:gap-2 shrink-0">
            <ScopeIndicator />
            <NotificationBell venueId={venueId} />
            <GearMenu scopeLevel={scopeLevel} />
          </div>
        </div>
        <div className="p-6 lg:p-8 max-w-7xl mx-auto">{children}</div>
      </main>
      <FloatingBrainDump />
    </>
  )
}
