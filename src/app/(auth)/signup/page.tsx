'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { User, Lock, Mail, ArrowRight } from 'lucide-react'
import Link from 'next/link'

type Role = 'coordinator' | 'couple'

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [role, setRole] = useState<Role>('coordinator')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Validation
    if (!firstName.trim()) {
      setError('First name is required.')
      return
    }
    if (!lastName.trim()) {
      setError('Last name is required.')
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

    const supabase = createClient()

    // 1. Create auth user
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          role,
        },
      },
    })

    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
      return
    }

    // 2. Insert user profile
    if (authData.user) {
      const { error: profileError } = await supabase.from('user_profiles').insert({
        id: authData.user.id,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        role,
      })

      if (profileError) {
        console.error('Failed to create user profile:', profileError)
        // Don't block signup — auth user was created, profile can be retried
      }
    }

    // Clear demo cookies on real sign-up
    document.cookie = 'bloom_demo=; path=/; max-age=0'

    // 3. Redirect based on role
    if (role === 'coordinator') {
      router.push('/agent/inbox')
    } else {
      router.push('/')
    }
  }

  const inputClasses =
    'w-full rounded-lg border border-border bg-warm-white px-3 py-2 text-sm text-sage-900 placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-sage-500/40 focus:border-sage-500'

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
            Create your account
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name Row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="firstName"
                className="block text-sm font-medium text-sage-700 mb-1"
              >
                First Name
              </label>
              <input
                id="firstName"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                autoComplete="given-name"
                className={inputClasses}
                placeholder="Jane"
              />
            </div>
            <div>
              <label
                htmlFor="lastName"
                className="block text-sm font-medium text-sage-700 mb-1"
              >
                Last Name
              </label>
              <input
                id="lastName"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                autoComplete="family-name"
                className={inputClasses}
                placeholder="Smith"
              />
            </div>
          </div>

          {/* Email */}
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
              className={inputClasses}
              placeholder="you@venue.com"
            />
          </div>

          {/* Password */}
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
              autoComplete="new-password"
              className={inputClasses}
              placeholder="At least 8 characters"
            />
          </div>

          {/* Confirm Password */}
          <div>
            <label
              htmlFor="confirmPassword"
              className="block text-sm font-medium text-sage-700 mb-1"
            >
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              className={inputClasses}
              placeholder="Re-enter your password"
            />
          </div>

          {/* Role Selector */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-2">
              I am a...
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setRole('coordinator')}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-all text-center ${
                  role === 'coordinator'
                    ? 'border-sage-500 bg-sage-50'
                    : 'border-border hover:border-sage-300'
                }`}
              >
                <User className={`w-5 h-5 ${role === 'coordinator' ? 'text-sage-600' : 'text-sage-400'}`} />
                <span className={`text-sm font-medium ${role === 'coordinator' ? 'text-sage-900' : 'text-sage-600'}`}>
                  Coordinator
                </span>
                <span className="text-[10px] text-sage-400 leading-tight">Venue staff</span>
              </button>
              <button
                type="button"
                onClick={() => setRole('couple')}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-all text-center ${
                  role === 'couple'
                    ? 'border-sage-500 bg-sage-50'
                    : 'border-border hover:border-sage-300'
                }`}
              >
                <User className={`w-5 h-5 ${role === 'couple' ? 'text-sage-600' : 'text-sage-400'}`} />
                <span className={`text-sm font-medium ${role === 'couple' ? 'text-sage-900' : 'text-sage-600'}`}>
                  Couple
                </span>
                <span className="text-[10px] text-sage-400 leading-tight">Getting married</span>
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-sage-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-sage-600 focus:outline-none focus:ring-2 focus:ring-sage-500/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        {/* Sign in link */}
        <p className="text-center text-sm text-sage-500 mt-6">
          Already have an account?{' '}
          <Link
            href="/login"
            className="text-sage-700 font-medium hover:text-sage-900 transition-colors"
          >
            Log in
          </Link>
        </p>
      </div>
    </div>
  )
}
