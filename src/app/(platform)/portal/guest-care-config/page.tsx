'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  Heart,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  Accessibility,
  PawPrint,
  Stethoscope,
  UtensilsCrossed,
  FileText,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PetPolicy = 'pets_welcome' | 'service_animals_only' | 'no_pets'

interface GuestCareConfig {
  accessibility_features: Record<string, boolean>
  custom_accessibility: string[]
  pet_policy: PetPolicy
  pet_notes: string
  medical_notes: string
  dietary_capabilities: Record<string, boolean>
  notes_to_couples: string
}

const ACCESSIBILITY_OPTIONS = [
  'Wheelchair accessible paths',
  'ADA-compliant restrooms',
  'Elevator access',
  'Hearing loop / assistive listening',
  'Reserved accessible parking',
  'Quiet/sensory-friendly space available',
]

const DIETARY_OPTIONS = [
  'Gluten-free kitchen',
  'Nut-free option',
  'Kosher available',
  'Halal available',
  'Vegan menu available',
]

const DEFAULT_CONFIG: GuestCareConfig = {
  accessibility_features: Object.fromEntries(
    ACCESSIBILITY_OPTIONS.map((f) => [f, false])
  ),
  custom_accessibility: [],
  pet_policy: 'service_animals_only',
  pet_notes: '',
  medical_notes: '',
  dietary_capabilities: Object.fromEntries(
    DIETARY_OPTIONS.map((d) => [d, false])
  ),
  notes_to_couples: '',
}

// ---------------------------------------------------------------------------
// Reusable components (platform style)
// ---------------------------------------------------------------------------

function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={cn(
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0',
          value ? 'bg-sage-500' : 'bg-sage-200'
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform',
            value ? 'translate-x-6' : 'translate-x-1'
          )}
        />
      </button>
      <span className="text-sm font-medium text-sage-800">{label}</span>
    </div>
  )
}

function RadioGroup({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { key: string; label: string; description?: string }[]
}) {
  return (
    <div className="space-y-2">
      {options.map((opt) => (
        <label
          key={opt.key}
          className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            value === opt.key
              ? 'border-sage-400 bg-sage-50'
              : 'border-border bg-white hover:bg-sage-50/50'
          )}
        >
          <input
            type="radio"
            name="pet-policy"
            checked={value === opt.key}
            onChange={() => onChange(opt.key)}
            className="mt-0.5 accent-sage-500"
          />
          <div>
            <span className="text-sm font-medium text-sage-800">{opt.label}</span>
            {opt.description && (
              <p className="text-xs text-sage-500 mt-0.5">{opt.description}</p>
            )}
          </div>
        </label>
      ))}
    </div>
  )
}

function ConfigSection({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-sage-100 flex items-center justify-center">
          <Icon className="w-5 h-5 text-sage-600" />
        </div>
        <h2 className="font-heading text-lg font-semibold text-sage-900">{title}</h2>
      </div>
      <div className="p-6 space-y-5">{children}</div>
    </div>
  )
}

function TagListInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder: string
}) {
  const [input, setInput] = useState('')

  function addTag() {
    const trimmed = input.trim()
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed])
    }
    setInput('')
  }

  function removeTag(idx: number) {
    onChange(values.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addTag()
            }
          }}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
        />
        <button
          type="button"
          onClick={addTag}
          disabled={!input.trim()}
          className="px-3 py-2 bg-sage-100 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((tag, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-sage-100 text-sage-700 border border-sage-200"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(idx)}
                className="hover:text-red-600 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function GuestCareConfigPage() {
  const VENUE_ID = useVenueId()
  const [config, setConfig] = useState<GuestCareConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<GuestCareConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()

      if (fetchErr) throw fetchErr

      if (data) {
        const flags = (data.feature_flags ?? {}) as Record<string, unknown>
        const gc = (flags.guest_care_config ?? {}) as Record<string, unknown>
        const loaded: GuestCareConfig = {
          accessibility_features: {
            ...DEFAULT_CONFIG.accessibility_features,
            ...((gc.accessibility_features as Record<string, boolean>) ?? {}),
          },
          custom_accessibility: (gc.custom_accessibility as string[]) ?? [],
          pet_policy: (gc.pet_policy as PetPolicy) ?? 'service_animals_only',
          pet_notes: (gc.pet_notes as string) ?? '',
          medical_notes: (gc.medical_notes as string) ?? '',
          dietary_capabilities: {
            ...DEFAULT_CONFIG.dietary_capabilities,
            ...((gc.dietary_capabilities as Record<string, boolean>) ?? {}),
          },
          notes_to_couples: (gc.notes_to_couples as string) ?? '',
        }
        setConfig(loaded)
        setOriginalConfig(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch guest care config:', err)
      setError('Failed to load guest care configuration')
    } finally {
      setLoading(false)
    }
  }, [VENUE_ID])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const hasChanges = JSON.stringify(config) !== JSON.stringify(originalConfig)

  const handleSave = async () => {
    if (!hasChanges) return
    setSaving(true)
    setSaved(false)

    try {
      const supabase = createClient()

      const { data: current } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()

      const flags = (current?.feature_flags ?? {}) as Record<string, unknown>
      flags.guest_care_config = {
        accessibility_features: config.accessibility_features,
        custom_accessibility: config.custom_accessibility,
        pet_policy: config.pet_policy,
        pet_notes: config.pet_notes,
        medical_notes: config.medical_notes,
        dietary_capabilities: config.dietary_capabilities,
        notes_to_couples: config.notes_to_couples,
      }

      const { error: updateErr } = await supabase
        .from('venue_config')
        .update({
          feature_flags: flags,
          updated_at: new Date().toISOString(),
        })
        .eq('venue_id', VENUE_ID)

      if (updateErr) throw updateErr

      setOriginalConfig({ ...config })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Save failed:', err)
      setError('Failed to save guest care configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof GuestCareConfig>(field: K, value: GuestCareConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  function toggleAccessibility(key: string) {
    const current = config.accessibility_features
    update('accessibility_features', { ...current, [key]: !current[key] })
  }

  function toggleDietary(key: string) {
    const current = config.dietary_capabilities
    update('dietary_capabilities', { ...current, [key]: !current[key] })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Guest Care Configuration
          </h1>
          <p className="text-sage-600">
            Configure accessibility, pet policy, dietary options, and guest care details.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-600">
              <CheckCircle className="w-4 h-4" />
              Saved
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              hasChanges
                ? 'bg-sage-600 text-white hover:bg-sage-700'
                : 'bg-sage-100 text-sage-400 cursor-not-allowed'
            )}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchConfig() }}
            className="mt-1 text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-6 animate-pulse">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 bg-sage-100 rounded-lg" />
                <div className="h-5 w-40 bg-sage-100 rounded" />
              </div>
              <div className="space-y-3">
                <div className="h-4 w-64 bg-sage-50 rounded" />
                <div className="h-4 w-48 bg-sage-50 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Accessibility Features */}
          <ConfigSection title="Venue Accessibility Features" icon={Accessibility}>
            <p className="text-sm text-sage-600 mb-3">
              Toggle the accessibility features your venue offers.
            </p>
            <div className="space-y-3">
              {ACCESSIBILITY_OPTIONS.map((feature) => (
                <Toggle
                  key={feature}
                  value={config.accessibility_features[feature] ?? false}
                  onChange={() => toggleAccessibility(feature)}
                  label={feature}
                />
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-border">
              <p className="text-sm font-medium text-sage-800 mb-2">
                Custom Accessibility Features
              </p>
              <TagListInput
                values={config.custom_accessibility}
                onChange={(v) => update('custom_accessibility', v)}
                placeholder="Add a custom accessibility feature..."
              />
            </div>
          </ConfigSection>

          {/* Pet Policy */}
          <ConfigSection title="Pet Policy" icon={PawPrint}>
            <p className="text-sm text-sage-600 mb-3">
              What is your venue&apos;s policy on pets?
            </p>
            <RadioGroup
              value={config.pet_policy}
              onChange={(v) => update('pet_policy', v as PetPolicy)}
              options={[
                {
                  key: 'pets_welcome',
                  label: 'Pets Welcome',
                  description: 'All well-behaved pets are allowed at the venue',
                },
                {
                  key: 'service_animals_only',
                  label: 'Service Animals Only',
                  description: 'Only certified service animals are permitted',
                },
                {
                  key: 'no_pets',
                  label: 'No Pets',
                  description: 'No animals allowed on the property',
                },
              ]}
            />
            <div className="mt-4">
              <label className="block text-sm font-medium text-sage-800 mb-1">
                Pet Notes
              </label>
              <textarea
                value={config.pet_notes}
                onChange={(e) => update('pet_notes', e.target.value)}
                placeholder="e.g., Dogs are most comfortable in the Cottage, away from festivities"
                rows={2}
                className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
              />
            </div>
          </ConfigSection>

          {/* Medical */}
          <ConfigSection title="Medical Accommodations" icon={Stethoscope}>
            <p className="text-sm text-sage-600 mb-2">
              Describe what medical accommodations the venue can provide.
            </p>
            <textarea
              value={config.medical_notes}
              onChange={(e) => update('medical_notes', e.target.value)}
              placeholder="e.g., First aid kit available. Nearest hospital: 15 min drive. EMTs can be arranged through our preferred vendor."
              rows={3}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>

          {/* Dietary Capabilities */}
          <ConfigSection title="Dietary Capabilities" icon={UtensilsCrossed}>
            <p className="text-sm text-sage-600 mb-3">
              Dietary accommodations your venue&apos;s kitchen can handle.
            </p>
            <div className="space-y-3">
              {DIETARY_OPTIONS.map((option) => (
                <Toggle
                  key={option}
                  value={config.dietary_capabilities[option] ?? false}
                  onChange={() => toggleDietary(option)}
                  label={option}
                />
              ))}
            </div>
          </ConfigSection>

          {/* Notes to Couples */}
          <ConfigSection title="Notes to Couples" icon={FileText}>
            <p className="text-sm text-sage-600 mb-2">
              Additional guest care information shown to couples in their portal.
            </p>
            <textarea
              value={config.notes_to_couples}
              onChange={(e) => update('notes_to_couples', e.target.value)}
              placeholder="e.g., We want every guest to feel welcome and comfortable. Let us know about any specific needs and we'll work with you to accommodate them."
              rows={4}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
