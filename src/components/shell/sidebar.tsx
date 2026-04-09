'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { ScopeSelector } from './scope-selector'
import { UserMenu } from './user-menu'
import { usePlanTier } from '@/lib/hooks/use-plan-tier'
import {
  // Coordinator / Day-to-Day
  Mail, FileCheck, Kanban, Flame, Heart,
  MessageCircleQuestion, MessagesSquare, BookOpen, Store,
  // Owner / Brand Control
  GraduationCap, ScrollText, Sparkles, Mic, Settings,
  // Intelligence (single venue)
  LayoutDashboard, TrendingUp, Newspaper, Star,
  MessageSquareText, XCircle, CalendarRange, LineChart,
  Megaphone, Share2, MapPinIcon, UserCheck, Activity,
  // Enterprise / Multi-venue
  Building2, MapPin, UsersRound, Layers,
  BarChart3, GitMerge,
  // System
  Building, ShieldCheck, Menu, X,
  // Misc
  ListOrdered, HelpCircle, Users, SlidersHorizontal, Workflow,
  // Config pages
  Wine, HardHat, Bus, CheckSquare,
  UtensilsCrossed, Armchair, Flower2, HeartHandshake,
  // Toggle
  ChevronDown, Zap, LayoutList,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Nav item type
// ---------------------------------------------------------------------------

interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string
  daily?: boolean // shown in Daily mode
}

interface NavSection {
  title: string
  subtitle?: string
  items: NavItem[]
  dailyOnly?: boolean // entire section hidden in Daily mode
  fullOnly?: boolean  // entire section hidden in Daily mode
}

// ---------------------------------------------------------------------------
// Enterprise sections
// ---------------------------------------------------------------------------

const ENTERPRISE_SECTIONS: NavSection[] = [
  {
    title: 'Portfolio',
    subtitle: 'All venues',
    items: [
      { label: 'Overview', href: '/intel/portfolio', icon: Layers, daily: true },
      { label: 'Company', href: '/intel/company', icon: Building2 },
      { label: 'Team Performance', href: '/intel/team', icon: Users },
      { label: 'Regions', href: '/intel/regions', icon: MapPin },
      { label: 'All Clients', href: '/intel/clients', icon: UserCheck },
      { label: 'Deduplication', href: '/intel/matching', icon: GitMerge },
    ],
  },
]

// ---------------------------------------------------------------------------
// Venue sections — daily: true marks items visible in Daily mode
// ---------------------------------------------------------------------------

