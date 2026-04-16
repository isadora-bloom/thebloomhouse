'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const supabase = createClient()

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email,
      {
        redirectTo: `${window.location.origin}/reset-password`,
      }
    )

    if (resetError) {
      setError(resetError.message)
      setLoading(false)
      return
    }

    setSent(true)
    setLoading(false)
  }

  return (
    <div className="w-full max-w-sm">
      <div className="bg-surface rounded-xl shadow-sm border border-border p-8">
        <div className="text-center mb-8">
          <img
            src="/brand/wordmark-black.png"
            alt="The Bloom House"
            className="h-12 w-auto mx-auto mb-4"
          />
          <p className="text-sm text-muted">
            {sent ? 'Check your email' : 'Reset your password'}
          </p>
        </div>

        {sent ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-sage-50 border border-sage-200 px-4 py-3 text-sm text-sage-800">
              If an account exists for <strong>{email}</strong>, we&apos;ve sent
              a link to reset your password. Check your inbox (and spam folder)
              for a message from The Bloom House.
            </div>
            <Link
              href="/login"
              className="block w-full rounded-lg bg-sage-500 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-sage-600 focus:outline-none focus:ring-2 focus:ring-sage-500/40 transition-colors"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-sage-700 mb-1"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full rounded-lg border border-border bg-warm-white px-3 py-2 text-sm text-sage-900 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-sage-500/40 focus:border-sage-500"
                placeholder="you@venue.com"
              />
              <p className="mt-2 text-xs text-muted">
                Enter the email on your account and we&apos;ll send you a link
                to create a new password.
              </p>
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-sage-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-sage-600 focus:outline-none focus:ring-2 focus:ring-sage-500/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Sending...' : 'Send reset link'}
            </button>

            <div className="text-center">
              <Link
                href="/login"
                className="text-xs text-sage-600 hover:text-sage-700 hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
