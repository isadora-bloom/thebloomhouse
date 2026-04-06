'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  GlassWater,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  MapPin,
  UtensilsCrossed,
  Users,
  FileText,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RehearsalConfig {
  venue_spaces: string[]
  food_options: string[]
  linen_info: string
  max_guests: number | null
  notes_to_couples: string
}

const DEFAULT_CONFIG: RehearsalConfig = {
  venue_spaces: [],
  food_options: [],
  linen_info: '',
  max_guests: null,
  notes_to_couples: '',
}

// ---------------------------------------------------------------------------
// Reusable components (platform style)
// ---------------------------------------------------------------------------

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

export default function RehearsalConfigPage() {
  const VENUE_ID = useVenueId()
  const [config, setConfig] = useState<RehearsalConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<RehearsalConfig>(DEFAULT_CONFIG)
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
        const rc = (flags.rehearsal_config ?? {}) as Record<string, unknown>
        const loaded: RehearsalConfig = {
          venue_spaces: (rc.venue_spaces as string[]) ?? [],
          food_options: (rc.food_options as string[]) ?? [],
          linen_info: (rc.linen_info as string) ?? '',
          max_guests: (rc.max_guests as number | null) ?? null,
          notes_to_couples: (rc.notes_to_couples as string) ?? '',
        }
        setConfig(loaded)
        setOriginalConfig(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch rehearsal config:', err)
      setError('Failed to load rehearsal configuration')
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
      flags.rehearsal_config = {
        venue_spaces: config.venue_spaces,
        food_options: config.food_options,
        linen_info: config.linen_info,
        max_guests: config.max_guests,
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
      setError('Failed to save rehearsal configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof RehearsalConfig>(field: K, value: RehearsalConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Rehearsal Configuration
          </h1>
          <p className="text-sage-600">
            Configure rehearsal dinner options for your couples.
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
          {/* Available Venue Spaces */}
          <ConfigSection title="Available Venue Spaces" icon={MapPin}>
            <p className="text-sm text-sage-600 mb-2">
              Spaces where rehearsal dinners can be held. These show as options when a couple
              selects &quot;At the Venue.&quot;
            </p>
            <TagListInput
              values={config.venue_spaces}
              onChange={(v) => update('venue_spaces', v)}
              placeholder='e.g., Patio, Ballroom, Kitchen, Barn, Tent'
            />
          </ConfigSection>

          {/* Food Options */}
          <ConfigSection title="Food Options at Venue" icon={UtensilsCrossed}>
            <p className="text-sm text-sage-600 mb-2">
              What food types does the venue offer for rehearsal dinners?
            </p>
            <TagListInput
              values={config.food_options}
              onChange={(v) => update('food_options', v)}
              placeholder="e.g., Full Catering, Pizza, BBQ, Buffet"
            />
          </ConfigSection>

          {/* Linen Info */}
          <ConfigSection title="Linen Information" icon={GlassWater}>
            <p className="text-sm text-sage-600 mb-2">
              Describe what linens the venue provides for rehearsal dinners.
            </p>
            <textarea
              value={config.linen_info}
              onChange={(e) => update('linen_info', e.target.value)}
              placeholder="e.g., Basic black linens for up to 25 guests; larger groups need rentals"
              rows={3}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>

          {/* Max Guests */}
          <ConfigSection title="Max Rehearsal Guests" icon={Users}>
            <p className="text-sm text-sage-600 mb-2">
              Maximum number of guests the venue can accommodate for a rehearsal dinner.
            </p>
            <input
              type="number"
              value={config.max_guests ?? ''}
              onChange={(e) =>
                update('max_guests', e.target.value ? Number(e.target.value) : null)
              }
              placeholder="e.g., 50"
              className="w-full max-w-xs px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            />
          </ConfigSection>

          {/* Notes to Couples */}
          <ConfigSection title="Notes to Couples" icon={FileText}>
            <p className="text-sm text-sage-600 mb-2">
              Additional rehearsal dinner information shown to couples in their portal.
            </p>
            <textarea
              value={config.notes_to_couples}
              onChange={(e) => update('notes_to_couples', e.target.value)}
              placeholder="e.g., Rehearsal dinners typically run from 6-9pm. We recommend finalizing your headcount 2 weeks before."
              rows={4}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
