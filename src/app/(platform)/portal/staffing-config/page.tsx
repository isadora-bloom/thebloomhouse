'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  HardHat,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  DollarSign,
  Users,
  FileText,
  AlertTriangle,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceRatio {
  buffet: number
  plated: number
  stations: number
  family_style: number
}

interface ExtraHandsTrigger {
  key: string
  label: string
  description: string
  enabled: boolean
  is_custom: boolean
}

interface StaffingConfig {
  staff_rate: number
  available_roles: string[]
  custom_roles: string[]
  minimum_staff: number
  guests_per_bartender: number
  guests_per_server: ServiceRatio
  extra_hands_triggers: ExtraHandsTrigger[]
  notes_to_couples: string
}

const DEFAULT_ROLES = [
  'Bartender',
  'Server',
  'Runner',
  'Line Cook',
  'Event Captain',
  'Setup Crew',
  'Cleanup Crew',
  'Parking Attendant',
  'Security',
]

const DEFAULT_TRIGGERS: ExtraHandsTrigger[] = [
  { key: 'large_vendor_team', label: 'Large vendor team', description: '10+ vendors on-site', enabled: true, is_custom: false },
  { key: 'large_wedding', label: 'Large wedding', description: '150+ guests', enabled: true, is_custom: false },
  { key: 'multiple_gatherings', label: 'Multiple gatherings', description: 'Friday + Saturday events', enabled: true, is_custom: false },
  { key: 'early_ceremony', label: 'Early ceremony', description: 'Ceremony before 3pm', enabled: true, is_custom: false },
  { key: 'lots_of_diy', label: 'Lots of DIY decor', description: 'Couple needs extra setup help', enabled: true, is_custom: false },
  { key: 'no_shuttles', label: 'No shuttles', description: 'Parking management needed', enabled: true, is_custom: false },
  { key: 'diy_flowers', label: 'DIY flowers', description: 'Extra vase/floral setup', enabled: true, is_custom: false },
]

const DEFAULT_CONFIG: StaffingConfig = {
  staff_rate: 350,
  available_roles: [...DEFAULT_ROLES],
  custom_roles: [],
  minimum_staff: 4,
  guests_per_bartender: 50,
  guests_per_server: {
    buffet: 30,
    plated: 20,
    stations: 35,
    family_style: 25,
  },
  extra_hands_triggers: DEFAULT_TRIGGERS,
  notes_to_couples: '',
}

// ---------------------------------------------------------------------------
// Reusable components
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
// Main Page
// ---------------------------------------------------------------------------

