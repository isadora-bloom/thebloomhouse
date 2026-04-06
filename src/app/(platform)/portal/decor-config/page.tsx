'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  Flower2,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  MapPin,
  Package,
  ShieldAlert,
  FileText,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DecorConfig {
  venue_spaces: string[]
  venue_provides: string[]
  restrictions: Record<string, boolean>
  custom_restrictions: string[]
  decor_notes: string
}

const BUILT_IN_RESTRICTIONS = [
  'No open flames / real candles',
  'No confetti / glitter',
  'No tape on walls',
  'No nails in woodwork',
]

const DEFAULT_CONFIG: DecorConfig = {
  venue_spaces: [],
  venue_provides: [],
  restrictions: Object.fromEntries(BUILT_IN_RESTRICTIONS.map((r) => [r, false])),
  custom_restrictions: [],
  decor_notes: '',
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

export default function DecorConfigPage() {
  const VENUE_ID = useVenueId()
  const [config, setConfig] = useState<DecorConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<DecorConfig>(DEFAULT_CONFIG)
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
        const dc = (flags.decor_config ?? {}) as Record<string, unknown>
        const loaded: DecorConfig = {
          venue_spaces: (dc.venue_spaces as string[]) ?? [],
          venue_provides: (dc.venue_provides as string[]) ?? [],
          restrictions: {
            ...DEFAULT_CONFIG.restrictions,
            ...((dc.restrictions as Record<string, boolean>) ?? {}),
          },
          custom_restrictions: (dc.custom_restrictions as string[]) ?? [],
          decor_notes: (dc.decor_notes as string) ?? '',
        }
        setConfig(loaded)
        setOriginalConfig(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch decor config:', err)
      setError('Failed to load decor configuration')
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
      flags.decor_config = {
        venue_spaces: config.venue_spaces,
        venue_provides: config.venue_provides,
        restrictions: config.restrictions,
        custom_restrictions: config.custom_restrictions,
        decor_notes: config.decor_notes,
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
      setError('Failed to save decor configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof DecorConfig>(field: K, value: DecorConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  function toggleRestriction(key: string) {
    const current = config.restrictions
    update('restrictions', { ...current, [key]: !current[key] })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Decor Configuration
          </h1>
          <p className="text-sage-600">
            Define your venue&apos;s decor options, add-on packages, and styling choices. These appear on the couple&apos;s portal so they can browse and select their preferences.
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
          {/* Venue Spaces */}
          <ConfigSection title="Venue Spaces" icon={MapPin}>
            <p className="text-sm text-sage-600 mb-2">
              Add the decorable spaces at your venue. These replace the default presets and
              appear as options for couples when planning decor.
            </p>
            <TagListInput
              values={config.venue_spaces}
              onChange={(v) => update('venue_spaces', v)}
              placeholder='e.g., Round Guest Tables, Head Table, Ceremony Arch, Welcome Table'
            />
          </ConfigSection>

          {/* What Venue Provides */}
          <ConfigSection title="What Venue Provides" icon={Package}>
            <p className="text-sm text-sage-600 mb-2">
              Items the venue includes as part of the booking. These help couples understand
              what they don&apos;t need to source separately.
            </p>
            <TagListInput
              values={config.venue_provides}
              onChange={(v) => update('venue_provides', v)}
              placeholder="e.g., Basic white linens, Votive candles, Centerpiece vases"
            />
          </ConfigSection>

          {/* Restrictions */}
          <ConfigSection title="Restrictions" icon={ShieldAlert}>
            <p className="text-sm text-sage-600 mb-3">
              Decor restrictions couples need to know about.
            </p>
            <div className="space-y-3">
              {BUILT_IN_RESTRICTIONS.map((restriction) => (
                <Toggle
                  key={restriction}
                  value={config.restrictions[restriction] ?? false}
                  onChange={() => toggleRestriction(restriction)}
                  label={restriction}
                />
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-border">
              <p className="text-sm font-medium text-sage-800 mb-2">
                Custom Restrictions
              </p>
              <TagListInput
                values={config.custom_restrictions}
                onChange={(v) => update('custom_restrictions', v)}
                placeholder="Add a custom restriction..."
              />
            </div>
          </ConfigSection>

          {/* Decor Notes */}
          <ConfigSection title="Decor Notes" icon={FileText}>
            <p className="text-sm text-sage-600 mb-2">
              Additional decor information shown to couples in their portal.
            </p>
            <textarea
              value={config.decor_notes}
              onChange={(e) => update('decor_notes', e.target.value)}
              placeholder="e.g., Our coordinator can help with decor setup starting at 10am on wedding day. We recommend using Command strips instead of nails."
              rows={4}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
