'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  Wine,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  Trash2,
  MapPin,
  DollarSign,
  Users,
  Package,
  FileText,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BarMode = 'calculator' | 'packages' | 'info_only'
type BarModel = 'in_house' | 'byob' | 'hybrid'

interface BarPackage {
  id: string
  name: string
  description: string
  price_per_person: number | null
  flat_rate: number | null
  whats_included: string
  is_default: boolean
}

interface BarConfig {
  bar_mode: BarMode
  bar_model: BarModel
  packages: BarPackage[]
  locations: string[]
  bartender_rate: number
  guests_per_bartender: number
  notes_to_couples: string
}

const DEFAULT_CONFIG: BarConfig = {
  bar_mode: 'calculator',
  bar_model: 'byob',
  packages: [],
  locations: [],
  bartender_rate: 350,
  guests_per_bartender: 50,
  notes_to_couples: '',
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10)
}

// ---------------------------------------------------------------------------
// Reusable components (platform style)
// ---------------------------------------------------------------------------

function Toggle({
  value,
  onChange,
  label,
  description,
}: {
  value: boolean
  onChange: (v: boolean) => void
  label: string
  description?: string
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={cn(
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 mt-0.5',
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
      <div>
        <span className="text-sm font-medium text-sage-800">{label}</span>
        {description && (
          <p className="text-xs text-sage-500 mt-0.5">{description}</p>
        )}
      </div>
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
            name="radio-group"
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
// Package Editor
// ---------------------------------------------------------------------------

function PackageEditor({
  packages,
  onChange,
}: {
  packages: BarPackage[]
  onChange: (p: BarPackage[]) => void
}) {
  function addPackage() {
    onChange([
      ...packages,
      {
        id: generateId(),
        name: '',
        description: '',
        price_per_person: null,
        flat_rate: null,
        whats_included: '',
        is_default: packages.length === 0,
      },
    ])
  }

  function updatePackage(idx: number, updates: Partial<BarPackage>) {
    onChange(packages.map((p, i) => (i === idx ? { ...p, ...updates } : p)))
  }

  function removePackage(idx: number) {
    const updated = packages.filter((_, i) => i !== idx)
    // If the removed package was default, set the first remaining one as default
    if (packages[idx]?.is_default && updated.length > 0) {
      updated[0].is_default = true
    }
    onChange(updated)
  }

  function setDefault(idx: number) {
    onChange(packages.map((p, i) => ({ ...p, is_default: i === idx })))
  }

  return (
    <div className="space-y-4">
      {packages.map((pkg, idx) => (
        <div
          key={pkg.id}
          className="bg-warm-white border border-border rounded-lg p-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Package Name
                  </label>
                  <input
                    type="text"
                    value={pkg.name}
                    onChange={(e) => updatePackage(idx, { name: e.target.value })}
                    placeholder="e.g., Premium Open Bar"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    value={pkg.description}
                    onChange={(e) => updatePackage(idx, { description: e.target.value })}
                    placeholder="Short description"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Price Per Person ($)
                  </label>
                  <input
                    type="number"
                    value={pkg.price_per_person ?? ''}
                    onChange={(e) =>
                      updatePackage(idx, {
                        price_per_person: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    placeholder="e.g., 45"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Flat Rate ($)
                  </label>
                  <input
                    type="number"
                    value={pkg.flat_rate ?? ''}
                    onChange={(e) =>
                      updatePackage(idx, {
                        flat_rate: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    placeholder="e.g., 3500"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  What&apos;s Included
                </label>
                <textarea
                  value={pkg.whats_included}
                  onChange={(e) => updatePackage(idx, { whats_included: e.target.value })}
                  placeholder="List what's included in this package..."
                  rows={3}
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
                />
              </div>
              <Toggle
                value={pkg.is_default}
                onChange={() => setDefault(idx)}
                label="Default package"
                description="Pre-selected for new couples"
              />
            </div>
            <button
              type="button"
              onClick={() => removePackage(idx)}
              className="p-1.5 rounded-md hover:bg-red-50 text-sage-400 hover:text-red-500 transition-colors shrink-0"
              title="Remove package"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addPackage}
        className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200"
      >
        <Plus className="w-4 h-4" />
        Add Package
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function BarConfigPage() {
  const VENUE_ID = useVenueId()
  const [config, setConfig] = useState<BarConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<BarConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from('venue_config')
        .select('feature_flags, bar_model')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()

      if (fetchErr) throw fetchErr

      if (data) {
        const flags = (data.feature_flags ?? {}) as Record<string, unknown>
        const barConfig = (flags.bar_config ?? {}) as Record<string, unknown>
        const loaded: BarConfig = {
          bar_mode: (barConfig.bar_mode as BarMode) ?? 'calculator',
          bar_model: (data.bar_model as BarModel) ?? 'byob',
          packages: (barConfig.packages as BarPackage[]) ?? [],
          locations: (barConfig.locations as string[]) ?? [],
          bartender_rate: (barConfig.bartender_rate as number) ?? 350,
          guests_per_bartender: (barConfig.guests_per_bartender as number) ?? 50,
          notes_to_couples: (barConfig.notes_to_couples as string) ?? '',
        }
        setConfig(loaded)
        setOriginalConfig(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch bar config:', err)
      setError('Failed to load bar configuration')
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

      // Read current feature_flags to merge
      const { data: current } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()

      const flags = (current?.feature_flags ?? {}) as Record<string, unknown>
      flags.bar_config = {
        bar_mode: config.bar_mode,
        packages: config.packages,
        locations: config.locations,
        bartender_rate: config.bartender_rate,
        guests_per_bartender: config.guests_per_bartender,
        notes_to_couples: config.notes_to_couples,
      }

      const { error: updateErr } = await supabase
        .from('venue_config')
        .update({
          feature_flags: flags,
          bar_model: config.bar_model,
          updated_at: new Date().toISOString(),
        })
        .eq('venue_id', VENUE_ID)

      if (updateErr) throw updateErr

      setOriginalConfig({ ...config })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Save failed:', err)
      setError('Failed to save bar configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof BarConfig>(field: K, value: BarConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Bar Configuration
          </h1>
          <p className="text-sage-600">
            Set up your bar service options, signature cocktails, and pricing tiers. Couples will see these choices on their planning portal when customizing their bar package.
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
          {Array.from({ length: 4 }).map((_, i) => (
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
          {/* Bar Mode */}
          <ConfigSection title="Bar Mode" icon={Wine}>
            <p className="text-sm text-sage-600 mb-3">
              Choose how couples interact with bar planning in their portal.
            </p>
            <RadioGroup
              value={config.bar_mode}
              onChange={(v) => update('bar_mode', v as BarMode)}
              options={[
                {
                  key: 'calculator',
                  label: 'Full Calculator',
                  description: 'Couples use the quantity calculator to plan their bar (BYOB-style)',
                },
                {
                  key: 'packages',
                  label: 'Package Selection',
                  description: 'Couples pick from pre-built bar packages you define below',
                },
                {
                  key: 'info_only',
                  label: 'Info Only',
                  description: 'Just show venue bar info, no planning tools',
                },
              ]}
            />
          </ConfigSection>

          {/* Bar Model */}
          <ConfigSection title="Bar Model" icon={Wine}>
            <p className="text-sm text-sage-600 mb-3">
              How does your venue handle bar service?
            </p>
            <RadioGroup
              value={config.bar_model}
              onChange={(v) => update('bar_model', v as BarModel)}
              options={[
                { key: 'in_house', label: 'In-House', description: 'Venue provides all beverages and bartending' },
                { key: 'byob', label: 'BYOB', description: 'Couples bring their own beverages' },
                { key: 'hybrid', label: 'Hybrid', description: 'Venue provides bartending, couples bring some beverages' },
              ]}
            />
          </ConfigSection>

          {/* Packages (only if package mode) */}
          {config.bar_mode === 'packages' && (
            <ConfigSection title="Bar Packages" icon={Package}>
              <p className="text-sm text-sage-600 mb-3">
                Define the bar packages couples can choose from.
              </p>
              <PackageEditor
                packages={config.packages}
                onChange={(p) => update('packages', p)}
              />
            </ConfigSection>
          )}

          {/* Bar Locations */}
          <ConfigSection title="Bar Locations" icon={MapPin}>
            <p className="text-sm text-sage-600 mb-2">
              Available bar locations at your venue. These appear as options for couples.
            </p>
            <TagListInput
              values={config.locations}
              onChange={(v) => update('locations', v)}
              placeholder="e.g., Main Bar, Patio Bar, Cocktail Hour Station"
            />
          </ConfigSection>

          {/* Rates & Ratios */}
          <ConfigSection title="Rates & Ratios" icon={DollarSign}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Bartender Rate ($/event)
                </label>
                <p className="text-xs text-sage-500 mb-2">
                  Cost per bartender per event
                </p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sage-400 text-sm">$</span>
                  <input
                    type="number"
                    value={config.bartender_rate}
                    onChange={(e) => update('bartender_rate', Number(e.target.value) || 0)}
                    className="w-full pl-7 pr-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Guests Per Bartender
                </label>
                <p className="text-xs text-sage-500 mb-2">
                  Recommended ratio for staffing
                </p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sage-400">
                    <Users className="w-4 h-4" />
                  </span>
                  <input
                    type="number"
                    value={config.guests_per_bartender}
                    onChange={(e) => update('guests_per_bartender', Number(e.target.value) || 1)}
                    className="w-full pl-9 pr-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
            </div>
          </ConfigSection>

          {/* Notes to Couples */}
          <ConfigSection title="Notes to Couples" icon={FileText}>
            <p className="text-sm text-sage-600 mb-2">
              Venue-specific bar information shown to couples on their bar planning page.
            </p>
            <textarea
              value={config.notes_to_couples}
              onChange={(e) => update('notes_to_couples', e.target.value)}
              placeholder="e.g., We provide all glassware and ice. Leftover alcohol must be removed by checkout Sunday."
              rows={4}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