const VENUE_SECTIONS: NavSection[] = [
  {
    title: 'Respond',
    subtitle: 'Email & leads',
    items: [
      { label: 'Inbox', href: '/agent/inbox', icon: Mail, daily: true },
      { label: 'Approval Queue', href: '/agent/drafts', icon: FileCheck, daily: true },
      { label: 'Pipeline', href: '/agent/pipeline', icon: Kanban, daily: true },
      { label: 'Leads & Heat Map', href: '/agent/leads', icon: Flame },
      { label: 'Sequences', href: '/agent/sequences', icon: Workflow },
      { label: 'Analytics', href: '/agent/analytics', icon: BarChart3 },
      { label: 'Knowledge Gaps', href: '/agent/knowledge-gaps', icon: HelpCircle },
      { label: 'Relationships', href: '/agent/relationships', icon: UsersRound },
      { label: 'Client Codes', href: '/agent/codes', icon: ListOrdered },
    ],
  },
  {
    title: 'Manage',
    subtitle: 'Couples & portal',
    items: [
      { label: 'Weddings', href: '/portal/weddings', icon: Heart, daily: true },
      { label: 'Messages', href: '/portal/messages', icon: MessagesSquare, daily: true },
      { label: 'Sage Queue', href: '/portal/sage-queue', icon: MessageCircleQuestion, daily: true },
      { label: 'Knowledge Base', href: '/portal/kb', icon: BookOpen },
      { label: 'Vendors', href: '/portal/vendors', icon: Store },
    ],
  },
  {
    title: 'Venue Config',
    subtitle: 'Customize for your venue',
    fullOnly: true,
    items: [
      { label: 'Portal Sections', href: '/portal/section-settings', icon: SlidersHorizontal },
      { label: 'Wedding Details', href: '/portal/wedding-details-config', icon: Heart },
      { label: 'Checklist Templates', href: '/portal/checklist-config', icon: CheckSquare },
      { label: 'Bar & Beverages', href: '/portal/bar-config', icon: Wine },
      { label: 'Staffing', href: '/portal/staffing-config', icon: HardHat },
      { label: 'Shuttle & Transport', href: '/portal/shuttle-config', icon: Bus },
      { label: 'Rehearsal Dinner', href: '/portal/rehearsal-config', icon: UtensilsCrossed },
      { label: 'Tables & Linens', href: '/portal/tables-config', icon: Armchair },
      { label: 'Seating & Floor Plan', href: '/portal/seating-config', icon: MapPinIcon },
      { label: 'Rooms & Hotels', href: '/portal/rooms-config', icon: Building },
      { label: 'Decor & Spaces', href: '/portal/decor-config', icon: Flower2 },
      { label: 'Guest Care', href: '/portal/guest-care-config', icon: HeartHandshake },
    ],
  },
  {
    title: 'Brand & Voice',
    subtitle: 'Train your AI',
    fullOnly: true,
    items: [
      { label: 'Teach Voice', href: '/agent/learning', icon: GraduationCap },
      { label: 'Rules', href: '/agent/rules', icon: ScrollText },
      { label: 'AI Personality', href: '/settings/personality', icon: Sparkles },
      { label: 'Voice Games', href: '/settings/voice', icon: Mic },
    ],
  },
  {
    title: 'Intelligence',
    subtitle: 'Venue insights',
    items: [
      { label: 'Dashboard', href: '/intel/dashboard', icon: LayoutDashboard, daily: true },
      { label: 'Market Pulse', href: '/intel/market-pulse', icon: Activity, daily: true },
      { label: 'Ask Anything', href: '/intel/nlq', icon: MessageSquareText },
      { label: 'Briefings', href: '/intel/briefings', icon: Newspaper },
      { label: 'Sources & ROI', href: '/intel/sources', icon: TrendingUp },
      { label: 'Trends', href: '/intel/trends', icon: Sparkles },
      { label: 'Reviews', href: '/intel/reviews', icon: Star },
      { label: 'Tours', href: '/intel/tours', icon: MapPinIcon },
      { label: 'Lost Deals', href: '/intel/lost-deals', icon: XCircle },
      { label: 'Campaigns', href: '/intel/campaigns', icon: Megaphone },
      { label: 'Social', href: '/intel/social', icon: Share2 },
      { label: 'Capacity', href: '/intel/capacity', icon: CalendarRange },
      { label: 'Forecasts', href: '/intel/forecasts', icon: LineChart },
      { label: 'Health Score', href: '/intel/health', icon: Activity },
    ],
  },
  {
    title: 'System',
    subtitle: 'Monitoring & config',
    fullOnly: true,
    items: [
      { label: 'Error Monitor', href: '/agent/errors', icon: Activity },
      { label: 'Notifications', href: '/agent/notifications', icon: Newspaper },
      { label: 'Agent Settings', href: '/agent/settings', icon: Settings },
    ],
  },
]

