'use client'

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { Sidebar } from './sidebar'
import { DemoBanner } from './demo-banner'

/**
 * Client wrapper for the platform layout.
 * Hides the sidebar + shell chrome on standalone routes like /onboarding.
 */
const STANDALONE_ROUTES = ['/onboarding']

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
    return <>{children}</>
  }

  return (
    <>
      {isDemo && (
        <div className="fixed top-0 left-0 right-0 z-50">
          <DemoBanner />
        </div>
      )}
      <Sidebar isDemo={isDemo} />
      <main className={`lg:pl-64 ${isDemo ? 'pt-24 lg:pt-10' : 'pt-14 lg:pt-0'}`}>
        <div className="p-6 lg:p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </>
  )
}
