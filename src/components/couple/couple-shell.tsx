'use client'

import { useState } from 'react'
import { CoupleTopBar } from './couple-top-bar'
import { CoupleSidebar } from './couple-sidebar'

interface CoupleShellProps {
  venueName: string
  logoUrl: string | null
  /** Base path for all couple-portal links, e.g. "/couple/hawthorne-manor". */
  base: string
  children: React.ReactNode
}

/**
 * Layout shell for the couple portal.
 *
 * Structure:
 *   - Fixed top bar (minimal: Ask Sage, Dashboard, Print, Account)
 *   - Fixed left sidebar on desktop (collapsible groups)
 *   - Slide-in sidebar drawer on mobile (hamburger in top bar)
 *   - Main content area offset for both top bar and sidebar
 */
export function CoupleShell({ venueName, logoUrl, base, children }: CoupleShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <>
      <CoupleTopBar
        venueName={venueName}
        logoUrl={logoUrl}
        base={base}
        onMobileMenuToggle={() => setMobileOpen(true)}
      />

      <CoupleSidebar
        base={base}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Main content — offset for fixed top bar (16) and desktop sidebar (64) */}
      <main className="pt-16 lg:pl-64">
        <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">{children}</div>
      </main>
    </>
  )
}
