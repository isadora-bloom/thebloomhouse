'use client'

import { useRouter } from 'next/navigation'
import { Eye, ArrowRight, X } from 'lucide-react'

/**
 * Fixed banner at the very top of the page during demo mode.
 * Height: h-10 (2.5rem / 40px). All other fixed elements (sidebar, mobile header)
 * must offset by top-10 when demo is active.
 */
export function DemoBanner() {
  const router = useRouter()

  function exitDemo() {
    document.cookie = 'bloom_demo=; path=/; max-age=0'
    document.cookie = 'bloom_venue=; path=/; max-age=0'
    document.cookie = 'bloom_scope=; path=/; max-age=0'
    router.push('/')
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] h-10 bg-amber-50 border-b border-amber-200 px-4 flex items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 text-amber-800">
        <Eye className="w-4 h-4 shrink-0" />
        <span className="font-medium">Demo Mode</span>
        <span className="hidden sm:inline text-amber-600">
          — You&apos;re viewing sample data. Nothing here is real.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <a
          href="/signup"
          className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1 bg-amber-600 text-white rounded-md text-xs font-medium hover:bg-amber-700 transition-colors"
        >
          Sign Up
          <ArrowRight className="w-3 h-3" />
        </a>
        <button
          onClick={exitDemo}
          className="p-1 text-amber-600 hover:text-amber-800 transition-colors"
          aria-label="Exit demo"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
