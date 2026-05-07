'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  CheckSquare, Clock, DollarSign, FileText,
  Users, ClipboardCheck, Armchair, Table2, UsersRound, ShieldAlert, HeartHandshake,
  BookOpen, UtensilsCrossed, Wine, Flower2, Camera, Sparkles, Lightbulb,
  Store, Star, BedDouble, Hotel, Car, HardHat, MapPin,
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

export function buildCoupleSidebarSections(
  base: string,
  opts: { showDayOf?: boolean } = {},
): NavSection[] {
  const { showDayOf = false } = opts
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
        { label: 'Floor Plan', href: `${base}/table-map`, icon: Table2 },
        { label: 'Table Sizes', href: `${base}/tables`, icon: Table2 },
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
        { label: 'Venue Info', href: `${base}/venue-info`, icon: MapPin },
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
        { label: 'Saved Items', href: `${base}/picks`, icon: ShoppingBag },
      ],
    },
    {
      title: 'Documents & Booking',
      items: [
        { label: 'Contracts', href: `${base}/contracts`, icon: FileSignature },
        { label: 'Booking', href: `${base}/booking`, icon: CalendarPlus },
        { label: 'Final Review', href: `${base}/final-review`, icon: ClipboardList },
        { label: 'Wedding Website', href: `${base}/website`, icon: Globe },
        { label: 'Downloads', href: `${base}/downloads`, icon: Download },
        { label: 'Resources', href: `${base}/resources`, icon: BookOpen },
      ],
    },
    {
      title: 'Communication',
      items: [
        { label: 'Messages', href: `${base}/messages`, icon: MessagesSquare },
      ],
    },
    // Tier-B #59A — surface the day-of view ONLY in the final week.
    // Outside that window the page itself renders a placeholder so a
    // direct URL still resolves; this gate keeps the sidebar focused.
    ...(showDayOf
      ? [{
          title: 'This week',
          items: [
            { label: 'Day-of', href: `${base}/day-of`, icon: CalendarRange },
          ],
        }]
      : []),
    {
      title: 'After Your Wedding',
      items: [
        { label: 'Day-of Memories', href: `${base}/day-of-memories`, icon: Camera },
      ],
    },
  ]
}

/**
 * Sections that should be collapsed by default for new couples.
 * Sarah's first-impression audit (#38): 37 links across 8 sections
 * with all opened was overwhelming. Most-used-early sections stay
 * open; far-future sections collapse until expanded.
 */
const DEFAULT_COLLAPSED = new Set([
  'Day-of',
  'Wedding Details',
  'After Your Wedding',
])

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
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(DEFAULT_COLLAPSED),
  )
  // Days-until-wedding shared by Final Review badge + post-wedding
  // section gating. Sarah-portal Tier-B #62: pre-fix the "After Your
  // Wedding" section was visible for every couple, including those
  // 14 months out. Now hide it until the wedding has passed.
  //
  // Round 8: pin the calc to local-midnight on both sides. Date-only
  // ISO strings ("2026-05-15") parse as UTC midnight; subtracting
  // Date.now() and ceiling drifts by ±1 around midnight depending on
  // the couple's timezone offset. Pinning to local-startOfDay makes
  // "the day of" stable across the whole calendar day.
  const daysUntilWedding = (() => {
    if (!weddingDate) return null
    const datePart = weddingDate.slice(0, 10) // YYYY-MM-DD
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart)
    if (!m) return null
    const wedding = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const ms = wedding.getTime() - today.getTime()
    return Math.round(ms / (1000 * 60 * 60 * 24))
  })()

  // Tier-B #59A — surface Day-of in the final week. Outside that window
  // the URL still resolves but the page renders a placeholder so
  // direct-link clicks aren't a dead end.
  const showDayOf = daysUntilWedding !== null && daysUntilWedding >= -1 && daysUntilWedding <= 7

  const sections = buildCoupleSidebarSections(base, { showDayOf })

  // Final Review badge: show when wedding is within 6 weeks (42 days)
  const finalReviewBadge =
    daysUntilWedding !== null && daysUntilWedding <= 42 && daysUntilWedding > 0
      ? `${daysUntilWedding}d`
      : undefined

  // Filter out post-wedding sections until they're useful. The "After
  // Your Wedding" section becomes visible once the wedding has passed
  // (daysUntilWedding <= 0). Pre-wedding it's just one Day-of Memories
  // link sitting in the sidebar with nothing to do.
  const visibleSections =
    daysUntilWedding !== null && daysUntilWedding > 0
      ? sections.filter((s) => s.title !== 'After Your Wedding')
      : sections

  // Inject badge into Final Review nav item
  if (finalReviewBadge) {
    for (const section of visibleSections) {
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
        {visibleSections.map((section) => {
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
