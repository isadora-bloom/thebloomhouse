'use client'

// Feature: configurable via wedding_detail_config table
// Table: wedding_details (single row per wedding, upsert)

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Palette,
  Heart,
  Church,
  PartyPopper,
  Sparkles,
  Check,
  Loader2,
  AtSign,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeddingDetails {
  id?: string
  wedding_colors: string | null
  partner1_social: string | null
  partner2_social: string | null
  dogs_coming: boolean
  dogs_description: string | null
  ceremony_location: 'outside' | 'inside' | 'both' | null
  arbor_choice: string | null
  unity_table: boolean
  ceremony_notes: string | null
  seating_method: string | null
  providing_table_numbers: boolean
  providing_charger_plates: boolean
  providing_champagne_glasses: boolean
  providing_cake_cutter: boolean
  providing_cake_topper: boolean
  favors_description: string | null
  reception_notes: string | null
  send_off_type: string | null
  send_off_notes: string | null
  // Custom field values stored as JSON
  custom_field_values?: Record<string, string | boolean>
}

interface CustomField {
  label: string
  type: 'text' | 'toggle' | 'select'
  options?: string[]
}

interface VenueConfig {
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

const DEFAULT_CONFIG: VenueConfig = {
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

const EMPTY_DETAILS: WeddingDetails = {
  wedding_colors: '',
  partner1_social: '',
  partner2_social: '',
  dogs_coming: false,
  dogs_description: '',
  ceremony_location: null,
  arbor_choice: '',
  unity_table: false,
  ceremony_notes: '',
  seating_method: '',
  providing_table_numbers: false,
  providing_charger_plates: false,
  providing_champagne_glasses: false,
  providing_cake_cutter: false,
  providing_cake_topper: false,
  favors_description: '',
  reception_notes: '',
  send_off_type: null,
  send_off_notes: '',
  custom_field_values: {},
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// ---------------------------------------------------------------------------
// Toggle component
// ---------------------------------------------------------------------------

function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean
  onChange: (v: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex items-center gap-3 group"
    >
      <div
        className={cn(
          'w-11 h-6 rounded-full transition-colors relative',
          value ? 'bg-[#7D8471]' : 'bg-gray-200'
        )}
      >
        <div
          className={cn(
            'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform',
            value ? 'translate-x-[22px]' : 'translate-x-0.5'
          )}
        />
      </div>
      {label && (
        <span className="text-sm text-gray-700 group-hover:text-gray-900">{label}</span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// OptionToggle — horizontal button group
// ---------------------------------------------------------------------------

function OptionToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T | null
  options: { key: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={cn(
            'px-4 py-2 rounded-lg text-sm font-medium transition-all border',
            value === opt.key
              ? 'bg-[#7D8471] text-white border-[#7D8471] shadow-sm'
              : 'bg-white text-gray-600 border-gray-200 hover:border-[#7D8471]/40 hover:text-[#7D8471]'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof Heart
  children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-[#7D8471]/10 flex items-center justify-center">
          <Icon className="w-5 h-5 text-[#7D8471]" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      </div>
      <div className="p-6 space-y-6">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Field wrapper
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wedding Details Page
// ---------------------------------------------------------------------------

export default function WeddingDetailsPage() {
  const [details, setDetails] = useState<WeddingDetails>(EMPTY_DETAILS)
  const [venueConfig, setVenueConfig] = useState<VenueConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const supabase = createClient()

  // ---- Fetch wedding details + venue config ----
  const fetchData = useCallback(async () => {
    // Fetch both in parallel
    const [detailsResult, configResult] = await Promise.all([
      supabase
        .from('wedding_details')
        .select('*')
        .eq('wedding_id', WEDDING_ID)
        .eq('venue_id', VENUE_ID)
        .maybeSingle(),
      supabase
        .from('wedding_detail_config')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .maybeSingle(),
    ])

    if (!detailsResult.error && detailsResult.data) {
      setDetails({
        ...EMPTY_DETAILS,
        ...detailsResult.data,
        wedding_colors: detailsResult.data.wedding_colors ?? '',
        partner1_social: detailsResult.data.partner1_social ?? '',
        partner2_social: detailsResult.data.partner2_social ?? '',
        dogs_description: detailsResult.data.dogs_description ?? '',
        arbor_choice: detailsResult.data.arbor_choice ?? '',
        ceremony_notes: detailsResult.data.ceremony_notes ?? '',
        seating_method: detailsResult.data.seating_method ?? '',
        favors_description: detailsResult.data.favors_description ?? '',
        reception_notes: detailsResult.data.reception_notes ?? '',
        send_off_notes: detailsResult.data.send_off_notes ?? '',
        custom_field_values: detailsResult.data.custom_field_values ?? {},
      })
    }

    if (!configResult.error && configResult.data) {
      setVenueConfig({
        allow_outside_ceremony: configResult.data.allow_outside_ceremony ?? true,
        allow_inside_ceremony: configResult.data.allow_inside_ceremony ?? true,
        arbor_options: configResult.data.arbor_options ?? [],
        allow_unity_table: configResult.data.allow_unity_table ?? true,
        allow_charger_plates: configResult.data.allow_charger_plates ?? true,
        allow_champagne_glasses: configResult.data.allow_champagne_glasses ?? true,
        allow_sparklers: configResult.data.allow_sparklers ?? true,
        allow_wands: configResult.data.allow_wands ?? true,
        allow_bubbles: configResult.data.allow_bubbles ?? true,
        custom_send_off_options: configResult.data.custom_send_off_options ?? [],
        custom_fields: configResult.data.custom_fields ?? [],
      })
    }

    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Auto-save with debounce ----
  const saveDetails = useCallback(
    async (data: WeddingDetails) => {
      setSaveStatus('saving')

      try {
        const res = await fetch('/api/couple/wedding-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })

        if (!res.ok) throw new Error('Save failed')

        setSaveStatus('saved')
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000)
      }
    },
    []
  )

  const debouncedSave = useCallback(
    (data: WeddingDetails) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => saveDetails(data), 1000)
    },
    [saveDetails]
  )

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
  }, [])

  // ---- Update helpers ----
  const updateField = useCallback(
    <K extends keyof WeddingDetails>(field: K, value: WeddingDetails[K]) => {
      setDetails((prev) => {
        const next = { ...prev, [field]: value }
        debouncedSave(next)
        return next
      })
    },
    [debouncedSave]
  )

  const updateText = useCallback(
    (field: keyof WeddingDetails) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      updateField(field, e.target.value as never)
    },
    [updateField]
  )

  const updateCustomFieldValue = useCallback(
    (fieldLabel: string, value: string | boolean) => {
      setDetails((prev) => {
        const next = {
          ...prev,
          custom_field_values: {
            ...(prev.custom_field_values ?? {}),
            [fieldLabel]: value,
          },
        }
        debouncedSave(next)
        return next
      })
    },
    [debouncedSave]
  )

  // ---- Build dynamic options based on venue config ----
  const ceremonyLocations = (() => {
    const locs: { key: 'outside' | 'inside' | 'both'; label: string }[] = []
    if (venueConfig.allow_outside_ceremony) locs.push({ key: 'outside', label: 'Outside' })
    if (venueConfig.allow_inside_ceremony) locs.push({ key: 'inside', label: 'Inside' })
    if (venueConfig.allow_outside_ceremony && venueConfig.allow_inside_ceremony) {
      locs.push({ key: 'both', label: 'Both' })
    }
    return locs
  })()

  const sendOffTypes = (() => {
    const types: { key: string; label: string }[] = []
    if (venueConfig.allow_sparklers) types.push({ key: 'sparklers', label: 'Sparklers' })
    if (venueConfig.allow_wands) types.push({ key: 'wands', label: 'Wands' })
    if (venueConfig.allow_bubbles) types.push({ key: 'bubbles', label: 'Bubbles' })
    // Add custom send-off options from venue config
    for (const opt of venueConfig.custom_send_off_options) {
      types.push({ key: opt.toLowerCase().replace(/\s+/g, '-'), label: opt })
    }
    types.push({ key: 'none', label: 'None' })
    types.push({ key: 'other', label: 'Other' })
    return types
  })()

  const providingItems = (() => {
    const items: { key: keyof WeddingDetails; label: string }[] = [
      { key: 'providing_table_numbers', label: 'Table numbers' },
    ]
    if (venueConfig.allow_charger_plates) {
      items.push({ key: 'providing_charger_plates', label: 'Charger plates' })
    }
    if (venueConfig.allow_champagne_glasses) {
      items.push({ key: 'providing_champagne_glasses', label: 'Champagne glasses' })
    }
    items.push(
      { key: 'providing_cake_cutter', label: 'Cake cutter & server' },
      { key: 'providing_cake_topper', label: 'Cake topper' },
    )
    return items
  })()

  // ---- Loading ----
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 text-[#7D8471] animate-spin" />
      </div>
    )
  }

  // ---- Save Status Indicator ----
  const SaveIndicator = () => {
    if (saveStatus === 'idle') return null

    return (
      <div
        className={cn(
          'fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium transition-all',
          saveStatus === 'saving' && 'bg-white text-gray-600 border border-gray-200',
          saveStatus === 'saved' && 'bg-[#7D8471] text-white',
          saveStatus === 'error' && 'bg-red-500 text-white'
        )}
      >
        {saveStatus === 'saving' && (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Saving...
          </>
        )}
        {saveStatus === 'saved' && (
          <>
            <Check className="w-4 h-4" />
            Saved
          </>
        )}
        {saveStatus === 'error' && (
          <>
            <span className="w-4 h-4 text-center">!</span>
            Save failed
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Wedding Details</h1>
          <p className="text-sm text-gray-500 mt-1">
            Tell us about your vision so we can help bring it to life.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saveStatus === 'saving' && (
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1.5 text-xs text-[#7D8471]">
              <Check className="w-3 h-3" />
              Saved
            </span>
          )}
        </div>
      </div>

      {/* Section 1: The Basics */}
      <Section title="The Basics" icon={Heart}>
        <Field label="Wedding Colors" hint="List the colors for your wedding palette">
          <div className="relative">
            <Palette className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={details.wedding_colors ?? ''}
              onChange={updateText('wedding_colors')}
              placeholder="e.g. Dusty rose, sage green, ivory"
              className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
            />
          </div>
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Partner 1 Social Handle" hint="Instagram, TikTok, etc.">
            <div className="relative">
              <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={details.partner1_social ?? ''}
                onChange={updateText('partner1_social')}
                placeholder="@handle"
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
              />
            </div>
          </Field>

          <Field label="Partner 2 Social Handle" hint="Instagram, TikTok, etc.">
            <div className="relative">
              <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={details.partner2_social ?? ''}
                onChange={updateText('partner2_social')}
                placeholder="@handle"
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
              />
            </div>
          </Field>
        </div>

        <div className="space-y-3">
          <Toggle
            value={details.dogs_coming}
            onChange={(v) => updateField('dogs_coming', v)}
            label="Will dogs be joining the celebration?"
          />
          {details.dogs_coming && (
            <Field label="Tell us about your pup(s)" hint="Names, breeds, any special needs">
              <textarea
                value={details.dogs_description ?? ''}
                onChange={updateText('dogs_description')}
                placeholder="My golden retriever Biscuit will be the ring bearer..."
                rows={3}
                className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] resize-none"
              />
            </Field>
          )}
        </div>
      </Section>

      {/* Section 2: Ceremony */}
      <Section title="Ceremony" icon={Church}>
        {ceremonyLocations.length > 0 && (
          <Field label="Ceremony Location">
            <OptionToggle
              value={details.ceremony_location}
              options={ceremonyLocations}
              onChange={(v) => updateField('ceremony_location', v)}
            />
          </Field>
        )}

        {venueConfig.arbor_options.length > 0 ? (
          <Field label="Arbor / Arch Choice" hint="Select from the available options">
            <select
              value={details.arbor_choice ?? ''}
              onChange={updateText('arbor_choice')}
              className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] bg-white"
            >
              <option value="">Select an option...</option>
              {venueConfig.arbor_options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Arbor / Arch Choice" hint="Describe what you'd like for your ceremony arch or arbor">
            <input
              type="text"
              value={details.arbor_choice ?? ''}
              onChange={updateText('arbor_choice')}
              placeholder="e.g. Wooden arch with floral arrangement, metal hexagon, etc."
              className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
            />
          </Field>
        )}

        {venueConfig.allow_unity_table && (
          <Toggle
            value={details.unity_table}
            onChange={(v) => updateField('unity_table', v)}
            label="Would you like a unity table? (for sand ceremony, candle lighting, etc.)"
          />
        )}

        <Field label="Ceremony Notes" hint="Anything else about your ceremony we should know">
          <textarea
            value={details.ceremony_notes ?? ''}
            onChange={updateText('ceremony_notes')}
            placeholder="Special readings, music requests, processional order..."
            rows={4}
            className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] resize-none"
          />
        </Field>
      </Section>

      {/* Section 3: Reception */}
      <Section title="Reception" icon={PartyPopper}>
        <Field label="Seating Method" hint="How would you like guests to find their seats?">
          <input
            type="text"
            value={details.seating_method ?? ''}
            onChange={updateText('seating_method')}
            placeholder="e.g. Escort cards, seating chart display, place cards at tables"
            className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
          />
        </Field>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">
            Will you be providing any of the following?
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {providingItems.map((item) => (
              <label
                key={item.key}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                  details[item.key]
                    ? 'bg-[#7D8471]/5 border-[#7D8471]/30'
                    : 'bg-white border-gray-200 hover:border-gray-300'
                )}
              >
                <div
                  className={cn(
                    'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0',
                    details[item.key]
                      ? 'bg-[#7D8471] border-[#7D8471]'
                      : 'border-gray-300'
                  )}
                >
                  {details[item.key] && <Check className="w-3 h-3 text-white" />}
                </div>
                <span className="text-sm text-gray-700">{item.label}</span>
              </label>
            ))}
          </div>
        </div>

        <Field label="Favors" hint="Describe any wedding favors you're planning">
          <textarea
            value={details.favors_description ?? ''}
            onChange={updateText('favors_description')}
            placeholder="e.g. Custom cookies, mini succulents, scratch-off lottery tickets..."
            rows={3}
            className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] resize-none"
          />
        </Field>

        <Field label="Reception Notes" hint="Any other details about your reception">
          <textarea
            value={details.reception_notes ?? ''}
            onChange={updateText('reception_notes')}
            placeholder="Special dances, announcements, surprises planned..."
            rows={4}
            className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] resize-none"
          />
        </Field>
      </Section>

      {/* Section 4: Send-Off */}
      <Section title="Send-Off" icon={Sparkles}>
        <Field label="Send-Off Type" hint="How would you like to end the night?">
          <OptionToggle
            value={details.send_off_type}
            options={sendOffTypes}
            onChange={(v) => updateField('send_off_type', v)}
          />
        </Field>

        {details.send_off_type && details.send_off_type !== 'none' && (
          <Field label="Send-Off Notes" hint="Any special instructions or ideas">
            <textarea
              value={details.send_off_notes ?? ''}
              onChange={updateText('send_off_notes')}
              placeholder={
                details.send_off_type === 'sparklers'
                  ? 'Sparkler length preference, timing, song to play...'
                  : details.send_off_type === 'other'
                    ? 'Describe your send-off idea...'
                    : 'Any details or preferences...'
              }
              rows={3}
              className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] resize-none"
            />
          </Field>
        )}
      </Section>

      {/* Section 5: Custom Fields (from venue config) */}
      {venueConfig.custom_fields.length > 0 && (
        <Section title="Additional Details" icon={Sparkles}>
          {venueConfig.custom_fields.map((field, idx) => {
            const fieldKey = field.label
            const fieldValue = details.custom_field_values?.[fieldKey]

            if (field.type === 'toggle') {
              return (
                <Toggle
                  key={idx}
                  value={!!fieldValue}
                  onChange={(v) => updateCustomFieldValue(fieldKey, v)}
                  label={field.label}
                />
              )
            }

            if (field.type === 'select' && field.options && field.options.length > 0) {
              return (
                <Field key={idx} label={field.label}>
                  <select
                    value={(fieldValue as string) ?? ''}
                    onChange={(e) => updateCustomFieldValue(fieldKey, e.target.value)}
                    className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] bg-white"
                  >
                    <option value="">Select an option...</option>
                    {field.options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </Field>
              )
            }

            // Default: text input
            return (
              <Field key={idx} label={field.label}>
                <input
                  type="text"
                  value={(fieldValue as string) ?? ''}
                  onChange={(e) => updateCustomFieldValue(fieldKey, e.target.value)}
                  placeholder={`Enter ${field.label.toLowerCase()}...`}
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
                />
              </Field>
            )
          })}
        </Section>
      )}

      {/* Floating save indicator */}
      <SaveIndicator />
    </div>
  )
}
