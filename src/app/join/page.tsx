'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Building2,
  Lock,
  Mail,
  User,
} from 'lucide-react'
import Link from 'next/link'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InvitationData {
  id: string
  org_id: string
  venue_id: string | null
  email: string
  role: string
  status: string
  expires_at: string
  organisations: { name: string } | null
  venues: { name: string } | null
}

// ---------------------------------------------------------------------------
// Join Page
// ---------------------------------------------------------------------------

export default function JoinPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const [loading, setLoading] = useState(true)
  const [invitation, setInvitation] = useState<InvitationData | null>(null)
  const [invalidReason, setInvalidReason] = useState<string | null>(null)
  const [existingUser, setExistingUser] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [acceptLoading, setAcceptLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // New user form
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // ---------------------------------------------------------------------------
  // Validate token on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    async function validate() {
      if (!token) {
        setInvalidReason('No invitation token provided.')
        setLoading(false)
        return
      }

      try {
        const res = await fetch(`/api/team/accept?token=${token}`)
        const data = await res.json()

        if (!res.ok || data.error) {
          setInvalidReason(data.error || 'Invalid invitation.')
          setLoading(false)
          return
        }

        setInvitation(data.invitation)

        // Check if user is already logged in
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          setExistingUser(true)
        }
      } catch {
        setInvalidReason('Failed to validate invitation. Please try again.')
      }

      setLoading(false)
    }

    validate()
  }, [token])

  // ---------------------------------------------------------------------------
  // Accept: existing user (already logged in)
  // ---------------------------------------------------------------------------
  async function acceptAsExistingUser() {
    setError(null)
    setAcceptLoading(true)

    try {
      const res = await fetch('/api/team/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      const data = await res.json()

      if (!res.ok || data.error) {
        setError(data.error || 'Failed to accept invitation.')
        setAcceptLoading(false)
        return
      }

      setAccepted(true)
      // Set scope cookie to the new venue
      if (invitation) {
        const scopeData = {
          level: 'venue',
          venueId: invitation.venue_id || data.venueId,
          orgId: invitation.org_id,
          venueName: invitation.venues?.name || 'Venue',
          companyName: invitation.organisations?.name || 'Company',
        }
        document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify(scopeData))}; path=/; max-age=${60 * 60 * 24 * 365}`
      }

      setTimeout(() => router.push('/'), 2000)
    } catch {
      setError('Something went wrong. Please try again.')
    }
    setAcceptLoading(false)
  }

  // ---------------------------------------------------------------------------
  // Accept: new user (sign up + accept)
  // ---------------------------------------------------------------------------
  async function acceptAsNewUser(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!firstName.trim() || !lastName.trim()) {
      setError('Please enter your name.')
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

    setAcceptLoading(true)

    try {
      const res = await fetch('/api/team/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          password,
        }),
      })

      const data = await res.json()

      if (!res.ok || data.error) {
        setError(data.error || 'Failed to create account.')
        setAcceptLoading(false)
        return
      }

      // Sign in the new user
      const supabase = createClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: invitation!.email,
        password,
      })

      if (signInError) {
        setError(signInError.message)
        setAcceptLoading(false)
        return
      }

      // Set scope cookie
      if (invitation) {
        const scopeData = {
          level: 'venue',
          venueId: invitation.venue_id || data.venueId,
          orgId: invitation.org_id,
          venueName: invitation.venues?.name || 'Venue',
          companyName: invitation.organisations?.name || 'Company',
        }
        document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify(scopeData))}; path=/; max-age=${60 * 60 * 24 * 365}`
        document.cookie = `bloom_demo=; path=/; max-age=0`
      }

      setAccepted(true)
      setTimeout(() => router.push('/'), 2000)
    } catch {
      setError('Something went wrong. Please try again.')
    }
    setAcceptLoading(false)
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const inputClasses =
    'w-full rounded-lg border border-border bg-warm-white px-3 py-2.5 text-sm text-sage-900 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-sage-500/40 focus:border-sage-500'

  const roleLabelMap: Record<string, string> = {
    org_admin: 'Organisation Admin',
    venue_manager: 'Venue Manager',
    coordinator: 'Coordinator',
    readonly: 'Read-only',
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Loading
  if (loading) {
    return (
      <div className="min-h-screen bg-warm-white flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-sage-400 animate-spin mx-auto mb-4" />
          <p className="text-sm text-sage-600">Validating your invitation...</p>
        </div>
      </div>
    )
  }

  // Invalid or expired
  if (invalidReason) {
    return (
      <div className="min-h-screen bg-warm-white flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="bg-surface border border-border rounded-xl p-8">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <h1 className="font-heading text-xl font-bold text-sage-900 mb-2">
              Invalid Invitation
            </h1>
            <p className="text-sm text-sage-600 mb-6">{invalidReason}</p>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 border border-border rounded-lg hover:bg-sage-50 transition-colors"
            >
              Go to Login
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Success
  if (accepted) {
    return (
      <div className="min-h-screen bg-warm-white flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="bg-surface border border-border rounded-xl p-8">
            <CheckCircle2 className="w-12 h-12 text-sage-500 mx-auto mb-4" />
            <h1 className="font-heading text-xl font-bold text-sage-900 mb-2">
              Welcome aboard!
            </h1>
            <p className="text-sm text-sage-600">
              You&apos;ve joined <span className="font-semibold">{invitation?.organisations?.name}</span>.
              Redirecting you now...
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Invitation found — show accept UI
  return (
    <div className="min-h-screen bg-warm-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-surface border border-border rounded-xl p-8">
          {/* Header */}
          <div className="text-center mb-6">
            <img
              src="/brand/wordmark-black.png"
              alt="The Bloom House"
              className="h-10 w-auto mx-auto mb-4"
            />
            <div className="w-12 h-12 bg-sage-50 rounded-xl flex items-center justify-center mx-auto mb-3">
              <Building2 className="w-6 h-6 text-sage-600" />
            </div>
            <h1 className="font-heading text-xl font-bold text-sage-900">
              You&apos;ve been invited!
            </h1>
            <p className="text-sm text-sage-600 mt-2">
              Join <span className="font-semibold">{invitation?.organisations?.name}</span>
              {invitation?.venues?.name && (
                <> at <span className="font-semibold">{invitation.venues.name}</span></>
              )} as a <span className="font-semibold">{roleLabelMap[invitation?.role ?? ''] ?? invitation?.role}</span>.
            </p>
          </div>

          {/* Existing user: just accept */}
          {existingUser ? (
            <div className="space-y-4">
              <p className="text-sm text-sage-600 text-center">
                You&apos;re already signed in. Click below to accept.
              </p>

              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                onClick={acceptAsExistingUser}
                disabled={acceptLoading}
                className="w-full flex items-center justify-center gap-2 bg-sage-600 text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
              >
                {acceptLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    Accept Invitation
                  </>
                )}
              </button>
            </div>
          ) : (
            /* New user: sign up form */
            <form onSubmit={acceptAsNewUser} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">
                    First Name
                  </label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className={inputClasses}
                    placeholder="Jane"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">
                    Last Name
                  </label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className={inputClasses}
                    placeholder="Smith"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Email
                </label>
                <div className="relative">
                  <input
                    type="email"
                    value={invitation?.email ?? ''}
                    disabled
                    className={`${inputClasses} bg-sage-50 text-sage-500`}
                  />
                  <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sage-400" />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClasses}
                  placeholder="At least 8 characters"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">
                  Confirm Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputClasses}
                  placeholder="Re-enter your password"
                  required
                />
              </div>

              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={acceptLoading}
                className="w-full flex items-center justify-center gap-2 bg-sage-600 text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
              >
                {acceptLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Create Account & Join
                  </>
                )}
              </button>
            </form>
          )}

          {/* Sign in link for new users */}
          {!existingUser && (
            <p className="text-center text-sm text-sage-500 mt-5">
              Already have an account?{' '}
              <Link href={`/login?redirect=/join?token=${token}`} className="text-sage-700 font-medium hover:text-sage-900">
                Sign in first
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
