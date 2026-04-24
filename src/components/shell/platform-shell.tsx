'use client'

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { Sidebar } from './sidebar'
import { SidebarV2 } from './sidebar-v2'
import { ModeStrip } from './mode-strip'
import { GearMenu } from './gear-menu'
import { DemoBanner } from './demo-banner'
import { ScopeIndicator } from './scope-indicator'
import { UserMenu } from './user-menu'
import { FloatingBrainDump } from './floating-brain-dump'

/**
 * Client wrapper for the platform layout.
 * Hides the sidebar + shell chrome on standalone routes like /onboarding.
 */
const STANDALONE_ROUTES = ['/onboarding', '/setup']

function useIsDemo(): boolean {
  const [isDemo, setIsDemo] = useState(false)
  useEffect(() => {
    setIsDemo(document.cookie.split('; ').some((c) => c === 'bloom_demo=true'))
  }, [])
  return isDemo
}

/**
 * Feature flag for the mode-based nav (Phase 2B). Cookie `bloom_nav_v2=true`
 * swaps legacy Sidebar + sticky top bar for SidebarV2 + ModeStrip + GearMenu.
 * Toggle exposed in the user menu so Isadora can flip between the two
 * while we validate the reorg. Defaults OFF until Phase 2C sign-off.
 */
function useNavV2(): boolean {
  const [v2, setV2] = useState(false)
  useEffect(() => {
    setV2(document.cookie.split('; ').some((c) => c === 'bloom_nav_v2=true'))
  }, [])
  return v2
}

function useScopeLevel(): 'venue' | 'group' | 'company' {
  const [level, setLevel] = useState<'venue' | 'group' | 'company'>('venue')
  useEffect(() => {
    try {
      const raw = document.cookie.split('; ').find((c) => c.startsWith('bloom_scope='))?.split('=')[1]
      if (!raw) return
      const parsed = JSON.parse(decodeURIComponent(raw)) as { level?: string }
      if (parsed?.level === 'group' || parsed?.level === 'company') setLevel(parsed.level)
    } catch { /* ignore */ }
  }, [])
  return level
}

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isDemo = useIsDemo()
  const navV2 = useNavV2()
  const scopeLevel = useScopeLevel()
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

  if (navV2) {
    // Mode-based nav (Phase 2B). ModeStrip replaces the flat top nav;
    // SidebarV2 is mode-aware and renders only the rail for the current
    // mode. GearMenu holds the Org admin entries. Legacy URLs continue
    // to work — nothing here changes routes, only the shell chrome.
    return (
      <>
        {isDemo && <DemoBanner />}
        <SidebarV2 scopeLevel={scopeLevel} />
        <main className={`lg:pl-64 ${isDemo ? 'pt-24 lg:pt-10' : 'pt-14 lg:pt-0'}`}>
          <div
            className={`sticky z-30 bg-warm-white/90 backdrop-blur-sm border-b border-border px-6 lg:px-8 py-2 flex items-center justify-between gap-4 ${
              isDemo ? 'top-24 lg:top-10' : 'top-14 lg:top-0'
            }`}
          >
            <ModeStrip />
            <div className="flex items-center gap-2">
              <ScopeIndicator />
              <GearMenu />
            </div>
          </div>
          <div className="p-6 lg:p-8 max-w-7xl mx-auto">{children}</div>
        </main>
        <FloatingBrainDump />
      </>
    )
  }

  return (
    <>
      {isDemo && <DemoBanner />}
      <Sidebar isDemo={isDemo} />
      {/* Mobile: banner(2.5rem) + mobile-header(3.5rem) = 6rem. Desktop: banner(2.5rem) only, sidebar handles its own offset */}
      <main className={`lg:pl-64 ${isDemo ? 'pt-24 lg:pt-10' : 'pt-14 lg:pt-0'}`}>
        <div
          className={`sticky z-30 bg-warm-white/90 backdrop-blur-sm border-b border-border px-6 lg:px-8 py-3 flex items-center justify-between ${
            isDemo ? 'top-24 lg:top-10' : 'top-14 lg:top-0'
          }`}
        >
          <ScopeIndicator />
          {/* room for breadcrumbs or page title later */}
        </div>
        <div className="p-6 lg:p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
      {/* Universal "Tell Sage something" capture — every platform page. */}
      <FloatingBrainDump />
    </>
  )
}
