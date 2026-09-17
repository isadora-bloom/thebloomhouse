'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CoupleTopBar } from './couple-top-bar'
import { CoupleSidebar } from './couple-sidebar'
import { MarkSectionCompleteBar } from './mark-section-complete'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { usePortalSections } from '@/lib/hooks/use-portal-sections'
import { isSlugOpen, slugFromPathname } from '@/lib/services/couple/section-visibility'

interface CoupleShellProps {
  venueName: string
  logoUrl: string | null
  /** Base path for all couple-portal links, e.g. "/couple/hawthorne-manor". */
  base: string
  /** The venue's slug, for the section settings lookup. */
  venueSlug?: string | null
  /** Optional client code (e.g. "HM-0042") shown unobtrusively in the top bar. */
  clientCode?: string | null
  /** Wedding date (ISO string) — passed to sidebar for Final Review badge. */
  weddingDate?: string | null
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
 *
 * Since 2026-09-17 the shell honours the venue's section settings: a
 * section the venue has switched off, or not yet released, is neither in
 * the sidebar nor reachable by link. And when the venue's soft close has
 * passed, a banner says so; saves are refused by the database, so this
 * is the explanation, not the enforcement.
 */
export function CoupleShell({ venueName, logoUrl, base, venueSlug, clientCode, weddingDate, children }: CoupleShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()
  const { weddingId } = useCoupleContext()
  const { open, closed } = usePortalSections(venueSlug ?? null, weddingId)
  const slug = slugFromPathname(pathname ?? '', base)
  const slugOpen = isSlugOpen(slug, open)

  return (
    <>
      <CoupleTopBar
        venueName={venueName}
        logoUrl={logoUrl}
        base={base}
        clientCode={clientCode}
        onMobileMenuToggle={() => setMobileOpen(true)}
      />

      <CoupleSidebar
        base={base}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        weddingDate={weddingDate}
        openSections={open}
      />

      {/* Main content — offset for fixed top bar (16) and desktop sidebar (64) */}
      <main className="pt-16 lg:pl-64">
        <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
          {closed ? (
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
              <p className="font-medium">Changes have closed ahead of your wedding.</p>
              <p className="mt-1 text-amber-800">
                Everything here is still yours to look at. If something needs changing, send {venueName} a message and they&apos;ll make it for you.{' '}
                <Link href={`${base}/messages`} className="underline">Message {venueName}</Link>
              </p>
            </div>
          ) : null}
          {slugOpen ? (
            children
          ) : (
            <div className="rounded-2xl border border-gray-200 bg-white px-6 py-10 text-center">
              <p className="text-lg font-medium text-gray-800" style={{ fontFamily: 'var(--couple-font-heading)' }}>
                Not part of your portal yet.
              </p>
              <p className="mt-2 text-sm text-gray-600">
                {venueName} opens sections as they become useful. There&apos;s nothing you need to do here for now.
              </p>
              <Link href={base || '/'} className="mt-5 inline-block text-sm underline text-gray-700">
                Back to your dashboard
              </Link>
            </div>
          )}
          {/* 2026-05-26 — auto-detects the current section from pathname
              and renders a "Mark complete" footer when actionable.
              Renders nothing on read-only / meta pages. */}
          {slugOpen ? <MarkSectionCompleteBar /> : null}
        </div>
      </main>
    </>
  )
}
