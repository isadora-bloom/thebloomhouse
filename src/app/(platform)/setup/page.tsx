'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Building2,
  MapPin,
  Users,
  ArrowRight,
  ArrowLeft,
  Check,
  Plus,
  Trash2,
  Loader2,
  SkipForward,
  Sparkles,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VenueType = 'single' | 'multi'
type PriceRange = 'budget' | 'mid' | 'premium' | 'luxury'

interface TeamMember {
  id: string
  name: string
  email: string
  role: 'venue_manager' | 'coordinator' | 'readonly'
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRICE_RANGES: { value: PriceRange; label: string; description: string }[] = [
  { value: 'budget', label: 'Budget', description: 'Under $5,000' },
  { value: 'mid', label: 'Mid-Range', description: '$5,000 - $15,000' },
  { value: 'premium', label: 'Premium', description: '$15,000 - $40,000' },
  { value: 'luxury', label: 'Luxury', description: '$40,000+' },
]

const ROLE_OPTIONS: { value: TeamMember['role']; label: string; description: string }[] = [
  { value: 'venue_manager', label: 'Lead Coordinator', description: 'Manages venue operations' },
  { value: 'coordinator', label: 'Coordinator', description: 'Handles inquiries and events' },
  { value: 'readonly', label: 'Read-only', description: 'View-only access' },
]

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2.5 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

const selectClasses =
  'w-full border border-border rounded-lg px-3 py-2.5 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Setup Wizard
// ---------------------------------------------------------------------------

export default function SetupPage() {
  const router = useRouter()
  const [step, setStep] = useState(1) // 1=company, 2=venue, 3=team
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Auth state
  const [orgId, setOrgId] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [userName, setUserName] = useState<string>('')

  // Step 1: Company
  const [companyName, setCompanyName] = useState('')
  const [venueType, setVenueType] = useState<VenueType>('single')
  const [venueCount, setVenueCount] = useState(1)

  // Step 2: First venue
  const [venueName, setVenueName] = useState('')
  const [venueCity, setVenueCity] = useState('')
  const [venueState, setVenueState] = useState('')
  const [venueCapacity, setVenueCapacity] = useState('')
  const [venuePriceRange, setVenuePriceRange] = useState<PriceRange>('mid')
  const [createdVenueId, setCreatedVenueId] = useState<string | null>(null)

  // Step 3: Team
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])

  // ---------------------------------------------------------------------------
  // Resolve auth user + org on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    async function resolve() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }

      setUserId(user.id)
      setUserName(user.user_metadata?.full_name || '')

      // Get the user's org
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('org_id, venue_id')
        .eq('id', user.id)
        .maybeSingle()

      if (!profile?.org_id) {
        // Shouldn't happen — signup creates org, but handle gracefully
        router.push('/login')
        return
      }

      setOrgId(profile.org_id as string)

      // If user already has a venue_id, they've already done setup — skip to onboarding
      if (profile.venue_id) {
        router.push('/onboarding')
        return
      }

      // Pre-fill company name from org
      const { data: org } = await supabase
        .from('organisations')
        .select('name')
        .eq('id', profile.org_id as string)
        .single()

      if (org?.name) {
        setCompanyName(org.name as string)
      }
    }

    resolve()
  }, [router])

  // ---------------------------------------------------------------------------
  // Step 1: Save company name
  // ---------------------------------------------------------------------------
  async function saveCompany() {
    if (!companyName.trim()) {
      setError('Please enter your company name.')
      return
    }
    setError(null)
    setLoading(true)

    try {
      const supabase = createClient()
      const { error: updateError } = await supabase
        .from('organisations')
        .update({ name: companyName.trim() })
        .eq('id', orgId!)

      if (updateError) {
        setError('Failed to update company name.')
        setLoading(false)
        return
      }

      setStep(2)
    } catch {
      setError('Something went wrong. Please try again.')
    }
    setLoading(false)
  }

  // ---------------------------------------------------------------------------
  // Step 2: Create first venue
  // ---------------------------------------------------------------------------
  async function createVenue() {
    if (!venueName.trim()) {
      setError('Please enter your venue name.')
      return
    }
    if (!venueCity.trim() || !venueState) {
      setError('Please enter the city and state.')
      return
    }
    setError(null)
    setLoading(true)

    try {
      const supabase = createClient()

      // Generate slug from venue name
      const slug = venueName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

      // Map price range to approximate base_price for venue_config
      const priceMap: Record<PriceRange, number> = {
        budget: 3000,
        mid: 10000,
        premium: 25000,
        luxury: 50000,
      }

      // 1. Create the venue (capacity/base_price live on venue_config, not venues)
      const { data: venue, error: venueError } = await supabase
        .from('venues')
        .insert({
          name: venueName.trim(),
          slug,
          org_id: orgId!,
          status: 'trial',
          is_demo: false,
          city: venueCity.trim(),
          state: venueState,
        })
        .select('id')
        .single()

      if (venueError) {
        console.error('Failed to create venue:', venueError)
        setError('Failed to create venue. The name might already be taken.')
        setLoading(false)
        return
      }

      // 2. Create venue_config
      const { error: configError } = await supabase.from('venue_config').insert({
        venue_id: venue.id,
        business_name: venueName.trim(),
        timezone: 'America/New_York',
        capacity: venueCapacity ? parseInt(venueCapacity) : null,
        base_price: priceMap[venuePriceRange],
        onboarding_completed: false,
      })

      if (configError) {
        console.error('Failed to create venue_config:', configError)
      }

      // 3. Update user_profile with venue_id
      const { error: profileError } = await supabase
        .from('user_profiles')
        .update({ venue_id: venue.id })
        .eq('id', userId!)

      if (profileError) {
        console.error('Failed to update user_profile:', profileError)
      }

      // 4. Set the scope cookie so the rest of the app knows which venue
      const scopeData = {
        level: 'venue',
        venueId: venue.id,
        orgId: orgId!,
        venueName: venueName.trim(),
        companyName: companyName.trim(),
      }
      document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify(scopeData))}; path=/; max-age=${60 * 60 * 24 * 365}`
      document.cookie = `bloom_venue=${venue.id}; path=/; max-age=${60 * 60 * 24 * 365}`

      setCreatedVenueId(venue.id)
      setStep(3)
    } catch {
      setError('Something went wrong. Please try again.')
    }
    setLoading(false)
  }

  // ---------------------------------------------------------------------------
  // Step 3: Invite team & finish
  // ---------------------------------------------------------------------------
  function addTeamMember() {
    setTeamMembers([
      ...teamMembers,
      { id: crypto.randomUUID(), name: '', email: '', role: 'coordinator' },
    ])
  }

  function removeTeamMember(id: string) {
    setTeamMembers(teamMembers.filter((m) => m.id !== id))
  }

  function updateTeamMember(id: string, field: keyof TeamMember, value: string) {
    setTeamMembers(teamMembers.map((m) =>
      m.id === id ? { ...m, [field]: value } : m
    ))
  }

  async function sendInvitations() {
    setError(null)
    setLoading(true)

    try {
      // Filter out empty rows
      const validMembers = teamMembers.filter(
        (m) => m.email.trim() && m.name.trim()
      )

      for (const member of validMembers) {
        const res = await fetch('/api/team/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: member.email.trim(),
            role: member.role,
            venueId: createdVenueId,
            orgId: orgId!,
          }),
        })

        const data = await res.json()
        if (!res.ok) {
          console.warn(`Failed to invite ${member.email}: ${data.error}`)
        }
      }

      // Navigate to onboarding (venue voice, KB, Gmail setup)
      router.push('/onboarding')
    } catch {
      setError('Some invitations may have failed. You can resend them from Settings.')
      // Still proceed
      setTimeout(() => router.push('/onboarding'), 2000)
    }
    setLoading(false)
  }

  function skipTeam() {
    router.push('/onboarding')
  }

  // ---------------------------------------------------------------------------
  // Progress bar
  // ---------------------------------------------------------------------------
  const steps = [
    { num: 1, label: 'Your Company', icon: Building2 },
    { num: 2, label: 'First Venue', icon: MapPin },
    { num: 3, label: 'Your Team', icon: Users },
  ]

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (!orgId) {
    return (
      <div className="min-h-screen bg-warm-white flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-sage-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-warm-white">
      {/* Header */}
      <div className="border-b border-border bg-surface">
        <div className="max-w-2xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/brand/wordmark-sage.png" alt="The Bloom House" className="h-8 w-auto" />
          </div>
          <p className="text-sm text-muted">Setting up your account</p>
        </div>
      </div>

      {/* Progress */}
      <div className="max-w-2xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-8">
          {steps.map((s, i) => {
            const Icon = s.icon
            const isActive = step === s.num
            const isDone = step > s.num
            return (
              <div key={s.num} className="flex items-center flex-1">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${
                      isDone
                        ? 'bg-sage-600 text-white'
                        : isActive
                          ? 'bg-sage-100 text-sage-700 ring-2 ring-sage-400'
                          : 'bg-sage-50 text-sage-400'
                    }`}
                  >
                    {isDone ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <Icon className="w-4 h-4" />
                    )}
                  </div>
                  <span
                    className={`text-sm font-medium hidden sm:inline ${
                      isActive ? 'text-sage-800' : isDone ? 'text-sage-600' : 'text-sage-400'
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={`flex-1 h-px mx-3 ${
                      step > s.num ? 'bg-sage-400' : 'bg-sage-200'
                    }`}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Step 1: Company */}
        {step === 1 && (
          <div className="bg-surface border border-border rounded-xl p-8">
            <div className="text-center mb-8">
              <div className="w-14 h-14 bg-sage-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Building2 className="w-7 h-7 text-sage-600" />
              </div>
              <h1 className="font-heading text-2xl font-bold text-sage-900">
                Name your company
              </h1>
              <p className="text-sage-600 mt-2 text-sm">
                This is the brand name that appears in reports and for your team.
              </p>
            </div>

            <div className="space-y-6 max-w-md mx-auto">
              {/* Company name */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Company / Brand Name
                </label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className={inputClasses}
                  placeholder="e.g. The Crestwood Collection"
                  autoFocus
                />
              </div>

              {/* Single vs multi */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-2">
                  How many venues do you operate?
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setVenueType('single')}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      venueType === 'single'
                        ? 'border-sage-500 bg-sage-50'
                        : 'border-border hover:border-sage-300'
                    }`}
                  >
                    <MapPin className={`w-5 h-5 mb-2 ${venueType === 'single' ? 'text-sage-600' : 'text-sage-400'}`} />
                    <p className={`text-sm font-semibold ${venueType === 'single' ? 'text-sage-900' : 'text-sage-700'}`}>
                      Single venue
                    </p>
                    <p className="text-xs text-sage-500 mt-1">Just one property</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setVenueType('multi')}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      venueType === 'multi'
                        ? 'border-sage-500 bg-sage-50'
                        : 'border-border hover:border-sage-300'
                    }`}
                  >
                    <Building2 className={`w-5 h-5 mb-2 ${venueType === 'multi' ? 'text-sage-600' : 'text-sage-400'}`} />
                    <p className={`text-sm font-semibold ${venueType === 'multi' ? 'text-sage-900' : 'text-sage-700'}`}>
                      Multiple venues
                    </p>
                    <p className="text-xs text-sage-500 mt-1">A portfolio of properties</p>
                  </button>
                </div>
              </div>

              {/* Venue count (only for multi) */}
              {venueType === 'multi' && (
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1.5">
                    How many venues? (approximate)
                  </label>
                  <input
                    type="number"
                    min={2}
                    max={100}
                    value={venueCount}
                    onChange={(e) => setVenueCount(parseInt(e.target.value) || 2)}
                    className={inputClasses}
                  />
                  <p className="text-xs text-sage-500 mt-1">
                    You&apos;ll set up your first venue next, then add more later.
                  </p>
                </div>
              )}

              {/* Continue */}
              <button
                onClick={saveCompany}
                disabled={loading || !companyName.trim()}
                className="w-full flex items-center justify-center gap-2 bg-sage-600 text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Continue
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: First venue */}
        {step === 2 && (
          <div className="bg-surface border border-border rounded-xl p-8">
            <div className="text-center mb-8">
              <div className="w-14 h-14 bg-sage-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <MapPin className="w-7 h-7 text-sage-600" />
              </div>
              <h1 className="font-heading text-2xl font-bold text-sage-900">
                Add your first venue
              </h1>
              <p className="text-sage-600 mt-2 text-sm">
                We&apos;ll configure Bloom&apos;s AI voice and knowledge base for this venue next.
              </p>
            </div>

            <div className="space-y-5 max-w-md mx-auto">
              {/* Venue name */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Venue Name
                </label>
                <input
                  type="text"
                  value={venueName}
                  onChange={(e) => setVenueName(e.target.value)}
                  className={inputClasses}
                  placeholder="e.g. Hawthorne Manor"
                  autoFocus
                />
              </div>

              {/* City + State */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-sage-700 mb-1.5">
                    City
                  </label>
                  <input
                    type="text"
                    value={venueCity}
                    onChange={(e) => setVenueCity(e.target.value)}
                    className={inputClasses}
                    placeholder="Richmond"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1.5">
                    State
                  </label>
                  <select
                    value={venueState}
                    onChange={(e) => setVenueState(e.target.value)}
                    className={selectClasses}
                  >
                    <option value="">--</option>
                    {US_STATES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Capacity */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Max Guest Capacity
                </label>
                <input
                  type="number"
                  min={1}
                  value={venueCapacity}
                  onChange={(e) => setVenueCapacity(e.target.value)}
                  className={inputClasses}
                  placeholder="200"
                />
              </div>

              {/* Price range */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-2">
                  Price Range
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {PRICE_RANGES.map((pr) => (
                    <button
                      key={pr.value}
                      type="button"
                      onClick={() => setVenuePriceRange(pr.value)}
                      className={`p-3 rounded-lg border-2 text-left transition-all ${
                        venuePriceRange === pr.value
                          ? 'border-sage-500 bg-sage-50'
                          : 'border-border hover:border-sage-300'
                      }`}
                    >
                      <p className={`text-sm font-semibold ${
                        venuePriceRange === pr.value ? 'text-sage-900' : 'text-sage-700'
                      }`}>
                        {pr.label}
                      </p>
                      <p className="text-xs text-sage-500">{pr.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Buttons */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setStep(1)}
                  className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-sage-600 hover:text-sage-800 border border-border rounded-lg hover:bg-sage-50 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
                <button
                  onClick={createVenue}
                  disabled={loading || !venueName.trim() || !venueCity.trim() || !venueState}
                  className="flex-1 flex items-center justify-center gap-2 bg-sage-600 text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      Create Venue
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Team */}
        {step === 3 && (
          <div className="bg-surface border border-border rounded-xl p-8">
            <div className="text-center mb-8">
              <div className="w-14 h-14 bg-sage-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Users className="w-7 h-7 text-sage-600" />
              </div>
              <h1 className="font-heading text-2xl font-bold text-sage-900">
                Invite your team
              </h1>
              <p className="text-sage-600 mt-2 text-sm">
                Who else works at <span className="font-semibold">{venueName || 'your venue'}</span>?
                They&apos;ll get an email invite to join.
              </p>
            </div>

            <div className="space-y-4 max-w-lg mx-auto">
              {/* Team member rows */}
              {teamMembers.map((member) => (
                <div key={member.id} className="flex gap-2 items-start">
                  <div className="flex-1 grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={member.name}
                      onChange={(e) => updateTeamMember(member.id, 'name', e.target.value)}
                      className={inputClasses}
                      placeholder="Name"
                    />
                    <input
                      type="email"
                      value={member.email}
                      onChange={(e) => updateTeamMember(member.id, 'email', e.target.value)}
                      className={inputClasses}
                      placeholder="email@venue.com"
                    />
                  </div>
                  <select
                    value={member.role}
                    onChange={(e) => updateTeamMember(member.id, 'role', e.target.value)}
                    className="w-36 border border-border rounded-lg px-2 py-2.5 text-sm text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 outline-none"
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeTeamMember(member.id)}
                    className="p-2.5 text-sage-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}

              {/* Add member button */}
              <button
                onClick={addTeamMember}
                className="flex items-center gap-2 text-sm text-sage-600 hover:text-sage-800 font-medium py-2 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add team member
              </button>

              {teamMembers.length === 0 && (
                <div className="text-center py-8 rounded-lg bg-sage-50/50 border border-dashed border-sage-200">
                  <Users className="w-8 h-8 text-sage-300 mx-auto mb-3" />
                  <p className="text-sm text-sage-600">
                    No team members added yet.
                  </p>
                  <p className="text-xs text-sage-500 mt-1">
                    You can always invite people later from Settings.
                  </p>
                </div>
              )}

              {/* Buttons */}
              <div className="flex gap-3 pt-4">
                <button
                  onClick={skipTeam}
                  className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-sage-500 hover:text-sage-700 transition-colors"
                >
                  <SkipForward className="w-4 h-4" />
                  Skip for now
                </button>
                <button
                  onClick={sendInvitations}
                  disabled={loading || teamMembers.filter((m) => m.email.trim()).length === 0}
                  className="flex-1 flex items-center justify-center gap-2 bg-sage-600 text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Send Invites & Continue
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
