'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Heart } from 'lucide-react'

interface VenueBranding {
  venueName: string
  logoUrl: string | null
  portalTagline: string | null
}

export default function CoupleLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [branding, setBranding] = useState<VenueBranding | null>(null)

  // Load venue branding from the CSS custom properties set by the couple layout
  useEffect(() => {
    async function loadBranding() {
      const supabase = createClient()

      // Try to determine venue slug from URL or cookie
      const params = new URLSearchParams(window.location.search)
      const slug = params.get('venue') || 'rixey-manor'

      const { data: venue } = await supabase
        .from('venues')
        .select('id, name, slug')
        .eq('slug', slug)
        .single()

      if (!venue) {
        setBranding({
          venueName: 'Wedding Portal',
          logoUrl: null,
          portalTagline: null,
        })
        return
      }

      const { data: config } = await supabase
        .from('venue_config')
        .select('business_name, logo_url, portal_tagline')
        .eq('venue_id', venue.id)
        .single()

      setBranding({
        venueName: config?.business_name || venue.name,
        logoUrl: config?.logo_url || null,
        portalTagline: config?.portal_tagline || null,
      })
    }

    loadBranding()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const supabase = createClient()

    const { data: authData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }

    // Verify this user has a couple role
    if (authData.user) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', authData.user.id)
        .single()

      if (profile?.role !== 'couple') {
        await supabase.auth.signOut()
        setError('This login is for couples only. If you are a coordinator, please use the main login.')
        setLoading(false)
        return
      }
    }

    // Redirect to couple dashboard
    router.push('/')
    router.refresh()
  }

  const venueName = branding?.venueName || 'Your Venue'

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 6%, white)',
      }}
    >
      <div className="w-full max-w-md">
        {/* Venue branding card */}
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 sm:p-10">
          {/* Logo / Venue initial */}
          <div className="flex flex-col items-center mb-8">
            {branding?.logoUrl ? (
              <img
                src={branding.logoUrl}
                alt={venueName}
                className="h-16 w-auto mb-4"
              />
            ) : (
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl font-bold mb-4"
                style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
              >
                {venueName.charAt(0)}
              </div>
            )}

            <h1
              className="text-2xl sm:text-3xl font-bold text-center"
              style={{
                fontFamily: 'var(--couple-font-heading, serif)',
                color: 'var(--couple-primary, #7D8471)',
              }}
            >
              {venueName}
            </h1>

            {branding?.portalTagline && (
              <p
                className="mt-2 text-center text-sm"
                style={{
                  fontFamily: 'var(--couple-font-body, sans-serif)',
                  color: 'var(--couple-secondary, #5D7A7A)',
                }}
              >
                {branding.portalTagline}
              </p>
            )}

            {!branding?.portalTagline && (
              <p
                className="mt-2 text-center text-sm text-gray-500"
                style={{ fontFamily: 'var(--couple-font-body, sans-serif)' }}
              >
                Sign in to your wedding portal
              </p>
            )}
          </div>

          {/* Login form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="couple-email"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Email
              </label>
              <input
                id="couple-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-shadow"
                onFocus={(e) => {
                  e.currentTarget.style.boxShadow = `0 0 0 2px color-mix(in srgb, var(--couple-primary, #7D8471) 30%, transparent)`
                  e.currentTarget.style.borderColor = 'var(--couple-primary, #7D8471)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.boxShadow = 'none'
                  e.currentTarget.style.borderColor = '#e5e7eb'
                }}
                placeholder="your@email.com"
              />
            </div>

            <div>
              <label
                htmlFor="couple-password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Password
              </label>
              <input
                id="couple-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-shadow"
                onFocus={(e) => {
                  e.currentTarget.style.boxShadow = `0 0 0 2px color-mix(in srgb, var(--couple-primary, #7D8471) 30%, transparent)`
                  e.currentTarget.style.borderColor = 'var(--couple-primary, #7D8471)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.boxShadow = 'none'
                  e.currentTarget.style.borderColor = '#e5e7eb'
                }}
                placeholder="Enter your password"
              />
            </div>

            {/* Error message */}
            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {/* Sign in button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                backgroundColor: 'var(--couple-primary, #7D8471)',
              }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12" cy="12" r="10"
                      stroke="currentColor" strokeWidth="4" fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Signing in...
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          {/* Forgot password */}
          <div className="mt-5 text-center">
            <button
              type="button"
              className="text-sm transition-colors hover:underline"
              style={{ color: 'var(--couple-secondary, #5D7A7A)' }}
              onClick={() => {
                // TODO: Implement password reset flow
                alert('Password reset coming soon. Please contact your coordinator.')
              }}
            >
              Forgot your password?
            </button>
          </div>
        </div>

        {/* Powered by footer */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-400 mb-1">Powered by</p>
          <img src="/brand/wordmark-sage-sm.png" alt="The Bloom House" className="h-5 w-auto mx-auto opacity-60" />
        </div>
      </div>
    </div>
  )
}
