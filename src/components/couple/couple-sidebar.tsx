'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { cn } from '@/lib/utils'
import {
  CheckSquare, Clock, DollarSign, FileText,
  Users, ClipboardCheck, Armchair, Table2, UsersRound, ShieldAlert, HeartHandshake,
  BookOpen, UtensilsCrossed, Wine, Flower2, Camera, Sparkles, Lightbulb,
  Store, Star, BedDouble, Hotel, Car, HardHat, MapPin,
  Heart, Package, ShoppingBag,
  Globe, Download, FileDown, CalendarPlus, ClipboardList, FileSignature,
  MessagesSquare, ChevronDown, X, CalendarRange, ShieldCheck,
} from 'lucide-react'
import {
  loadSectionStatuses,
  loadCoordinatorPriorities,
  getRecommendedSectionSlugs,
  type SectionStatus,
  type CoordinatorPriority,
} from '@/lib/services/couple/section-status'
import { SECTION_STATUS_CHANGED_EVENT } from './mark-section-complete'

// ---------------------------------------------------------------------------
// Nav structure - grouped sections per couple portal spec
// ---------------------------------------------------------------------------

interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  /** Optional badge text shown next to the label */
  badge?: string
  /** Optional title-attr tooltip shown on hover. Used by Final Review
   *  countdown (A1) to convey urgency without the inline "42d" badge
   *  the audit found confusing. */
  tooltip?: string
}

interface NavSection {
  title: string
  items: NavItem[]
}

export function buildCoupleSidebarSections(
  base: string,
  opts: { showDayOf?: boolean; showAfterWedding?: boolean } = {},
): NavSection[] {
  const { showDayOf = false, showAfterWedding = false } = opts
  // 2026-05-26 reorg. 5 named buckets + Account, replacing the old
  // 8-group structure. Rationale: couples kept hunting between
  // "Plan / Day-of / Logistics" for items that should live together.
  // Day-of items split between General (timeline / ceremony /
  // rehearsal — overall flow) and Vendors (bar / beauty / decor /
  // photos / transport / staffing — vendor-driven). Seating moves to
  // Guests where the data-source actually lives.
  return [
    {
      title: 'General',
      items: [
        // Tier-D #197: bookmark-able "what's next" landing.
        { label: "What's next", href: `${base}/whats-next`, icon: Lightbulb },
        { label: 'Checklist', href: `${base}/checklist`, icon: CheckSquare },
        { label: 'Wedding Details', href: `${base}/wedding-details`, icon: Heart },
        // B2 starting cut (2026-05-08): couple + family addresses.
        { label: 'Addresses', href: `${base}/addresses`, icon: MapPin },
        { label: 'Budget', href: `${base}/budget`, icon: DollarSign },
        { label: 'Booking', href: `${base}/booking`, icon: CalendarPlus },
        { label: 'Availability', href: `${base}/availability`, icon: CalendarRange },
        { label: 'Venue Info', href: `${base}/venue-info`, icon: MapPin },
        { label: 'Timeline', href: `${base}/timeline`, icon: Clock },
        { label: 'Ceremony', href: `${base}/ceremony`, icon: BookOpen },
        { label: 'Ceremony Chairs', href: `${base}/ceremony-chairs`, icon: Armchair },
        { label: 'Rehearsal', href: `${base}/rehearsal`, icon: UtensilsCrossed },
        { label: 'Final Review', href: `${base}/final-review`, icon: ClipboardList },
      ],
    },
    {
      title: 'Vendors',
      items: [
        { label: 'Vendors', href: `${base}/vendors`, icon: Store },
        { label: 'Preferred Vendors', href: `${base}/preferred-vendors`, icon: Star },
        { label: 'Contracts', href: `${base}/contracts`, icon: FileSignature },
        { label: 'Bar', href: `${base}/bar`, icon: Wine },
        { label: 'Beauty', href: `${base}/beauty`, icon: Sparkles },
        { label: 'Decor', href: `${base}/decor`, icon: Flower2 },
        { label: 'Photos', href: `${base}/photos`, icon: Camera },
        { label: 'Transportation', href: `${base}/transportation`, icon: Car },
        { label: 'Staffing', href: `${base}/staffing`, icon: HardHat },
      ],
    },
    {
      title: 'Guests',
      items: [
        { label: 'Guest List', href: `${base}/guests`, icon: Users },
        { label: 'RSVP Settings', href: `${base}/rsvp-settings`, icon: ClipboardCheck },
        { label: 'Wedding Party', href: `${base}/party`, icon: UsersRound },
        { label: 'Allergies', href: `${base}/allergies`, icon: ShieldAlert },
        { label: 'Guest Care', href: `${base}/guest-care`, icon: HeartHandshake },
        { label: 'Rooms', href: `${base}/rooms`, icon: BedDouble },
        { label: 'Stays', href: `${base}/stays`, icon: Hotel },
        { label: 'Seating', href: `${base}/seating`, icon: Armchair },
        { label: 'Floor Plan', href: `${base}/table-map`, icon: Table2 },
        { label: 'Table Sizes', href: `${base}/tables`, icon: Table2 },
      ],
    },
    {
      // 2026-05-26-late — Venue Inclusions ("what you can borrow from
      // the venue") and Recommended Buys (curated shopping list) are
      // the most-searched-for items in this group. Pinned to the top
      // so clients don't hunt. Group stays open by default — see
      // DEFAULT_COLLAPSED below.
      title: 'Inclusions & Resources',
      items: [
        { label: 'Venue Inclusions', href: `${base}/venue-inventory`, icon: Package },
        { label: 'Recommended Buys', href: `${base}/picks`, icon: ShoppingBag },
        { label: 'Inspiration', href: `${base}/inspo`, icon: Lightbulb },
        { label: 'Worksheets', href: `${base}/worksheets`, icon: FileText },
        // Resources page (rebuilt 2026-05-08) reads brand_assets where
        // couple_facing = true. Watercolors, floor plans, favor templates.
        { label: 'Resources', href: `${base}/resources`, icon: FileDown },
        { label: 'Downloads', href: `${base}/downloads`, icon: Download },
        { label: 'Wedding Website', href: `${base}/website`, icon: Globe },
      ],
    },
    {
      title: 'Communication',
      items: [
        { label: 'Messages', href: `${base}/messages`, icon: MessagesSquare },
      ],
    },
    // Tier-B #59A — Day-of view only surfaces in the final week.
    ...(showDayOf
      ? [{
          title: 'This week',
          items: [
            { label: 'Day-of', href: `${base}/day-of`, icon: CalendarRange },
          ],
        }]
      : []),
    // Tier-D #190 — "After Your Wedding" gated to post-wedding.
    ...(showAfterWedding
      ? [{
          title: 'After Your Wedding',
          items: [
            { label: 'Day-of Memories', href: `${base}/day-of-memories`, icon: Camera },
          ],
        }]
      : []),
    {
      title: 'Account',
      items: [
        { label: 'Privacy & data', href: `${base}/privacy`, icon: ShieldCheck },
      ],
    },
  ]
}

