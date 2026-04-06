'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  LayoutGrid,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  Palette,
  Layers,
  Users,
  FileText,
  Table,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LinenColor {
  name: string
  hex: string
}

interface TablesConfig {
  table_types: Record<string, boolean>
  linen_colors: LinenColor[]
  runner_styles: Record<string, boolean>
  max_capacity: number | null
  linen_notes: string
  extra_tables: Record<string, boolean>
}

const TABLE_TYPE_OPTIONS = [
  'Round',
  'Rectangular',
  'Farm',
  'Cocktail',
  'Sweetheart',
  'Head Table',
]

const RUNNER_STYLE_OPTIONS = ['None', 'Runner', 'Overlay', 'Greenery']

const EXTRA_TABLE_OPTIONS = [
  'Gift Table',
  'Card Table',
  'Cake Table',
  'Dessert Table',
  'Guestbook Table',
  'Photo Display Table',
  'Escort Card Table',
  'Place Card Table',
  'Favors Table',
  'Programs Table',
  'DJ Table',
  'Band Table',
  'Ceremony Table',
  'Unity Ceremony Table',
  'Memorial Table',
  'Drinks Table',
  'Coffee Station',
  'Late Night Snack Table',
  'Kids Table',
  'Vendor Meal Table',
  'Sign-In Table',
  'Seating Chart Display',
]

