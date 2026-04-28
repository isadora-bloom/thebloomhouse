'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { usePlanTier } from '@/lib/hooks/use-plan-tier'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import { ChevronDown } from 'lucide-react'
import {
  MODES,
  modeForPath,
  type ModeConfig,
  type NavSection,
  type NavItem,
} from './nav-config'

/**
 * SidebarV2 — mode-aware nav. Reads the active mode from the URL
 * and renders only that mode's rail.
 *
 * Two view modes:
 *   - "Essential" (default) — only items flagged `daily: true` in
 *     nav-config.ts. ~18 items across all four modes; what a
 *     coordinator opens every day.
 *   - "All" — every item in the mode. Use when you need to dig into
 *     something less common (sequence editing, voice training, etc.).
 *
 * Selection persists in `bloom_nav_view` cookie. Per-section collapse
 * state still persists in `bloom_nav_collapsed`. Plan-tier gates and
 * venue-only sections still apply in both views.
 */

interface SidebarV2Props {
  isDemo?: boolean
  scopeLevel: 'venue' | 'group' | 'company'
}

type View = 'essential' | 'all'

function isNavItemVisible(item: NavItem, planTier: 'starter' | 'intelligence' | 'enterprise'): boolean {
  if (!item.requiresPlan) return true
  if (item.requiresPlan === 'enterprise') return planTier === 'enterprise'
  if (item.requiresPlan === 'intelligence') return planTier === 'intelligence' || planTier === 'enterprise'
  return true
}

function isSectionVisible(
  section: NavSection,
  scopeLevel: 'venue' | 'group' | 'company',
  planTier: 'starter' | 'intelligence' | 'enterprise'
): boolean {
  if (section.venueOnly && scopeLevel !== 'venue') return false
  if (section.requiresPlan) {
    if (section.requiresPlan === 'enterprise' && planTier !== 'enterprise') return false
    if (
      section.requiresPlan === 'intelligence' &&
      planTier !== 'intelligence' &&
      planTier !== 'enterprise'
    ) {
      return false
    }
  }
  return true
}

function readView(): View {
  if (typeof document === 'undefined') return 'essential'
  const raw = document.cookie.split('; ').find((c) => c.startsWith('bloom_nav_view='))?.split('=')[1]
  return raw === 'all' ? 'all' : 'essential'
}

function writeView(view: View) {
  document.cookie = `bloom_nav_view=${view}; path=/; max-age=${60 * 60 * 24 * 365}`
}