const SETTINGS_SECTION: NavSection = {
  title: 'Settings',
  items: [
    { label: 'Venue Settings', href: '/settings', icon: Settings, daily: true },
    { label: 'Onboarding', href: '/onboarding', icon: Building },
    { label: 'Super Admin', href: '/super-admin', icon: ShieldCheck },
  ],
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function getNavModeCookie(): 'daily' | 'full' {
  if (typeof document === 'undefined') return 'daily'
  try {
    const match = document.cookie.split('; ').find((c) => c.startsWith('bloom_nav_mode='))
    return (match?.split('=')[1] as 'daily' | 'full') || 'daily'
  } catch { return 'daily' }
}

function setNavModeCookie(mode: 'daily' | 'full') {
  document.cookie = `bloom_nav_mode=${mode}; path=/; max-age=${60 * 60 * 24 * 365}`
}

// ---------------------------------------------------------------------------
// Build sections
// ---------------------------------------------------------------------------

// Sections that are venue-specific (config, training, system) — hidden at group/company scope
const VENUE_ONLY_SECTIONS = new Set(['Venue Config', 'Brand & Voice', 'System'])

function buildSections(
  scopeLevel: string,
  hasMultipleVenues: boolean,
  planTier: 'starter' | 'intelligence' | 'enterprise'
): NavSection[] {
  const sections: NavSection[] = []

  // Portfolio sections — show whenever scope is group/company (or venue with multi-venue access)
  const showPortfolio =
    (scopeLevel === 'group' || scopeLevel === 'company' || hasMultipleVenues) &&
    planTier === 'enterprise'
  if (showPortfolio) {
    sections.push(...ENTERPRISE_SECTIONS)
  }

  // Show Agent / Manage / Intelligence at every scope level — they aggregate by venue/group/company
  for (const section of VENUE_SECTIONS) {
    // Intelligence section requires 'intelligence' or 'enterprise' tier
    if (section.title === 'Intelligence' && planTier === 'starter') continue
    // Hide venue-only config sections at group/company scope
    if (scopeLevel !== 'venue' && VENUE_ONLY_SECTIONS.has(section.title)) continue
    sections.push(section)
  }

  sections.push(SETTINGS_SECTION)
  return sections
}

// ---------------------------------------------------------------------------
// Filter for daily mode
// ---------------------------------------------------------------------------

function filterForDaily(sections: NavSection[]): NavSection[] {
  return sections
    .filter((s) => !s.fullOnly)
    .map((s) => ({ ...s, items: s.items.filter((i) => i.daily) }))
    .filter((s) => s.items.length > 0)
}

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

export function Sidebar({ isDemo = false }: { isDemo?: boolean }) {
  const pathname = usePathname()
  const { tier: planTier } = usePlanTier()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scopeLevel, setScopeLevel] = useState<string>('venue')
  const [hasMultipleVenues, setHasMultipleVenues] = useState(false)
  const [hasPortfolioAccess, setHasPortfolioAccess] = useState(isDemo)
  const [navMode, setNavMode] = useState<'daily' | 'full'>('daily')
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  useEffect(() => {
    setNavMode(getNavModeCookie())

    try {
      const raw = document.cookie.split('; ').find((c) => c.startsWith('bloom_scope='))?.split('=')[1]
      if (raw) {
        const parsed = JSON.parse(decodeURIComponent(raw))
        setScopeLevel(parsed.level || 'venue')
        if (parsed.level === 'group' || parsed.level === 'company') setHasMultipleVenues(true)
      }
    } catch { /* default */ }

    // Check if org has multiple venues + user role for portfolio access
    import('@/lib/supabase/client').then(({ createClient }) => {
      const supabase = createClient()
      supabase.from('venues').select('id', { count: 'exact', head: true }).then(({ count }) => {
        if (count && count > 1) setHasMultipleVenues(true)
      })
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (user) {
          supabase.from('user_profiles').select('role').eq('id', user.id).single().then(({ data }) => {
            if (data && (data.role === 'super_admin' || data.role === 'org_admin')) {
              setHasPortfolioAccess(true)
            }
          })
        }
      })
    })
  }, [])

  function toggleNavMode() {
    const next = navMode === 'daily' ? 'full' : 'daily'
    setNavMode(next)
    setNavModeCookie(next)
    setCollapsedSections(new Set())
  }

  function toggleSection(title: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  const allSections = buildSections(scopeLevel, hasMultipleVenues && hasPortfolioAccess, planTier)
  const sections = navMode === 'daily' ? filterForDaily(allSections) : allSections

  const nav = (
    <nav className="flex flex-col h-full">
      {/* Brand + Scope */}
      <div className="pb-3 border-b border-border">
        <div className="px-6 pt-5 pb-2 flex items-center gap-2">
          <img src="/brand/wordmark-sage.png" alt="The Bloom House" className="h-8 w-auto" />
          {isDemo && (
            <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-amber-100 text-amber-700 border border-amber-200">
              Demo
            </span>
          )}
        </div>
        <ScopeSelector />
      </div>

      {/* Mode toggle */}
      <div className="px-3 pt-3 pb-1">
        <button
          onClick={toggleNavMode}
          className={cn(
            'flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all',
            'border',
            navMode === 'daily'
              ? 'bg-sage-50 border-sage-200 text-sage-700'
              : 'bg-teal-50 border-teal-200 text-teal-700'
          )}
        >
          {navMode === 'daily' ? (
            <>
              <Zap className="w-3.5 h-3.5" />
              <span className="flex-1 text-left">Daily Essentials</span>
              <span className="text-[10px] opacity-60">Show all</span>
            </>
          ) : (
            <>
              <LayoutList className="w-3.5 h-3.5" />
              <span className="flex-1 text-left">Full Navigation</span>
              <span className="text-[10px] opacity-60">Simplify</span>
            </>
          )}
        </button>
      </div>

      {/* Navigation sections */}
      <div className="flex-1 overflow-y-auto py-2 px-3 space-y-3">
        {sections.map((section) => {
          const isCollapsed = collapsedSections.has(section.title)
          const hasActiveItem = section.items.some(
            (item) => pathname === item.href || (pathname.startsWith(item.href) && item.href !== '/settings')
          )

          return (
            <div key={section.title}>
              <button
                onClick={() => navMode === 'full' && toggleSection(section.title)}
                className={cn(
                  'flex items-center w-full px-3 mb-1',
                  navMode === 'full' && 'cursor-pointer hover:opacity-80'
                )}
              >
                <div className="flex-1 text-left">
                  <p className={cn(
                    'text-xs font-semibold uppercase tracking-wider',
                    hasActiveItem ? 'text-sage-700' : 'text-sage-500'
                  )}>
                    {section.title}
                  </p>
                  {section.subtitle && !isCollapsed && (
                    <p className="text-[10px] text-sage-400 mt-0.5">{section.subtitle}</p>
                  )}
                </div>
                {navMode === 'full' && (
                  <ChevronDown className={cn(
                    'w-3 h-3 text-sage-400 transition-transform',
                    isCollapsed && '-rotate-90'
                  )} />
                )}
              </button>
              {!isCollapsed && (
                <ul className="space-y-0.5">
                  {section.items.map((item) => {
                    const isActive = pathname === item.href ||
                      (pathname.startsWith(item.href) && item.href !== '/settings')
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setMobileOpen(false)}
                          className={cn(
                            'flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm transition-colors',
                            isActive
                              ? 'bg-sage-100 text-sage-800 font-medium'
                              : 'text-sage-600 hover:bg-sage-50 hover:text-sage-800'
                          )}
                        >
                          <item.icon className="w-4 h-4 shrink-0" />
                          <span className="flex-1">{item.label}</span>
                          {item.badge && (
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-red-100 text-red-700">
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

      {/* User menu */}
      <div className="p-4 border-t border-border flex items-center justify-between">
        <UserMenu />
      </div>
    </nav>
  )

  return (
    <>
      {/* Mobile header */}
      <div className={cn(
        'lg:hidden fixed left-0 right-0 h-14 bg-surface border-b border-border z-40 flex items-center px-4',
        isDemo ? 'top-10' : 'top-0'
      )}>
        <button onClick={() => setMobileOpen(!mobileOpen)} className="p-2 -ml-2">
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
        <img src="/brand/wordmark-sage.png" alt="The Bloom House" className="h-6 w-auto ml-3" />
        {isDemo && (
          <span className="ml-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-amber-100 text-amber-700">
            Demo
          </span>
        )}
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className={cn(
            'absolute left-0 bottom-0 w-64 bg-surface shadow-xl overflow-y-auto',
            isDemo ? 'top-[calc(2.5rem+3.5rem)]' : 'top-14'
          )}>
            {nav}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className={cn(
        'hidden lg:block fixed left-0 bottom-0 w-64 bg-surface border-r border-border z-30',
        isDemo ? 'top-10' : 'top-0'
      )}>
        {nav}
      </aside>
    </>
  )
}
