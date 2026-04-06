'use client'

import { useEffect } from 'react'

export default function CouplePortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[CouplePortalError]', error)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ backgroundColor: 'var(--couple-bg, #FDFAF6)' }}>
      <div className="max-w-md w-full text-center">
        <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-5">
          <svg className="w-7 h-7 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-xl font-bold mb-2" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary, #7D8471)' }}>
          Something went wrong
        </h2>
        <p className="text-sm text-gray-600 mb-6">
          We hit a snag loading this page. Please try again.
        </p>
        <button
          onClick={reset}
          className="inline-flex items-center px-5 py-2.5 rounded-lg text-white text-sm font-medium transition-colors"
          style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
        >
          Try again
        </button>
      </div>
    </div>
  )
}
