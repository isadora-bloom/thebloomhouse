'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { clearDemoCookiesClientSide } from '@/lib/demo-cookies'

/**
 * Couple password reset, step two.
 *
 * Landed on from the recovery email. Supabase parses the #access_token
 * fragment on load and fires PASSWORD_RECOVERY; we wait for that (or for
 * an existing session, in case the event fired before we subscribed)
 * before offering the form.
 *
 * Venue-branded, and it finishes inside the couple's own portal rather
 * than at the platform root the way the coordinator page does.
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

export default function CoupleResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [isRecovery, setIsRecovery] = useState(false)
  const [ready, setReady] = useState(false)
  const [slug, setSlug] = useState('')
  const [branding, setBranding] = useState<VenueBranding | null>(null)

  useEffect(() => {
    setSlug(getSlug())
  }, [])

  useEffect(() => {
    const supabase = createClient()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsRecovery(true)
        setReady(true)
      }
    })

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setIsRecovery(true)
      setReady(true)
    })

    return () => {
      subscription.unsubscribe()
    }
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
        console.warn('[couple reset-password] branding load failed:', err)
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
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    // Clear demo cookies so a real session takes over (middleware also
    // clears server-side; this is belt-and-braces).
    clearDemoCookiesClientSide()

    router.push(base || '/')
    router.refresh()
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
              Set a new password
            </p>
          </div>

          {!ready ? (
            <div className="text-center text-sm text-gray-500 py-4">
              Checking your reset link...
            </div>
          ) : !isRecovery ? (
            <div className="space-y-4">
              <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                This reset link is invalid or has expired. Ask for a new one and
                use the most recent email.
              </div>
              <a
                href={`${base}/forgot-password`}
                className="block w-full rounded-xl px-4 py-3 text-center text-sm font-semibold text-white transition-all hover:opacity-90"
                style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
              >
                Request a new link
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="couple-new-password"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  New password
                </label>
                <input
                  id="couple-new-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
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

              <div>
                <label
                  htmlFor="couple-confirm-new-password"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Confirm new password
                </label>
                <input
                  id="couple-confirm-new-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
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
                  placeholder="Re-enter your new password"
                />
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
                {loading ? 'Updating...' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
