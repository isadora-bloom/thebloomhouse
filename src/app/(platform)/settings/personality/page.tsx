'use client'

import { useState, useEffect, useCallback } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { useScope } from '@/lib/hooks/use-scope'
import {
  Bot, Save, Sliders, MessageSquare, Sparkles, Mic, Send,
  Zap, Heart, SmilePlus, X,
} from 'lucide-react'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AIConfig {
  id: string
  venue_id: string
  ai_name: string
  ai_email: string | null
  ai_emoji: string | null
  warmth_level: number
  formality_level: number
  playfulness_level: number
  brevity_level: number
  enthusiasm_level: number
  uses_contractions: boolean
  uses_exclamation_points: boolean
  emoji_level: string
  phrase_style: string
  vibe: string
  follow_up_style: string
  max_follow_ups: number
  escalation_style: string
  sales_approach: string
  signature_greeting: string | null
  signature_closer: string | null
  signature_expressions: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERSONALITY_DIMENSIONS: {
  key: keyof Pick<AIConfig, 'warmth_level' | 'formality_level' | 'playfulness_level' | 'brevity_level' | 'enthusiasm_level'>
  label: string
  minLabel: string
  maxLabel: string
  icon: typeof Heart
}[] = [
  { key: 'warmth_level', label: 'Warmth', minLabel: 'Reserved', maxLabel: 'Very Warm', icon: Heart },
  { key: 'formality_level', label: 'Formality', minLabel: 'Casual', maxLabel: 'Formal', icon: Bot },
  { key: 'playfulness_level', label: 'Playfulness', minLabel: 'Serious', maxLabel: 'Playful', icon: SmilePlus },
  { key: 'brevity_level', label: 'Brevity', minLabel: 'Verbose', maxLabel: 'Concise', icon: MessageSquare },
  { key: 'enthusiasm_level', label: 'Enthusiasm', minLabel: 'Measured', maxLabel: 'Energetic', icon: Zap },
]

const PHRASE_STYLES = [
  { value: 'warm', label: 'Warm', description: 'Friendly and heartfelt' },
  { value: 'playful', label: 'Playful', description: 'Light and fun' },
  { value: 'professional', label: 'Professional', description: 'Polished and composed' },
  { value: 'enthusiastic', label: 'Enthusiastic', description: 'Energetic and exciting' },
]

const VIBE_OPTIONS = [
  { value: 'romantic_timeless', label: 'Romantic Timeless' },
  { value: 'rustic_charm', label: 'Rustic Charm' },
  { value: 'modern_minimal', label: 'Modern Minimal' },
  { value: 'garden_romantic', label: 'Garden Romantic' },
  { value: 'classic_estate', label: 'Classic Estate' },
  { value: 'bohemian_chic', label: 'Bohemian Chic' },
  { value: 'coastal_elegant', label: 'Coastal Elegant' },
  { value: 'mountain_lodge', label: 'Mountain Lodge' },
]

const EMOJI_LEVELS = [
  { value: 'none', label: 'None', description: 'No emojis in emails' },
  { value: 'signoff_only', label: 'Sign-off Only', description: 'One emoji in closing' },
  { value: 'moderate', label: 'Moderate', description: 'A few emojis for warmth' },
  { value: 'liberal', label: 'Liberal', description: 'Emojis throughout' },
]

const FOLLOW_UP_STYLES = [
  { value: 'none', label: 'None', description: 'Never follow up automatically' },
  { value: 'light', label: 'Light', description: 'One gentle nudge' },
  { value: 'moderate', label: 'Moderate', description: 'Balanced follow-ups' },
  { value: 'persistent', label: 'Persistent', description: 'Stay on top of every lead' },
]

const ESCALATION_STYLES = [
  { value: 'immediate', label: 'Immediate', description: 'Escalate to human right away' },
  { value: 'soft_offer', label: 'Soft Offer', description: 'Offer to connect with team' },
  { value: 'reassure_first', label: 'Reassure First', description: 'Handle what you can, then offer' },
]

const SALES_APPROACHES = [
  { value: 'direct', label: 'Direct', description: 'Straightforward pricing and availability' },
  { value: 'consultative', label: 'Consultative', description: 'Ask questions, understand needs' },
  { value: 'experience_first', label: 'Experience First', description: 'Paint the picture before pricing' },
  { value: 'tour_first', label: 'Tour First', description: 'Always push toward a tour' },
]

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors'

const selectClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PersonalityPage() {
  const { venueId, loading: scopeLoading } = useScope()
  const [config, setConfig] = useState<AIConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [newExpression, setNewExpression] = useState('')

  // Load venue-specific AI config. Previously did `.limit(1).single()`
  // with no filter, which loaded whichever venue_ai_config row Postgres
  // returned first — fine for a single-venue org, wrong for anyone else.
  useEffect(() => {
    if (scopeLoading) return
    if (!venueId) {
      setLoading(false)
      return
    }
    async function load() {
      const { data, error } = await supabase
        .from('venue_ai_config')
        .select('*')
        .eq('venue_id', venueId)
        .maybeSingle()

      if (error) {
        console.error('Failed to load AI config:', error)
      }
      if (data) {
        setConfig({
          ...data,
          signature_expressions: data.signature_expressions ?? [],
        } as AIConfig)
      }
      setLoading(false)
    }
    load()
  }, [venueId, scopeLoading])

  // Save handler
  const handleSave = useCallback(async () => {
    if (!config) return
    setSaving(true)
    setSaveMessage(null)

    const { error } = await supabase
      .from('venue_ai_config')
      .update({
        ai_name: config.ai_name,
        ai_email: config.ai_email,
        ai_emoji: config.ai_emoji,
        warmth_level: config.warmth_level,
        formality_level: config.formality_level,
        playfulness_level: config.playfulness_level,
        brevity_level: config.brevity_level,
        enthusiasm_level: config.enthusiasm_level,
        uses_contractions: config.uses_contractions,
        uses_exclamation_points: config.uses_exclamation_points,
        emoji_level: config.emoji_level,
        phrase_style: config.phrase_style,
        vibe: config.vibe,
        follow_up_style: config.follow_up_style,
        max_follow_ups: config.max_follow_ups,
        escalation_style: config.escalation_style,
        sales_approach: config.sales_approach,
        signature_greeting: config.signature_greeting,
        signature_closer: config.signature_closer,
        signature_expressions: config.signature_expressions,
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id)

    if (error) {
      console.error('Save failed:', error)
      setSaveMessage('Failed to save. Please try again.')
    } else {
      setSaveMessage('Personality settings saved successfully.')
    }
    setSaving(false)
    setTimeout(() => setSaveMessage(null), 3000)
  }, [config])

  // Updater helper
  function update<K extends keyof AIConfig>(key: K, value: AIConfig[K]) {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  // Expression management
  function addExpression() {
    const trimmed = newExpression.trim()
    if (!trimmed || !config) return
    if (config.signature_expressions.includes(trimmed)) return
    update('signature_expressions', [...config.signature_expressions, trimmed])
    setNewExpression('')
  }

  function removeExpression(expr: string) {
    if (!config) return
    update('signature_expressions', config.signature_expressions.filter((e) => e !== expr))
  }

  // ---------------------------------------------------------------------------
  // Preview email generation
  // ---------------------------------------------------------------------------
  function generatePreviewEmail(): string {
    if (!config) return ''

    const name = config.ai_name || 'Sage'
    const emoji = config.ai_emoji || ''
    const warmth = config.warmth_level
    const formality = config.formality_level
    const enthusiasm = config.enthusiasm_level
    const brevity = config.brevity_level
    const usesContractions = config.uses_contractions
    const usesExclamation = config.uses_exclamation_points

    // Greeting
    const greeting = config.signature_greeting
      || (warmth >= 7 ? 'Hi there' : formality >= 7 ? 'Good afternoon' : 'Hello')

    // Opening
    const excl = usesExclamation ? '!' : '.'
    const openingWarm = warmth >= 7
      ? `Thank you so much for reaching out${excl} ${usesContractions ? "We're" : "We are"} absolutely thrilled ${usesContractions ? "you're" : "you are"} considering us for your special day.`
      : warmth >= 4
        ? `Thank you for your inquiry${excl} ${usesContractions ? "We'd" : "We would"} love to help you plan your wedding.`
        : `Thank you for contacting us. We would be pleased to assist with your wedding planning.`

    // Middle based on sales approach
    let middle = ''
    switch (config.sales_approach) {
      case 'direct':
        middle = `We have availability on your requested date. Our starting package is competitively priced and includes the full venue, setup, and day-of coordination.`
        break
      case 'experience_first':
        middle = enthusiasm >= 7
          ? `Imagine exchanging vows surrounded by rolling hills and golden hour light${excl} Every couple who visits says the same thing — the grounds just take your breath away.`
          : `Our venue offers a truly unique setting. The grounds provide a beautiful backdrop for ceremonies and receptions alike.`
        break
      case 'tour_first':
        middle = `The best way to experience what we offer is to see it in person. ${usesContractions ? "I'd" : "I would"} love to arrange a private tour so you can picture your day here.`
        break
      default: // consultative
        middle = `${usesContractions ? "I'd" : "I would"} love to learn more about your vision${excl} Could you share a bit about what ${usesContractions ? "you're" : "you are"} envisioning for the day — your guest count, preferred style, and any must-haves?`
    }

    // Trim for brevity
    if (brevity >= 8) {
      middle = middle.split('.')[0] + '.'
    }

    // Closer
    const closer = config.signature_closer
      || (warmth >= 7 ? 'Warmly' : formality >= 7 ? 'Best regards' : 'Best')

    // Emoji in signoff
    const signoffEmoji = config.emoji_level === 'none' ? '' : ` ${emoji}`

    // Signature expressions
    const exprLine = config.signature_expressions.length > 0
      ? `\n\nP.S. ${config.signature_expressions[0]}`
      : ''

    return `${greeting},

${openingWarm}

${middle}${exprLine}

${closer},${signoffEmoji}
${name}`
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function RadioGroup({
    options,
    value,
    onChange,
  }: {
    options: { value: string; label: string; description: string }[]
    value: string
    onChange: (v: string) => void
  }) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={`relative flex flex-col p-3 rounded-lg border cursor-pointer transition-all ${
              value === opt.value
                ? 'border-sage-500 bg-sage-50 ring-2 ring-sage-200'
                : 'border-border hover:border-sage-300'
            }`}
          >
            <input
              type="radio"
              name={opt.value + '-radio'}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            <span className="text-sm font-medium text-sage-900">{opt.label}</span>
            <span className="text-xs text-sage-500 mt-0.5">{opt.description}</span>
          </label>
        ))}
      </div>
    )
  }

  function ToggleSwitch({
    label,
    description,
    checked,
    onChange,
  }: {
    label: string
    description?: string
    checked: boolean
    onChange: (v: boolean) => void
  }) {
    return (
      <label className="flex items-center justify-between gap-4 cursor-pointer group">
        <div>
          <span className="text-sm font-medium text-sage-900">{label}</span>
          {description && <p className="text-xs text-sage-500">{description}</p>}
        </div>
        <div className="relative">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 rounded-full bg-sage-200 peer-checked:bg-sage-500 transition-colors" />
          <div className="absolute left-0.5 top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
        </div>
      </label>
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-pulse text-sage-500 text-sm">Loading AI personality...</div>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-sage-500 text-sm">No AI configuration found. Please seed your database first.</div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <Sparkles className="w-8 h-8 text-sage-500" />
            AI Personality
          </h1>
          <p className="text-sage-600">
            Shape your AI&apos;s personality — warmth, formality, playfulness, and how she signs off. Preview changes in real-time to make sure the voice feels authentically yours.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-6 py-2.5 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Save feedback */}
      {saveMessage && (
        <div className={`px-4 py-2 rounded-lg text-sm font-medium ${
          saveMessage.includes('success') ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {saveMessage}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Identity Section                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Bot className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Identity</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">AI Name</label>
            <input
              type="text"
              value={config.ai_name}
              onChange={(e) => update('ai_name', e.target.value)}
              placeholder="Sage"
              className={inputClasses}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Emoji</label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={config.ai_emoji ?? ''}
                onChange={(e) => update('ai_emoji', e.target.value)}
                placeholder="e.g. a leaf or sparkle emoji"
                className={inputClasses}
                maxLength={4}
              />
              {config.ai_emoji && (
                <span className="text-3xl">{config.ai_emoji}</span>
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">AI Email</label>
            <input
              type="email"
              value={config.ai_email ?? ''}
              onChange={(e) => update('ai_email', e.target.value)}
              placeholder="sage@yourvenue.com"
              className={inputClasses}
            />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Personality Dimensions                                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Sliders className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Personality Dimensions</h2>
        </div>

        <div className="space-y-6">
          {PERSONALITY_DIMENSIONS.map(({ key, label, minLabel, maxLabel, icon: Icon }) => {
            const value = config[key] as number
            return (
              <div key={key}>
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-sage-700">
                    <Icon className="w-4 h-4 text-sage-400" />
                    {label}
                  </label>
                  <span className="text-sm font-bold text-sage-900 bg-sage-100 rounded-full w-8 h-8 flex items-center justify-center">
                    {value}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-sage-500 w-20 text-right shrink-0">{minLabel}</span>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={value}
                    onChange={(e) => update(key, parseInt(e.target.value, 10))}
                    className="w-full accent-sage-500 h-2 rounded-full"
                  />
                  <span className="text-xs text-sage-500 w-20 shrink-0">{maxLabel}</span>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Style Section                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Mic className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Style</h2>
        </div>

        {/* Phrase Style */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-3">Phrase Style</label>
          <RadioGroup
            options={PHRASE_STYLES}
            value={config.phrase_style}
            onChange={(v) => update('phrase_style', v)}
          />
        </div>

        {/* Vibe */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-1">Vibe</label>
          <select
            value={config.vibe}
            onChange={(e) => update('vibe', e.target.value)}
            className={selectClasses + ' max-w-md'}
          >
            {VIBE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-sage-500 mt-1">Overall aesthetic vibe that influences language and imagery choices.</p>
        </div>

        {/* Emoji Level */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-3">Emoji Usage</label>
          <RadioGroup
            options={EMOJI_LEVELS}
            value={config.emoji_level}
            onChange={(v) => update('emoji_level', v)}
          />
        </div>

        {/* Toggles */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
          <ToggleSwitch
            label="Uses Contractions"
            description={`e.g. "we'd" instead of "we would"`}
            checked={config.uses_contractions}
            onChange={(v) => update('uses_contractions', v)}
          />
          <ToggleSwitch
            label="Uses Exclamation Points"
            description="Adds energy with exclamation marks"
            checked={config.uses_exclamation_points}
            onChange={(v) => update('uses_exclamation_points', v)}
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Behavior Section                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Send className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Behavior</h2>
        </div>

        {/* Follow-up Style */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-3">Follow-up Style</label>
          <RadioGroup
            options={FOLLOW_UP_STYLES}
            value={config.follow_up_style}
            onChange={(v) => update('follow_up_style', v)}
          />
        </div>

        {/* Max Follow-ups */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-1">Max Follow-ups</label>
          <input
            type="number"
            min={0}
            max={10}
            value={config.max_follow_ups}
            onChange={(e) => update('max_follow_ups', parseInt(e.target.value, 10) || 0)}
            className={inputClasses + ' max-w-[120px]'}
          />
          <p className="text-xs text-sage-500 mt-1">Maximum number of automated follow-up emails per lead.</p>
        </div>

        {/* Escalation Style */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-3">Escalation Style</label>
          <RadioGroup
            options={ESCALATION_STYLES}
            value={config.escalation_style}
            onChange={(v) => update('escalation_style', v)}
          />
        </div>

        {/* Sales Approach */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-3">Sales Approach</label>
          <RadioGroup
            options={SALES_APPROACHES}
            value={config.sales_approach}
            onChange={(v) => update('sales_approach', v)}
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Signature Section                                                   */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Signature</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Greeting</label>
            <input
              type="text"
              value={config.signature_greeting ?? ''}
              onChange={(e) => update('signature_greeting', e.target.value || null)}
              placeholder="Hi there"
              className={inputClasses}
            />
            <p className="text-xs text-sage-500 mt-1">Default greeting. Sage will also use the client&apos;s first name when available and naturally rotate between warm openers.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Closer</label>
            <input
              type="text"
              value={config.signature_closer ?? ''}
              onChange={(e) => update('signature_closer', e.target.value || null)}
              placeholder="Warmly"
              className={inputClasses}
            />
            <p className="text-xs text-sage-500 mt-1">How the AI signs off every email.</p>
          </div>
        </div>

        {/* Signature Expressions */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-2">Signature Expressions</label>
          <p className="text-xs text-sage-500 mb-3">
            Phrases your AI loves to use. These get woven into emails naturally.
          </p>

          {/* Tags */}
          <div className="flex flex-wrap gap-2 mb-3">
            {config.signature_expressions.map((expr) => (
              <span
                key={expr}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-sage-100 text-sage-800 text-sm"
              >
                {expr}
                <button
                  onClick={() => removeExpression(expr)}
                  className="text-sage-400 hover:text-sage-700 transition-colors"
                  aria-label={`Remove "${expr}"`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
            {config.signature_expressions.length === 0 && (
              <span className="text-xs text-sage-400 italic">No expressions added yet.</span>
            )}
          </div>

          {/* Add expression */}
          <div className="flex gap-2 max-w-md">
            <input
              type="text"
              value={newExpression}
              onChange={(e) => setNewExpression(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExpression() } }}
              placeholder={`e.g. "Can't wait to show you around!"`}
              className={inputClasses}
            />
            <button
              onClick={addExpression}
              disabled={!newExpression.trim()}
              className="px-4 py-2 rounded-lg border border-sage-300 text-sage-700 hover:bg-sage-50 disabled:opacity-40 transition-colors text-sm font-medium shrink-0"
            >
              Add
            </button>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Live Preview                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Live Preview</h2>
        </div>
        <p className="text-xs text-sage-500 mb-4">
          This is how {config.ai_name || 'your AI'} would write an initial response to a new inquiry with the current settings.
        </p>

        <div className="bg-warm-white border border-border rounded-xl p-6">
          {/* Email header */}
          <div className="border-b border-border pb-3 mb-4">
            <div className="flex items-center gap-2 text-sm text-sage-500">
              <span className="font-medium text-sage-800">From:</span>
              <span>{config.ai_name || 'Sage'} {config.ai_emoji || ''}</span>
              {config.ai_email && (
                <span className="text-sage-400">&lt;{config.ai_email}&gt;</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-sage-500 mt-1">
              <span className="font-medium text-sage-800">Subject:</span>
              <span>Re: Wedding Inquiry - June 2027</span>
            </div>
          </div>

          {/* Email body */}
          <div className="whitespace-pre-line text-sm text-sage-800 leading-relaxed">
            {generatePreviewEmail()}
          </div>
        </div>
      </section>

      {/* Bottom Save */}
      <div className="flex justify-end pb-8">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-6 py-2.5 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
