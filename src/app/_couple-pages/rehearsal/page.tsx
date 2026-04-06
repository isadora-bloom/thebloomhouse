'use client'

// Feature: configurable via venue_config.feature_flags
// Table: rehearsal_dinner

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  CalendarDays,
  Save,
  Check,
  Loader2,
  Info,
  Users,
  Utensils,
  Wine,
  Armchair,
  LayoutGrid,
  Baby,
  Trash2,
  Paintbrush,
  TableProperties,
  StickyNote,
  MapPin,
  Clock,
  Phone,
  User,
  DollarSign,
  Home,
  Building2,
  HelpCircle,
  Landmark,
} from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types & options
// ---------------------------------------------------------------------------

type LocationType = 'at_venue' | 'restaurant' | 'private_home' | 'other'

interface RehearsalData {
  id?: string
  // Common fields
  location_type: LocationType
  date: string
  start_time: string
  end_time: string
  guest_count: number | null
  notes: string

  // At Venue fields
  venue_space: string
  bar_type: string
  food_type: string
  food_notes: string
  seating: string
  table_layout: string
  high_chairs: boolean
  high_chair_count: number
  disposables: boolean
  renting_china: boolean
  renting_flatware: boolean
  linens_source: string
  decor_source: string

  // Restaurant fields
  restaurant_name: string
  restaurant_address: string
  restaurant_contact: string
  restaurant_phone: string
  reservation_time: string
  private_dining: boolean
  set_menu: boolean
  menu_notes: string
  dietary_notes: string
  cost_per_person: number | null
  total_budget: number | null

  // Private Home fields
  home_address: string
  host_name: string
  home_food_type: string
  home_bar_type: string
  setup_cleanup_plan: string

  // Other Location fields
  other_location_name: string
  other_address: string
  other_food_type: string
  other_bar_type: string
}

const EMPTY_DATA: RehearsalData = {
  location_type: 'at_venue',
  date: '',
  start_time: '',
  end_time: '',
  guest_count: null,
  notes: '',

  venue_space: '',
  bar_type: '',
  food_type: '',
  food_notes: '',
  seating: '',
  table_layout: '',
  high_chairs: false,
  high_chair_count: 0,
  disposables: false,
  renting_china: false,
  renting_flatware: false,
  linens_source: '',
  decor_source: '',

  restaurant_name: '',
  restaurant_address: '',
  restaurant_contact: '',
  restaurant_phone: '',
  reservation_time: '',
  private_dining: false,
  set_menu: false,
  menu_notes: '',
  dietary_notes: '',
  cost_per_person: null,
  total_budget: null,

  home_address: '',
  host_name: '',
  home_food_type: '',
  home_bar_type: '',
  setup_cleanup_plan: '',

  other_location_name: '',
  other_address: '',
  other_food_type: '',
  other_bar_type: '',
}

const LOCATION_TYPE_OPTIONS: { value: LocationType; label: string; icon: React.ElementType; description: string }[] = [
  { value: 'at_venue', label: 'At the Venue', icon: Landmark, description: 'Host at your wedding venue' },
  { value: 'restaurant', label: 'Restaurant', icon: Building2, description: 'Private dining or reserved area' },
  { value: 'private_home', label: 'Private Home', icon: Home, description: 'Hosted at someone\'s home' },
  { value: 'other', label: 'Other Location', icon: HelpCircle, description: 'Park, brewery, etc.' },
]

const BAR_OPTIONS = ['Dry', 'Beer & Wine', 'Full Bar']
const VENUE_FOOD_OPTIONS = ['Full Catering', 'Self-Catered', 'Potluck']
const HOME_FOOD_OPTIONS = ['Catered', 'Self-Cooked', 'Potluck']
const SEATING_OPTIONS = ['Open', 'Assigned']
const TABLE_LAYOUT_OPTIONS = ['Round', 'Rectangular', 'Mix', 'Leave to Venue']
const LINENS_OPTIONS = ['Venue', 'Couple Brings', 'Rental Company']
const DECOR_OPTIONS = ['Couple Brings', 'Venue', 'Florist']

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// ---------------------------------------------------------------------------
// Toggle group component
// ---------------------------------------------------------------------------

