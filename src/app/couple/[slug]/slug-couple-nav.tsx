'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  MessageCircle,
  Clock,
  DollarSign,
  Users,
  CheckSquare,
  Menu,
  X,
  LogOut,
  User,
  Armchair,
  Lightbulb,
  Store,
  FileText,
  Globe,
  Printer,
} from 'lucide-react'

interface SlugCoupleNavProps {
  venueName: string
  logoUrl: string | null
  venueSlug: string
}

export function SlugCoupleNav({ venueName, logoUrl, venueSlug }: SlugCoupleNavProps) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const base = `/couple/${venueSlug}`

  const navItems = [
    { label: 'Dashboard', href: base, icon: LayoutDashboard },
    { label: 'Chat', href: `${base}/chat`, icon: MessageCircle },
    { label: 'Timeline', href: `${base}/timeline`, icon: Clock },
    { label: 'Budget', href: `${base}/budget`, icon: DollarSign },
    { label: 'Guests', href: `${base}/guests`, icon: Users },
    { label: 'Seating', href: `${base}/seating`, icon: Armchair },
    { label: 'Checklist', href: `${base}/checklist`, icon: CheckSquare },
    { label: 'Inspo', href: `${base}/inspo`, icon: Lightbulb },
    { label: 'Vendors', href: `${base}/vendors`, icon: Store },
    { label: 'Contracts', href: `${base}/contracts`, icon: FileText },
    { label: 'Website', href: `${base}/website`, icon: Globe },
  ]

  return (
    <>
      {/* Fixed top navigation */}
      <header
        className="fixed top-0 left-0 right-0 h-16 z-40 border-b backdrop-blur-sm"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          borderColor: 'var(--couple-primary, #7D8471)',
          borderBottomWidth: '2px',
        }}
      >
        <div className="max-w-6xl mx-auto h-full flex items-center justify-between px-4 sm:px-6 lg:px-8">
          {/* Left: logo/name */}
          <Link href={base} className="flex items-center gap-3 shrink-0">
            {logoUrl ? (
              <img src={logoUrl} alt={venueName} className="h-8 w-auto" />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {venueName.charAt(0)}
              </div>
            )}
            <span
              className="text-lg font-semibold hidden sm:block"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              {venueName}
            </span>
          </Link>

          {/* Center: nav links (desktop) — scrollable for many items */}
          <nav className="hidden lg:flex items-center gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const isActive =
                item.href === base
                  ? pathname === base || pathname === base + '/'
                  : pathname.startsWith(item.href)

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap',
                    isActive
                      ? 'text-white'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                  )}
                  style={isActive ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                >
                  <item.icon className="w-3.5 h-3.5" />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          {/* Right: print + avatar + mobile hamburger */}
          <div className="flex items-center gap-3">
            {/* Print button */}
            <button
              onClick={() => window.print()}
              className="hidden sm:flex items-center justify-center w-8 h-8 rounded-full text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors no-print"
              title="Print this page"
            >
              <Printer className="w-4 h-4" />
            </button>

            {/* User avatar placeholder */}
            <div className="hidden sm:flex items-center gap-2">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{ backgroundColor: 'var(--couple-accent)', color: 'white' }}
              >
                <User className="w-4 h-4" />
              </div>
              <button className="text-gray-500 hover:text-gray-700 transition-colors">
                <LogOut className="w-4 h-4" />
              </button>
            </div>

            {/* Mobile hamburger */}
            <button
              className="lg:hidden p-2 -mr-2 text-gray-600 hover:text-gray-900"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className="absolute right-0 top-16 bottom-0 w-64 bg-white shadow-xl overflow-y-auto">
            <nav className="p-4 space-y-1">
              {navItems.map((item) => {
                const isActive =
                  item.href === base
                    ? pathname === base || pathname === base + '/'
                    : pathname.startsWith(item.href)

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                      isActive
                        ? 'text-white'
                        : 'text-gray-600 hover:bg-gray-50'
                    )}
                    style={isActive ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                )
              })}
              <hr className="my-3 border-gray-200" />
              <button className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-50 w-full">
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </nav>
          </div>
        </div>
      )}
    </>
  )
}
