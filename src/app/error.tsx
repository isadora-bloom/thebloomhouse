'use client'

import { useEffect } from 'react'

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[RootError]', error)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center bg-warm-white px-4">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="font-heading text-2xl font-bold text-sage-900 mb-2">
          Something went wrong
        </h1>
        <p className="text-sage-600 text-sm mb-6">
          An unexpected error occurred. Please try again.
        </p>
        <button
          onClick={reset}
          className="inline-flex items-center px-5 py-2.5 rounded-lg bg-sage-600 text-white text-sm font-medium hover:bg-sage-700 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
