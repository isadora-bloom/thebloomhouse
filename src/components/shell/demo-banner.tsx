'use client'

import { useRouter } from 'next/navigation'
import { Eye, ArrowRight, X } from 'lucide-react'

export function DemoBanner() {
  const router = useRouter()

  function exitDemo() {
    document.cookie = 'bloom_demo=; path=/; max-age=0'
    document.cookie = 'bloom_venue=; path=/; max-age=0'
    document.cookie = 'bloom_scope=; path=/; max-age=0'
    router.push('/')
  }

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between gap-3 text-sm">
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