function ToggleGroup({
  label,
  options,
  value,
  onChange,
  icon,
}: {
  label: string
  options: string[]
  value: string
  onChange: (v: string) => void
  icon?: React.ReactNode
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-2">
        {icon}
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={cn(
              'px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors',
              value === opt
                ? 'text-white border-transparent shadow-sm'
                : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white',
            )}
            style={value === opt ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Yes/No toggle component
// ---------------------------------------------------------------------------

function YesNoToggle({
  label,
  value,
  onChange,
  icon,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  icon?: React.ReactNode
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-2">
        {icon}
        {label}
      </label>
      <div className="flex gap-2">
        {[true, false].map((opt) => (
          <button
            key={String(opt)}
            onClick={() => onChange(opt)}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
              value === opt
                ? 'text-white border-transparent shadow-sm'
                : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white',
            )}
            style={value === opt ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            {opt ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text input helper
// ---------------------------------------------------------------------------

function FormInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  icon,
  className: extraClass,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <div className={extraClass}>
      <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1">
        {icon}
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
        style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
      />
    </div>
  )
}

function FormTextarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  icon,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  icon?: React.ReactNode
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1">
        {icon}
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
        style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
      />
    </div>
  )
}

function FormNumber({
  label,
  value,
  onChange,
  placeholder,
  icon,
  prefix,
  className: extraClass,
}: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
  placeholder?: string
  icon?: React.ReactNode
  prefix?: string
  className?: string
}) {
  return (
    <div className={extraClass}>
      <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1">
        {icon}
        {label}
      </label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{prefix}</span>
        )}
        <input
          type="number"
          min={0}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value ? parseInt(e.target.value) : null)}
          placeholder={placeholder}
          className={cn(
            'w-full py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent',
            prefix ? 'pl-7 pr-3' : 'px-3',
          )}
          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RehearsalPage() {
  const [data, setData] = useState<RehearsalData>(EMPTY_DATA)
  const [existingId, setExistingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [dirty, setDirty] = useState(false)
  const [venueSpaceOptions, setVenueSpaceOptions] = useState<string[]>([])
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [rehearsalRes, configRes] = await Promise.all([
      supabase
        .from('rehearsal_dinner')
        .select('*')
        .eq('wedding_id', WEDDING_ID)
        .maybeSingle(),
      supabase
        .from('venue_config')
        .select('rehearsal_space_options')
        .eq('venue_id', VENUE_ID)
        .maybeSingle(),
    ])

    if (rehearsalRes.data) {
      const row = rehearsalRes.data
      setExistingId(row.id)
      setData({
        location_type: row.location_type || 'at_venue',
        date: row.date || '',
        start_time: row.start_time || '',
        end_time: row.end_time || '',
        guest_count: row.guest_count ?? null,
        notes: row.notes || '',

        venue_space: row.venue_space || '',
        bar_type: row.bar_type || '',
        food_type: row.food_type || '',
        food_notes: row.food_notes || '',
        seating: row.seating || '',
        table_layout: row.table_layout || '',
        high_chairs: row.high_chairs || false,
        high_chair_count: row.high_chair_count || 0,
        disposables: row.disposables || false,
        renting_china: row.renting_china || false,
        renting_flatware: row.renting_flatware || false,
        linens_source: row.linens_source || '',
        decor_source: row.decor_source || '',

        restaurant_name: row.restaurant_name || '',
        restaurant_address: row.restaurant_address || '',
        restaurant_contact: row.restaurant_contact || '',
        restaurant_phone: row.restaurant_phone || '',
        reservation_time: row.reservation_time || '',
        private_dining: row.private_dining || false,
        set_menu: row.set_menu || false,
        menu_notes: row.menu_notes || '',
        dietary_notes: row.dietary_notes || '',
        cost_per_person: row.cost_per_person ?? null,
        total_budget: row.total_budget ?? null,

        home_address: row.home_address || '',
        host_name: row.host_name || '',
        home_food_type: row.home_food_type || '',
        home_bar_type: row.home_bar_type || '',
        setup_cleanup_plan: row.setup_cleanup_plan || '',

        other_location_name: row.other_location_name || '',
        other_address: row.other_address || '',
        other_food_type: row.other_food_type || '',
        other_bar_type: row.other_bar_type || '',
      })
    }

    if (configRes.data && configRes.data.rehearsal_space_options) {
      setVenueSpaceOptions(configRes.data.rehearsal_space_options as string[])
    }

    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Update field ----
  function updateField<K extends keyof RehearsalData>(field: K, value: RehearsalData[K]) {
    setData((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
    setSaveStatus('idle')
  }

  // ---- Save ----
  async function handleSave() {
    setSaveStatus('saving')

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      location_type: data.location_type,
      date: data.date || null,
      start_time: data.start_time || null,
      end_time: data.end_time || null,
      guest_count: data.guest_count,
      notes: data.notes.trim() || null,

      // At Venue
      venue_space: data.venue_space || null,
      bar_type: data.bar_type || null,
      food_type: data.food_type || null,
      food_notes: data.food_notes.trim() || null,
      seating: data.seating || null,
      table_layout: data.table_layout || null,
      high_chairs: data.high_chairs,
      high_chair_count: data.high_chairs ? data.high_chair_count : 0,
      disposables: data.disposables,
      renting_china: data.renting_china,
      renting_flatware: data.renting_flatware,
      linens_source: data.linens_source || null,
      decor_source: data.decor_source || null,

      // Restaurant
      restaurant_name: data.restaurant_name.trim() || null,
      restaurant_address: data.restaurant_address.trim() || null,
      restaurant_contact: data.restaurant_contact.trim() || null,
      restaurant_phone: data.restaurant_phone.trim() || null,
      reservation_time: data.reservation_time || null,
      private_dining: data.private_dining,
      set_menu: data.set_menu,
      menu_notes: data.menu_notes.trim() || null,
      dietary_notes: data.dietary_notes.trim() || null,
      cost_per_person: data.cost_per_person,
      total_budget: data.total_budget,

      // Private Home
      home_address: data.home_address.trim() || null,
      host_name: data.host_name.trim() || null,
      home_food_type: data.home_food_type || null,
      home_bar_type: data.home_bar_type || null,
      setup_cleanup_plan: data.setup_cleanup_plan.trim() || null,

      // Other
      other_location_name: data.other_location_name.trim() || null,
      other_address: data.other_address.trim() || null,
      other_food_type: data.other_food_type.trim() || null,
      other_bar_type: data.other_bar_type || null,
    }

    let error
    if (existingId) {
      const result = await supabase.from('rehearsal_dinner').update(payload).eq('id', existingId)
      error = result.error
    } else {
      const result = await supabase.from('rehearsal_dinner').insert(payload).select('id').single()
      error = result.error
      if (!error && result.data) setExistingId(result.data.id)
    }

    if (error) {
      setSaveStatus('error')
    } else {
      setSaveStatus('saved')
      setDirty(false)
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 2500)
    }
  }

  // ---- Loading ----
  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-100 rounded-xl" />
      </div>
    )
  }

  const currentLocationType = LOCATION_TYPE_OPTIONS.find((o) => o.value === data.location_type)

  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Rehearsal Dinner
        </h1>
        <p className="text-gray-500 text-sm">
          Plan every detail of your rehearsal dinner, wherever it may be.
        </p>
      </div>

      {/* ================================================================ */}
      {/* Step 1: Location Type */}
      {/* ================================================================ */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
        <h2
          className="text-sm font-semibold"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Where is the rehearsal dinner?
        </h2>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {LOCATION_TYPE_OPTIONS.map((opt) => {
            const OptIcon = opt.icon
            const isSelected = data.location_type === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => updateField('location_type', opt.value)}
                className={cn(
                  'text-left p-3 rounded-lg border transition-colors',
                  isSelected
                    ? 'text-white border-transparent'
                    : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white',
                )}
                style={isSelected ? { backgroundColor: 'var(--couple-primary)' } : undefined}
              >
                <OptIcon className="w-5 h-5 mb-1.5" />
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className={cn('block text-[10px] mt-0.5', isSelected ? 'text-white/80' : 'text-gray-400')}>
                  {opt.description}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* ================================================================ */}
      {/* Common Fields: Date & Time */}
      {/* ================================================================ */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
        <h2
          className="text-sm font-semibold flex items-center gap-1.5"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          <CalendarDays className="w-4 h-4" />
          Date & Time
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FormInput
            label="Date"
            type="date"
            value={data.date}
            onChange={(v) => updateField('date', v)}
            icon={<CalendarDays className="w-3.5 h-3.5 text-gray-400" />}
          />
          <FormInput
            label="Start Time"
            type="time"
            value={data.start_time}
            onChange={(v) => updateField('start_time', v)}
            icon={<Clock className="w-3.5 h-3.5 text-gray-400" />}
          />
          <FormInput
            label="End Time"
            type="time"
            value={data.end_time}
            onChange={(v) => updateField('end_time', v)}
            icon={<Clock className="w-3.5 h-3.5 text-gray-400" />}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormNumber
            label="Estimated Guest Count"
            value={data.guest_count}
            onChange={(v) => updateField('guest_count', v)}
            placeholder="e.g., 45"
            icon={<Users className="w-3.5 h-3.5 text-gray-400" />}
          />
        </div>
      </div>

      {/* ================================================================ */}
      {/* Step 2: Location-Specific Fields */}
      {/* ================================================================ */}

      {/* ---- AT VENUE ---- */}
      {data.location_type === 'at_venue' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-100">
          <div className="p-5 space-y-4">
            <h2
              className="text-sm font-semibold flex items-center gap-1.5"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              <Landmark className="w-4 h-4" />
              Venue Details
            </h2>

            {/* Venue space */}
            {venueSpaceOptions.length > 0 ? (
              <ToggleGroup
                label="Venue Space"
                options={venueSpaceOptions}
                value={data.venue_space}
                onChange={(v) => updateField('venue_space', v)}
                icon={<MapPin className="w-4 h-4 text-gray-400" />}
              />
            ) : (
              <FormInput
                label="Venue Space"
                value={data.venue_space}
                onChange={(v) => updateField('venue_space', v)}
                placeholder="e.g., Patio, Ballroom, Kitchen"
                icon={<MapPin className="w-3.5 h-3.5 text-gray-400" />}
              />
            )}
          </div>

          {/* Bar Type */}
          <div className="p-5">
            <ToggleGroup
              label="Bar Type"
              options={BAR_OPTIONS}
              value={data.bar_type}
              onChange={(v) => updateField('bar_type', v)}
              icon={<Wine className="w-4 h-4 text-gray-400" />}
            />
          </div>

          {/* Food Type */}
          <div className="p-5 space-y-3">
            <ToggleGroup
              label="Food"
              options={VENUE_FOOD_OPTIONS}
              value={data.food_type}
              onChange={(v) => updateField('food_type', v)}
              icon={<Utensils className="w-4 h-4 text-gray-400" />}
            />
            <FormTextarea
              label="Food Notes"
              value={data.food_notes}
              onChange={(v) => updateField('food_notes', v)}
              placeholder="Dietary accommodations, menu selections, vendor contact..."
              rows={2}
            />
          </div>

          {/* Seating */}
          <div className="p-5">
            <ToggleGroup
              label="Seating"
              options={SEATING_OPTIONS}
              value={data.seating}
              onChange={(v) => updateField('seating', v)}
              icon={<Armchair className="w-4 h-4 text-gray-400" />}
            />
          </div>

          {/* Table Layout */}
          <div className="p-5">
            <ToggleGroup
              label="Table Layout"
              options={TABLE_LAYOUT_OPTIONS}
              value={data.table_layout}
              onChange={(v) => updateField('table_layout', v)}
              icon={<LayoutGrid className="w-4 h-4 text-gray-400" />}
            />
          </div>

          {/* Tableware */}
          <div className="p-5 space-y-5">
            <ToggleGroup
              label="Linens"
              options={LINENS_OPTIONS}
              value={data.linens_source}
              onChange={(v) => updateField('linens_source', v)}
              icon={<TableProperties className="w-4 h-4 text-gray-400" />}
            />
            <YesNoToggle
              label="Using Disposables"
              value={data.disposables}
              onChange={(v) => updateField('disposables', v)}
              icon={<Trash2 className="w-4 h-4 text-gray-400" />}
            />
            <YesNoToggle
              label="Renting China"
              value={data.renting_china}
              onChange={(v) => updateField('renting_china', v)}
              icon={<TableProperties className="w-4 h-4 text-gray-400" />}
            />
            <YesNoToggle
              label="Renting Flatware"
              value={data.renting_flatware}
              onChange={(v) => updateField('renting_flatware', v)}
              icon={<Utensils className="w-4 h-4 text-gray-400" />}
            />
          </div>

          {/* High Chairs */}
          <div className="p-5 space-y-3">
            <YesNoToggle
              label="High Chairs Needed"
              value={data.high_chairs}
              onChange={(v) => updateField('high_chairs', v)}
              icon={<Baby className="w-4 h-4 text-gray-400" />}
            />
            {data.high_chairs && (
              <FormNumber
                label="How many?"
                value={data.high_chair_count || null}
                onChange={(v) => updateField('high_chair_count', v ?? 0)}
                className="max-w-[120px]"
              />
            )}
          </div>

          {/* Decor Source */}
          <div className="p-5">
            <ToggleGroup
              label="Decor"
              options={DECOR_OPTIONS}
              value={data.decor_source}
              onChange={(v) => updateField('decor_source', v)}
              icon={<Paintbrush className="w-4 h-4 text-gray-400" />}
            />
          </div>
        </div>
      )}

      {/* ---- RESTAURANT ---- */}
      {data.location_type === 'restaurant' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-100">
          <div className="p-5 space-y-4">
            <h2
              className="text-sm font-semibold flex items-center gap-1.5"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              <Building2 className="w-4 h-4" />
              Restaurant Details
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormInput
                label="Restaurant Name"
                value={data.restaurant_name}
                onChange={(v) => updateField('restaurant_name', v)}
                placeholder="e.g., The Blue Duck Tavern"
                icon={<Building2 className="w-3.5 h-3.5 text-gray-400" />}
              />
              <FormInput
                label="Address"
                value={data.restaurant_address}
                onChange={(v) => updateField('restaurant_address', v)}
                placeholder="Full address"
                icon={<MapPin className="w-3.5 h-3.5 text-gray-400" />}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormInput
                label="Contact Person"
                value={data.restaurant_contact}
                onChange={(v) => updateField('restaurant_contact', v)}
                placeholder="Name of your contact"
                icon={<User className="w-3.5 h-3.5 text-gray-400" />}
              />
              <FormInput
                label="Phone"
                value={data.restaurant_phone}
                onChange={(v) => updateField('restaurant_phone', v)}
                placeholder="(555) 123-4567"
                type="tel"
                icon={<Phone className="w-3.5 h-3.5 text-gray-400" />}
              />
            </div>

            <FormInput
              label="Reservation Time"
              value={data.reservation_time}
              onChange={(v) => updateField('reservation_time', v)}
              type="time"
              icon={<Clock className="w-3.5 h-3.5 text-gray-400" />}
            />
          </div>

          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <YesNoToggle
                label="Private Dining Room"
                value={data.private_dining}
                onChange={(v) => updateField('private_dining', v)}
              />
              <YesNoToggle
                label="Set Menu"
                value={data.set_menu}
                onChange={(v) => updateField('set_menu', v)}
              />
            </div>

            {data.set_menu && (
              <FormTextarea
                label="Menu Notes"
                value={data.menu_notes}
                onChange={(v) => updateField('menu_notes', v)}
                placeholder="Menu selections, courses, special items..."
                rows={3}
                icon={<Utensils className="w-3.5 h-3.5 text-gray-400" />}
              />
            )}

            <FormTextarea
              label="Dietary Needs Notes"
              value={data.dietary_notes}
              onChange={(v) => updateField('dietary_notes', v)}
              placeholder="Allergies, vegetarian/vegan needs, kosher, etc."
              rows={2}
              icon={<Info className="w-3.5 h-3.5 text-gray-400" />}
            />
          </div>

          <div className="p-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormNumber
                label="Cost per Person"
                value={data.cost_per_person}
                onChange={(v) => updateField('cost_per_person', v)}
                placeholder="0"
                prefix="$"
                icon={<DollarSign className="w-3.5 h-3.5 text-gray-400" />}
              />
              <FormNumber
                label="Total Budget"
                value={data.total_budget}
                onChange={(v) => updateField('total_budget', v)}
                placeholder="0"
                prefix="$"
                icon={<DollarSign className="w-3.5 h-3.5 text-gray-400" />}
              />
            </div>
          </div>
        </div>
      )}

      {/* ---- PRIVATE HOME ---- */}
      {data.location_type === 'private_home' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-100">
          <div className="p-5 space-y-4">
            <h2
              className="text-sm font-semibold flex items-center gap-1.5"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              <Home className="w-4 h-4" />
              Private Home Details
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormInput
                label="Host Name"
                value={data.host_name}
                onChange={(v) => updateField('host_name', v)}
                placeholder="Who is hosting?"
                icon={<User className="w-3.5 h-3.5 text-gray-400" />}
              />
              <FormInput
                label="Address"
                value={data.home_address}
                onChange={(v) => updateField('home_address', v)}
                placeholder="Full address"
                icon={<MapPin className="w-3.5 h-3.5 text-gray-400" />}
              />
            </div>
          </div>

          <div className="p-5 space-y-4">
            <ToggleGroup
              label="Bar Type"
              options={BAR_OPTIONS}
              value={data.home_bar_type}
              onChange={(v) => updateField('home_bar_type', v)}
              icon={<Wine className="w-4 h-4 text-gray-400" />}
            />
            <ToggleGroup
              label="Food"
              options={HOME_FOOD_OPTIONS}
              value={data.home_food_type}
              onChange={(v) => updateField('home_food_type', v)}
              icon={<Utensils className="w-4 h-4 text-gray-400" />}
            />
          </div>

          <div className="p-5">
            <FormTextarea
              label="Setup & Cleanup Plan"
              value={data.setup_cleanup_plan}
              onChange={(v) => updateField('setup_cleanup_plan', v)}
              placeholder="Who is setting up? Cleaning up? Rental pickup times?"
              rows={3}
              icon={<StickyNote className="w-3.5 h-3.5 text-gray-400" />}
            />
          </div>
        </div>
      )}

      {/* ---- OTHER LOCATION ---- */}
      {data.location_type === 'other' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-100">
          <div className="p-5 space-y-4">
            <h2
              className="text-sm font-semibold flex items-center gap-1.5"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              <HelpCircle className="w-4 h-4" />
              Location Details
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormInput
                label="Location Name"
                value={data.other_location_name}
                onChange={(v) => updateField('other_location_name', v)}
                placeholder="e.g., Blue Mountain Brewery"
                icon={<MapPin className="w-3.5 h-3.5 text-gray-400" />}
              />
              <FormInput
                label="Address"
                value={data.other_address}
                onChange={(v) => updateField('other_address', v)}
                placeholder="Full address"
                icon={<MapPin className="w-3.5 h-3.5 text-gray-400" />}
              />
            </div>
          </div>

          <div className="p-5 space-y-4">
            <FormInput
              label="Food Type"
              value={data.other_food_type}
              onChange={(v) => updateField('other_food_type', v)}
              placeholder="e.g., BBQ buffet, pizza, food truck"
              icon={<Utensils className="w-3.5 h-3.5 text-gray-400" />}
            />
            <ToggleGroup
              label="Bar Type"
              options={BAR_OPTIONS}
              value={data.other_bar_type}
              onChange={(v) => updateField('other_bar_type', v)}
              icon={<Wine className="w-4 h-4 text-gray-400" />}
            />
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* General Notes (all types) */}
      {/* ================================================================ */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <FormTextarea
          label="Additional Notes"
          value={data.notes}
          onChange={(v) => updateField('notes', v)}
          placeholder="Toasts, slideshows, timing details, anything else to remember..."
          rows={4}
          icon={<StickyNote className="w-3.5 h-3.5 text-gray-400" />}
        />
      </div>

      {/* ================================================================ */}
      {/* Sticky Save Button */}
      {/* ================================================================ */}
      <div className="fixed bottom-0 left-0 right-0 z-40 pointer-events-none">
        <div className="max-w-3xl mx-auto px-4 pb-4">
          <div
            className={cn(
              'pointer-events-auto flex items-center justify-between gap-3 px-5 py-3 rounded-xl border shadow-lg transition-all',
              dirty
                ? 'bg-white border-gray-200'
                : saveStatus === 'saved'
                  ? 'bg-green-50 border-green-200'
                  : saveStatus === 'error'
                    ? 'bg-red-50 border-red-200'
                    : 'bg-white border-gray-100',
            )}
          >
            <div className="text-sm">
              {saveStatus === 'saving' && (
                <span className="text-gray-500 flex items-center gap-1.5">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </span>
              )}
              {saveStatus === 'saved' && (
                <span className="text-green-600 flex items-center gap-1.5">
                  <Check className="w-4 h-4" />
                  Saved
                </span>
              )}
              {saveStatus === 'error' && (
                <span className="text-red-600">Failed to save. Try again.</span>
              )}
              {saveStatus === 'idle' && dirty && (
                <span className="text-amber-600">Unsaved changes</span>
              )}
              {saveStatus === 'idle' && !dirty && (
                <span className="text-gray-400">All changes saved</span>
              )}
            </div>

            <button
              onClick={handleSave}
              disabled={!dirty || saveStatus === 'saving'}
              className={cn(
                'inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium text-white transition-opacity',
                dirty ? 'hover:opacity-90' : 'opacity-50 cursor-not-allowed',
              )}
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Save className="w-4 h-4" />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
