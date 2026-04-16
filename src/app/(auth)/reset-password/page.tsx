'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [isRecovery, setIsRecovery] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const supabase = createClient()

    // Supabase parses the #access_token fragment automatically and fires
    // PASSWORD_RECOVERY when the user lands here from a recovery email link.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsRecovery(true)
        setReady(true)
      }
    })

    // Fallback: if there's already a session (user clicked link and the
    // event fired before we subscribed), allow them to proceed.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setIsRecovery(true)
      }
      setReady(true)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)

    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({
      password,
    })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    // Clear demo cookie so a real session takes over
    document.cookie = 'bloom_demo=; path=/; max-age=0'

    router.push('/')
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
          <p className="text-sm text-muted">Set a new password</p>
        </div>

        {!ready ? (
          <div className="text-center text-sm text-muted py-4">
            Verifying reset link...
          </div>
        ) : !isRecovery ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              This reset link is invalid or has expired. Please request a new
              one.
            </div>
            <Link
              href="/forgot-password"
              className="block w-full rounded-lg bg-sage-500 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-sage-600 focus:outline-none focus:ring-2 focus:ring-sage-500/40 transition-colors"
            >
              Request new link
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-sage-700 mb-1"
              >
                New password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-warm-white px-3 py-2 text-sm text-sage-900 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-sage-500/40 focus:border-sage-500"
                placeholder="At least 8 characters"
              />
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-sage-700 mb-1"
              >
                Confirm new password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full rounded-lg border border-border bg-warm-white px-3 py-2 text-sm text-sage-900 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-sage-500/40 focus:border-sage-500"
                placeholder="Re-enter your new password"
              />
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
              {loading ? 'Updating...' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
