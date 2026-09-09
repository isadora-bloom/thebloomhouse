'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Couple password reset, step one.
 *
 * The coordinator flow at /(auth)/forgot-password exists but is Bloom
 * branded and sends people back to the platform root, so pointing a
 * couple at it would both break white-label and drop them somewhere they
 * cannot use. This is the same Supabase call wearing the venue's colours,
 * returning to the venue's own reset page.
 *
 * Until W1 (2026-09-08) the login page's "Forgot your password?" was a
 * TODO and a browser alert, so a locked-out couple had to ring the venue.
 */

function getSlug(): string {
  if (typeof window === 'undefined') return ''
  const parts = window.location.pathname.split('/')
  const coupleIdx = parts.indexOf('couple')
  if (coupleIdx >= 0 && parts[coupleIdx + 1]) return parts[coupleIdx + 1]
  return new URLSearchParams(window.location.search).get('venue')?.trim() || ''
}

interface VenueBranding {
  venueName: string
  logoUrl: string | null
}

export default function CoupleForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [slug, setSlug] = useState('')
  const [branding, setBranding] = useState<VenueBranding | null>(null)

  useEffect(() => {
    setSlug(getSlug())
  }, [])

  useEffect(() => {
    async function loadBranding() {
      try {
        const resolved = getSlug()
        if (!resolved) {
          setBranding({ venueName: 'Wedding Portal', logoUrl: null })
          return
        }
        const supabase = createClient()
        const { data: venue } = await supabase
          .from('venues')
          .select('id, name')
          .eq('slug', resolved)
          .single()
        if (!venue) {
          setBranding({ venueName: 'Wedding Portal', logoUrl: null })
          return
        }
        const { data: config } = await supabase
          .from('venue_config')
          .select('business_name, logo_url')
          .eq('venue_id', venue.id)
          .single()
        setBranding({
          venueName: config?.business_name || venue.name,
          logoUrl: config?.logo_url || null,
        })
      } catch (err) {
        console.warn('[couple forgot-password] branding load failed:', err)
        setBranding({ venueName: 'Wedding Portal', logoUrl: null })
      }
    }
    loadBranding()
  }, [])

  const base = slug ? `/couple/${slug}` : ''
  const venueName = branding?.venueName || 'Your Venue'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const supabase = createClient()
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      { redirectTo: `${window.location.origin}${base}/reset-password` }
    )

    if (resetError) {
      setError(resetError.message)
      setLoading(false)
      return
    }

    // Always the same confirmation, whether or not the address is on file.
    // Telling a stranger which of a venue's couples have accounts is not
    // a trade worth making for slightly clearer copy.
    setSent(true)
    setLoading(false)
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 6%, white)',
      }}
    >
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 sm:p-10">
          <div className="flex flex-col items-center mb-8">
            {branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={venueName} className="h-16 w-auto mb-4" />
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
              {sent ? 'Check your email' : 'Reset your password'}
            </p>
          </div>

          {sent ? (
            <div className="space-y-4">
              <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-700">
                If an account exists for <strong>{email.trim()}</strong>, a link
                to set a new password is on its way. It can take a minute, and
                it is worth a look in your spam folder.
              </div>
              <a
                href={`${base}/login`}
                className="block w-full rounded-xl px-4 py-3 text-center text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
              >
                Back to sign in
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="couple-forgot-email"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Email
                </label>
                <input
                  id="couple-forgot-email"
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
                <p className="mt-1 text-xs text-gray-400">
                  The address you sign in with.
                </p>
              </div>

              {error && (
                <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
              >
                {loading ? 'Sending...' : 'Send reset link'}
              </button>

              <div className="text-center">
                <a
                  href={`${base}/login`}
                  className="text-sm transition-colors hover:underline"
                  style={{ color: 'var(--couple-secondary, #5D7A7A)' }}
                >
                  Back to sign in
                </a>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
