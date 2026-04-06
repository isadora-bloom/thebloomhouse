'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function PlatformError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  useEffect(() => {
    console.error('[PlatformError]', error)
  }, [error])

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md w-full text-center">
        <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-5">
          <svg className="w-7 h-7 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="font-heading text-xl font-bold text-sage-900 mb-2">
          Page Error
        </h2>
        <p className="text-sage-600 text-sm mb-6">
          This page encountered an error. You can try again or go back to the dashboard.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg bg-sage-600 text-white text-sm font-medium hover:bg-sage-700 transition-colors"
          >
            Try again
          </button>
          <button
            onClick={() => router.push('/intel/dashboard')}
            className="px-4 py-2 rounded-lg border border-sage-200 text-sage-700 text-sm font-medium hover:bg-sage-50 transition-colors"
          >
            Dashboard
          </button>
        </div>
      </div>
    </div>
  )
}
