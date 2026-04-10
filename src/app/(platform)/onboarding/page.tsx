'use client'

import { useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useScope } from '@/lib/hooks/use-scope'
import { FONT_PAIRS } from '@/config/fonts'
import {
  Building2,
  Palette,
  Bot,
  BookOpen,
  Store,
  Sun,
  ArrowLeft,
  ArrowRight,
  Check,
  Plus,
  Trash2,
  Sparkles,
  PartyPopper,
  Mail,
  Settings,
  SkipForward,
} from 'lucide-react'

// Venue ID is now resolved from the active scope at render time (see useScope below).
// TODO: bloom_demo_only — once signup wires the org/venue creation flow, derive
// VENUE_ID from the new-venue intent rather than the currently selected scope.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepConfig {
  key: string
  label: string
  icon: React.ReactNode
  optional?: boolean
}

interface VenueBasics {
  business_name: string
  coordinator_name: string
  coordinator_email: string
  coordinator_phone: string
  timezone: string
  capacity: string
  base_price: string
  catering_model: string
  bar_model: string
}

interface Branding {
  logo_url: string
  primary_color: string
  secondary_color: string
  accent_color: string
  font_pair: string
  portal_tagline: string
}

interface AIPersonality {
  ai_name: string
  ai_emoji: string
  warmth_level: number
  formality_level: number
  playfulness_level: number
  brevity_level: number
  enthusiasm_level: number
  signature_greeting: string
  signature_closer: string
  vibe: string
}

interface FAQItem {
  category: string
  question: string
  answer: string
}

interface VendorItem {
  vendor_name: string
  vendor_type: string
  contact_email: string
  contact_phone: string
  website_url: string
}

