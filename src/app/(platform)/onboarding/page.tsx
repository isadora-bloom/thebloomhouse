'use client'

import { useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Building2,
  Palette,
  Bot,
  BookOpen,
  Mail,
  Rocket,
  ArrowLeft,
  ArrowRight,
  Check,
  Plus,
  Trash2,
  Sparkles,
} from 'lucide-react'

// TODO: Replace with org from auth context
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepConfig {
  key: string
  label: string
  icon: React.ReactNode
}

interface VenueBasics {
  name: string
  slug: string
  address: string
  capacity: string
  timezone: string
}

interface Branding {
  primary_color: string
  secondary_color: string
  accent_color: string
  font_pair: string
  logo_url: string
}

interface AIPersonality {
  ai_name: string
  warmth_level: number
  formality_level: number
  playfulness_level: number
  enthusiasm_level: number
  brevity_level: number
  phrase_style: string
  vibe: string
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
  { key: 'basics', label: 'Venue Basics', icon: <Building2 className="w-5 h-5" /> },
  { key: 'branding', label: 'Branding', icon: <Palette className="w-5 h-5" /> },
  { key: 'personality', label: 'AI Personality', icon: <Bot className="w-5 h-5" /> },
  { key: 'knowledge', label: 'Knowledge Base', icon: <BookOpen className="w-5 h-5" /> },
  { key: 'gmail', label: 'Gmail Connect', icon: <Mail className="w-5 h-5" /> },
  { key: 'review', label: 'Review & Launch', icon: <Rocket className="w-5 h-5" /> },
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

const FONT_PAIRS = [
  { value: 'playfair_inter', label: 'Playfair Display + Inter' },
  { value: 'cormorant_lato', label: 'Cormorant Garamond + Lato' },
  { value: 'eb_garamond_source_sans', label: 'EB Garamond + Source Sans' },
  { value: 'libre_baskerville_raleway', label: 'Libre Baskerville + Raleway' },
  { value: 'josefin_slab_open_sans', label: 'Josefin Slab + Open Sans' },
]

const PHRASE_STYLES = [
  { value: 'warm', label: 'Warm', desc: 'Friendly and inviting, like a conversation with a trusted friend' },
  { value: 'playful', label: 'Playful', desc: 'Fun and energetic, with a touch of wit' },
  { value: 'professional', label: 'Professional', desc: 'Polished and elegant, confidence without stiffness' },
  { value: 'enthusiastic', label: 'Enthusiastic', desc: 'Excited and passionate, genuine enthusiasm' },
]

const VIBES = [
  { value: 'romantic_timeless', label: 'Romantic & Timeless' },
  { value: 'fun_modern', label: 'Fun & Modern' },
  { value: 'rustic_cozy', label: 'Rustic & Cozy' },
  { value: 'luxurious_exclusive', label: 'Luxurious & Exclusive' },
  { value: 'garden_whimsical', label: 'Garden & Whimsical' },
  { value: 'industrial_chic', label: 'Industrial Chic' },
]

const FAQ_CATEGORIES = ['General', 'Pricing', 'Catering', 'Ceremony', 'Accommodation', 'Logistics', 'Policy']

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

const selectClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Step Indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => {
        const stepNum = i + 1
        const isCompleted = stepNum < current + 1
        const isActive = stepNum === current + 1

        return (
          <div key={i} className="flex items-center gap-2">
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${
                isCompleted
                  ? 'bg-sage-500 text-white'
                  : isActive
                    ? 'bg-sage-500 text-white ring-4 ring-sage-200'
                    : 'bg-sage-100 text-sage-400'
              }`}
            >
              {isCompleted ? <Check className="w-4 h-4" /> : stepNum}
            </div>
            {i < total - 1 && (
              <div className={`w-8 h-0.5 ${isCompleted ? 'bg-sage-500' : 'bg-sage-200'}`} />
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
  const [currentStep, setCurrentStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1: Venue Basics
  const [basics, setBasics] = useState<VenueBasics>({
    name: '',
    slug: '',
    address: '',
    capacity: '',
    timezone: 'America/New_York',
  })

  // Step 2: Branding
  const [branding, setBranding] = useState<Branding>({
    primary_color: '#7D8471',
    secondary_color: '#5D7A7A',
    accent_color: '#A6894A',
    font_pair: 'playfair_inter',
    logo_url: '',
  })

  // Step 3: AI Personality
  const [personality, setPersonality] = useState<AIPersonality>({
    ai_name: 'Sage',
    warmth_level: 7,
    formality_level: 4,
    playfulness_level: 5,
    enthusiasm_level: 6,
    brevity_level: 6,
    phrase_style: 'warm',
    vibe: 'romantic_timeless',
  })

  // Step 4: Knowledge Base
  const [faqs, setFaqs] = useState<FAQItem[]>([
    { category: 'General', question: '', answer: '' },
  ])

  // Step 5: Gmail
  const [gmailConnected, setGmailConnected] = useState(false)

  const supabase = createClient()

  // ---- Slug generation ----
  function generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim()
  }

  // ---- Save progress at each step ----
  const saveStep = useCallback(async () => {
    setSaving(true)
    setError(null)

    try {
      switch (currentStep) {
        case 0: {
          // Save venue basics
          const { error: venueError } = await supabase
            .from('venues')
            .upsert({
              id: VENUE_ID,
              name: basics.name,
              slug: basics.slug || generateSlug(basics.name),
              status: 'trial',
              plan_tier: 'starter',
              updated_at: new Date().toISOString(),
            }, { onConflict: 'id' })
          if (venueError) throw venueError

          const { error: configError } = await supabase
            .from('venue_config')
            .upsert({
              venue_id: VENUE_ID,
              business_name: basics.name,
              capacity: basics.capacity ? parseInt(basics.capacity) : null,
              timezone: basics.timezone,
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
              primary_color: branding.primary_color,
              secondary_color: branding.secondary_color,
              accent_color: branding.accent_color,
              font_pair: branding.font_pair,
              logo_url: branding.logo_url || null,
              updated_at: new Date().toISOString(),
            })
            .eq('venue_id', VENUE_ID)
          if (brandError) throw brandError
          break
        }
        case 2: {
          // Save AI personality
          const { error: aiError } = await supabase
            .from('venue_ai_config')
            .upsert({
              venue_id: VENUE_ID,
              ai_name: personality.ai_name,
              warmth_level: personality.warmth_level,
              formality_level: personality.formality_level,
              playfulness_level: personality.playfulness_level,
              enthusiasm_level: personality.enthusiasm_level,
              brevity_level: personality.brevity_level,
              phrase_style: personality.phrase_style,
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
            const { error: kbError } = await supabase
              .from('knowledge_base')
              .insert(
                validFaqs.map((f) => ({
                  venue_id: VENUE_ID,
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
        // Steps 4 (Gmail) and 5 (Review) don't save incrementally
      }
    } catch (err: any) {
      console.error('Failed to save step:', err)
      setError(err.message || 'Failed to save. Please try again.')
      setSaving(false)
      return false
    }

    setSaving(false)
    return true
  }, [currentStep, basics, branding, personality, faqs, supabase])

  // ---- Navigation ----
  async function handleNext() {
    const success = await saveStep()
    if (success) {
      setCurrentStep((prev) => Math.min(prev + 1, STEPS.length - 1))
    }
  }

  function handleBack() {
    setCurrentStep((prev) => Math.max(prev - 1, 0))
  }

  // ---- Launch venue ----
  async function handleLaunch() {
    setSaving(true)
    setError(null)

    try {
      const { error: launchError } = await supabase
        .from('venues')
        .update({
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('id', VENUE_ID)

      if (launchError) throw launchError

      // Redirect to dashboard
      window.location.href = '/agent/inbox'
    } catch (err: any) {
      console.error('Failed to launch venue:', err)
      setError(err.message || 'Failed to launch. Please try again.')
      setSaving(false)
    }
  }

  // ---- FAQ helpers ----
  function addFaq() {
    setFaqs((prev) => [...prev, { category: 'General', question: '', answer: '' }])
  }

  function removeFaq(index: number) {
    setFaqs((prev) => prev.filter((_, i) => i !== index))
  }

  function updateFaq(index: number, field: keyof FAQItem, value: string) {
    setFaqs((prev) => prev.map((f, i) => (i === index ? { ...f, [field]: value } : f)))
  }

  const isLastStep = currentStep === STEPS.length - 1

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div className="text-center">
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-2">
          Set Up Your Venue
        </h1>
        <p className="text-sage-600">
          {STEPS[currentStep].label} &mdash; Step {currentStep + 1} of {STEPS.length}
        </p>
      </div>

      {/* Step Indicator */}
      <StepIndicator current={currentStep} total={STEPS.length} />

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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-sage-700 mb-1">Venue Name</label>
              <input
                type="text"
                value={basics.name}
                onChange={(e) => {
                  setBasics({ ...basics, name: e.target.value, slug: generateSlug(e.target.value) })
                }}
                placeholder="Crestwood Manor"
                className={inputClasses}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">URL Slug</label>
              <div className="flex items-center gap-0">
                <span className="px-3 py-2 bg-sage-50 border border-r-0 border-border rounded-l-lg text-sm text-sage-500">
                  bloomhouse.ai/
                </span>
                <input
                  type="text"
                  value={basics.slug}
                  onChange={(e) => setBasics({ ...basics, slug: e.target.value })}
                  placeholder="crestwood-manor"
                  className={inputClasses + ' rounded-l-none'}
                />
              </div>
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

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-sage-700 mb-1">Address</label>
              <input
                type="text"
                value={basics.address}
                onChange={(e) => setBasics({ ...basics, address: e.target.value })}
                placeholder="123 Manor Lane, Richmond, VA 23220"
                className={inputClasses}
              />
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

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Font Pair</label>
            <select
              value={branding.font_pair}
              onChange={(e) => setBranding({ ...branding, font_pair: e.target.value })}
              className={selectClasses + ' max-w-md'}
            >
              {FONT_PAIRS.map((fp) => (
                <option key={fp.value} value={fp.value}>{fp.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Logo URL</label>
            <input
              type="text"
              value={branding.logo_url}
              onChange={(e) => setBranding({ ...branding, logo_url: e.target.value })}
              placeholder="https://your-bucket.supabase.co/storage/v1/object/public/logos/logo.png"
              className={inputClasses}
            />
            <p className="text-xs text-sage-400 mt-1">Direct URL to your logo. File upload coming soon.</p>
          </div>

          {/* Color Preview */}
          <div className="rounded-xl p-6 border border-border" style={{ backgroundColor: branding.primary_color + '0A' }}>
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

          {/* AI Name */}
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
              <label className="block text-sm font-medium text-sage-700 mb-1">Vibe</label>
              <select
                value={personality.vibe}
                onChange={(e) => setPersonality({ ...personality, vibe: e.target.value })}
                className={selectClasses}
              >
                {VIBES.map((v) => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Phrase Style */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-3">Phrase Style</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {PHRASE_STYLES.map((style) => (
                <button
                  key={style.value}
                  onClick={() => setPersonality({ ...personality, phrase_style: style.value })}
                  className={`text-left p-4 rounded-xl border-2 transition-all ${
                    personality.phrase_style === style.value
                      ? 'border-sage-500 bg-sage-50'
                      : 'border-border hover:border-sage-300'
                  }`}
                >
                  <p className={`text-sm font-semibold ${
                    personality.phrase_style === style.value ? 'text-sage-900' : 'text-sage-700'
                  }`}>
                    {style.label}
                  </p>
                  <p className="text-xs text-sage-500 mt-1">{style.desc}</p>
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
        </div>
      )}

      {/* ================================================================ */}
      {/* Step 4: Knowledge Base (FAQs)                                     */}
      {/* ================================================================ */}
      {currentStep === 3 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-5 h-5 text-sage-500" />
            <h2 className="font-heading text-xl font-semibold text-sage-900">Knowledge Base</h2>
          </div>

          <p className="text-sm text-sage-500">
            Add 5&ndash;10 frequently asked questions. Your AI will use these to answer couple inquiries accurately.
            You can always add more later.
          </p>

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
                      <option key={c} value={c}>{c}</option>
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
              Add Another FAQ
            </button>
          )}

          <p className="text-xs text-sage-400">
            {faqs.filter((f) => f.question.trim() && f.answer.trim()).length} of {faqs.length} FAQs completed
          </p>
        </div>
      )}

      {/* ================================================================ */}
      {/* Step 5: Gmail Connect                                             */}
      {/* ================================================================ */}
      {currentStep === 4 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
          <div className="flex items-center gap-2 mb-2">
            <Mail className="w-5 h-5 text-sage-500" />
            <h2 className="font-heading text-xl font-semibold text-sage-900">Connect Gmail</h2>
          </div>

          <p className="text-sm text-sage-500">
            Connect your venue&apos;s Gmail account so the Agent can read inquiries and send responses.
            This step is optional &mdash; you can connect later in Agent Settings.
          </p>

          <div className="bg-warm-white border border-border rounded-xl p-8 text-center space-y-4">
            <Mail className={`w-16 h-16 mx-auto ${gmailConnected ? 'text-green-500' : 'text-sage-300'}`} />

            {gmailConnected ? (
              <>
                <h3 className="font-heading text-lg font-semibold text-sage-900">Gmail Connected</h3>
                <p className="text-sm text-sage-500">
                  Your Gmail account is linked. The Agent will start syncing emails after launch.
                </p>
              </>
            ) : (
              <>
                <h3 className="font-heading text-lg font-semibold text-sage-900">Not Connected Yet</h3>
                <p className="text-sm text-sage-500 max-w-md mx-auto">
                  Connecting Gmail allows the Agent to process incoming emails automatically and generate draft responses.
                </p>
                <a
                  href="/api/auth/gmail"
                  onClick={(e) => {
                    // In production this would do OAuth; for now we simulate
                    e.preventDefault()
                    setGmailConnected(true)
                  }}
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-6 py-3 transition-colors text-sm"
                >
                  <Mail className="w-4 h-4" />
                  Connect Gmail Account
                </a>
              </>
            )}
          </div>

          <div className="bg-sage-50 rounded-xl p-4 text-sm text-sage-600">
            <p className="font-medium text-sage-800 mb-1">What permissions are needed?</p>
            <ul className="list-disc pl-5 space-y-1 text-sage-500">
              <li>Read incoming emails to detect inquiries and client messages</li>
              <li>Send emails on behalf of your venue (only when you approve)</li>
              <li>We never delete, forward, or modify your existing emails</li>
            </ul>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* Step 6: Review & Launch                                           */}
      {/* ================================================================ */}
      {currentStep === 5 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
          <div className="flex items-center gap-2 mb-2">
            <Rocket className="w-5 h-5 text-sage-500" />
            <h2 className="font-heading text-xl font-semibold text-sage-900">Review & Launch</h2>
          </div>

          <p className="text-sm text-sage-500">
            Review your configuration before launching. You can always change these settings later.
          </p>

          {/* Summary cards */}
          <div className="space-y-4">
            {/* Venue */}
            <div className="bg-warm-white border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Building2 className="w-4 h-4 text-sage-500" />
                <h3 className="text-sm font-semibold text-sage-800">Venue</h3>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <p className="text-sage-500">Name:</p>
                <p className="text-sage-900 font-medium">{basics.name || 'Not set'}</p>
                <p className="text-sage-500">Slug:</p>
                <p className="text-sage-900 font-medium">{basics.slug || 'Not set'}</p>
                <p className="text-sage-500">Capacity:</p>
                <p className="text-sage-900 font-medium">{basics.capacity || 'Not set'}</p>
                <p className="text-sage-500">Timezone:</p>
                <p className="text-sage-900 font-medium">{basics.timezone.replace(/_/g, ' ')}</p>
              </div>
            </div>

            {/* Branding */}
            <div className="bg-warm-white border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Palette className="w-4 h-4 text-sage-500" />
                <h3 className="text-sm font-semibold text-sage-800">Branding</h3>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg border border-border" style={{ backgroundColor: branding.primary_color }} />
                <div className="w-8 h-8 rounded-lg border border-border" style={{ backgroundColor: branding.secondary_color }} />
                <div className="w-8 h-8 rounded-lg border border-border" style={{ backgroundColor: branding.accent_color }} />
                <span className="text-sm text-sage-600 ml-2">
                  {FONT_PAIRS.find((fp) => fp.value === branding.font_pair)?.label}
                </span>
              </div>
            </div>

            {/* AI */}
            <div className="bg-warm-white border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Bot className="w-4 h-4 text-sage-500" />
                <h3 className="text-sm font-semibold text-sage-800">AI Personality</h3>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <p className="text-sage-500">Name:</p>
                <p className="text-sage-900 font-medium">{personality.ai_name}</p>
                <p className="text-sage-500">Style:</p>
                <p className="text-sage-900 font-medium capitalize">{personality.phrase_style}</p>
                <p className="text-sage-500">Vibe:</p>
                <p className="text-sage-900 font-medium">{VIBES.find((v) => v.value === personality.vibe)?.label}</p>
              </div>
            </div>

            {/* Knowledge Base */}
            <div className="bg-warm-white border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <BookOpen className="w-4 h-4 text-sage-500" />
                <h3 className="text-sm font-semibold text-sage-800">Knowledge Base</h3>
              </div>
              <p className="text-sm text-sage-600">
                {faqs.filter((f) => f.question.trim() && f.answer.trim()).length} FAQ{faqs.filter((f) => f.question.trim() && f.answer.trim()).length !== 1 ? 's' : ''} configured
              </p>
            </div>

            {/* Gmail */}
            <div className="bg-warm-white border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Mail className="w-4 h-4 text-sage-500" />
                <h3 className="text-sm font-semibold text-sage-800">Gmail</h3>
              </div>
              <p className={`text-sm font-medium ${gmailConnected ? 'text-green-600' : 'text-sage-400'}`}>
                {gmailConnected ? 'Connected' : 'Not connected (can be set up later)'}
              </p>
            </div>
          </div>

          {/* Launch button */}
          <div className="pt-4 text-center">
            <button
              onClick={handleLaunch}
              disabled={saving || !basics.name.trim()}
              className="inline-flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl px-8 py-3.5 transition-colors text-base shadow-sm"
            >
              <Sparkles className="w-5 h-5" />
              {saving ? 'Launching...' : 'Launch Your Venue'}
            </button>
            {!basics.name.trim() && (
              <p className="text-xs text-red-500 mt-2">Please go back and enter a venue name.</p>
            )}
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* Navigation                                                        */}
      {/* ================================================================ */}
      {!isLastStep && (
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={handleBack}
            disabled={currentStep === 0}
            className="flex items-center gap-2 text-sm font-medium text-sage-600 hover:text-sage-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <button
            onClick={handleNext}
            disabled={saving}
            className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-6 py-2.5 transition-colors text-sm"
          >
            {saving ? 'Saving...' : 'Next'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
      {isLastStep && (
        <div className="flex items-center justify-start pt-2">
          <button
            onClick={handleBack}
            className="flex items-center gap-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        </div>
      )}
    </div>
  )
}
