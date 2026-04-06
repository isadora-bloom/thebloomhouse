'use client'

import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import {
  Settings,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  Church,
  PartyPopper,
  Sparkles,
  ListPlus,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CustomField {
  label: string
  type: 'text' | 'toggle' | 'select'
  options?: string[]
}

interface WeddingDetailConfig {
  id?: string
  venue_id?: string
  allow_outside_ceremony: boolean
  allow_inside_ceremony: boolean
  arbor_options: string[]
  allow_unity_table: boolean
  allow_charger_plates: boolean
  allow_champagne_glasses: boolean
  allow_sparklers: boolean
  allow_wands: boolean
  allow_bubbles: boolean
  custom_send_off_options: string[]
  custom_fields: CustomField[]
}

const DEFAULT_CONFIG: WeddingDetailConfig = {
  allow_outside_ceremony: true,
  allow_inside_ceremony: true,
  arbor_options: [],
  allow_unity_table: true,
  allow_charger_plates: true,
  allow_champagne_glasses: true,
  allow_sparklers: true,
  allow_wands: true,
  allow_bubbles: true,
  custom_send_off_options: [],
  custom_fields: [],
}

// ---------------------------------------------------------------------------
// Toggle component (platform style)
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

// ---------------------------------------------------------------------------
// Tag list input (for arbor options, custom send-off options)
// ---------------------------------------------------------------------------

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
// Custom field editor
// ---------------------------------------------------------------------------

function CustomFieldEditor({
  fields,
  onChange,
}: {
  fields: CustomField[]
  onChange: (fields: CustomField[]) => void
}) {
  function addField() {
    onChange([...fields, { label: '', type: 'text' }])
  }

  function updateField(idx: number, updates: Partial<CustomField>) {
    onChange(
      fields.map((f, i) => (i === idx ? { ...f, ...updates } : f))
    )
  }

  function removeField(idx: number) {
    onChange(fields.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {fields.map((field, idx) => (
        <div
          key={idx}
          className="bg-warm-white border border-border rounded-lg p-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 space-y-3">
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Label
                </label>
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => updateField(idx, { label: e.target.value })}
                  placeholder="e.g., Preferred lighting color"
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Field Type
                </label>
                <select
                  value={field.type}
                  onChange={(e) =>
                    updateField(idx, {
                      type: e.target.value as 'text' | 'toggle' | 'select',
                      options: e.target.value === 'select' ? field.options ?? [] : undefined,
                    })
                  }
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                >
                  <option value="text">Text input</option>
                  <option value="toggle">Yes/No toggle</option>
                  <option value="select">Dropdown select</option>
                </select>
              </div>
              {field.type === 'select' && (
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Options
                  </label>
                  <TagListInput
                    values={field.options ?? []}
                    onChange={(options) => updateField(idx, { options })}
                    placeholder="Add an option..."
                  />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => removeField(idx)}
              className="p-1.5 rounded-md hover:bg-red-50 text-sage-400 hover:text-red-500 transition-colors shrink-0"
              title="Remove field"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addField}
        className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200"
      >
        <Plus className="w-4 h-4" />
        Add Custom Field
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function ConfigSection({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof Settings
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
// Main Page
// ---------------------------------------------------------------------------

export default function WeddingDetailsConfigPage() {
  const [config, setConfig] = useState<WeddingDetailConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<WeddingDetailConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/wedding-detail-config')
      if (!res.ok) throw new Error('Failed to fetch config')
      const { data } = await res.json()

      if (data) {
        const loaded: WeddingDetailConfig = {
          id: data.id,
          venue_id: data.venue_id,
          allow_outside_ceremony: data.allow_outside_ceremony ?? true,
          allow_inside_ceremony: data.allow_inside_ceremony ?? true,
          arbor_options: data.arbor_options ?? [],
          allow_unity_table: data.allow_unity_table ?? true,
          allow_charger_plates: data.allow_charger_plates ?? true,
          allow_champagne_glasses: data.allow_champagne_glasses ?? true,
          allow_sparklers: data.allow_sparklers ?? true,
          allow_wands: data.allow_wands ?? true,
          allow_bubbles: data.allow_bubbles ?? true,
          custom_send_off_options: data.custom_send_off_options ?? [],
          custom_fields: data.custom_fields ?? [],
        }
        setConfig(loaded)
        setOriginalConfig(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch config:', err)
      setError('Failed to load wedding detail configuration')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const hasChanges = JSON.stringify(config) !== JSON.stringify(originalConfig)

  const handleSave = async () => {
    if (!hasChanges) return
    setSaving(true)
    setSaved(false)

    try {
      const res = await fetch('/api/portal/wedding-detail-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })

      if (!res.ok) throw new Error('Failed to save')

      const { data } = await res.json()
      const saved: WeddingDetailConfig = {
        ...config,
        id: data.id,
        venue_id: data.venue_id,
      }
      setConfig(saved)
      setOriginalConfig(saved)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Save failed:', err)
      setError('Failed to save configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof WeddingDetailConfig>(
    field: K,
    value: WeddingDetailConfig[K]
  ) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Wedding Details Config
          </h1>
          <p className="text-sage-600">
            Define the wedding detail fields couples fill out — colors, themes, ceremony style, dietary needs, and more. Customize what information you collect from each couple.
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
                <div className="h-4 w-56 bg-sage-50 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Ceremony Options */}
          <ConfigSection title="Ceremony Options" icon={Church}>
            <Toggle
              value={config.allow_outside_ceremony}
              onChange={(v) => update('allow_outside_ceremony', v)}
              label="Allow outside ceremony"
              description="Couples can select 'Outside' as a ceremony location"
            />
            <Toggle
              value={config.allow_inside_ceremony}
              onChange={(v) => update('allow_inside_ceremony', v)}
              label="Allow inside ceremony"
              description="Couples can select 'Inside' as a ceremony location"
            />
            <Toggle
              value={config.allow_unity_table}
              onChange={(v) => update('allow_unity_table', v)}
              label="Allow unity table"
              description="Show the unity table option (sand ceremony, candle lighting, etc.)"
            />

            <div>
              <label className="block text-sm font-medium text-sage-800 mb-1">
                Arbor / Arch Options
              </label>
              <p className="text-xs text-sage-500 mb-2">
                If set, couples will choose from a dropdown instead of free text. Leave empty for free text.
              </p>
              <TagListInput
                values={config.arbor_options}
                onChange={(v) => update('arbor_options', v)}
                placeholder="e.g., Wooden arch, Metal hexagon, Draped pergola"
              />
            </div>
          </ConfigSection>

          {/* Reception Options */}
          <ConfigSection title="Reception Options" icon={PartyPopper}>
            <Toggle
              value={config.allow_charger_plates}
              onChange={(v) => update('allow_charger_plates', v)}
              label="Allow charger plates"
              description="Show 'Charger plates' in the providing items checklist"
            />
            <Toggle
              value={config.allow_champagne_glasses}
              onChange={(v) => update('allow_champagne_glasses', v)}
              label="Allow champagne glasses"
              description="Show 'Champagne glasses' in the providing items checklist"
            />
          </ConfigSection>

          {/* Send-Off Options */}
          <ConfigSection title="Send-Off Options" icon={Sparkles}>
            <Toggle
              value={config.allow_sparklers}
              onChange={(v) => update('allow_sparklers', v)}
              label="Allow sparklers"
              description="Show 'Sparklers' as a send-off option"
            />
            <Toggle
              value={config.allow_wands}
              onChange={(v) => update('allow_wands', v)}
              label="Allow wands"
              description="Show 'Wands' as a send-off option"
            />
            <Toggle
              value={config.allow_bubbles}
              onChange={(v) => update('allow_bubbles', v)}
              label="Allow bubbles"
              description="Show 'Bubbles' as a send-off option"
            />

            <div>
              <label className="block text-sm font-medium text-sage-800 mb-1">
                Custom Send-Off Options
              </label>
              <p className="text-xs text-sage-500 mb-2">
                Add venue-specific send-off options (e.g., Confetti cannons, Ribbon wands).
              </p>
              <TagListInput
                values={config.custom_send_off_options}
                onChange={(v) => update('custom_send_off_options', v)}
                placeholder="e.g., Confetti cannons, Flower petals"
              />
            </div>
          </ConfigSection>

          {/* Custom Fields */}
          <ConfigSection title="Custom Fields" icon={ListPlus}>
            <p className="text-sm text-sage-600">
              Add custom questions that will appear on the couple&apos;s wedding details page.
              Each field can be a text input, a yes/no toggle, or a dropdown select.
            </p>
            <CustomFieldEditor
              fields={config.custom_fields}
              onChange={(v) => update('custom_fields', v)}
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
