'use client'

import { useState, useCallback, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useScope } from '@/lib/hooks/use-scope'
import {
  Building2,
  Bot,
  BookOpen,
  ArrowLeft,
  ArrowRight,
  Check,
  Plus,
  Trash2,
  Sparkles,
  Mail,
  SkipForward,
  Loader2,
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  Rocket,
  RefreshCw,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepConfig {
  key: string
  label: string
  subtitle: string
  duration: string
  icon: React.ReactNode
}

interface VenueBasics {
  business_name: string
  address: string
  city: string
  state: string
  zip: string
  capacity: string
  base_price: string
  timezone: string
}

interface AIPersonality {
  warmth_level: number
  formality_level: number
  playfulness_level: number
  brevity_level: number
  enthusiasm_level: number
}

interface FAQItem {
  category: string
  question: string
  answer: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEPS: StepConfig[] = [
  { key: 'basics', label: 'Venue Basics', subtitle: 'Tell us about your venue', duration: '2 min', icon: <Building2 className="w-5 h-5" /> },
  { key: 'gmail', label: 'Connect Gmail', subtitle: 'Link your inquiry inbox', duration: '2 min', icon: <Mail className="w-5 h-5" /> },
  { key: 'voice', label: 'Train Your Voice', subtitle: 'Teach Bloom how you write', duration: '5 min', icon: <Bot className="w-5 h-5" /> },
  { key: 'knowledge', label: 'Knowledge Base', subtitle: 'Seed common questions', duration: '3 min', icon: <BookOpen className="w-5 h-5" /> },
  { key: 'test', label: 'Test Draft', subtitle: 'See Bloom in action', duration: '2 min', icon: <MessageSquare className="w-5 h-5" /> },
  { key: 'launch', label: 'Go Live', subtitle: 'You\'re ready!', duration: '1 min', icon: <Rocket className="w-5 h-5" /> },
]

const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
]

const FAQ_CATEGORIES = ['general', 'pricing', 'availability', 'logistics']

const FAQ_TEMPLATES: FAQItem[] = [
  { category: 'general', question: 'What is the maximum guest capacity?', answer: '' },
  { category: 'logistics', question: 'Is there on-site parking? How many spots?', answer: '' },
  { category: 'pricing', question: 'Do you offer in-house catering or is it BYOB?', answer: '' },
  { category: 'logistics', question: 'Is there a rain plan or backup indoor space?', answer: '' },
  { category: 'availability', question: 'What are the typical event start and end times?', answer: '' },
]

const MOCK_INQUIRY =
  'Hi, we\'re interested in your venue for our September 2027 wedding. We\'re expecting about 120 guests. Can you tell us about pricing and availability?'

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

const selectClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Voice preview generator (client-side, no AI call)
// ---------------------------------------------------------------------------

function generateVoicePreview(p: AIPersonality, venueName: string): string {
  const warm = p.warmth_level
  const formal = p.formality_level
  const playful = p.playfulness_level
  const enthusiasm = p.enthusiasm_level
  const brief = p.brevity_level

  // Greeting
  let greeting: string
  if (warm >= 8 && formal <= 4) {
    greeting = 'Hi Sarah!'
  } else if (warm >= 6 && formal <= 5) {
    greeting = 'Hi Sarah,'
  } else if (formal >= 7) {
    greeting = 'Dear Ms. Johnson,'
  } else {
    greeting = 'Hello Sarah,'
  }

  // Opening line
  let opening: string
  if (enthusiasm >= 7 && warm >= 7) {
    opening = `Thanks so much for reaching out about ${venueName}! We are absolutely thrilled you're considering us for your big day.`
  } else if (warm >= 6) {
    opening = `Thank you for your interest in ${venueName}. We'd love to help you plan your special day.`
  } else if (formal >= 7) {
    opening = `Thank you for your inquiry regarding ${venueName}. We appreciate your consideration.`
  } else {
    opening = `Thanks for reaching out about ${venueName}. Happy to share some details with you.`
  }

  // Body
  let body: string
  if (brief >= 7) {
    body = 'I\'d love to set up a time to walk you through everything and show you the space.'
  } else {
    body = 'We have some wonderful options that could work perfectly for your celebration. I\'d love to set up a time to chat through the details and give you a tour of the property.'
  }

  // Playful touch
  let playfulTouch = ''
  if (playful >= 7) {
    playfulTouch = ' (Trust me, the photos don\'t do it justice!)'
  } else if (playful >= 5) {
    playfulTouch = ' It\'s such a beautiful space — I think you\'ll love it.'
  }

  // Closer
  let closer: string
  if (warm >= 8 && formal <= 4) {
    closer = 'Can\'t wait to hear from you!'
  } else if (warm >= 6) {
    closer = 'Looking forward to connecting with you!'
  } else {
    closer = 'Please don\'t hesitate to reach out with any questions.'
  }

  return `${greeting}\n\n${opening}\n\n${body}${playfulTouch}\n\n${closer}`
}

// ---------------------------------------------------------------------------
// Step Indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current, total, steps }: { current: number; total: number; steps: StepConfig[] }) {
  const progressPercent = ((current) / (total - 1)) * 100

  return (
    <div className="space-y-3">
      {/* Progress bar */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-sage-600 whitespace-nowrap">
          Step {current + 1} of {total}
        </span>
        <div className="flex-1 h-2 bg-sage-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-sage-500 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <span className="text-xs text-sage-400 whitespace-nowrap">{steps[current]?.duration}</span>
      </div>
      {/* Step dots */}
      <div className="flex items-center justify-center gap-2">
        {Array.from({ length: total }, (_, i) => {
          const isCompleted = i < current
          const isActive = i === current

          return (
            <div key={i} className="flex items-center gap-2">
              <div className="flex flex-col items-center gap-1">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${
                    isCompleted
                      ? 'bg-sage-500 text-white'
                      : isActive
                        ? 'bg-sage-500 text-white ring-4 ring-sage-200'
                        : 'bg-sage-100 text-sage-400'
                  }`}
                >
                  {isCompleted ? <Check className="w-4 h-4" /> : i + 1}
                </div>
                <span className={`text-[10px] font-medium hidden sm:block ${
                  isActive ? 'text-sage-800' : isCompleted ? 'text-sage-500' : 'text-sage-400'
                }`}>
                  {steps[i].label}
                </span>
              </div>
              {i < total - 1 && (
                <div className={`w-6 h-0.5 mb-4 sm:mb-0 ${isCompleted ? 'bg-sage-500' : 'bg-sage-200'}`} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dimension Slider
// ---------------------------------------------------------------------------

function DimensionSlider({
  label,
  lowLabel,
  highLabel,
  value,
  onChange,
}: {
  label: string
  lowLabel: string
  highLabel: string
  value: number
  onChange: (val: number) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-sm font-medium text-sage-700">{label}</label>
        <span className="text-sm font-semibold text-sage-900 tabular-nums">{value}/10</span>
      </div>
      <input
        type="range"
        min={1}
        max={10}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className="w-full h-2 bg-sage-100 rounded-full appearance-none cursor-pointer accent-sage-500"
      />
      <div className="flex justify-between text-[10px] text-sage-400 mt-0.5">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const scope = useScope()
  const VENUE_ID = scope.venueId
  const [currentStep, setCurrentStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1: Venue Basics
  const [basics, setBasics] = useState<VenueBasics>({
    business_name: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    capacity: '',
    base_price: '',
    timezone: 'America/New_York',
  })

  // Step 2: Gmail connection state
  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailEmail, setGmailEmail] = useState<string | null>(null)
  const [gmailLoading, setGmailLoading] = useState(false)
  const [gmailChecked, setGmailChecked] = useState(false)

  // Step 3: Voice / Personality
  const [personality, setPersonality] = useState<AIPersonality>({
    warmth_level: 7,
    formality_level: 4,
    playfulness_level: 5,
    brevity_level: 6,
    enthusiasm_level: 6,
  })

  // Step 4: Knowledge Base
  const [faqs, setFaqs] = useState<FAQItem[]>(() =>
    FAQ_TEMPLATES.map((t) => ({ ...t }))
  )

  // Step 5: Test Draft
  const [testDraft, setTestDraft] = useState<string | null>(null)
  const [testDraftLoading, setTestDraftLoading] = useState(false)
  const [testDraftError, setTestDraftError] = useState<string | null>(null)

  const supabase = createClient()

  // ---- Load existing data on mount ----
  useEffect(() => {
    if (!VENUE_ID) return
    let cancelled = false

    async function loadExisting() {
      // Load venue basics
      const { data: venue } = await supabase
        .from('venues')
        .select('name, address, city, state, zip, timezone')
        .eq('id', VENUE_ID!)
        .maybeSingle()

      if (cancelled) return

      const { data: config } = await supabase
        .from('venue_config')
        .select('business_name, capacity, base_price, timezone')
        .eq('venue_id', VENUE_ID!)
        .maybeSingle()

      if (cancelled) return

      if (venue || config) {
        setBasics((prev) => ({
          ...prev,
          business_name: config?.business_name || venue?.name || prev.business_name,
          address: venue?.address || prev.address,
          city: venue?.city || prev.city,
          state: venue?.state || prev.state,
          zip: venue?.zip || prev.zip,
          capacity: config?.capacity?.toString() || prev.capacity,
          base_price: config?.base_price?.toString() || prev.base_price,
          timezone: config?.timezone || venue?.timezone || prev.timezone,
        }))
      }

      // Load AI personality
      const { data: aiConfig } = await supabase
        .from('venue_ai_config')
        .select('warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level')
        .eq('venue_id', VENUE_ID!)
        .maybeSingle()

      if (cancelled) return
      if (aiConfig) {
        setPersonality({
          warmth_level: aiConfig.warmth_level ?? 7,
          formality_level: aiConfig.formality_level ?? 4,
          playfulness_level: aiConfig.playfulness_level ?? 5,
          brevity_level: aiConfig.brevity_level ?? 6,
          enthusiasm_level: aiConfig.enthusiasm_level ?? 6,
        })
      }

      // Load existing FAQs from knowledge_base
      const { data: kbEntries } = await supabase
        .from('knowledge_base')
        .select('category, question, answer')
        .eq('venue_id', VENUE_ID!)
        .limit(15)

      if (cancelled) return
      if (kbEntries && kbEntries.length > 0) {
        setFaqs(kbEntries.map((e) => ({
          category: e.category ?? 'general',
          question: e.question ?? '',
          answer: e.answer ?? '',
        })))
      }

      // Check Gmail connection
      const { data: gmailConfig } = await supabase
        .from('venue_config')
        .select('gmail_tokens, coordinator_email')
        .eq('venue_id', VENUE_ID!)
        .maybeSingle()

      if (cancelled) return
      if (gmailConfig?.gmail_tokens) {
        setGmailConnected(true)
        setGmailEmail(gmailConfig.coordinator_email || 'Connected')
      }
      setGmailChecked(true)
    }

    loadExisting()
    return () => { cancelled = true }
  }, [VENUE_ID, supabase])

  // ---- Save progress at each step ----
  const saveStep = useCallback(async () => {
    const venueId = VENUE_ID
    if (!venueId) {
      setError('No venue selected. Please pick a venue from the scope selector before completing onboarding.')
      return false
    }
    setSaving(true)
    setError(null)

    try {
      switch (currentStep) {
        case 0: {
          // Save venue basics to venues + venue_config
          const slug = basics.business_name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .trim()

          const { error: venueError } = await supabase
            .from('venues')
            .upsert({
              id: venueId,
              name: basics.business_name,
              slug,
              address: basics.address || null,
              city: basics.city || null,
              state: basics.state || null,
              zip: basics.zip || null,
              timezone: basics.timezone,
              status: 'trial',
              updated_at: new Date().toISOString(),
            }, { onConflict: 'id' })
          if (venueError) throw venueError

          const { error: configError } = await supabase
            .from('venue_config')
            .upsert({
              venue_id: venueId,
              business_name: basics.business_name,
              timezone: basics.timezone,
              capacity: basics.capacity ? parseInt(basics.capacity) : null,
              base_price: basics.base_price ? parseFloat(basics.base_price) : null,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'venue_id' })
          if (configError) throw configError
          break
        }
        case 1: {
          // Gmail step — nothing to save here, OAuth handles it
          break
        }
        case 2: {
          // Save AI personality
          const { error: aiError } = await supabase
            .from('venue_ai_config')
            .upsert({
              venue_id: venueId,
              warmth_level: personality.warmth_level,
              formality_level: personality.formality_level,
              playfulness_level: personality.playfulness_level,
              brevity_level: personality.brevity_level,
              enthusiasm_level: personality.enthusiasm_level,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'venue_id' })
          if (aiError) throw aiError
          break
        }
        case 3: {
          // Save FAQs (knowledge base)
          const validFaqs = faqs.filter((f) => f.question.trim() && f.answer.trim())
          if (validFaqs.length > 0) {
            // Delete existing onboarding FAQs to avoid duplicates on re-run
            await supabase
              .from('knowledge_base')
              .delete()
              .eq('venue_id', venueId)
              .in('category', FAQ_CATEGORIES)

            const { error: kbError } = await supabase
              .from('knowledge_base')
              .insert(
                validFaqs.map((f) => ({
                  venue_id: venueId,
                  category: f.category,
                  question: f.question.trim(),
                  answer: f.answer.trim(),
                  is_active: true,
                }))
              )
            if (kbError) throw kbError
          }
          break
        }
        case 4: {
          // Test draft step — nothing to save
          break
        }
        case 5: {
          // Go Live — mark venue active
          await supabase
            .from('venues')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('id', venueId)
          break
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save. Please try again.'
      console.error('Failed to save step:', err)
      setError(message)
      setSaving(false)
      return false
    }

    setSaving(false)
    return true
  }, [currentStep, basics, personality, faqs, supabase, VENUE_ID])

  // ---- Navigation ----
  async function handleNext() {
    const success = await saveStep()
    if (success) {
      if (currentStep === STEPS.length - 1) {
        // Final step — redirect to dashboard
        window.location.href = '/'
      } else {
        setCurrentStep((prev) => prev + 1)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    }
  }

  function handleBack() {
    setError(null)
    setCurrentStep((prev) => Math.max(prev - 1, 0))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function handleSkip() {
    setError(null)
    if (currentStep === STEPS.length - 1) {
      window.location.href = '/'
    } else {
      setCurrentStep((prev) => prev + 1)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // ---- Gmail OAuth ----
  async function handleGmailConnect() {
    setGmailLoading(true)
    try {
      const redirectUri = `${window.location.origin}/onboarding`
      const res = await fetch(`/api/agent/gmail?redirectUri=${encodeURIComponent(redirectUri)}`)
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setError(data.error || 'Gmail integration is not configured yet. You can connect it later in Settings.')
        setGmailLoading(false)
      }
    } catch {
      setError('Failed to initiate Gmail connection. You can try again later in Settings.')
      setGmailLoading(false)
    }
  }

  // Handle Gmail OAuth callback on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (!code) return

    async function handleCallback() {
      try {
        const redirectUri = `${window.location.origin}/onboarding`
        const res = await fetch('/api/agent/gmail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirectUri }),
        })
        const data = await res.json()
        if (data.connected) {
          setGmailConnected(true)
          setGmailEmail('Connected')
          // Clean URL
          window.history.replaceState({}, '', '/onboarding')
          // Jump to Gmail step
          setCurrentStep(1)
        }
      } catch {
        setError('Failed to complete Gmail connection.')
      }
    }

    handleCallback()
  }, [])

  // ---- Test Draft ----
  async function generateTestDraft() {
    setTestDraftLoading(true)
    setTestDraftError(null)
    setTestDraft(null)

    try {
      const validFaqs = faqs
        .filter((f) => f.question.trim() && f.answer.trim())
        .map((f) => ({ question: f.question, answer: f.answer }))

      const res = await fetch('/api/onboarding/test-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueName: basics.business_name || 'Your Venue',
          personality,
          faqs: validFaqs,
          mockInquiry: MOCK_INQUIRY,
        }),
      })

      const data = await res.json()
      if (data.draft) {
        setTestDraft(data.draft)
      } else {
        setTestDraftError(data.error || 'Failed to generate draft')
      }
    } catch {
      setTestDraftError('Could not reach the AI service. Please try again.')
    }

    setTestDraftLoading(false)
  }

  // Auto-generate test draft when entering step 5
  useEffect(() => {
    if (currentStep === 4 && !testDraft && !testDraftLoading && !testDraftError) {
      generateTestDraft()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep])

  // ---- FAQ helpers ----
  function addFaq() {
    setFaqs((prev) => [...prev, { category: 'general', question: '', answer: '' }])
  }

  function removeFaq(index: number) {
    setFaqs((prev) => prev.filter((_, i) => i !== index))
  }

  function updateFaq(index: number, field: keyof FAQItem, value: string) {
    setFaqs((prev) => prev.map((f, i) => (i === index ? { ...f, [field]: value } : f)))
  }

  function addTemplateFaq(template: FAQItem) {
    if (!faqs.some((f) => f.question === template.question)) {
      setFaqs((prev) => [...prev, { ...template }])
    }
  }

  // ---- Voice preview ----
  const voicePreview = generateVoicePreview(personality, basics.business_name || 'Your Venue')

  return (
    <div className="min-h-screen flex flex-col bg-warm-white">
      {/* Fixed header */}
      <div className="sticky top-0 z-10 bg-warm-white/95 backdrop-blur-sm border-b border-border">
        <div className="max-w-2xl mx-auto px-6 py-4 space-y-3">
          <div className="text-center">
            <img src="/brand/wordmark-black.png" alt="The Bloom House" className="h-8 w-auto mx-auto mb-1" />
          </div>
          <StepIndicator current={currentStep} total={STEPS.length} steps={STEPS} />
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
          {/* Error banner */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 1: Welcome + Venue Basics                                    */}
          {/* ================================================================ */}
          {currentStep === 0 && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h1 className="font-heading text-2xl font-bold text-sage-900">
                  Let&apos;s get your venue set up
                </h1>
                <p className="text-sage-500 text-sm">
                  This takes about 15 minutes. Everything saves as you go.
                </p>
              </div>

              <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-sage-700 mb-1">Venue Name *</label>
                    <input
                      type="text"
                      value={basics.business_name}
                      onChange={(e) => setBasics({ ...basics, business_name: e.target.value })}
                      placeholder="Hawthorne Manor"
                      className={inputClasses}
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-sage-700 mb-1">Street Address</label>
                    <input
                      type="text"
                      value={basics.address}
                      onChange={(e) => setBasics({ ...basics, address: e.target.value })}
                      placeholder="123 Oak Lane"
                      className={inputClasses}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-sage-700 mb-1">City</label>
                    <input
                      type="text"
                      value={basics.city}
                      onChange={(e) => setBasics({ ...basics, city: e.target.value })}
                      placeholder="Richmond"
                      className={inputClasses}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-sage-700 mb-1">State</label>
                      <input
                        type="text"
                        value={basics.state}
                        onChange={(e) => setBasics({ ...basics, state: e.target.value })}
                        placeholder="VA"
                        className={inputClasses}
                        maxLength={2}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-sage-700 mb-1">ZIP</label>
                      <input
                        type="text"
                        value={basics.zip}
                        onChange={(e) => setBasics({ ...basics, zip: e.target.value })}
                        placeholder="23220"
                        className={inputClasses}
                        maxLength={10}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-sage-700 mb-1">Maximum Capacity</label>
                    <input
                      type="number"
                      value={basics.capacity}
                      onChange={(e) => setBasics({ ...basics, capacity: e.target.value })}
                      placeholder="250"
                      className={inputClasses}
                      min={1}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-sage-700 mb-1">Base Price ($)</label>
                    <input
                      type="number"
                      value={basics.base_price}
                      onChange={(e) => setBasics({ ...basics, base_price: e.target.value })}
                      placeholder="8500"
                      className={inputClasses}
                      min={0}
                      step={100}
                    />
                    <p className="text-xs text-sage-400 mt-1">Starting rental fee for your most common package.</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-sage-700 mb-1">Timezone</label>
                    <select
                      value={basics.timezone}
                      onChange={(e) => setBasics({ ...basics, timezone: e.target.value })}
                      className={selectClasses}
                    >
                      {TIMEZONE_OPTIONS.map((tz) => (
                        <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 2: Connect Gmail                                             */}
          {/* ================================================================ */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h1 className="font-heading text-2xl font-bold text-sage-900">
                  Connect your inquiry inbox
                </h1>
                <p className="text-sage-500 text-sm">
                  Connect your Gmail so Bloom can start reading inquiries and drafting responses.
                </p>
              </div>

              <div className="bg-surface border border-border rounded-xl p-8 shadow-sm">
                <div className="flex flex-col items-center text-center space-y-6">
                  {gmailConnected ? (
                    <>
                      <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center">
                        <CheckCircle2 className="w-8 h-8 text-green-500" />
                      </div>
                      <div>
                        <p className="font-semibold text-sage-900 text-lg">Gmail Connected</p>
                        <p className="text-sage-500 text-sm mt-1">
                          Connected as <span className="font-medium text-sage-700">{gmailEmail}</span>
                        </p>
                      </div>
                    </>
                  ) : gmailChecked ? (
                    <>
                      <div className="w-16 h-16 rounded-full bg-sage-50 flex items-center justify-center">
                        <Mail className="w-8 h-8 text-sage-400" />
                      </div>
                      <div className="space-y-3">
                        <p className="text-sage-700 text-sm max-w-md">
                          Connect the Gmail account where your venue receives inquiries (e.g., info@yourvenue.com).
                        </p>
                        <button
                          onClick={handleGmailConnect}
                          disabled={gmailLoading}
                          className="inline-flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-semibold rounded-xl px-6 py-3 transition-colors text-sm"
                        >
                          {gmailLoading ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Mail className="w-4 h-4" />
                          )}
                          Connect Gmail
                        </button>
                      </div>
                      <div className="bg-sage-50 rounded-lg px-4 py-3 max-w-md">
                        <p className="text-xs text-sage-500">
                          <strong>Skip for now?</strong> You can connect later in Settings. Bloom won&apos;t be able to draft responses until Gmail is connected.
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="py-8">
                      <Loader2 className="w-6 h-6 animate-spin text-sage-400 mx-auto" />
                      <p className="text-sm text-sage-400 mt-2">Checking connection...</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 3: Train Your Voice                                          */}
          {/* ================================================================ */}
          {currentStep === 2 && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h1 className="font-heading text-2xl font-bold text-sage-900">
                  Teach Bloom how you write
                </h1>
                <p className="text-sage-500 text-sm">
                  This is the personality engine. Adjust the sliders and watch the preview update.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Sliders */}
                <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
                  <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider">Voice Settings</h3>
                  <DimensionSlider
                    label="Warmth"
                    lowLabel="Reserved"
                    highLabel="Very Warm"
                    value={personality.warmth_level}
                    onChange={(v) => setPersonality({ ...personality, warmth_level: v })}
                  />
                  <DimensionSlider
                    label="Formality"
                    lowLabel="Casual"
                    highLabel="Very Formal"
                    value={personality.formality_level}
                    onChange={(v) => setPersonality({ ...personality, formality_level: v })}
                  />
                  <DimensionSlider
                    label="Playfulness"
                    lowLabel="Serious"
                    highLabel="Very Playful"
                    value={personality.playfulness_level}
                    onChange={(v) => setPersonality({ ...personality, playfulness_level: v })}
                  />
                  <DimensionSlider
                    label="Enthusiasm"
                    lowLabel="Calm"
                    highLabel="Very Enthusiastic"
                    value={personality.enthusiasm_level}
                    onChange={(v) => setPersonality({ ...personality, enthusiasm_level: v })}
                  />
                  <DimensionSlider
                    label="Brevity"
                    lowLabel="Detailed"
                    highLabel="Very Concise"
                    value={personality.brevity_level}
                    onChange={(v) => setPersonality({ ...personality, brevity_level: v })}
                  />
                </div>

                {/* Live Preview */}
                <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
                  <div className="flex items-center gap-2 mb-4">
                    <Sparkles className="w-4 h-4 text-sage-500" />
                    <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider">Live Preview</h3>
                  </div>
                  <div className="bg-warm-white border border-sage-100 rounded-lg p-4">
                    <p className="text-xs text-sage-400 mb-3">Sample email with your current settings:</p>
                    <div className="text-sm text-sage-800 whitespace-pre-line leading-relaxed">
                      {voicePreview}
                    </div>
                  </div>
                  <p className="text-xs text-sage-400 mt-3">
                    This preview uses templates. The real AI will be even more natural — you&apos;ll see it in Step 5.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 4: Seed Your Knowledge Base                                  */}
          {/* ================================================================ */}
          {currentStep === 3 && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h1 className="font-heading text-2xl font-bold text-sage-900">
                  Seed your knowledge base
                </h1>
                <p className="text-sage-500 text-sm">
                  Add 5&ndash;10 common questions your couples ask. Bloom will use these to answer accurately.
                </p>
              </div>

              <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
                {/* Template suggestions */}
                {FAQ_TEMPLATES.filter((t) => !faqs.some((f) => f.question === t.question)).length > 0 && (
                  <div className="bg-sage-50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-sage-700 mb-2">Add a common question:</p>
                    <div className="flex flex-wrap gap-2">
                      {FAQ_TEMPLATES.filter((t) => !faqs.some((f) => f.question === t.question)).map((t, idx) => (
                        <button
                          key={idx}
                          onClick={() => addTemplateFaq(t)}
                          className="text-xs bg-white border border-sage-200 rounded-full px-3 py-1.5 text-sage-700 hover:bg-sage-100 hover:border-sage-300 transition-colors"
                        >
                          + {t.question}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  {faqs.map((faq, idx) => (
                    <div key={idx} className="border border-border rounded-xl p-4 space-y-3 bg-warm-white">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-sage-800">Q{idx + 1}</span>
                        {faqs.length > 1 && (
                          <button
                            onClick={() => removeFaq(idx)}
                            className="p-1 text-sage-400 hover:text-red-500 transition-colors"
                            title="Remove"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-sage-600 mb-1">Question</label>
                        <input
                          type="text"
                          value={faq.question}
                          onChange={(e) => updateFaq(idx, 'question', e.target.value)}
                          placeholder="e.g., What is the rental fee for a Saturday wedding?"
                          className={inputClasses}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-sage-600 mb-1">Answer</label>
                        <textarea
                          value={faq.answer}
                          onChange={(e) => updateFaq(idx, 'answer', e.target.value)}
                          placeholder="e.g., Our Saturday rental fee starts at $8,500 and includes..."
                          className={inputClasses + ' resize-none'}
                          rows={3}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                {faqs.length < 15 && (
                  <button
                    onClick={addFaq}
                    className="flex items-center gap-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add another
                  </button>
                )}

                <p className="text-xs text-sage-400">
                  {faqs.filter((f) => f.question.trim() && f.answer.trim()).length} of {faqs.length} completed. You can always add more later.
                </p>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 5: Review a Test Draft                                       */}
          {/* ================================================================ */}
          {currentStep === 4 && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h1 className="font-heading text-2xl font-bold text-sage-900">
                  See Bloom in action
                </h1>
                <p className="text-sage-500 text-sm">
                  Here&apos;s what Bloom would say to a new inquiry. How does it look?
                </p>
              </div>

              {/* Mock inquiry */}
              <div className="bg-sage-50 border border-sage-100 rounded-xl p-5">
                <p className="text-xs font-semibold text-sage-600 mb-2 uppercase tracking-wider">Incoming Inquiry</p>
                <p className="text-sm text-sage-800 italic">&ldquo;{MOCK_INQUIRY}&rdquo;</p>
              </div>

              {/* Generated draft */}
              <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-sage-500" />
                    <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider">
                      Bloom&apos;s Draft Response
                    </h3>
                  </div>
                  {testDraft && (
                    <button
                      onClick={generateTestDraft}
                      disabled={testDraftLoading}
                      className="flex items-center gap-1.5 text-xs text-sage-500 hover:text-sage-700 transition-colors"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${testDraftLoading ? 'animate-spin' : ''}`} />
                      Regenerate
                    </button>
                  )}
                </div>

                {testDraftLoading && (
                  <div className="py-12 text-center">
                    <Loader2 className="w-6 h-6 animate-spin text-sage-400 mx-auto" />
                    <p className="text-sm text-sage-400 mt-3">Generating draft with your voice settings...</p>
                  </div>
                )}

                {testDraftError && !testDraftLoading && (
                  <div className="py-8 text-center space-y-3">
                    <AlertCircle className="w-6 h-6 text-red-400 mx-auto" />
                    <p className="text-sm text-red-600">{testDraftError}</p>
                    <button
                      onClick={generateTestDraft}
                      className="text-sm text-sage-600 hover:text-sage-800 font-medium"
                    >
                      Try again
                    </button>
                  </div>
                )}

                {testDraft && !testDraftLoading && (
                  <div className="bg-warm-white border border-sage-100 rounded-lg p-5">
                    <div className="text-sm text-sage-800 whitespace-pre-line leading-relaxed">
                      {testDraft}
                    </div>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              {testDraft && !testDraftLoading && (
                <div className="flex flex-col sm:flex-row items-center gap-3 justify-center">
                  <button
                    onClick={() => {
                      setCurrentStep(2)
                      window.scrollTo({ top: 0, behavior: 'smooth' })
                    }}
                    className="flex items-center gap-2 text-sm font-medium text-sage-600 hover:text-sage-800 border border-border rounded-lg px-5 py-2.5 transition-colors"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Needs work &mdash; adjust voice
                  </button>
                  <button
                    onClick={handleNext}
                    className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 text-white font-semibold rounded-lg px-6 py-2.5 transition-colors text-sm"
                  >
                    <Check className="w-4 h-4" />
                    Looks great!
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 6: Go Live                                                   */}
          {/* ================================================================ */}
          {currentStep === 5 && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-sage-100 mb-2">
                  <Rocket className="w-8 h-8 text-sage-600" />
                </div>
                <h1 className="font-heading text-2xl font-bold text-sage-900">
                  You&apos;re ready!
                </h1>
                <p className="text-sage-500 text-sm">
                  <strong>{basics.business_name || 'Your venue'}</strong> is all set. Here&apos;s what happens next:
                </p>
              </div>

              <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-sage-100 flex items-center justify-center shrink-0 mt-0.5">
                    <Mail className="w-4 h-4 text-sage-600" />
                  </div>
                  <div>
                    <p className="font-medium text-sage-900 text-sm">Bloom checks your inbox every 15 minutes</p>
                    <p className="text-sage-500 text-xs mt-0.5">New inquiries from The Knot, WeddingWire, and direct emails are detected automatically.</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-sage-100 flex items-center justify-center shrink-0 mt-0.5">
                    <MessageSquare className="w-4 h-4 text-sage-600" />
                  </div>
                  <div>
                    <p className="font-medium text-sage-900 text-sm">New inquiries get a draft in your Approval Queue</p>
                    <p className="text-sage-500 text-xs mt-0.5">Each draft uses your voice settings and knowledge base to sound like you.</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-sage-100 flex items-center justify-center shrink-0 mt-0.5">
                    <Check className="w-4 h-4 text-sage-600" />
                  </div>
                  <div>
                    <p className="font-medium text-sage-900 text-sm">You approve, edit, or reject each one</p>
                    <p className="text-sage-500 text-xs mt-0.5">You stay in full control. Nothing sends without your approval.</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-sage-100 flex items-center justify-center shrink-0 mt-0.5">
                    <Sparkles className="w-4 h-4 text-sage-600" />
                  </div>
                  <div>
                    <p className="font-medium text-sage-900 text-sm">Over time, Bloom learns from your corrections</p>
                    <p className="text-sage-500 text-xs mt-0.5">Every edit teaches the AI to write more like you. It gets better with every response.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Navigation                                                        */}
          {/* ================================================================ */}
          {/* Hide default nav on step 5 if draft is shown (it has its own buttons) */}
          {!(currentStep === 4 && testDraft && !testDraftLoading) && (
            <div className="flex items-center justify-between pt-2 pb-8">
              <button
                onClick={handleBack}
                disabled={currentStep === 0}
                className="flex items-center gap-2 text-sm font-medium text-sage-600 hover:text-sage-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleSkip}
                  className="flex items-center gap-1.5 text-sm font-medium text-sage-400 hover:text-sage-600 transition-colors"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                  Skip
                </button>
                <button
                  onClick={handleNext}
                  disabled={saving || (currentStep === 0 && !basics.business_name.trim())}
                  className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-6 py-2.5 transition-colors text-sm"
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Saving...
                    </>
                  ) : currentStep === STEPS.length - 1 ? (
                    <>
                      Go to Dashboard
                      <Sparkles className="w-4 h-4" />
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