/**
 * Sections collapsed by default. Only "After Your Wedding" since it's
 * post-event noise during planning. 2026-05-26-late: previously also
 * collapsed "Inspo & Resources" but a real client couldn't find Venue
 * Inclusions (the "borrow" stuff). Opening the group + putting
 * Inclusions/Buys at the top fixes the discoverability.
 */
const DEFAULT_COLLAPSED = new Set([
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
  /** Wedding date string (ISO) - used to show a badge on Final Review when within 6 weeks. */
  weddingDate?: string | null
}

export function CoupleSidebar({ base, mobileOpen, onMobileClose, weddingDate }: CoupleSidebarProps) {
  const pathname = usePathname()
  // 2026-05-26 — pulls the authoritative weddingId from CoupleContext
  // rather than from the layout, which only has a demo-mode proxy.
  const { weddingId } = useCoupleContext()
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(DEFAULT_COLLAPSED),
  )

  // 2026-05-26 — per-section status dots. Loads on mount + on
  // wedding-id change + when MarkSectionCompleteBar dispatches the
  // status-changed event. Stale across in-tab data writes but
  // refreshed via the event bus.
  const [statuses, setStatuses] = useState<Record<string, SectionStatus>>({})
  useEffect(() => {
    if (!weddingId) return
    let cancelled = false
    const supabase = createClient()

    const fetch = () => {
      loadSectionStatuses(supabase, weddingId)
        .then((s) => { if (!cancelled) setStatuses(s) })
        .catch((err) => console.warn('[CoupleSidebar] status load failed:', err))
    }
    fetch()

    const onChange = () => fetch()
    window.addEventListener(SECTION_STATUS_CHANGED_EVENT, onChange)
    return () => {
      cancelled = true
      window.removeEventListener(SECTION_STATUS_CHANGED_EVENT, onChange)
    }
  }, [weddingId])

  // Coordinator priorities — separate effect because it's a single
  // query (cheap) and we want it refreshed on every page nav so the
  // couple sees coordinator updates within-session without reloading.
  // Status fetch (25 HEAD queries) stays gated to mount/event only.
  const [coordinatorPriorities, setCoordinatorPriorities] = useState<CoordinatorPriority[]>([])
  useEffect(() => {
    if (!weddingId) return
    let cancelled = false
    const supabase = createClient()
    loadCoordinatorPriorities(supabase, weddingId)
      .then((p) => { if (!cancelled) setCoordinatorPriorities(p) })
      .catch((err) => console.warn('[CoupleSidebar] priorities load failed:', err))
    return () => { cancelled = true }
  }, [weddingId, pathname])
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

  // Tier-B #59A - surface Day-of in the final week. Outside that window
  // the URL still resolves but the page renders a placeholder so
  // direct-link clicks aren't a dead end.
  const showDayOf = daysUntilWedding !== null && daysUntilWedding >= -1 && daysUntilWedding <= 7
  // Tier-D #190 - "After Your Wedding" section visible from wedding day
  // onward. -1 catches the day-of edge case (couple uploading evening of).
  const showAfterWedding = daysUntilWedding !== null && daysUntilWedding <= 0

  const sections = buildCoupleSidebarSections(base, { showDayOf, showAfterWedding })

  // 2026-05-08: Final Review countdown moved from inline badge to
  // hover-tooltip per A1. Inline `42d` text was confusing (auditor:
  // "what does 42d mean?"). Tooltip surfaces "Final Review - X days
  // to go" on hover only.
  const finalReviewTooltip =
    daysUntilWedding !== null && daysUntilWedding <= 42 && daysUntilWedding > 0
      ? `${daysUntilWedding} day${daysUntilWedding === 1 ? '' : 's'} to your wedding`
      : undefined

  // Round 12 #a (2026-05-08): the redundant visibleSections post-filter
  // that previously stripped 'After Your Wedding' is gone. The
  // showAfterWedding gate inside buildCoupleSidebarSections already
  // enforces the same condition; the post-filter was dead code.
  const visibleSections = sections

  // Inject tooltip into Final Review nav item (A1: tooltip-on-hover
  // replaces the inline badge text).
  if (finalReviewTooltip) {
    for (const section of visibleSections) {
      for (const item of section.items) {
        if (item.href.endsWith('/final-review')) {
          item.tooltip = finalReviewTooltip
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

  // 2026-05-26 — "Now" recommendations. Two sources, coordinator wins:
  //   1. wedding_priorities (coordinator-flagged) → filled star + note
  //   2. time-aware default → outlined star
  // When priorities exist, the time-aware band is replaced; when no
  // priorities exist, the time-aware band drives the stars.
  const coordinatorPrioritySlugs = new Set(coordinatorPriorities.map((p) => p.section_slug))
  const coordinatorNoteBySlug = new Map(coordinatorPriorities.map((p) => [p.section_slug, p.note]))
  const recommendedSlugs = coordinatorPrioritySlugs.size > 0
    ? coordinatorPrioritySlugs
    : getRecommendedSectionSlugs(daysUntilWedding)

  // Slug derivation: every nav href is `${base}/<slug>` so the last
  // segment is the section slug. Used by both the status dot and the
  // recommendation star.
  const slugFromHref = (href: string): string => {
    const cleaned = href.replace(/\/+$/, '')
    const last = cleaned.split('/').pop() || ''
    return last
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
                    const slug = slugFromHref(item.href)
                    const status = statuses[slug]
                    const isRecommended = recommendedSlugs.has(slug)
                    const isCoordinatorFlag = coordinatorPrioritySlugs.has(slug)
                    const coordinatorNote = coordinatorNoteBySlug.get(slug)
                    // Tooltip on the link itself surfaces the coordinator
                    // note (when present) so the hover reveals context.
                    const linkTitle = isCoordinatorFlag && coordinatorNote
                      ? `Coordinator priority: ${coordinatorNote}`
                      : isCoordinatorFlag
                        ? 'Your coordinator flagged this as a priority'
                        : item.tooltip
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={onMobileClose}
                          title={linkTitle}
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

                          {/* "Now" recommendation star — wins over status dot.
                              Filled when coordinator-flagged (priority), faded
                              when just time-aware. Shown before the dot so
                              the eye lands on the priority signal first. */}
                          {isRecommended && (
                            <Star
                              className={cn(
                                'w-3.5 h-3.5 shrink-0',
                                active
                                  ? 'fill-white text-white'
                                  : isCoordinatorFlag
                                    ? 'fill-amber-500 text-amber-500'
                                    : 'fill-amber-300 text-amber-400'
                              )}
                              aria-label={isCoordinatorFlag ? 'Coordinator priority' : 'Recommended now'}
                            />
                          )}

                          {/* Status dot:
                                amber     = started, not yet signed off
                                green     = couple signed off
                                confirmed = couple AND coordinator both signed
                                            (dot gets an emerald outer ring) */}
                          {status && (
                            <span
                              className={cn(
                                'w-2 h-2 rounded-full shrink-0',
                                status === 'amber' && 'bg-amber-400',
                                (status === 'green' || status === 'confirmed') && 'bg-emerald-500',
                                status === 'confirmed' && !active && 'ring-2 ring-emerald-200 ring-offset-1 ring-offset-white',
                                active && 'ring-1 ring-white/60'
                              )}
                              aria-label={
                                status === 'confirmed'
                                  ? 'Coordinator confirmed'
                                  : status === 'green'
                                    ? 'Marked done'
                                    : 'In progress'
                              }
                              title={
                                status === 'confirmed'
                                  ? 'Coordinator confirmed'
                                  : status === 'green'
                                    ? 'Marked done — awaiting coordinator review'
                                    : 'In progress'
                              }
                            />
                          )}

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

      {/* Desktop sidebar - fixed left, below top bar */}
      <aside
        className="hidden lg:block fixed left-0 top-16 bottom-0 w-64 bg-white border-r z-20 no-print"
        style={{ borderColor: 'rgba(125, 132, 113, 0.15)' }}
      >
        {nav}
      </aside>
    </>
  )
}
