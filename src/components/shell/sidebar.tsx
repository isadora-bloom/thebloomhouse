'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { ScopeSelector } from './scope-selector'
import { UserMenu } from './user-menu'
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
  ListOrdered, HelpCircle, Users, SlidersHorizontal,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Navigation structure — organized by WHO uses it
// ---------------------------------------------------------------------------

interface NavItem {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string  // e.g. notification count
}

interface NavSection {
  title: string
  subtitle?: string
  scope?: 'venue' | 'group' | 'company' | 'any' // when this section shows
  items: NavItem[]
}

const navSections: NavSection[] = [
  // ── COORDINATOR / SALES ──────────────────────────────────────────────
  // These are the daily tools for the person answering emails and
  // managing couples. Scope: single venue.
  {
    title: 'Respond',
    subtitle: 'Email & leads',
    scope: 'venue',
    items: [
      { label: 'Inbox', href: '/agent/inbox', icon: Mail },
      { label: 'Approval Queue', href: '/agent/drafts', icon: FileCheck },
      { label: 'Pipeline', href: '/agent/pipeline', icon: Kanban },
      { label: 'Leads & Heat Map', href: '/agent/leads', icon: Flame },
      { label: 'Follow-up Sequences', href: '/agent/sequences', icon: ListOrdered },
      { label: 'Knowledge Gaps', href: '/agent/knowledge-gaps', icon: HelpCircle },
    ],
  },
  {
    title: 'Manage',
    subtitle: 'Couples & portal',
    scope: 'venue',
    items: [
      { label: 'Weddings', href: '/portal/weddings', icon: Heart },
      { label: 'Messages', href: '/portal/messages', icon: MessagesSquare },
      { label: 'Sage Queue', href: '/portal/sage-queue', icon: MessageCircleQuestion },
      { label: 'Knowledge Base', href: '/portal/kb', icon: BookOpen },
      { label: 'Vendors', href: '/portal/vendors', icon: Store },
      { label: 'Section Settings', href: '/portal/section-settings', icon: SlidersHorizontal },
    ],
  },

  // ── OWNER / BRAND CONTROL ────────────────────────────────────────────
  // Venue owner shapes the AI's voice, sets rules, configures personality.
  // This is THE differentiator. Scope: single venue.
  {
    title: 'Brand & Voice',
    subtitle: 'Train your AI',
    scope: 'venue',
    items: [
      { label: 'Teach Voice', href: '/agent/learning', icon: GraduationCap },
      { label: 'Rules', href: '/agent/rules', icon: ScrollText },
      { label: 'AI Personality', href: '/settings/personality', icon: Sparkles },
      { label: 'Voice Games', href: '/settings/voice', icon: Mic },
    ],
  },

  // ── VENUE INTELLIGENCE ───────────────────────────────────────────────
  // Analytics and insights for a single venue. Shows when viewing
  // one venue. Scope: single venue.
  {
    title: 'Intelligence',
    subtitle: 'Venue insights',
    scope: 'venue',
    items: [
      { label: 'Dashboard', href: '/intel/dashboard', icon: LayoutDashboard },
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

  // ── GROUP / REGIONAL MANAGER ─────────────────────────────────────────
  // Comparing venues within a group. Shows when viewing a group
  // or the company. Scope: group or company.
  {
    title: 'Portfolio',
    subtitle: 'Compare venues',
    scope: 'group',
    items: [
      { label: 'Overview', href: '/intel/portfolio', icon: Layers },
      { label: 'Venue Comparison', href: '/intel/cross', icon: BarChart3 },
      { label: 'Team Performance', href: '/intel/team', icon: Users },
      { label: 'Regions', href: '/intel/regions', icon: MapPin },
      { label: 'Deduplication', href: '/intel/matching', icon: GitMerge },
    ],
  },

  // ── COMPANY / EXECUTIVE ──────────────────────────────────────────────
  // Organization-wide view. Shows when viewing the company.
  // Scope: company.
  {
    title: 'Company',
    subtitle: 'Organization-wide',
    scope: 'company',
    items: [
      { label: 'Company Overview', href: '/intel/company', icon: Building2 },
      { label: 'All Clients', href: '/intel/clients', icon: UserCheck },
      { label: 'Portfolio', href: '/intel/portfolio', icon: Layers },
      { label: 'Regions', href: '/intel/regions', icon: MapPin },
    ],
  },

  // ── SETTINGS ─────────────────────────────────────────────────────────
  {
    title: 'Settings',
    scope: 'any',
    items: [
      { label: 'Venue Settings', href: '/settings', icon: Settings },
      { label: 'Onboarding', href: '/onboarding', icon: Building },
      { label: 'Super Admin', href: '/super-admin', icon: ShieldCheck },
    ],
  },
]

// ---------------------------------------------------------------------------
// Helper: which sections show for a given scope level
// ---------------------------------------------------------------------------

function visibleSections(scopeLevel: string): NavSection[] {
  return navSections.filter((section) => {
    if (!section.scope || section.scope === 'any') return true
    if (section.scope === 'venue') return scopeLevel === 'venue'
    if (section.scope === 'group') return scopeLevel === 'group' || scopeLevel === 'company'
    if (section.scope === 'company') return scopeLevel === 'company'
    return true
  })
}

// ---------------------------------------------------------------------------
// Sidebar component
// ---------------------------------------------------------------------------

export function Sidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  // Read scope from cookie (client-side)
  const [scopeLevel, setScopeLevel] = useState<string>('venue')

  // Listen for scope changes (cookie-based for now)
  useState(() => {
    try {
      const raw = document.cookie
        .split('; ')
        .find((c) => c.startsWith('bloom_scope='))
        ?.split('=')[1]
      if (raw) {
        const parsed = JSON.parse(decodeURIComponent(raw))
        setScopeLevel(parsed.level || 'venue')
      }
    } catch {
      // Default to venue
    }
  })

  const sections = visibleSections(scopeLevel)

  const nav = (
    <nav className="flex flex-col h-full">
      {/* Brand + Scope Selector */}
      <div className="pb-3 border-b border-border">
        <div className="px-6 pt-5 pb-2">
          <h1 className="font-heading text-xl font-bold text-sage-800">The Bloom House</h1>
        </div>
        <ScopeSelector />
      </div>

      {/* Navigation sections */}
      <div className="flex-1 overflow-y-auto py-3 px-3 space-y-5">
        {sections.map((section) => (
          <div key={section.title}>
            <div className="px-3 mb-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                {section.title}
              </p>
              {section.subtitle && (
                <p className="text-[10px] text-sage-400 mt-0.5">{section.subtitle}</p>
              )}
            </div>
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
          </div>
        ))}
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
      <div className="lg:hidden fixed top-0 left-0 right-0 h-14 bg-surface border-b border-border z-40 flex items-center px-4">
        <button onClick={() => setMobileOpen(!mobileOpen)} className="p-2 -ml-2">
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
        <h1 className="font-heading text-lg font-bold text-sage-800 ml-3">The Bloom House</h1>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-14 bottom-0 w-64 bg-surface shadow-xl">
            {nav}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:block fixed left-0 top-0 bottom-0 w-64 bg-surface border-r border-border z-30">
        {nav}
      </aside>
    </>
  )
}
