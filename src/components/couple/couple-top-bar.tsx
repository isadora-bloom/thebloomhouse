'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, MessageCircle, Printer, FileText, Menu,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CoupleUserMenu } from './couple-user-menu'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'

interface CoupleTopBarProps {
  /** Venue display name shown next to the logo. */
  venueName: string
  /** Optional venue logo URL. */
  logoUrl: string | null
  /** Base path (e.g. "/couple/hawthorne-manor"). */
  base: string
  /** Handler that opens the mobile sidebar drawer. */
  onMobileMenuToggle: () => void
  /** Optional client code (e.g. "HM-0042") shown unobtrusively for quick reference. */
  clientCode?: string | null
}

/**
 * Minimal top bar for the couple portal.
 *
 * Only four persistent controls: Ask Sage, Dashboard, Print, Account.
 * All other navigation lives in the left sidebar.
 */
export function CoupleTopBar({
  venueName,
  logoUrl,
  base,
  onMobileMenuToggle,
  clientCode,
}: CoupleTopBarProps) {
  const pathname = usePathname()
  const { weddingId, aiName } = useCoupleContext()
  const sageHref = `${base}/chat`
  const dashHref = base

  const isSageActive = pathname === sageHref || pathname.startsWith(sageHref + '/')
  const isDashActive = pathname === base || pathname === base + '/'

  return (
    <header
      className="fixed top-0 left-0 right-0 h-16 z-30 border-b backdrop-blur-sm bg-white/95 no-print"
      style={{
        borderColor: 'var(--couple-primary, #7D8471)',
        borderBottomWidth: '2px',
      }}
    >
      <div className="h-full flex items-center justify-between px-4 sm:px-6">
        {/* Left: mobile hamburger + logo/name */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="lg:hidden p-2 -ml-2 text-gray-600 hover:text-gray-900"
            onClick={onMobileMenuToggle}
            aria-label="Open navigation"
          >
            <Menu className="w-5 h-5" />
          </button>
          <Link href={base} className="flex items-center gap-3 min-w-0">
            {logoUrl ? (
              <img src={logoUrl} alt={venueName} className="h-8 w-auto shrink-0" />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {venueName.charAt(0)}
              </div>
            )}
            <span
              className="text-lg font-semibold hidden sm:block truncate"
              style={{
                fontFamily: 'var(--couple-font-heading)',
                color: 'var(--couple-primary)',
              }}
            >
              {venueName}
            </span>
          </Link>
          {clientCode && (
            <span
              className="hidden md:inline-flex items-center ml-2 px-1.5 py-0.5 rounded text-[11px] font-mono text-gray-400 border border-gray-200"
              title="Your client reference code"
            >
              {clientCode}
            </span>
          )}
        </div>

        {/* Right: 4 items — Ask Sage, Dashboard, Print, Account */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* 1. Ask Sage — prominent accent pill */}
          <Link
            href={sageHref}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-opacity whitespace-nowrap text-white shadow-sm hover:opacity-90',
              isSageActive && 'ring-2 ring-offset-1'
            )}
            style={{ backgroundColor: 'var(--couple-accent, #A6894A)' }}
          >
            <MessageCircle className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Ask {aiName}</span>
          </Link>

          {/* 2. Dashboard */}
          <Link
            href={dashHref}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap',
              isDashActive
                ? 'text-white'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
            )}
            style={isDashActive ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>

          {/* 3. Print Day-of Package */}
          {weddingId && (
            <Link
              href={`/portal/weddings/${weddingId}/print`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors whitespace-nowrap"
              title="Print day-of coordination package"
            >
              <FileText className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Day-of Package</span>
            </Link>
          )}

          {/* 4. Print current page */}
          <button
            type="button"
            onClick={() => window.print()}
            className="flex items-center justify-center w-9 h-9 rounded-full text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            title="Print this page"
            aria-label="Print"
          >
            <Printer className="w-4 h-4" />
          </button>

          {/* 5. Account */}
          <CoupleUserMenu />
        </div>
      </div>
    </header>
  )
}
