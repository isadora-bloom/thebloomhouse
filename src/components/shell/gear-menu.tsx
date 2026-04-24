'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { GEAR_GROUPS } from './nav-config'

type Role = 'coordinator' | 'group_admin' | 'org_admin' | 'super_admin' | 'venue_manager' | 'readonly' | 'couple' | 'owner' | 'admin' | 'manager' | 'viewer'

/**
 * Gear menu — admin settings drawer in the top-right corner. Replaces the
 * old Settings top-nav slot. Only renders for users with org_admin /
 * group_admin / super_admin roles — coordinator-only users never see it.
 *
 * role hierarchy for visibility:
 *   super_admin > org_admin > group_admin > anything else
 *
 * group_admin sees the same rail as org_admin but downstream pages are
 * scoped to their group (the Org admin pages themselves enforce this;
 * this component only controls visibility).
 */
export function GearMenu() {
  const [role, setRole] = useState<Role | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Demo mode: treat as org_admin so the gear is visible.
    if (document.cookie.split('; ').some((c) => c === 'bloom_demo=true')) {
      setRole('org_admin')
      return
    }
    async function load() {
      const sb = createClient()
      const { data: { user } } = await sb.auth.getUser()
      if (!user) return
      const { data: profile } = await sb
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
      setRole((profile?.role as Role | null) ?? null)
    }
    load()
  }, [])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Hide the gear entirely for non-admin roles. A coordinator doesn't
  // have a venue settings surface and shouldn't see an empty menu.
  const isAdmin =
    role === 'org_admin' ||
    role === 'super_admin' ||
    role === 'group_admin' ||
    role === 'owner' ||
    role === 'admin'
  if (!isAdmin) return null

  function canSee(required?: 'group_admin' | 'org_admin' | 'super_admin'): boolean {
    if (!required) return true
    if (required === 'super_admin') return role === 'super_admin'
    if (required === 'org_admin') {
      return role === 'org_admin' || role === 'super_admin' || role === 'owner' || role === 'admin'
    }
    if (required === 'group_admin') {
      return (
        role === 'group_admin' ||
        role === 'org_admin' ||
        role === 'super_admin' ||
        role === 'owner' ||
        role === 'admin'
      )
    }
    return false
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'p-2 rounded-md text-sage-600 hover:bg-sage-50 hover:text-sage-900 transition-colors',
          open && 'bg-sage-100 text-sage-900'
        )}
        aria-label="Admin menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Settings className="w-5 h-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-border bg-warm-white shadow-lg z-40 py-2">
          {GEAR_GROUPS.map((group) => {
            const visible = group.items.filter((i) => canSee(i.requiresRole))
            if (visible.length === 0) return null
            return (
              <div key={group.title} className="py-1">
                <p className="px-3 py-1 text-[10px] uppercase tracking-wider text-sage-500 font-semibold">
                  {group.title}
                </p>
                {visible.map((item) => {
                  const Icon = item.icon
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm text-sage-700 hover:bg-sage-50 hover:text-sage-900 transition-colors"
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </Link>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