const DEFAULT_CONFIG: TablesConfig = {
  table_types: Object.fromEntries(TABLE_TYPE_OPTIONS.map((t) => [t, false])),
  linen_colors: [],
  runner_styles: Object.fromEntries(RUNNER_STYLE_OPTIONS.map((s) => [s, false])),
  max_capacity: null,
  linen_notes: '',
  extra_tables: Object.fromEntries(EXTRA_TABLE_OPTIONS.map((t) => [t, false])),
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

// ---------------------------------------------------------------------------
// Linen Color Editor
// ---------------------------------------------------------------------------

function LinenColorEditor({
  colors,
  onChange,
}: {
  colors: LinenColor[]
  onChange: (c: LinenColor[]) => void
}) {
  const [nameInput, setNameInput] = useState('')
  const [hexInput, setHexInput] = useState('#FFFFFF')

  function addColor() {
    const trimmed = nameInput.trim()
    if (trimmed && !colors.some((c) => c.name === trimmed)) {
      onChange([...colors, { name: trimmed, hex: hexInput }])
    }
    setNameInput('')
    setHexInput('#FFFFFF')
  }

  function removeColor(idx: number) {
    onChange(colors.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-sage-600 mb-1">Color Name</label>
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addColor()
              }
            }}
            placeholder="e.g., Ivory, Dusty Rose"
            className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
          />
        </div>
        <div className="w-24">
          <label className="block text-xs font-medium text-sage-600 mb-1">Hex</label>
          <input
            type="color"
            value={hexInput}
            onChange={(e) => setHexInput(e.target.value)}
            className="w-full h-[38px] p-1 bg-warm-white border border-border rounded-lg cursor-pointer"
          />
        </div>
        <button
          type="button"
          onClick={addColor}
          disabled={!nameInput.trim()}
          className="px-3 py-2 bg-sage-100 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {colors.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {colors.map((color, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-sage-100 text-sage-700 border border-sage-200"
            >
              <span
                className="w-4 h-4 rounded-full border border-sage-300 shrink-0"
                style={{ backgroundColor: color.hex }}
              />
              {color.name}
              <button
                type="button"
                onClick={() => removeColor(idx)}
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

export default function TablesConfigPage() {
  const VENUE_ID = useVenueId()
  const [config, setConfig] = useState<TablesConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<TablesConfig>(DEFAULT_CONFIG)
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
        const tc = (flags.tables_config ?? {}) as Record<string, unknown>
        const loaded: TablesConfig = {
          table_types: {
            ...DEFAULT_CONFIG.table_types,
            ...((tc.table_types as Record<string, boolean>) ?? {}),
          },
          linen_colors: (tc.linen_colors as LinenColor[]) ?? [],
          runner_styles: {
            ...DEFAULT_CONFIG.runner_styles,
            ...((tc.runner_styles as Record<string, boolean>) ?? {}),
          },
          max_capacity: (tc.max_capacity as number | null) ?? null,
          linen_notes: (tc.linen_notes as string) ?? '',
          extra_tables: {
            ...DEFAULT_CONFIG.extra_tables,
            ...((tc.extra_tables as Record<string, boolean>) ?? {}),
          },
        }
        setConfig(loaded)
        setOriginalConfig(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch tables config:', err)
      setError('Failed to load tables configuration')
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
      flags.tables_config = {
        table_types: config.table_types,
        linen_colors: config.linen_colors,
        runner_styles: config.runner_styles,
        max_capacity: config.max_capacity,
        linen_notes: config.linen_notes,
        extra_tables: config.extra_tables,
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
      setError('Failed to save tables configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof TablesConfig>(field: K, value: TablesConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  function toggleMapKey(
    field: 'table_types' | 'runner_styles' | 'extra_tables',
    key: string
  ) {
    const current = config[field]
    update(field, { ...current, [key]: !current[key] })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Tables &amp; Linen Configuration
          </h1>
          <p className="text-sage-600">
            Configure your table inventory — sizes, shapes, linen options, and default layouts. This is what couples work with when they build their seating arrangements.
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
          {/* Table Types */}
          <ConfigSection title="Available Table Types" icon={LayoutGrid}>
            <p className="text-sm text-sage-600 mb-3">
              Toggle which table types your venue has available.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {TABLE_TYPE_OPTIONS.map((type) => (
                <Toggle
                  key={type}
                  value={config.table_types[type] ?? false}
                  onChange={() => toggleMapKey('table_types', type)}
                  label={type}
                />
              ))}
            </div>
          </ConfigSection>

          {/* Linen Colors */}
          <ConfigSection title="Linen Colors Available" icon={Palette}>
            <p className="text-sm text-sage-600 mb-3">
              Add the linen colors your venue provides. These show as color circles on the
              couple&apos;s page.
            </p>
            <LinenColorEditor
              colors={config.linen_colors}
              onChange={(c) => update('linen_colors', c)}
            />
          </ConfigSection>

          {/* Runner Styles */}
          <ConfigSection title="Runner Styles Available" icon={Layers}>
            <p className="text-sm text-sage-600 mb-3">
              Toggle which runner/overlay styles are available.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {RUNNER_STYLE_OPTIONS.map((style) => (
                <Toggle
                  key={style}
                  value={config.runner_styles[style] ?? false}
                  onChange={() => toggleMapKey('runner_styles', style)}
                  label={style}
                />
              ))}
            </div>
          </ConfigSection>

          {/* Max Capacity */}
          <ConfigSection title="Max Seated Capacity" icon={Users}>
            <p className="text-sm text-sage-600 mb-2">
              Maximum number of seated guests your venue supports.
            </p>
            <input
              type="number"
              value={config.max_capacity ?? ''}
              onChange={(e) =>
                update('max_capacity', e.target.value ? Number(e.target.value) : null)
              }
              placeholder="e.g., 200"
              className="w-full max-w-xs px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            />
          </ConfigSection>

          {/* Linen Notes */}
          <ConfigSection title="Venue Linen Notes" icon={FileText}>
            <p className="text-sm text-sage-600 mb-2">
              Additional linen information shown to couples.
            </p>
            <textarea
              value={config.linen_notes}
              onChange={(e) => update('linen_notes', e.target.value)}
              placeholder="e.g., We provide ivory linens for up to 150. Additional colors available through our rental partner."
              rows={4}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>

          {/* Extra Tables */}
          <ConfigSection title="Extra Tables Available" icon={Table}>
            <p className="text-sm text-sage-600 mb-3">
              Toggle which extra table types your venue supports.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {EXTRA_TABLE_OPTIONS.map((table) => (
                <Toggle
                  key={table}
                  value={config.extra_tables[table] ?? false}
                  onChange={() => toggleMapKey('extra_tables', table)}
                  label={table}
                />
              ))}
            </div>
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
