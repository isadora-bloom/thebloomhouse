'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Settings, LogOut, Sparkles } from 'lucide-react'

interface UserData {
  name: string
  email: string
  initials: string
  avatarUrl: string | null
  role: string
}

interface UserMenuProps {
  compact?: boolean
}

// Keys must match user_profiles.role values. The legacy short names
// (owner/admin/manager/viewer) are kept as aliases so older seed rows or
// demo fixtures still render with a sensible badge.
const ROLE_BADGES: Record<string, { label: string; className: string }> = {
  super_admin:   { label: 'Super Admin',  className: 'bg-gold-100 text-gold-700' },
  org_admin:     { label: 'Org Admin',    className: 'bg-sage-100 text-sage-700' },
  venue_manager: { label: 'Manager',      className: 'bg-teal-100 text-teal-700' },
  coordinator:   { label: 'Coordinator',  className: 'bg-teal-100 text-teal-700' },
  readonly:      { label: 'Read-only',    className: 'bg-gray-100 text-gray-600' },
  couple:        { label: 'Couple',       className: 'bg-rose-100 text-rose-700' },
  // Legacy aliases
  owner:         { label: 'Owner',        className: 'bg-gold-100 text-gold-700' },
  admin:         { label: 'Admin',        className: 'bg-sage-100 text-sage-700' },
  manager:       { label: 'Manager',      className: 'bg-teal-100 text-teal-700' },
  viewer:        { label: 'Viewer',       className: 'bg-gray-100 text-gray-600' },
}

// Toggle for the Phase 2B mode-nav feature flag (cookie bloom_nav_v2).
// Sits between Settings and Sign Out so Isadora can flip without
// touching DevTools. Reloads the page so the new shell renders.
function NavV2Toggle({ onDone }: { onDone: () => void }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    setOn(document.cookie.split('; ').some((c) => c === 'bloom_nav_v2=true'))
  }, [])
  function flip() {
    const next = !on
    document.cookie = `bloom_nav_v2=${next ? 'true' : ''}; path=/; max-age=${next ? 60 * 60 * 24 * 365 : 0}`
    onDone()
    // Full reload so PlatformShell re-evaluates the cookie.
    window.location.reload()
  }
  return (
    <button
      onClick={flip}
      className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-sage-600 hover:bg-sage-50 hover:text-sage-800 transition-colors"
    >
      <Sparkles className="w-4 h-4" />
      {on ? 'Back to classic nav' : 'Try new nav (beta)'}
    </button>
  )
}

export function UserMenu({ compact = false }: UserMenuProps) {
  const router = useRouter()
  const [user, setUser] = useState<UserData | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function loadUser() {
      // Demo mode: show a fake profile so the menu (with Sign Out) is always visible
      const isDemo = document.cookie.split('; ').some((c) => c === 'bloom_demo=true')
      if (isDemo) {
        setUser({
          name: 'Demo User',
          email: 'demo@thebloomhouse.ai',
          initials: 'DU',
          avatarUrl: null,
          role: 'owner',
        })
        return
      }

      const supabase = createClient()

      const { data: { user: authUser } } = await supabase.auth.getUser()
      if (!authUser) return

      // Try to get profile data
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('first_name, last_name, avatar_url, role')
        .eq('id', authUser.id)
        .maybeSingle()

      const fullName = profile
        ? [profile.first_name, profile.last_name].filter(Boolean).join(' ')
        : ''
      const name = fullName ||
        authUser.user_metadata?.full_name ||
        authUser.email?.split('@')[0] ||
        'User'

      const nameParts = name.trim().split(/\s+/)
      const initials = nameParts.length >= 2
        ? `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`.toUpperCase()
        : name.slice(0, 2).toUpperCase()

      setUser({
        name,
        email: authUser.email ?? '',
        initials,
        avatarUrl: (profile?.avatar_url as string) ?? null,
        role: (profile?.role as string) ?? 'viewer',
      })
    }

    loadUser()
  }, [])

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function handleSignOut() {
    // Clear demo cookies if present
    document.cookie = 'bloom_demo=; path=/; max-age=0'
    document.cookie = 'bloom_venue=; path=/; max-age=0'
    document.cookie = 'bloom_scope=; path=/; max-age=0'

    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (!user) {
    return (
      <div
        className={cn(
          'rounded-full bg-sage-100 animate-pulse',
          compact ? 'w-8 h-8' : 'w-9 h-9'
        )}
      />
    )
  }

  // If the role isn't in the map (missing profile row, unknown value),
  // surface that honestly instead of silently showing "Viewer" — we hit
  // this when an auth user has no user_profiles row yet.
  const roleBadge = ROLE_BADGES[user.role] ?? { label: 'No role', className: 'bg-red-100 text-red-700' }

  return (
    <div ref={ref} className="relative">
      {/* Avatar button */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'rounded-full flex items-center justify-center font-medium transition-colors',
          'bg-sage-200 text-sage-700 hover:bg-sage-300',
          compact ? 'w-8 h-8 text-xs' : 'w-9 h-9 text-sm'
        )}
        aria-label="User menu"
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt={user.name}
            className="w-full h-full rounded-full object-cover"
          />
        ) : (
          user.initials
        )}
      </button>

      {/* Dropdown — opens above avatar in sidebar, below in compact/mobile */}
      {open && (
        <div
          className={cn(
            'w-56 bg-surface border border-border rounded-lg shadow-lg z-[70] overflow-hidden',
            compact
              ? 'absolute right-0 top-full mt-2'
              : 'fixed bottom-16 left-2'
          )}
        >
          {/* User info */}
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-medium text-sage-800 truncate">
              {user.name}
            </p>
            <p className="text-xs text-muted truncate mt-0.5">
              {user.email}
            </p>
            <span
              className={cn(
                'inline-block mt-1.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full',
                roleBadge.className
              )}
            >
              {roleBadge.label}
            </span>
          </div>

          {/* Menu items */}
          <div className="py-1">
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2 text-sm text-sage-600 hover:bg-sage-50 hover:text-sage-800 transition-colors"
            >
              <Settings className="w-4 h-4" />
              Settings
            </Link>

            <NavV2Toggle onDone={() => setOpen(false)} />

            <button
              onClick={handleSignOut}
              className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-sage-600 hover:bg-sage-50 hover:text-sage-800 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
