'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Settings, LogOut } from 'lucide-react'

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

const ROLE_BADGES: Record<string, { label: string; className: string }> = {
  owner: { label: 'Owner', className: 'bg-gold-100 text-gold-700' },
  admin: { label: 'Admin', className: 'bg-sage-100 text-sage-700' },
  manager: { label: 'Manager', className: 'bg-teal-100 text-teal-700' },
  viewer: { label: 'Viewer', className: 'bg-gray-100 text-gray-600' },
}

export function UserMenu({ compact = false }: UserMenuProps) {
  const router = useRouter()
  const [user, setUser] = useState<UserData | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function loadUser() {
      const supabase = createClient()

      const { data: { user: authUser } } = await supabase.auth.getUser()
      if (!authUser) return

      // Try to get profile data
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('full_name, avatar_url, role')
        .eq('id', authUser.id)
        .single()

      const name = (profile?.full_name as string) ??
        authUser.user_metadata?.full_name ??
        authUser.email?.split('@')[0] ??
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

  const roleBadge = ROLE_BADGES[user.role] ?? ROLE_BADGES.viewer

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

      {/* Dropdown */}
      {open && (
        <div
          className={cn(
            'absolute right-0 mt-2 w-56 bg-surface border border-border rounded-lg shadow-lg z-50 overflow-hidden',
            compact ? 'top-full' : 'bottom-full mb-2'
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
