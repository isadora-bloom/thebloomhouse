'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CoupleUserMenuProps {
  /** Display name shown in the dropdown header, e.g. "Chloe & Ryan" */
  name?: string
  /** Two-letter initials shown in the avatar circle, e.g. "CR" */
  initials?: string
  /** Email shown below the name */
  email?: string
}

/**
 * Couple portal avatar + dropdown.
 *
 * Demo: shows "Chloe & Ryan" / "CR". Sign Out clears demo cookies and
 * routes to /demo.
 */
export function CoupleUserMenu({
  name = 'Chloe & Ryan',
  initials = 'CR',
  email = 'demo@thebloomhouse.com',
}: CoupleUserMenuProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function handleSignOut() {
    // Clear demo cookies
    document.cookie = 'bloom_demo=; path=/; max-age=0'
    document.cookie = 'bloom_venue=; path=/; max-age=0'
    document.cookie = 'bloom_scope=; path=/; max-age=0'
    setOpen(false)
    router.push('/demo')
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold transition-opacity hover:opacity-90',
          'text-white'
        )}
        style={{ backgroundColor: 'var(--couple-accent, #A6894A)' }}
        aria-label="Account menu"
      >
        {initials}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-60 bg-white border border-gray-200 rounded-xl shadow-xl z-[80] overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p
              className="text-sm font-semibold truncate"
              style={{ color: 'var(--couple-primary, #7D8471)' }}
            >
              {name}
            </p>
            <p className="text-xs text-gray-500 truncate mt-0.5">{email}</p>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2.5 w-full px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      )}
    </div>
  )
}
