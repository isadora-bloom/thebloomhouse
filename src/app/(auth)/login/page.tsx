'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const supabase = createClient()

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }

    // Clear demo cookies on real sign-in
    document.cookie = 'bloom_demo=; path=/; max-age=0'

    router.push('/agent/inbox')
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
            Sign in to your venue dashboard
          </p>
        </div>

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
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-sage-700 mb-1"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full rounded-lg border border-border bg-warm-white px-3 py-2 text-sm text-sage-900 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-sage-500/40 focus:border-sage-500"
              placeholder="Enter your password"
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
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