interface SeasonalInfo {
  peak_season: string
  off_season: string
  special_considerations: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEPS: StepConfig[] = [
  { key: 'basics', label: 'Venue Basics', icon: <Building2 className="w-5 h-5" /> },
  { key: 'branding', label: 'Branding', icon: <Palette className="w-5 h-5" /> },
  { key: 'personality', label: 'AI Personality', icon: <Bot className="w-5 h-5" /> },
  { key: 'knowledge', label: 'Knowledge Base', icon: <BookOpen className="w-5 h-5" /> },
  { key: 'vendors', label: 'Preferred Vendors', icon: <Store className="w-5 h-5" />, optional: true },
  { key: 'seasonal', label: 'Seasonal Info', icon: <Sun className="w-5 h-5" />, optional: true },
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

const CATERING_OPTIONS = [
  { value: 'in_house', label: 'In-House Catering' },
  { value: 'byob', label: 'BYOB (Bring Your Own)' },
  { value: 'preferred_list', label: 'Preferred Vendor List' },
]

const BAR_OPTIONS = [
  { value: 'in_house', label: 'In-House Bar' },
  { value: 'byob', label: 'BYOB (Bring Your Own)' },
  { value: 'hybrid', label: 'Hybrid' },
]

const fontPairKeys = Object.keys(FONT_PAIRS)

const VIBES = [
  { value: 'romantic_timeless', label: 'Romantic & Timeless' },
  { value: 'fun_modern', label: 'Fun & Modern' },
  { value: 'rustic_cozy', label: 'Rustic & Cozy' },
  { value: 'luxurious_exclusive', label: 'Luxurious & Exclusive' },
  { value: 'garden_whimsical', label: 'Garden & Whimsical' },
  { value: 'industrial_chic', label: 'Industrial Chic' },
]

const AI_EMOJIS = ['🌿', '✨', '🌸', '💐', '🪴', '🌻', '🌹', '🕊️', '💍', '🎀']

const FAQ_CATEGORIES = ['general', 'pricing', 'availability', 'logistics']

const FAQ_TEMPLATES: FAQItem[] = [
  { category: 'pricing', question: 'What is the venue rental fee?', answer: '' },
  { category: 'pricing', question: 'What is included in the rental fee?', answer: '' },
  { category: 'availability', question: 'How far in advance should we book?', answer: '' },
  { category: 'general', question: 'What is the maximum guest capacity?', answer: '' },
  { category: 'logistics', question: 'Is there a rain plan or backup indoor space?', answer: '' },
  { category: 'pricing', question: 'Is there a minimum spend for catering?', answer: '' },
  { category: 'logistics', question: 'What time can vendors arrive for setup?', answer: '' },
  { category: 'general', question: 'Are there noise restrictions or a curfew?', answer: '' },
  { category: 'logistics', question: 'Is there on-site parking? How many spots?', answer: '' },
  { category: 'availability', question: 'Do you offer Friday or Sunday discounts?', answer: '' },
]

const VENDOR_TYPES = [
  'Photographer',
  'Videographer',
  'Florist',
  'DJ',
  'Band',
  'Caterer',
  'Baker',
  'Officiant',
  'Hair & Makeup',
  'Planner',
  'Rentals',
  'Lighting',
  'Transportation',
  'Stationer',
  'Other',
]

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

const selectClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Step Indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current, total, labels }: { current: number; total: number; labels: string[] }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => {
        const isCompleted = i < current
        const isActive = i === current

        return (
          <div key={i} className="flex items-center gap-2">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${
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
                {labels[i]}
              </span>
            </div>
            {i < total - 1 && (
              <div className={`w-6 h-0.5 mb-4 sm:mb-0 ${isCompleted ? 'bg-sage-500' : 'bg-sage-200'}`} />
            )}
          </div>
        )
      })}
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
  const [completed, setCompleted] = useState(false)

  // Step 1: Venue Basics
  const [basics, setBasics] = useState<VenueBasics>({
    business_name: '',
    coordinator_name: '',
    coordinator_email: '',
    coordinator_phone: '',
    timezone: 'America/New_York',
    capacity: '',
    base_price: '',
    catering_model: 'in_house',
    bar_model: 'in_house',
  })

  // Step 2: Branding
  const [branding, setBranding] = useState<Branding>({
    logo_url: '',
    primary_color: '#7D8471',
    secondary_color: '#5D7A7A',
    accent_color: '#A6894A',
    font_pair: 'playfair_inter',
    portal_tagline: '',
  })

  // Step 3: AI Personality
  const [personality, setPersonality] = useState<AIPersonality>({
    ai_name: 'Sage',
    ai_emoji: '🌿',
    warmth_level: 7,
    formality_level: 4,
    playfulness_level: 5,
    brevity_level: 6,
    enthusiasm_level: 6,
    signature_greeting: '',
    signature_closer: '',
    vibe: 'romantic_timeless',
  })

  // Step 4: Knowledge Base
  const [faqs, setFaqs] = useState<FAQItem[]>([
    { ...FAQ_TEMPLATES[0] },
    { ...FAQ_TEMPLATES[1] },
    { ...FAQ_TEMPLATES[2] },
    { ...FAQ_TEMPLATES[3] },
    { ...FAQ_TEMPLATES[4] },
  ])

  // Step 5: Preferred Vendors
  const [vendors, setVendors] = useState<VendorItem[]>([
    { vendor_name: '', vendor_type: 'Photographer', contact_email: '', contact_phone: '', website_url: '' },
  ])

  // Step 6: Seasonal Info
  const [seasonal, setSeasonal] = useState<SeasonalInfo>({
    peak_season: '',
    off_season: '',
    special_considerations: '',
  })

  const supabase = createClient()

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
              status: 'trial',
              updated_at: new Date().toISOString(),
            }, { onConflict: 'id' })
          if (venueError) throw venueError

          const { error: configError } = await supabase
            .from('venue_config')
            .upsert({
              venue_id: venueId,
              business_name: basics.business_name,
              coordinator_name: basics.coordinator_name || null,
              coordinator_email: basics.coordinator_email || null,
              coordinator_phone: basics.coordinator_phone || null,
              timezone: basics.timezone,
              capacity: basics.capacity ? parseInt(basics.capacity) : null,
              base_price: basics.base_price ? parseFloat(basics.base_price) : null,
              catering_model: basics.catering_model,
              bar_model: basics.bar_model,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'venue_id' })
          if (configError) throw configError
          break
        }
        case 1: {
          // Save branding
          const { error: brandError } = await supabase
            .from('venue_config')
            .update({
              logo_url: branding.logo_url || null,
              primary_color: branding.primary_color,
              secondary_color: branding.secondary_color,
              accent_color: branding.accent_color,
              font_pair: branding.font_pair,
              portal_tagline: branding.portal_tagline || null,
              updated_at: new Date().toISOString(),
            })
            .eq('venue_id', venueId)
          if (brandError) throw brandError
          break
        }
        case 2: {
          // Save AI personality
          const { error: aiError } = await supabase
            .from('venue_ai_config')
            .upsert({
              venue_id: venueId,
              ai_name: personality.ai_name,
              ai_emoji: personality.ai_emoji,
              warmth_level: personality.warmth_level,
              formality_level: personality.formality_level,
              playfulness_level: personality.playfulness_level,
              brevity_level: personality.brevity_level,
              enthusiasm_level: personality.enthusiasm_level,
              signature_greeting: personality.signature_greeting || null,
              signature_closer: personality.signature_closer || null,
              vibe: personality.vibe,
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
          // Save preferred vendors
          const validVendors = vendors.filter((v) => v.vendor_name.trim())
          if (validVendors.length > 0) {
            const { error: vendorError } = await supabase
              .from('vendor_recommendations')
              .insert(
                validVendors.map((v) => ({
                  venue_id: venueId,
                  vendor_name: v.vendor_name.trim(),
                  vendor_type: v.vendor_type,
                  contact_email: v.contact_email || null,
                  contact_phone: v.contact_phone || null,
                  website_url: v.website_url || null,
                  is_preferred: true,
                }))
              )
            if (vendorError) throw vendorError
          }
          break
        }
        case 5: {
          // Save seasonal info to knowledge_base as special entries
          const seasonalEntries: { category: string; question: string; answer: string }[] = []
          if (seasonal.peak_season.trim()) {
            seasonalEntries.push({
              category: 'availability',
              question: 'When is peak season at your venue?',
              answer: seasonal.peak_season.trim(),
            })
          }
          if (seasonal.off_season.trim()) {
            seasonalEntries.push({
              category: 'availability',
              question: 'When is the off-season and are there discounts?',
              answer: seasonal.off_season.trim(),
            })
          }
          if (seasonal.special_considerations.trim()) {
            seasonalEntries.push({
              category: 'logistics',
              question: 'Are there any seasonal considerations or special notes?',
              answer: seasonal.special_considerations.trim(),
            })
          }
          if (seasonalEntries.length > 0) {
            const { error: seasonalError } = await supabase
              .from('knowledge_base')
              .insert(
                seasonalEntries.map((e) => ({
                  venue_id: venueId,
                  category: e.category,
                  question: e.question,
                  answer: e.answer,
                  is_active: true,
                }))
              )
            if (seasonalError) throw seasonalError
          }
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
  }, [currentStep, basics, branding, personality, faqs, vendors, seasonal, supabase, VENUE_ID])

  // ---- Navigation ----
  async function handleNext() {
    const success = await saveStep()
    if (success) {
      if (currentStep === STEPS.length - 1) {
        // Final step completed — mark venue active and show celebration
        const venueId = VENUE_ID
        if (venueId) {
          await supabase
            .from('venues')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('id', venueId)
        }
        setCompleted(true)
      } else {
        setCurrentStep((prev) => prev + 1)
      }
    }
  }

  function handleBack() {
    setError(null)
    setCurrentStep((prev) => Math.max(prev - 1, 0))
  }

  function handleSkip() {
    setError(null)
    if (currentStep === STEPS.length - 1) {
      // Skip the last optional step — mark active and celebrate
      const venueId = VENUE_ID
      if (venueId) {
        supabase
          .from('venues')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('id', venueId)
          .then(() => setCompleted(true))
      } else {
        setCompleted(true)
      }
    } else {
      setCurrentStep((prev) => prev + 1)
    }
  }

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
    // Only add if not already present
    if (!faqs.some((f) => f.question === template.question)) {
      setFaqs((prev) => [...prev, { ...template }])
    }
  }

  // ---- Vendor helpers ----
  function addVendor() {
    setVendors((prev) => [
      ...prev,
      { vendor_name: '', vendor_type: 'Photographer', contact_email: '', contact_phone: '', website_url: '' },
    ])
  }

  function removeVendor(index: number) {
    setVendors((prev) => prev.filter((_, i) => i !== index))
  }

  function updateVendor(index: number, field: keyof VendorItem, value: string) {
    setVendors((prev) => prev.map((v, i) => (i === index ? { ...v, [field]: value } : v)))
  }

  const isOptionalStep = STEPS[currentStep]?.optional

  // ---- Celebration screen ----
  if (completed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-lg w-full text-center space-y-6">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-sage-100 mb-2">
            <PartyPopper className="w-10 h-10 text-sage-600" />
          </div>
          <h1 className="font-heading text-4xl font-bold text-sage-900">
            You&apos;re All Set!
          </h1>
          <p className="text-sage-600 text-lg leading-relaxed">
            <strong>{basics.business_name || 'Your venue'}</strong> is ready to go.{' '}
            {personality.ai_name} is standing by to help your couples.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4">
            <a
              href="/agent/inbox"
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-surface hover:bg-sage-50 transition-colors"
            >
              <Mail className="w-6 h-6 text-sage-500" />
              <span className="text-sm font-semibold text-sage-800">Inbox</span>
              <span className="text-xs text-sage-500">View incoming emails</span>
            </a>
            <a
              href="/settings"
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-surface hover:bg-sage-50 transition-colors"
            >
              <Settings className="w-6 h-6 text-sage-500" />
              <span className="text-sm font-semibold text-sage-800">Settings</span>
              <span className="text-xs text-sage-500">Tweak your config</span>
            </a>
            <a
              href="/portal/knowledge"
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-surface hover:bg-sage-50 transition-colors"
            >
              <BookOpen className="w-6 h-6 text-sage-500" />
              <span className="text-sm font-semibold text-sage-800">Knowledge Base</span>
              <span className="text-xs text-sage-500">Add more Q&amp;A</span>
            </a>
          </div>

          <div className="pt-6">
            <a
              href="/agent/inbox"
              className="inline-flex items-center gap-2 bg-sage-500 hover:bg-sage-600 text-white font-semibold rounded-xl px-8 py-3 transition-colors text-sm"
            >
              <Sparkles className="w-4 h-4" />
              Go to Your Dashboard
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Fixed header */}
      <div className="sticky top-0 z-10 bg-warm-white/95 backdrop-blur-sm border-b border-border">
        <div className="max-w-3xl mx-auto px-6 py-4 space-y-4">
          <div className="text-center relative">
            <a
              href="/agent/inbox"
              className="absolute left-0 top-1 flex items-center gap-1.5 text-sm text-sage-500 hover:text-sage-800 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </a>
            <img src="/brand/wordmark-black.png" alt="The Bloom House" className="h-8 w-auto mx-auto mb-2" />
            <p className="text-sage-600 text-sm">
              {STEPS[currentStep].label} &mdash; Step {currentStep + 1} of {STEPS.length}
              {isOptionalStep && <span className="text-sage-400 ml-1">(optional)</span>}
            </p>
          </div>
          <StepIndicator
            current={currentStep}
            total={STEPS.length}
            labels={STEPS.map((s) => s.label)}
          />
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 1: Venue Basics                                              */}
          {/* ================================================================ */}
          {currentStep === 0 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
              <div className="flex items-center gap-2 mb-2">
                <Building2 className="w-5 h-5 text-sage-500" />
                <h2 className="font-heading text-xl font-semibold text-sage-900">Venue Basics</h2>
              </div>

              <p className="text-sm text-sage-500">
                Tell us about your venue and the primary coordinator who will manage it.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-sage-700 mb-1">Business Name *</label>
                  <input
                    type="text"
                    value={basics.business_name}
                    onChange={(e) => setBasics({ ...basics, business_name: e.target.value })}
                    placeholder="Crestwood Manor"
                    className={inputClasses}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Coordinator Name</label>
                  <input
                    type="text"
                    value={basics.coordinator_name}
                    onChange={(e) => setBasics({ ...basics, coordinator_name: e.target.value })}
                    placeholder="Jane Smith"
                    className={inputClasses}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Coordinator Email</label>
                  <input
                    type="email"
                    value={basics.coordinator_email}
                    onChange={(e) => setBasics({ ...basics, coordinator_email: e.target.value })}
                    placeholder="jane@crestwood.com"
                    className={inputClasses}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Coordinator Phone</label>
                  <input
                    type="tel"
                    value={basics.coordinator_phone}
                    onChange={(e) => setBasics({ ...basics, coordinator_phone: e.target.value })}
                    placeholder="(804) 555-1234"
                    className={inputClasses}
                  />
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
                  <label className="block text-sm font-medium text-sage-700 mb-1">Catering Model</label>
                  <select
                    value={basics.catering_model}
                    onChange={(e) => setBasics({ ...basics, catering_model: e.target.value })}
                    className={selectClasses}
                  >
                    {CATERING_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Bar Model</label>
                  <select
                    value={basics.bar_model}
                    onChange={(e) => setBasics({ ...basics, bar_model: e.target.value })}
                    className={selectClasses}
                  >
                    {BAR_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 2: Branding                                                  */}
          {/* ================================================================ */}
          {currentStep === 1 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
              <div className="flex items-center gap-2 mb-2">
                <Palette className="w-5 h-5 text-sage-500" />
                <h2 className="font-heading text-xl font-semibold text-sage-900">Branding</h2>
              </div>

              <p className="text-sm text-sage-500">
                These colors and fonts will be used on your couple-facing portal.
              </p>

              {/* Logo URL */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Logo URL</label>
                <input
                  type="text"
                  value={branding.logo_url}
                  onChange={(e) => setBranding({ ...branding, logo_url: e.target.value })}
                  placeholder="https://your-bucket.supabase.co/storage/v1/object/public/logos/logo.png"
                  className={inputClasses}
                />
                <p className="text-xs text-sage-400 mt-1">Direct URL to your logo. You can upload one later in Settings.</p>
              </div>

              {/* Colors */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Primary Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={branding.primary_color}
                      onChange={(e) => setBranding({ ...branding, primary_color: e.target.value })}
                      className="w-10 h-10 rounded-lg border border-border cursor-pointer"
                    />
                    <input
                      type="text"
                      value={branding.primary_color}
                      onChange={(e) => {
                        if (/^#[0-9A-Fa-f]{0,6}$/.test(e.target.value))
                          setBranding({ ...branding, primary_color: e.target.value })
                      }}
                      className={inputClasses + ' font-mono'}
                      maxLength={7}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Secondary Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={branding.secondary_color}
                      onChange={(e) => setBranding({ ...branding, secondary_color: e.target.value })}
                      className="w-10 h-10 rounded-lg border border-border cursor-pointer"
                    />
                    <input
                      type="text"
                      value={branding.secondary_color}
                      onChange={(e) => {
                        if (/^#[0-9A-Fa-f]{0,6}$/.test(e.target.value))
                          setBranding({ ...branding, secondary_color: e.target.value })
                      }}
                      className={inputClasses + ' font-mono'}
                      maxLength={7}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Accent Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={branding.accent_color}
                      onChange={(e) => setBranding({ ...branding, accent_color: e.target.value })}
                      className="w-10 h-10 rounded-lg border border-border cursor-pointer"
                    />
                    <input
                      type="text"
                      value={branding.accent_color}
                      onChange={(e) => {
                        if (/^#[0-9A-Fa-f]{0,6}$/.test(e.target.value))
                          setBranding({ ...branding, accent_color: e.target.value })
                      }}
                      className={inputClasses + ' font-mono'}
                      maxLength={7}
                    />
                  </div>
                </div>
              </div>

              {/* Color Preview */}
              <div className="rounded-xl p-5 border border-border" style={{ backgroundColor: branding.primary_color + '0A' }}>
                <p className="text-sm font-medium text-sage-700 mb-3">Preview</p>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="px-5 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: branding.primary_color }}>
                    Primary
                  </div>
                  <div className="px-5 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: branding.secondary_color }}>
                    Secondary
                  </div>
                  <div className="px-3 py-1 rounded-full text-white text-xs font-semibold" style={{ backgroundColor: branding.accent_color }}>
                    Accent Badge
                  </div>
                </div>
              </div>

              {/* Font Pair */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-2">Font Pair</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {fontPairKeys.map((key) => {
                    const fp = FONT_PAIRS[key]
                    return (
                      <button
                        key={key}
                        onClick={() => setBranding({ ...branding, font_pair: key })}
                        className={`text-left p-4 rounded-xl border-2 transition-all ${
                          branding.font_pair === key
                            ? 'border-sage-500 bg-sage-50'
                            : 'border-border hover:border-sage-300'
                        }`}
                      >
                        <p className={`text-sm font-semibold ${
                          branding.font_pair === key ? 'text-sage-900' : 'text-sage-700'
                        }`}>
                          {fp.label}
                        </p>
                        <p className="text-xs text-sage-500 mt-1">{fp.description}</p>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Portal Tagline */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Portal Tagline</label>
                <input
                  type="text"
                  value={branding.portal_tagline}
                  onChange={(e) => setBranding({ ...branding, portal_tagline: e.target.value })}
                  placeholder="Where your love story begins..."
                  className={inputClasses}
                />
                <p className="text-xs text-sage-400 mt-1">Shown on your couple portal login page.</p>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 3: AI Personality                                            */}
          {/* ================================================================ */}
          {currentStep === 2 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
              <div className="flex items-center gap-2 mb-2">
                <Bot className="w-5 h-5 text-sage-500" />
                <h2 className="font-heading text-xl font-semibold text-sage-900">AI Personality</h2>
              </div>

              <p className="text-sm text-sage-500">
                Your AI assistant will handle emails and chat with your couples. Give it a name and personality that matches your venue&apos;s brand.
              </p>

              {/* AI Name + Emoji */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">AI Name</label>
                  <input
                    type="text"
                    value={personality.ai_name}
                    onChange={(e) => setPersonality({ ...personality, ai_name: e.target.value })}
                    placeholder="Sage"
                    className={inputClasses}
                  />
                  <p className="text-xs text-sage-400 mt-1">This name will appear in emails and the couple chat.</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">AI Emoji</label>
                  <div className="flex flex-wrap gap-2">
                    {AI_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => setPersonality({ ...personality, ai_emoji: emoji })}
                        className={`w-10 h-10 rounded-lg text-lg flex items-center justify-center transition-all ${
                          personality.ai_emoji === emoji
                            ? 'bg-sage-500 ring-2 ring-sage-300 scale-110'
                            : 'bg-sage-50 hover:bg-sage-100'
                        }`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Vibe Selection */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-2">Vibe</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {VIBES.map((v) => (
                    <button
                      key={v.value}
                      onClick={() => setPersonality({ ...personality, vibe: v.value })}
                      className={`text-left p-3 rounded-xl border-2 transition-all ${
                        personality.vibe === v.value
                          ? 'border-sage-500 bg-sage-50'
                          : 'border-border hover:border-sage-300'
                      }`}
                    >
                      <p className={`text-sm font-medium ${
                        personality.vibe === v.value ? 'text-sage-900' : 'text-sage-700'
                      }`}>
                        {v.label}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Personality Dimensions */}
              <div className="space-y-5 pt-4 border-t border-border">
                <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider">Personality Dimensions</h3>
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

              {/* Greeting & Closer */}
              <div className="space-y-4 pt-4 border-t border-border">
                <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider">Signature Messages</h3>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Signature Greeting</label>
                  <input
                    type="text"
                    value={personality.signature_greeting}
                    onChange={(e) => setPersonality({ ...personality, signature_greeting: e.target.value })}
                    placeholder="Hi there! Thank you for reaching out to us..."
                    className={inputClasses}
                  />
                  <p className="text-xs text-sage-400 mt-1">How your AI opens emails and chat messages.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Signature Closer</label>
                  <input
                    type="text"
                    value={personality.signature_closer}
                    onChange={(e) => setPersonality({ ...personality, signature_closer: e.target.value })}
                    placeholder="Warmly, Sage"
                    className={inputClasses}
                  />
                  <p className="text-xs text-sage-400 mt-1">How your AI signs off on emails.</p>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 4: Knowledge Base (FAQs)                                     */}
          {/* ================================================================ */}
          {currentStep === 3 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
              <div className="flex items-center gap-2 mb-2">
                <BookOpen className="w-5 h-5 text-sage-500" />
                <h2 className="font-heading text-xl font-semibold text-sage-900">Knowledge Base Quick Start</h2>
              </div>

              <p className="text-sm text-sage-500">
                Add 5&ndash;10 frequently asked questions. Your AI will use these to answer couple inquiries accurately.
                We&apos;ve pre-loaded common questions&nbsp;&mdash; just fill in the answers.
              </p>

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
                      <span className="text-sm font-semibold text-sage-800">FAQ #{idx + 1}</span>
                      {faqs.length > 1 && (
                        <button
                          onClick={() => removeFaq(idx)}
                          className="p-1 text-sage-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-sage-600 mb-1">Category</label>
                      <select
                        value={faq.category}
                        onChange={(e) => updateFaq(idx, 'category', e.target.value)}
                        className={selectClasses}
                      >
                        {FAQ_CATEGORIES.map((c) => (
                          <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                        ))}
                      </select>
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
                  Add Custom FAQ
                </button>
              )}

              <p className="text-xs text-sage-400">
                {faqs.filter((f) => f.question.trim() && f.answer.trim()).length} of {faqs.length} FAQs completed &mdash; you can always add more later in Knowledge Base
              </p>
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 5: Preferred Vendors                                         */}
          {/* ================================================================ */}
          {currentStep === 4 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
              <div className="flex items-center gap-2 mb-2">
                <Store className="w-5 h-5 text-sage-500" />
                <h2 className="font-heading text-xl font-semibold text-sage-900">Preferred Vendors</h2>
              </div>

              <p className="text-sm text-sage-500">
                Add your go-to vendors so couples can easily find them in the portal.
                This step is optional&nbsp;&mdash; you can manage vendors later.
              </p>

              <div className="space-y-4">
                {vendors.map((vendor, idx) => (
                  <div key={idx} className="border border-border rounded-xl p-4 space-y-3 bg-warm-white">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-sage-800">Vendor #{idx + 1}</span>
                      {vendors.length > 1 && (
                        <button
                          onClick={() => removeVendor(idx)}
                          className="p-1 text-sage-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-sage-600 mb-1">Vendor Name</label>
                        <input
                          type="text"
                          value={vendor.vendor_name}
                          onChange={(e) => updateVendor(idx, 'vendor_name', e.target.value)}
                          placeholder="Valley Blooms"
                          className={inputClasses}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-sage-600 mb-1">Type</label>
                        <select
                          value={vendor.vendor_type}
                          onChange={(e) => updateVendor(idx, 'vendor_type', e.target.value)}
                          className={selectClasses}
                        >
                          {VENDOR_TYPES.map((type) => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-sage-600 mb-1">Email</label>
                        <input
                          type="email"
                          value={vendor.contact_email}
                          onChange={(e) => updateVendor(idx, 'contact_email', e.target.value)}
                          placeholder="info@valleyblooms.com"
                          className={inputClasses}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-sage-600 mb-1">Phone</label>
                        <input
                          type="tel"
                          value={vendor.contact_phone}
                          onChange={(e) => updateVendor(idx, 'contact_phone', e.target.value)}
                          placeholder="(804) 555-5678"
                          className={inputClasses}
                        />
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-sage-600 mb-1">Website</label>
                        <input
                          type="url"
                          value={vendor.website_url}
                          onChange={(e) => updateVendor(idx, 'website_url', e.target.value)}
                          placeholder="https://valleyblooms.com"
                          className={inputClasses}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {vendors.length < 10 && (
                <button
                  onClick={addVendor}
                  className="flex items-center gap-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add Another Vendor
                </button>
              )}
            </div>
          )}

          {/* ================================================================ */}
          {/* Step 6: Seasonal Info                                             */}
          {/* ================================================================ */}
          {currentStep === 5 && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
              <div className="flex items-center gap-2 mb-2">
                <Sun className="w-5 h-5 text-sage-500" />
                <h2 className="font-heading text-xl font-semibold text-sage-900">Seasonal Info</h2>
              </div>

              <p className="text-sm text-sage-500">
                Help your AI understand when things get busy and any seasonal nuances.
                This step is optional&nbsp;&mdash; you can skip it and add details later.
              </p>

              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Peak Season</label>
                  <textarea
                    value={seasonal.peak_season}
                    onChange={(e) => setSeasonal({ ...seasonal, peak_season: e.target.value })}
                    placeholder="e.g., May through October is our busiest time. Saturdays in June and September book 12+ months out..."
                    className={inputClasses + ' resize-none'}
                    rows={3}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Off-Season</label>
                  <textarea
                    value={seasonal.off_season}
                    onChange={(e) => setSeasonal({ ...seasonal, off_season: e.target.value })}
                    placeholder="e.g., November through March. We offer 20% off rental fees for Friday or Sunday weddings in January and February..."
                    className={inputClasses + ' resize-none'}
                    rows={3}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Special Considerations</label>
                  <textarea
                    value={seasonal.special_considerations}
                    onChange={(e) => setSeasonal({ ...seasonal, special_considerations: e.target.value })}
                    placeholder="e.g., Our outdoor spaces are not available December through February. We host a holiday market in early December that blocks the first two weekends..."
                    className={inputClasses + ' resize-none'}
                    rows={3}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* Navigation                                                        */}
          {/* ================================================================ */}
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
              {isOptionalStep && (
                <button
                  onClick={handleSkip}
                  className="flex items-center gap-2 text-sm font-medium text-sage-500 hover:text-sage-700 transition-colors"
                >
                  <SkipForward className="w-4 h-4" />
                  Skip
                </button>
              )}
              <button
                onClick={handleNext}
                disabled={saving || (currentStep === 0 && !basics.business_name.trim())}
                className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-6 py-2.5 transition-colors text-sm"
              >
                {saving ? 'Saving...' : currentStep === STEPS.length - 1 ? 'Finish Setup' : 'Next'}
                {!saving && currentStep < STEPS.length - 1 && <ArrowRight className="w-4 h-4" />}
                {!saving && currentStep === STEPS.length - 1 && <Sparkles className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
