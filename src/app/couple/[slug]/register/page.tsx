'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Heart, Loader2 } from 'lucide-react'

interface VenueBranding {
  venueName: string
  logoUrl: string | null
  portalTagline: string | null
}

export default function CoupleRegisterPage() {
  const router = useRouter()
  const params = useParams<{ slug: string }>()
  const searchParams = useSearchParams()
  const slug = params?.slug || ''

  // Pre-fill event code from URL ?code=XXX
  const [eventCode, setEventCode] = useState(searchParams?.get('code') || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [branding, setBranding] = useState<VenueBranding | null>(null)
  const [success, setSuccess] = useState(false)

  // Load venue branding
  useEffect(() => {
    async function loadBranding() {
      const supabase = createClient()

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
  }, [slug])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Validation
    if (!eventCode.trim()) {
      setError('Please enter your event code.')
      return
    }
    if (!email.trim()) {
      setError('Please enter your email address.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)

    try {
      const res = await fetch('/api/couple/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          eventCode: eventCode.trim().toUpperCase(),
          slug,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Registration failed. Please try again.')
        setLoading(false)
        return
      }

      // Registration succeeded — now sign in
      const supabase = createClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

      if (signInError) {
        // Account was created but auto-sign-in failed — send them to login
        setSuccess(true)
        setLoading(false)
        return
      }

      // Clear any demo cookie
      document.cookie = 'bloom_demo=; path=/; max-age=0'

      // Redirect to the couple portal
      router.push(`/couple/${slug}`)
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  const venueName = branding?.venueName || 'Your Venue'

  // Success state — account created but couldn't auto-sign-in
  if (success) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-4"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 6%, white)',
        }}
      >
        <div className="w-full max-w-md">
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 sm:p-10 text-center">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center text-white mx-auto mb-6"
              style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
            >
              <Heart className="w-8 h-8" />
            </div>
            <h1
              className="text-2xl font-bold mb-3"
              style={{
                fontFamily: 'var(--couple-font-heading, serif)',
                color: 'var(--couple-primary, #7D8471)',
              }}
            >
              Account Created!
            </h1>
            <p className="text-gray-600 mb-6">
              Your account has been set up. Please sign in to access your wedding portal.
            </p>
            <a
              href={`/couple/${slug}/login`}
              className="inline-block w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
              style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
            >
              Go to Sign In
            </a>
          </div>
        </div>
      </div>
    )
  }

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

            <p
              className="mt-2 text-center text-sm text-gray-500"
              style={{ fontFamily: 'var(--couple-font-body, sans-serif)' }}
            >
              Welcome! Let&apos;s set up your account.
            </p>
          </div>

          {/* Registration form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Event Code */}
            <div>
              <label
                htmlFor="event-code"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Event Code
              </label>
              <input
                id="event-code"
                type="text"
                value={eventCode}
                onChange={(e) => setEventCode(e.target.value.toUpperCase())}
                required
                autoComplete="off"
                className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-shadow font-mono tracking-wider text-center text-lg"
                style={{
                  // Dynamic focus ring using venue primary color
                }}
                onFocus={(e) => {
                  e.currentTarget.style.boxShadow = `0 0 0 2px color-mix(in srgb, var(--couple-primary, #7D8471) 30%, transparent)`
                  e.currentTarget.style.borderColor = 'var(--couple-primary, #7D8471)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.boxShadow = 'none'
                  e.currentTarget.style.borderColor = '#e5e7eb'
                }}
                placeholder="HWM-482"
              />
              <p className="mt-1 text-xs text-gray-400">
                This was included in your invitation email from your coordinator.
              </p>
            </div>

            {/* Email */}
            <div>
              <label
                htmlFor="register-email"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Email
              </label>
              <input
                id="register-email"
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

            {/* Password */}
            <div>
              <label
                htmlFor="register-password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Password
              </label>
              <input
                id="register-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-shadow"
                onFocus={(e) => {
                  e.currentTarget.style.boxShadow = `0 0 0 2px color-mix(in srgb, var(--couple-primary, #7D8471) 30%, transparent)`
                  e.currentTarget.style.borderColor = 'var(--couple-primary, #7D8471)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.boxShadow = 'none'
                  e.currentTarget.style.borderColor = '#e5e7eb'
                }}
                placeholder="At least 8 characters"
              />
            </div>

            {/* Confirm Password */}
            <div>
              <label
                htmlFor="register-confirm-password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Confirm Password
              </label>
              <input
                id="register-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent transition-shadow"
                onFocus={(e) => {
                  e.currentTarget.style.boxShadow = `0 0 0 2px color-mix(in srgb, var(--couple-primary, #7D8471) 30%, transparent)`
                  e.currentTarget.style.borderColor = 'var(--couple-primary, #7D8471)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.boxShadow = 'none'
                  e.currentTarget.style.borderColor = '#e5e7eb'
                }}
                placeholder="Re-enter your password"
              />
            </div>

            {/* Error message */}
            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating your account...
                </span>
              ) : (
                'Create Account'
              )}
            </button>
          </form>

          {/* Sign in link */}
          <div className="mt-5 text-center">
            <p className="text-sm text-gray-500">
              Already have an account?{' '}
              <a
                href={`/couple/${slug}/login`}
                className="font-medium transition-colors hover:underline"
                style={{ color: 'var(--couple-secondary, #5D7A7A)' }}
              >
                Sign in
              </a>
            </p>
          </div>
        </div>

        {/* Powered by footer */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-400 mb-1">Powered by</p>
          <img
            src="/brand/wordmark-sage-sm.png"
            alt="The Bloom House"
            className="h-5 w-auto mx-auto opacity-60"
          />
        </div>
      </div>
    </div>
  )
}