export default function StaffingConfigPage() {
  const VENUE_ID = useVenueId()
  const [config, setConfig] = useState<StaffingConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<StaffingConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customRoleInput, setCustomRoleInput] = useState('')
  const [customTriggerLabel, setCustomTriggerLabel] = useState('')
  const [customTriggerDesc, setCustomTriggerDesc] = useState('')

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
        const sc = (flags.staffing_config ?? {}) as Record<string, unknown>
        if (Object.keys(sc).length > 0) {
          const loaded: StaffingConfig = {
            staff_rate: (sc.staff_rate as number) ?? 350,
            available_roles: (sc.available_roles as string[]) ?? [...DEFAULT_ROLES],
            custom_roles: (sc.custom_roles as string[]) ?? [],
            minimum_staff: (sc.minimum_staff as number) ?? 4,
            guests_per_bartender: (sc.guests_per_bartender as number) ?? 50,
            guests_per_server: (sc.guests_per_server as ServiceRatio) ?? DEFAULT_CONFIG.guests_per_server,
            extra_hands_triggers: (sc.extra_hands_triggers as ExtraHandsTrigger[]) ?? DEFAULT_TRIGGERS,
            notes_to_couples: (sc.notes_to_couples as string) ?? '',
          }
          setConfig(loaded)
          setOriginalConfig(loaded)
        }
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch staffing config:', err)
      setError('Failed to load staffing configuration')
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
      flags.staffing_config = {
        staff_rate: config.staff_rate,
        available_roles: config.available_roles,
        custom_roles: config.custom_roles,
        minimum_staff: config.minimum_staff,
        guests_per_bartender: config.guests_per_bartender,
        guests_per_server: config.guests_per_server,
        extra_hands_triggers: config.extra_hands_triggers,
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
      setError('Failed to save staffing configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof StaffingConfig>(field: K, value: StaffingConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  const toggleRole = (role: string) => {
    const roles = config.available_roles.includes(role)
      ? config.available_roles.filter((r) => r !== role)
      : [...config.available_roles, role]
    update('available_roles', roles)
  }

  const addCustomRole = () => {
    const trimmed = customRoleInput.trim()
    if (trimmed && !config.custom_roles.includes(trimmed) && !DEFAULT_ROLES.includes(trimmed)) {
      update('custom_roles', [...config.custom_roles, trimmed])
      update('available_roles', [...config.available_roles, trimmed])
      setCustomRoleInput('')
    }
  }

  const removeCustomRole = (role: string) => {
    update('custom_roles', config.custom_roles.filter((r) => r !== role))
    update('available_roles', config.available_roles.filter((r) => r !== role))
  }

  const toggleTrigger = (key: string) => {
    update(
      'extra_hands_triggers',
      config.extra_hands_triggers.map((t) =>
        t.key === key ? { ...t, enabled: !t.enabled } : t
      )
    )
  }

  const addCustomTrigger = () => {
    const label = customTriggerLabel.trim()
    if (!label) return
    const key = 'custom_' + Math.random().toString(36).substring(2, 8)
    update('extra_hands_triggers', [
      ...config.extra_hands_triggers,
      {
        key,
        label,
        description: customTriggerDesc.trim(),
        enabled: true,
        is_custom: true,
      },
    ])
    setCustomTriggerLabel('')
    setCustomTriggerDesc('')
  }

  const removeCustomTrigger = (key: string) => {
    update(
      'extra_hands_triggers',
      config.extra_hands_triggers.filter((t) => t.key !== key)
    )
  }

  const updateServerRatio = (serviceType: keyof ServiceRatio, value: number) => {
    update('guests_per_server', { ...config.guests_per_server, [serviceType]: value })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Staffing Configuration
          </h1>
          <p className="text-sage-600">
            Define staffing roles, responsibilities, and day-of assignments. This feeds into the couple&apos;s timeline and helps coordinate your team for each wedding.
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
          {/* Rate & Minimums */}
          <ConfigSection title="Rate & Minimums" icon={DollarSign}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Staff Rate ($/person/day)
                </label>
                <p className="text-xs text-sage-500 mb-2">
                  Per-person rate for staff
                </p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sage-400 text-sm">$</span>
                  <input
                    type="number"
                    value={config.staff_rate}
                    onChange={(e) => update('staff_rate', Number(e.target.value) || 0)}
                    className="w-full pl-7 pr-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Minimum Staff
                </label>
                <p className="text-xs text-sage-500 mb-2">
                  Minimum staff for any event
                </p>
                <input
                  type="number"
                  value={config.minimum_staff}
                  onChange={(e) => update('minimum_staff', Number(e.target.value) || 1)}
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
            </div>
          </ConfigSection>

          {/* Available Roles */}
          <ConfigSection title="Available Roles" icon={Users}>
            <p className="text-sm text-sage-600 mb-3">
              Choose which staff roles to show couples in the staffing calculator.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {DEFAULT_ROLES.map((role) => (
                <label
                  key={role}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors',
                    config.available_roles.includes(role)
                      ? 'border-sage-400 bg-sage-50'
                      : 'border-border bg-white hover:bg-sage-50/50'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={config.available_roles.includes(role)}
                    onChange={() => toggleRole(role)}
                    className="accent-sage-500"
                  />
                  <span className="text-sm text-sage-800">{role}</span>
                </label>
              ))}
            </div>

            {/* Custom roles */}
            {config.custom_roles.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-sage-600 mb-2">Custom Roles</p>
                <div className="flex flex-wrap gap-1.5">
                  {config.custom_roles.map((role) => (
                    <span
                      key={role}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-sage-100 text-sage-700 border border-sage-200"
                    >
                      {role}
                      <button
                        type="button"
                        onClick={() => removeCustomRole(role)}
                        className="hover:text-red-600 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 mt-3">
              <input
                type="text"
                value={customRoleInput}
                onChange={(e) => setCustomRoleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustomRole()
                  }
                }}
                placeholder="Add custom role..."
                className="flex-1 px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
              />
              <button
                type="button"
                onClick={addCustomRole}
                disabled={!customRoleInput.trim()}
                className="px-3 py-2 bg-sage-100 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </ConfigSection>

          {/* Service Ratios */}
          <ConfigSection title="Guests Per Server" icon={Users}>
            <p className="text-sm text-sage-600 mb-3">
              Set the recommended guests-per-server ratio for each service style.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {(
                [
                  { key: 'buffet', label: 'Buffet' },
                  { key: 'plated', label: 'Plated' },
                  { key: 'stations', label: 'Stations' },
                  { key: 'family_style', label: 'Family Style' },
                ] as const
              ).map(({ key, label }) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-sage-800 mb-1">{label}</label>
                  <input
                    type="number"
                    value={config.guests_per_server[key]}
                    onChange={(e) => updateServerRatio(key, Number(e.target.value) || 1)}
                    className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              ))}
            </div>
            <div className="mt-4">
              <label className="block text-sm font-medium text-sage-800 mb-1">
                Guests Per Bartender
              </label>
              <input
                type="number"
                value={config.guests_per_bartender}
                onChange={(e) => update('guests_per_bartender', Number(e.target.value) || 1)}
                className="w-full sm:w-48 px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
              />
            </div>
          </ConfigSection>

          {/* Extra Hands Triggers */}
          <ConfigSection title="Extra Hands Triggers" icon={AlertTriangle}>
            <p className="text-sm text-sage-600 mb-3">
              Toggle which &quot;extra hands needed&quot; triggers appear in the staffing calculator.
            </p>
            <div className="space-y-2">
              {config.extra_hands_triggers.map((trigger) => (
                <div
                  key={trigger.key}
                  className={cn(
                    'flex items-center justify-between gap-3 px-4 py-3 rounded-lg border transition-colors',
                    trigger.enabled
                      ? 'border-sage-300 bg-sage-50/50'
                      : 'border-border bg-white'
                  )}
                >
                  <Toggle
                    value={trigger.enabled}
                    onChange={() => toggleTrigger(trigger.key)}
                    label={trigger.label}
                    description={trigger.description}
                  />
                  {trigger.is_custom && (
                    <button
                      type="button"
                      onClick={() => removeCustomTrigger(trigger.key)}
                      className="p-1.5 rounded-md hover:bg-red-50 text-sage-400 hover:text-red-500 transition-colors shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Add custom trigger */}
            <div className="mt-4 p-4 bg-warm-white border border-border rounded-lg space-y-2">
              <p className="text-xs font-medium text-sage-600">Add Custom Trigger</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  value={customTriggerLabel}
                  onChange={(e) => setCustomTriggerLabel(e.target.value)}
                  placeholder="Trigger name"
                  className="px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
                <input
                  type="text"
                  value={customTriggerDesc}
                  onChange={(e) => setCustomTriggerDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
              <button
                type="button"
                onClick={addCustomTrigger}
                disabled={!customTriggerLabel.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" />
                Add Trigger
              </button>
            </div>
          </ConfigSection>

          {/* Notes to Couples */}
          <ConfigSection title="Venue-Specific Notes" icon={FileText}>
            <p className="text-sm text-sage-600 mb-2">
              Notes shown to couples on their staffing page.
            </p>
            <textarea
              value={config.notes_to_couples}
              onChange={(e) => update('notes_to_couples', e.target.value)}
              placeholder="e.g., Staff tip is collected via Venmo at your final walkthrough. We recommend at least 2 bartenders for cocktail hour."
              rows={4}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
