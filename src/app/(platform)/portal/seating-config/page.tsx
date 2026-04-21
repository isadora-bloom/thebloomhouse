'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  Trash2,
  MapPin,
  Upload,
  Image as ImageIcon,
  Table,
  FileText,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PresetTable {
  id: string
  name: string
  type: string
  capacity: number | null
}

interface SeatingConfig {
  venue_spaces: string[]
  preset_tables: PresetTable[]
}

interface PageState {
  floor_plan_url: string | null
  seating: SeatingConfig
}

const DEFAULT_STATE: PageState = {
  floor_plan_url: null,
  seating: {
    venue_spaces: [],
    preset_tables: [],
  },
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10)
}

const TABLE_TYPE_OPTIONS = [
  'Round',
  'Rectangular',
  'Farm',
  'Cocktail',
  'Sweetheart',
  'Head Table',
]

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
// Preset Table Editor
// ---------------------------------------------------------------------------

function PresetTableEditor({
  tables,
  onChange,
}: {
  tables: PresetTable[]
  onChange: (t: PresetTable[]) => void
}) {
  function addTable() {
    onChange([
      ...tables,
      { id: generateId(), name: '', type: 'Round', capacity: null },
    ])
  }

  function updateTable(idx: number, updates: Partial<PresetTable>) {
    onChange(tables.map((t, i) => (i === idx ? { ...t, ...updates } : t)))
  }

  function removeTable(idx: number) {
    onChange(tables.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {tables.map((table, idx) => (
        <div
          key={table.id}
          className="bg-warm-white border border-border rounded-lg p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Table Name
                </label>
                <input
                  type="text"
                  value={table.name}
                  onChange={(e) => updateTable(idx, { name: e.target.value })}
                  placeholder="e.g., Table 1, Head Table"
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Type
                </label>
                <select
                  value={table.type}
                  onChange={(e) => updateTable(idx, { type: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                >
                  {TABLE_TYPE_OPTIONS.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Capacity
                </label>
                <input
                  type="number"
                  value={table.capacity ?? ''}
                  onChange={(e) =>
                    updateTable(idx, {
                      capacity: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  placeholder="e.g., 8"
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => removeTable(idx)}
              className="p-1.5 rounded-md hover:bg-red-50 text-sage-400 hover:text-red-500 transition-colors shrink-0 mt-5"
              title="Remove table"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addTable}
        className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200"
      >
        <Plus className="w-4 h-4" />
        Add Table
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SeatingConfigPage() {
  const VENUE_ID = useVenueId()
  const [state, setState] = useState<PageState>(DEFAULT_STATE)
  const [originalState, setOriginalState] = useState<PageState>(DEFAULT_STATE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
        const sc = (flags.seating_config ?? {}) as Record<string, unknown>
        const loaded: PageState & Record<string, unknown> = {
          floor_plan_url: (flags.floor_plan_url as string | null) ?? null,
          floor_plan_venue_width_ft: (flags.floor_plan_venue_width_ft as number | null) ?? null,
          floor_plan_venue_depth_ft: (flags.floor_plan_venue_depth_ft as number | null) ?? null,
          seating: {
            venue_spaces: (sc.venue_spaces as string[]) ?? [],
            preset_tables: (sc.preset_tables as PresetTable[]) ?? [],
          },
        }
        setState(loaded)
        setOriginalState(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch seating config:', err)
      setError('Failed to load seating configuration')
    } finally {
      setLoading(false)
    }
  }, [VENUE_ID])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const hasChanges = JSON.stringify(state) !== JSON.stringify(originalState)

  // Floor plan upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    setError(null)

    try {
      const supabase = createClient()
      const ext = file.name.split('.').pop() || 'png'
      const path = `venue-assets/${VENUE_ID}/floor-plan.${ext}`

      // Remove old file if it exists
      if (state.floor_plan_url) {
        const oldPath = state.floor_plan_url.split('/venue-assets/')[1]
        if (oldPath) {
          await supabase.storage.from('venue-assets').remove([`venue-assets/${oldPath}`])
        }
      }

      const { error: uploadErr } = await supabase.storage
        .from('venue-assets')
        .upload(path, file, { upsert: true })

      if (uploadErr) throw uploadErr

      const { data: urlData } = supabase.storage
        .from('venue-assets')
        .getPublicUrl(path)

      setState((prev) => ({ ...prev, floor_plan_url: urlData.publicUrl }))
    } catch (err) {
      console.error('Upload failed:', err)
      setError('Failed to upload floor plan')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDeleteFloorPlan = async () => {
    if (!state.floor_plan_url) return

    try {
      const supabase = createClient()
      const parts = state.floor_plan_url.split('/venue-assets/')
      const filePath = parts[parts.length - 1]
      if (filePath) {
        await supabase.storage.from('venue-assets').remove([filePath])
      }
      setState((prev) => ({ ...prev, floor_plan_url: null }))
    } catch (err) {
      console.error('Delete failed:', err)
      setError('Failed to delete floor plan')
    }
  }

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
      flags.floor_plan_url = state.floor_plan_url
      flags.floor_plan_venue_width_ft = (state as unknown as Record<string, unknown>).floor_plan_venue_width_ft || null
      flags.floor_plan_venue_depth_ft = (state as unknown as Record<string, unknown>).floor_plan_venue_depth_ft || null
      flags.seating_config = {
        venue_spaces: state.seating.venue_spaces,
        preset_tables: state.seating.preset_tables,
      }

      const { error: updateErr } = await supabase
        .from('venue_config')
        .update({
          feature_flags: flags,
          updated_at: new Date().toISOString(),
        })
        .eq('venue_id', VENUE_ID)

      if (updateErr) throw updateErr

      setOriginalState({ ...state })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Save failed:', err)
      setError('Failed to save seating configuration')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Seating &amp; Floor Plan Configuration
          </h1>
          <p className="text-sage-600">
            Design your default floor plan layouts and table configurations. Couples use this as their starting point when building their seating chart on the portal.
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
          {Array.from({ length: 3 }).map((_, i) => (
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
          {/* Floor Plan Upload */}
          <ConfigSection title="Floor Plan" icon={ImageIcon}>
            <p className="text-sm text-sage-600 mb-3">
              Upload your venue floor plan image. This helps couples visualize their seating layout.
            </p>

            {state.floor_plan_url ? (
              <div className="space-y-3">
                <div className="border border-border rounded-lg overflow-hidden bg-warm-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={state.floor_plan_url}
                    alt="Venue floor plan"
                    className="w-full max-h-96 object-contain"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200"
                  >
                    <Upload className="w-4 h-4" />
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteFloorPlan}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors border border-red-200"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full border-2 border-dashed border-sage-300 rounded-lg p-8 text-center hover:border-sage-400 hover:bg-sage-50/50 transition-colors"
              >
                {uploading ? (
                  <Loader2 className="w-8 h-8 text-sage-400 mx-auto animate-spin" />
                ) : (
                  <Upload className="w-8 h-8 text-sage-400 mx-auto" />
                )}
                <p className="mt-2 text-sm font-medium text-sage-700">
                  {uploading ? 'Uploading...' : 'Click to upload floor plan'}
                </p>
                <p className="mt-1 text-xs text-sage-500">
                  PNG, JPG, or PDF up to 10MB
                </p>
              </button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
              onChange={handleFileUpload}
              className="hidden"
            />
          </ConfigSection>

          {/* Floor Plan Scale */}
          {state.floor_plan_url && (
            <ConfigSection title="Floor Plan Scale" icon={FileText}>
              <p className="text-sm text-sage-600 mb-3">
                Enter the real-world width of the venue space shown in your floor plan. This lets the table map calculate accurate sizes.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Venue width in feet</label>
                  <input
                    type="number" min={1} max={500} step={1}
                    value={(state as unknown as Record<string, unknown>).floor_plan_venue_width_ft as number || ''}
                    onChange={e => setState(prev => ({ ...prev, floor_plan_venue_width_ft: parseFloat(e.target.value) || null } as PageState))}
                    placeholder="e.g. 80"
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
                  />
                  <p className="text-xs text-sage-500 mt-1">The total width of the space in the image</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Venue depth in feet</label>
                  <input
                    type="number" min={1} max={500} step={1}
                    value={(state as unknown as Record<string, unknown>).floor_plan_venue_depth_ft as number || ''}
                    onChange={e => setState(prev => ({ ...prev, floor_plan_venue_depth_ft: parseFloat(e.target.value) || null } as PageState))}
                    placeholder="e.g. 45"
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
                  />
                  <p className="text-xs text-sage-500 mt-1">The total depth of the space in the image</p>
                </div>
              </div>
            </ConfigSection>
          )}

          {/* Venue Spaces */}
          <ConfigSection title="Venue Spaces" icon={MapPin}>
            <p className="text-sm text-sage-600 mb-2">
              Named spaces in your venue (e.g., Barn, Patio, Tent). These can be used as
              sections in the couple&apos;s seating layout.
            </p>
            <TagListInput
              values={state.seating.venue_spaces}
              onChange={(v) =>
                setState((prev) => ({
                  ...prev,
                  seating: { ...prev.seating, venue_spaces: v },
                }))
              }
              placeholder='e.g., Barn, Patio, Tent, Garden'
            />
          </ConfigSection>

          {/* Pre-Set Tables */}
          <ConfigSection title="Pre-Set Tables" icon={Table}>
            <p className="text-sm text-sage-600 mb-3">
              Define tables that always exist in your venue&apos;s standard layout. Couples
              will start with these tables pre-populated.
            </p>
            <PresetTableEditor
              tables={state.seating.preset_tables}
              onChange={(t) =>
                setState((prev) => ({
                  ...prev,
                  seating: { ...prev.seating, preset_tables: t },
                }))
              }
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
