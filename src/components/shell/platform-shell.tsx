'use client'

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { Sidebar } from './sidebar'
import { DemoBanner } from './demo-banner'
import { ScopeIndicator } from './scope-indicator'
import { UserMenu } from './user-menu'

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

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isDemo = useIsDemo()
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
    </>
  )
}
