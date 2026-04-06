'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, MessageCircle, Clock, DollarSign, Users,
  CheckSquare, Menu, X, LogOut, User, Armchair, Lightbulb,
  Store, FileText, Globe, Printer, Heart, Sparkles, Car,
  BedDouble, UtensilsCrossed, Flower2, HardHat, Wine,
  ShieldAlert, HeartHandshake, Camera, Package, Hotel,
  ClipboardCheck, MessagesSquare, ImagePlus, Download,
  CalendarPlus, Rocket, BookOpen, UsersRound, ChevronDown,
  ShoppingBag, Star, Table2,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// All couple portal sections — matches Rixey portal structure
// ---------------------------------------------------------------------------

interface NavSection {
  group: string
  items: { key: string; label: string; href: string; icon: React.ComponentType<{ className?: string }> }[]
}

function buildNavSections(base: string): NavSection[] {
  return [
    {
      group: '',
      items: [
        { key: 'chat',             label: 'Chat with Sage',     href: `${base}/chat`,               icon: MessageCircle },
      ],
    },
    {
      group: 'Main',
      items: [
        { key: 'dashboard',        label: 'Dashboard',          href: base,                         icon: LayoutDashboard },
        { key: 'getting-started',   label: 'Get Started',        href: `${base}/getting-started`,    icon: Rocket },
        { key: 'worksheets',       label: 'Worksheets',         href: `${base}/worksheets`,         icon: FileText },
      ],
    },
    {
      group: 'Plan',
      items: [
        { key: 'wedding-details',  label: 'Wedding Details',    href: `${base}/wedding-details`,    icon: Heart },
        { key: 'checklist',        label: 'Checklist',          href: `${base}/checklist`,          icon: CheckSquare },
        { key: 'budget',           label: 'Budget',             href: `${base}/budget`,             icon: DollarSign },
        { key: 'guests',           label: 'Guest List',         href: `${base}/guests`,             icon: Users },
        { key: 'vendors',          label: 'Vendors',            href: `${base}/vendors`,            icon: Store },
        { key: 'preferred-vendors',label: 'Preferred Vendors',  href: `${base}/preferred-vendors`,  icon: Star },
        { key: 'timeline',         label: 'Timeline',           href: `${base}/timeline`,           icon: Clock },
        { key: 'contracts',        label: 'Contracts',          href: `${base}/contracts`,          icon: FileText },
      ],
    },
    {
      group: 'Day Of',
      items: [
        { key: 'tables',           label: 'Tables',             href: `${base}/tables`,             icon: Table2 },
        { key: 'ceremony',         label: 'Ceremony Order',     href: `${base}/ceremony`,           icon: BookOpen },
        { key: 'seating',          label: 'Seating Chart',      href: `${base}/seating`,            icon: Armchair },
        { key: 'staffing',         label: 'Staffing Guide',     href: `${base}/staffing`,           icon: HardHat },
        { key: 'bar',              label: 'Bar Planner',        href: `${base}/bar`,                icon: Wine },
        { key: 'beauty',           label: 'Hair & Makeup',      href: `${base}/beauty`,             icon: Sparkles },
        { key: 'transportation',   label: 'Shuttle Schedule',   href: `${base}/transportation`,     icon: Car },
        { key: 'rehearsal',        label: 'Rehearsal Dinner',   href: `${base}/rehearsal`,           icon: UtensilsCrossed },
        { key: 'rooms',            label: 'Bedroom Assignments',href: `${base}/rooms`,              icon: BedDouble },
        { key: 'decor',            label: 'Decor Inventory',    href: `${base}/decor`,              icon: Flower2 },
      ],
    },
    {
      group: 'Your Guests',
      items: [
        { key: 'allergies',        label: 'Allergy Registry',   href: `${base}/allergies`,          icon: ShieldAlert },
        { key: 'guest-care',       label: 'Guest Care Notes',   href: `${base}/guest-care`,         icon: HeartHandshake },
      ],
    },
    {
      group: 'Your Website',
      items: [
        { key: 'website',          label: 'Build Your Website', href: `${base}/website`,            icon: Globe },
        { key: 'rsvp-settings',    label: 'RSVP Settings',      href: `${base}/rsvp-settings`,      icon: ClipboardCheck },
        { key: 'photos',           label: 'Photo Library',      href: `${base}/photos`,             icon: Camera },
        { key: 'party',            label: 'Wedding Party',      href: `${base}/party`,              icon: UsersRound },
        { key: 'couple-photo',     label: 'Couple Photo',       href: `${base}/couple-photo`,       icon: ImagePlus },
      ],
    },
    {
      group: 'Venue',
      items: [
        { key: 'inspo',            label: 'Inspiration',        href: `${base}/inspo`,              icon: Lightbulb },
        { key: 'venue-inventory',  label: 'Borrow Brochure',    href: `${base}/venue-inventory`,    icon: Package },
        { key: 'picks',            label: 'Venue Picks',        href: `${base}/picks`,              icon: ShoppingBag },
        { key: 'downloads',        label: 'Downloads',          href: `${base}/downloads`,          icon: Download },
      ],
    },
    {
      group: 'Connect',
      items: [
        { key: 'messages',         label: 'Inbox',              href: `${base}/messages`,           icon: MessagesSquare },
        { key: 'booking',          label: 'Book a Meeting',     href: `${base}/booking`,            icon: CalendarPlus },
        { key: 'resources',        label: 'Resources',          href: `${base}/resources`,          icon: BookOpen },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SlugCoupleNavProps {
  venueName: string
  logoUrl: string | null
  venueSlug: string
}

export function SlugCoupleNav({ venueName, logoUrl, venueSlug }: SlugCoupleNavProps) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const base = `/couple/${venueSlug}`
  const sections = buildNavSections(base)

  // Sage is always first and visually distinct
  const sageItem = { label: 'Ask Sage', href: `${base}/chat`, icon: MessageCircle }

  // Flat list for the top bar (most important items after Sage)
  const topBarItems = [
    { label: 'Dashboard', href: base, icon: LayoutDashboard },
    { label: 'Timeline', href: `${base}/timeline`, icon: Clock },
    { label: 'Budget', href: `${base}/budget`, icon: DollarSign },
    { label: 'Guests', href: `${base}/guests`, icon: Users },
    { label: 'Checklist', href: `${base}/checklist`, icon: CheckSquare },
    { label: 'Vendors', href: `${base}/vendors`, icon: Store },
    { label: 'Seating', href: `${base}/seating`, icon: Armchair },
  ]

  function isActive(href: string) {
    return href === base
      ? pathname === base || pathname === base + '/'
      : pathname.startsWith(href)
  }

  return (
    <>
      {/* Fixed top navigation */}
      <header
        className="fixed top-0 left-0 right-0 h-16 z-40 border-b backdrop-blur-sm no-print"
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

          {/* Center: quick nav (desktop) */}
          <div className="hidden lg:flex items-center gap-1.5">
            {/* Sage button — always prominent */}
            <Link
              href={sageItem.href}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap',
                isActive(sageItem.href)
                  ? 'text-white shadow-sm'
                  : 'text-white hover:opacity-90 shadow-sm'
              )}
              style={{ backgroundColor: 'var(--couple-accent, #A6894A)' }}
            >
              <sageItem.icon className="w-3.5 h-3.5" />
              {sageItem.label}
            </Link>
            <div className="w-px h-5 bg-gray-200 mx-0.5" />
            <nav className="flex items-center gap-1">
              {topBarItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap',
                    isActive(item.href)
                      ? 'text-white'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                  )}
                  style={isActive(item.href) ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                >
                  <item.icon className="w-3.5 h-3.5" />
                  {item.label}
                </Link>
              ))}
            </nav>
            {/* "All Sections" dropdown — outside nav to avoid overflow clipping */}
            <div className="relative">
              <button
                onClick={() => setExpandedGroup(expandedGroup === 'more' ? null : 'more')}
                className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
              >
                All Sections
                <ChevronDown className={cn('w-3 h-3 transition-transform', expandedGroup === 'more' && 'rotate-180')} />
              </button>
              {expandedGroup === 'more' && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setExpandedGroup(null)} />
                  <div className="absolute right-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden max-h-[70vh] overflow-y-auto">
                    {sections.map((section) => (
                      <div key={section.group}>
                        <p className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                          {section.group}
                        </p>
                        {section.items.map((item) => (
                          <Link
                            key={item.href}
                            href={item.href}
                            onClick={() => setExpandedGroup(null)}
                            className={cn(
                              'flex items-center gap-3 px-4 py-2 text-sm transition-colors',
                              isActive(item.href)
                                ? 'font-medium'
                                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                            )}
                            style={isActive(item.href) ? { color: 'var(--couple-primary)' } : undefined}
                          >
                            <item.icon className="w-4 h-4 shrink-0" />
                            {item.label}
                          </Link>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Right: print + avatar + mobile hamburger */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.print()}
              className="hidden sm:flex items-center justify-center w-8 h-8 rounded-full text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors no-print"
              title="Print this page"
            >
              <Printer className="w-4 h-4" />
            </button>
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
            <button
              className="lg:hidden p-2 -mr-2 text-gray-600 hover:text-gray-900"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer — full section list grouped */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className="absolute right-0 top-16 bottom-0 w-72 bg-white shadow-xl overflow-y-auto">
            <nav className="p-3 space-y-4">
              {sections.map((section) => (
                <div key={section.group}>
                  <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                    {section.group}
                  </p>
                  {section.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                        isActive(item.href) ? 'text-white' : 'text-gray-600 hover:bg-gray-50'
                      )}
                      style={isActive(item.href) ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                    >
                      <item.icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                  ))}
                </div>
              ))}
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
