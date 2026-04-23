'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  CheckSquare, Clock, DollarSign, FileText,
  Users, ClipboardCheck, Armchair, Table2, UsersRound, ShieldAlert, HeartHandshake,
  BookOpen, UtensilsCrossed, Wine, Flower2, Camera, Sparkles, Lightbulb,
  Store, Star, BedDouble, Hotel, Car, HardHat,
  Heart, Package, ShoppingBag,
  Globe, Download, CalendarPlus, ClipboardList, FileSignature,
  MessagesSquare, ChevronDown, X, CalendarRange,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Nav structure — grouped sections per couple portal spec
// ---------------------------------------------------------------------------

interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  /** Optional badge text shown next to the label */
  badge?: string
}

interface NavSection {
  title: string
  items: NavItem[]
}

export function buildCoupleSidebarSections(base: string): NavSection[] {
  return [
    {
      title: 'Plan',
      items: [
        { label: 'Availability', href: `${base}/availability`, icon: CalendarRange },
        { label: 'Checklist', href: `${base}/checklist`, icon: CheckSquare },
        { label: 'Timeline', href: `${base}/timeline`, icon: Clock },
        { label: 'Budget', href: `${base}/budget`, icon: DollarSign },
        { label: 'Worksheets', href: `${base}/worksheets`, icon: FileText },
      ],
    },
    {
      title: 'Guests',
      items: [
        { label: 'Guest List', href: `${base}/guests`, icon: Users },
        { label: 'RSVP Settings', href: `${base}/rsvp-settings`, icon: ClipboardCheck },
        { label: 'Seating', href: `${base}/seating`, icon: Armchair },
        { label: 'Table Map', href: `${base}/table-map`, icon: Table2 },
        { label: 'Tables', href: `${base}/tables`, icon: Table2 },
        { label: 'Wedding Party', href: `${base}/party`, icon: UsersRound },
        { label: 'Allergies', href: `${base}/allergies`, icon: ShieldAlert },
        { label: 'Guest Care', href: `${base}/guest-care`, icon: HeartHandshake },
      ],
    },
    {
      title: 'Day-of',
      items: [
        { label: 'Ceremony', href: `${base}/ceremony`, icon: BookOpen },
        { label: 'Ceremony Chairs', href: `${base}/ceremony-chairs`, icon: Armchair },
        { label: 'Rehearsal', href: `${base}/rehearsal`, icon: UtensilsCrossed },
        { label: 'Bar', href: `${base}/bar`, icon: Wine },
        { label: 'Decor', href: `${base}/decor`, icon: Flower2 },
        { label: 'Photos', href: `${base}/photos`, icon: Camera },
        { label: 'Beauty', href: `${base}/beauty`, icon: Sparkles },
        { label: 'Inspo', href: `${base}/inspo`, icon: Lightbulb },
      ],
    },
    {
      title: 'Logistics',
      items: [
        { label: 'Vendors', href: `${base}/vendors`, icon: Store },
        { label: 'Preferred Vendors', href: `${base}/preferred-vendors`, icon: Star },
        { label: 'Rooms', href: `${base}/rooms`, icon: BedDouble },
        { label: 'Stays', href: `${base}/stays`, icon: Hotel },
        { label: 'Transportation', href: `${base}/transportation`, icon: Car },
        { label: 'Staffing', href: `${base}/staffing`, icon: HardHat },
      ],
    },
    {
      title: 'Wedding Details',
      items: [
        { label: 'Wedding Details', href: `${base}/wedding-details`, icon: Heart },
        { label: 'Venue Inventory', href: `${base}/venue-inventory`, icon: Package },
        { label: 'Picks', href: `${base}/picks`, icon: ShoppingBag },
      ],
    },
    {
      title: 'Outputs',
      items: [
        { label: 'Website', href: `${base}/website`, icon: Globe },
        { label: 'Downloads', href: `${base}/downloads`, icon: Download },
        { label: 'Resources', href: `${base}/resources`, icon: BookOpen },
        { label: 'Booking', href: `${base}/booking`, icon: CalendarPlus },
        { label: 'Final Review', href: `${base}/final-review`, icon: ClipboardList },
        { label: 'Contracts', href: `${base}/contracts`, icon: FileSignature },
      ],
    },
    {
      title: 'Communication',
      items: [
        { label: 'Messages', href: `${base}/messages`, icon: MessagesSquare },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

interface CoupleSidebarProps {
  /** Base path (e.g. "/couple/hawthorne-manor") used to build nav links. */
  base: string
  /** Controlled mobile drawer open state. */
  mobileOpen: boolean
  /** Callback to close the mobile drawer (used on link click / overlay click). */
  onMobileClose: () => void
  /** Wedding date string (ISO) — used to show a badge on Final Review when within 6 weeks. */
  weddingDate?: string | null
}

export function CoupleSidebar({ base, mobileOpen, onMobileClose, weddingDate }: CoupleSidebarProps) {
  const pathname = usePathname()
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const sections = buildCoupleSidebarSections(base)

  // Compute Final Review badge: show when wedding is within 6 weeks (42 days)
  const finalReviewBadge = (() => {
    if (!weddingDate) return undefined
    const daysUntil = Math.ceil(
      (new Date(weddingDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    )
    if (daysUntil <= 42 && daysUntil > 0) return `${daysUntil}d`
    return undefined
  })()

  // Inject badge into Final Review nav item
  if (finalReviewBadge) {
    for (const section of sections) {
      for (const item of section.items) {
        if (item.href.endsWith('/final-review')) {
          item.badge = finalReviewBadge
        }
      }
    }
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/')
  }

  function toggleSection(title: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  const nav = (
    <nav className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto py-4 px-3 space-y-4">
        {sections.map((section) => {
          const isCollapsed = collapsedSections.has(section.title)
          const hasActiveItem = section.items.some((item) => isActive(item.href))

          return (
            <div key={section.title}>
              <button
                type="button"
                onClick={() => toggleSection(section.title)}
                className="flex items-center w-full px-3 mb-1 cursor-pointer hover:opacity-80"
              >
                <p
                  className={cn(
                    'flex-1 text-left text-[11px] font-semibold uppercase tracking-wider',
                    hasActiveItem ? 'opacity-100' : 'opacity-70'
                  )}
                  style={{ color: 'var(--couple-primary, #7D8471)' }}
                >
                  {section.title}
                </p>
                <ChevronDown
                  className={cn(
                    'w-3 h-3 transition-transform opacity-60',
                    isCollapsed && '-rotate-90'
                  )}
                  style={{ color: 'var(--couple-primary, #7D8471)' }}
                />
              </button>
              {!isCollapsed && (
                <ul className="space-y-0.5">
                  {section.items.map((item) => {
                    const active = isActive(item.href)
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={onMobileClose}
                          className={cn(
                            'flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-colors',
                            active
                              ? 'text-white font-medium'
                              : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                          )}
                          style={active ? { backgroundColor: 'var(--couple-primary, #7D8471)' } : undefined}
                        >
                          <item.icon className="w-4 h-4 shrink-0" />
                          <span className="flex-1">{item.label}</span>
                          {item.badge && (
                            <span
                              className={cn(
                                'ml-auto px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none',
                                active
                                  ? 'bg-white/20 text-white'
                                  : 'bg-amber-100 text-amber-700'
                              )}
                            >
                              {item.badge}
                            </span>
                          )}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )

  return (
    <>
      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 no-print">
          <div className="absolute inset-0 bg-black/30" onClick={onMobileClose} />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-white shadow-xl overflow-y-auto">
            <div className="h-16 flex items-center justify-end px-4 border-b border-gray-200">
              <button
                onClick={onMobileClose}
                className="p-2 -mr-2 text-gray-600 hover:text-gray-900"
                aria-label="Close menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {nav}
          </div>
        </div>
      )}

      {/* Desktop sidebar — fixed left, below top bar */}
      <aside
        className="hidden lg:block fixed left-0 top-16 bottom-0 w-64 bg-white border-r z-20 no-print"
        style={{ borderColor: 'rgba(125, 132, 113, 0.15)' }}
      >
        {nav}
      </aside>
    </>
  )
}