export function SidebarV2({ scopeLevel }: SidebarV2Props) {
  const pathname = usePathname()
  const { tier: planTier } = usePlanTier()
  const venueId = useVenueId()
  const activeMode = modeForPath(pathname)
  const mode: ModeConfig | undefined = MODES.find((m) => m.mode === activeMode) ?? MODES[0]

  const [view, setView] = useState<View>('essential')
  useEffect(() => {
    setView(readView())
  }, [])

  // Live counts for nav badges. Today only Anomalies has one — count
  // of unacknowledged anomaly_alerts for this venue. Re-fetched when
  // the venue changes; not on every navigation. The cron writes new
  // anomalies and the badge stays accurate within an hour, which is
  // good enough for "you have unread anomalies."
  const [anomalyCount, setAnomalyCount] = useState<number>(0)
  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    async function load() {
      const sb = createClient()
      const { count } = await sb
        .from('anomaly_alerts')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('acknowledged', false)
      if (!cancelled) setAnomalyCount(count ?? 0)
    }
    load()
    return () => { cancelled = true }
  }, [venueId])

  function flipView(next: View) {
    setView(next)
    writeView(next)
  }

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  useEffect(() => {
    try {
      const raw = document.cookie.split('; ').find((c) => c.startsWith('bloom_nav_collapsed='))?.split('=')[1]
      if (raw) setCollapsed(new Set(JSON.parse(decodeURIComponent(raw)) as string[]))
    } catch { /* ignore */ }
  }, [])
  function toggle(title: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      document.cookie = `bloom_nav_collapsed=${encodeURIComponent(JSON.stringify([...next]))}; path=/; max-age=${60 * 60 * 24 * 365}`
      return next
    })
  }

  const sections = mode.sections.filter((s) => isSectionVisible(s, scopeLevel, planTier))

  // For each section, filter items by plan, then by view mode if
  // Essential. Drop sections that have zero matching items so the
  // sidebar doesn't render empty headers.
  const renderable = sections
    .map((s) => {
      const planFiltered = s.items.filter((i) => isNavItemVisible(i, planTier))
      const items = view === 'essential' ? planFiltered.filter((i) => i.daily === true) : planFiltered
      return { section: s, items }
    })
    .filter(({ items }) => items.length > 0)

  // Count what the OTHER view would show — used to render the
  // "+ N more" hint on the Essential pill so the user knows there's
  // depth waiting in All.
  const allCount = sections.reduce(
    (sum, s) => sum + s.items.filter((i) => isNavItemVisible(i, planTier)).length,
    0
  )
  const essentialCount = sections.reduce(
    (sum, s) => sum + s.items.filter((i) => isNavItemVisible(i, planTier) && i.daily === true).length,
    0
  )

  return (
    <aside className="hidden lg:flex fixed top-0 left-0 h-screen w-64 flex-col border-r border-border bg-warm-white overflow-y-auto z-20">
      <div className="px-5 py-4 border-b border-border">
        <Link href="/" className="font-heading text-lg font-bold text-sage-900">
          Bloom
        </Link>
        <p className="text-[11px] text-sage-500 mt-0.5">{mode.description}</p>
      </div>

      {/* Essential / All toggle. Sits below the brand block; persists
          in bloom_nav_view cookie. */}
      <div className="px-3 pt-3">
        <div className="flex items-center bg-sage-50 rounded-lg p-0.5 text-xs">
          <button
            onClick={() => flipView('essential')}
            className={cn(
              'flex-1 px-2 py-1 rounded-md font-medium transition-colors',
              view === 'essential'
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-500 hover:text-sage-700'
            )}
          >
            Essential
            <span className="ml-1 text-[10px] text-sage-400">{essentialCount}</span>
          </button>
          <button
            onClick={() => flipView('all')}
            className={cn(
              'flex-1 px-2 py-1 rounded-md font-medium transition-colors',
              view === 'all'
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-500 hover:text-sage-700'
            )}
          >
            All
            <span className="ml-1 text-[10px] text-sage-400">{allCount}</span>
          </button>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-5">
        {renderable.map(({ section: s, items }) => {
          const isCollapsed = collapsed.has(s.title)
          return (
            <div key={s.title}>
              <button
                onClick={() => toggle(s.title)}
                className="w-full flex items-center justify-between px-2 text-[10px] uppercase tracking-wider text-sage-500 font-semibold mb-2 hover:text-sage-700"
              >
                <span>{s.title}</span>
                <ChevronDown
                  className={cn(
                    'w-3 h-3 transition-transform',
                    isCollapsed && '-rotate-90'
                  )}
                />
              </button>
              {s.subtitle && !isCollapsed && view === 'all' && (
                <p className="text-[11px] text-sage-400 px-2 mb-1">{s.subtitle}</p>
              )}
              {!isCollapsed && (
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const active = pathname === item.href || pathname.startsWith(item.href + '/')
                    const Icon = item.icon
                    // Live anomaly count override — shows on the
                    // Anomalies nav item only. Falls through to the
                    // static badge for other items.
                    const isAnomalies = item.href === '/intel/anomalies'
                    const badgeText =
                      isAnomalies && anomalyCount > 0
                        ? String(anomalyCount)
                        : item.badge
                    const badgeUrgent = isAnomalies && anomalyCount > 0
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                            active
                              ? 'bg-sage-100 text-sage-900 font-medium'
                              : 'text-sage-700 hover:bg-sage-50 hover:text-sage-900'
                          )}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                          <span className="flex-1 truncate">{item.label}</span>
                          {badgeText && (
                            <span
                              className={cn(
                                'text-[9px] px-1.5 py-0.5 rounded font-semibold',
                                badgeUrgent
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-sage-200 text-sage-700'
                              )}
                            >
                              {badgeText}
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

        {/* Hint when Essential is empty for this mode (no items have
            daily:true). Falls back to a soft prompt to flip to All. */}
        {view === 'essential' && renderable.length === 0 && (
          <div className="px-2 py-3 text-xs text-sage-500 text-center">
            <p className="mb-2">No essentials configured for this view.</p>
            <button
              onClick={() => flipView('all')}
              className="text-sage-700 underline underline-offset-2 hover:text-sage-900"
            >
              Show all options
            </button>
          </div>
        )}
      </nav>
    </aside>
  )
}
