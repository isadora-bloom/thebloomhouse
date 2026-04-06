'use client'

import { usePathname } from 'next/navigation'
import { Sidebar } from './sidebar'

/**
 * Client wrapper for the platform layout.
 * Hides the sidebar + shell chrome on standalone routes like /onboarding.
 */
const STANDALONE_ROUTES = ['/onboarding']

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isStandalone = STANDALONE_ROUTES.some((route) => pathname.startsWith(route))

  if (isStandalone) {
    return <>{children}</>
  }

  return (
    <>
      <Sidebar />
      <main className="lg:pl-64 pt-14 lg:pt-0">
        <div className="p-6 lg:p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </>
  )
}
