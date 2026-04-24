'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { usePlanTier } from '@/lib/hooks/use-plan-tier'
import { ChevronDown } from 'lucide-react'
import {
  MODES,
  modeForPath,
  type ModeConfig,
  type NavSection,
  type NavItem,
} from './nav-config'

/**
 * Sidebar v2 — mode-aware. Reads the active mode from the current URL
 * and renders only that mode's rail. Sections collapse per-mode state
 * in a cookie so the collapse pattern persists across reloads. Same
 * plan-tier gates as the legacy sidebar. Venue-only sections hide at
 * group/company scope.
 */

interface SidebarV2Props {
  isDemo?: boolean
  scopeLevel: 'venue' | 'group' | 'company'
}

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

export function SidebarV2({ scopeLevel }: SidebarV2Props) {
  const pathname = usePathname()
  const { tier: planTier } = usePlanTier()
  const activeMode = modeForPath(pathname)
  const mode: ModeConfig | undefined = MODES.find((m) => m.mode === activeMode) ?? MODES[0]

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

  return (
    <aside className="hidden lg:flex fixed top-0 left-0 h-screen w-64 flex-col border-r border-border bg-warm-white overflow-y-auto z-20">
      <div className="px-5 py-4 border-b border-border">
        <Link href="/" className="font-heading text-lg font-bold text-sage-900">
          Bloom
        </Link>
        <p className="text-[11px] text-sage-500 mt-0.5">{mode.description}</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-5">
        {sections.map((s) => {
          const isCollapsed = collapsed.has(s.title)
          const visibleItems = s.items.filter((i) => isNavItemVisible(i, planTier))
          if (visibleItems.length === 0) return null
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
              {s.subtitle && !isCollapsed && (
                <p className="text-[11px] text-sage-400 px-2 mb-1">{s.subtitle}</p>
              )}
              {!isCollapsed && (
                <ul className="space-y-0.5">
                  {visibleItems.map((item) => {
                    const active = pathname === item.href || pathname.startsWith(item.href + '/')
                    const Icon = item.icon
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
                          {item.badge && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-sage-200 text-sage-700 font-medium">
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
      </nav>
    </aside>
  )
}
