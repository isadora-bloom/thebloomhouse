'use client'

// Feature: configurable via venue_config.feature_flags
// Table: wedding_tables (single row per wedding, upsert)

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutGrid,
  Users,
  Palette,
  Armchair,
  Sparkles,
  StickyNote,
  Save,
  Check,
  Loader2,
  Heart,
  Crown,
  Baby,
  Wine,
  CircleDot,
  RectangleHorizontal,
  TreePine,
  Shuffle,
  ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TableShape = 'round' | 'rectangular' | 'farm' | 'mixed'
type HeadTableSided = 'one' | 'two'
type RunnerStyle = 'none' | 'runner' | 'overlay' | 'greenery'

interface ExtraTable {
  id: string
  label: string
  category: string
  count: number
  selected: boolean
}

// ---------------------------------------------------------------------------
// Extra Tables Definition (must be before DEFAULT_TABLES)
// ---------------------------------------------------------------------------

interface ExtraTableDef {
  id: string
  label: string
  category: string
}

const EXTRA_TABLE_DEFS: ExtraTableDef[] = [
  // Food & Beverage
  { id: 'cake', label: 'Cake table', category: 'Food & Beverage' },
  { id: 'candy_bar', label: 'Candy bar / dessert table', category: 'Food & Beverage' },
  { id: 'late_night', label: 'Late night snacks', category: 'Food & Beverage' },
  { id: 'coffee_tea', label: 'Coffee & tea station', category: 'Food & Beverage' },
  { id: 'cigar_bar', label: 'Cigar bar', category: 'Food & Beverage' },
  { id: 'smores', label: "S'mores station", category: 'Food & Beverage' },
  { id: 'buffet', label: 'Buffet table', category: 'Food & Beverage' },
  { id: 'welcome_drinks', label: 'Welcome drinks', category: 'Food & Beverage' },
  // Guest Experience
  { id: 'guest_book', label: 'Guest book', category: 'Guest Experience' },
  { id: 'place_cards', label: 'Place cards / escort cards', category: 'Guest Experience' },
  { id: 'gifts', label: 'Gift table', category: 'Guest Experience' },
  { id: 'card_box', label: 'Card box', category: 'Guest Experience' },
  { id: 'favors', label: 'Favors table', category: 'Guest Experience' },
  { id: 'photo_booth', label: 'Photo booth', category: 'Guest Experience' },
  { id: 'polaroid', label: 'Polaroid / instant camera', category: 'Guest Experience' },
  { id: 'programs', label: 'Programs table', category: 'Guest Experience' },
  // Memory
  { id: 'memorial', label: 'Memorial table', category: 'Memory' },
  { id: 'family_photos', label: 'Family photos display', category: 'Memory' },
  // Reception extras
  { id: 'dj', label: 'DJ table', category: 'Reception Extras' },
  { id: 'seating_chart', label: 'Seating chart display', category: 'Reception Extras' },
  { id: 'lawn_games', label: 'Lawn games area', category: 'Reception Extras' },
  { id: 'kids_activity', label: 'Kids activity station', category: 'Reception Extras' },
]

function buildDefaultExtras(): ExtraTable[] {
  return EXTRA_TABLE_DEFS.map((d) => ({
    id: d.id,
    label: d.label,
    category: d.category,
    count: 1,
    selected: false,
  }))
}

interface WeddingTables {
  id?: string
  guest_count: number
  table_shape: TableShape
  guests_per_table: number
  rect_table_count: number
  sweetheart_table: boolean
  head_table: boolean
  head_table_people: number
  head_table_sided: HeadTableSided
  kids_table: boolean
  kids_count: number
  cocktail_tables: number
  linen_color: string
  napkin_color: string
  linen_venue_choice: boolean
  runner_style: RunnerStyle
  chargers: boolean
  checkered_dance_floor: boolean
  lounge_area: boolean
  centerpiece_notes: string
  layout_notes: string
  linen_notes: string
  extra_tables: ExtraTable[]
  is_draft: boolean
}

const DEFAULT_TABLES: WeddingTables = {
  guest_count: 100,
  table_shape: 'round',
  guests_per_table: 8,
  rect_table_count: 0,
  sweetheart_table: false,
  head_table: false,
  head_table_people: 8,
  head_table_sided: 'one',
  kids_table: false,
  kids_count: 0,
  cocktail_tables: 0,
  linen_color: 'white',
  napkin_color: 'white',
  linen_venue_choice: false,
  runner_style: 'none',
  chargers: false,
  checkered_dance_floor: false,
  lounge_area: false,
  centerpiece_notes: '',
  layout_notes: '',
  linen_notes: '',
  extra_tables: buildDefaultExtras(),
  is_draft: true,
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// ---------------------------------------------------------------------------
// Linen Colors
// ---------------------------------------------------------------------------

interface LinenColor {
  name: string
  hex: string
  ring: string
}

const LINEN_COLORS: LinenColor[] = [
  { name: 'Venue Default', hex: '#9CA3AF', ring: 'ring-gray-400' },
  { name: 'White', hex: '#FFFFFF', ring: 'ring-gray-300' },
  { name: 'Ivory', hex: '#FFFFF0', ring: 'ring-yellow-200' },
  { name: 'Champagne', hex: '#F7E7CE', ring: 'ring-amber-200' },
  { name: 'Blush', hex: '#FFB6C1', ring: 'ring-pink-300' },
  { name: 'Dusty Rose', hex: '#DCAE96', ring: 'ring-rose-300' },
  { name: 'Sage', hex: '#9CAF88', ring: 'ring-green-400' },
  { name: 'Dusty Blue', hex: '#B0C4DE', ring: 'ring-blue-300' },
  { name: 'Navy', hex: '#000080', ring: 'ring-blue-800' },
  { name: 'Burgundy', hex: '#800020', ring: 'ring-red-900' },
  { name: 'Black', hex: '#1A1A1A', ring: 'ring-gray-800' },
]

// ---------------------------------------------------------------------------
// Table Shape Buttons
// ---------------------------------------------------------------------------

const TABLE_SHAPES: { key: TableShape; label: string; icon: typeof CircleDot; defaultPer: number }[] = [
  { key: 'round', label: 'Round', icon: CircleDot, defaultPer: 8 },
  { key: 'rectangular', label: 'Rectangular', icon: RectangleHorizontal, defaultPer: 8 },
  { key: 'farm', label: 'Farm', icon: TreePine, defaultPer: 10 },
  { key: 'mixed', label: 'Mixed', icon: Shuffle, defaultPer: 8 },
]

const RUNNER_STYLES: { key: RunnerStyle; label: string }[] = [
  { key: 'none', label: 'None' },
  { key: 'runner', label: 'Runner' },
  { key: 'overlay', label: 'Overlay' },
  { key: 'greenery', label: 'Greenery' },
]

const GUESTS_PER_TABLE_OPTIONS = [6, 8, 10, 12]

// ---------------------------------------------------------------------------
// Toggle component
// ---------------------------------------------------------------------------

function Toggle({
  value,
  onChange,
  label,
  emoji,
}: {
  value: boolean
  onChange: (v: boolean) => void
  label: string
  emoji?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex items-center gap-3 group w-full text-left"
    >
      <div
        className={cn(
          'w-11 h-6 rounded-full transition-colors relative flex-shrink-0',
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
      <span className="text-sm text-gray-700 group-hover:text-gray-900">
        {emoji && <span className="mr-1.5">{emoji}</span>}
        {label}
      </span>
    </button>
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
  icon: typeof Users
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
// Color Picker Row
// ---------------------------------------------------------------------------

function ColorPicker({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (v: string) => void
  label: string
}) {
  const selectedColor = LINEN_COLORS.find((c) => c.name.toLowerCase() === value.toLowerCase())

  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-2 items-center">
        {LINEN_COLORS.map((color) => {
          const isSelected = color.name.toLowerCase() === value.toLowerCase()
          return (
            <button
              key={color.name}
              type="button"
              onClick={() => onChange(color.name.toLowerCase())}
              title={color.name}
              className={cn(
                'w-9 h-9 rounded-full border-2 transition-all flex-shrink-0',
                isSelected
                  ? 'ring-2 ring-offset-2 border-[#7D8471] scale-110'
                  : 'border-gray-200 hover:scale-105'
              )}
              style={{ backgroundColor: color.hex }}
            />
          )
        })}
      </div>
      {selectedColor && (
        <p className="text-xs text-[#7D8471] font-medium mt-1.5">{selectedColor.name}</p>
      )}
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Tables Page
// ---------------------------------------------------------------------------

export default function TablesPage() {
  const [tables, setTables] = useState<WeddingTables>(DEFAULT_TABLES)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')

  const supabase = createClient()

  // ---- Fetch ----
  const fetchTables = useCallback(async () => {
    const { data, error } = await supabase
      .from('wedding_tables')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .eq('venue_id', VENUE_ID)
      .maybeSingle()

    if (!error && data) {
      setTables({
        ...DEFAULT_TABLES,
        ...data,
        centerpiece_notes: data.centerpiece_notes ?? '',
        layout_notes: data.layout_notes ?? '',
        linen_notes: data.linen_notes ?? '',
        extra_tables: mergeExtras(data.extra_tables),
      })
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchTables()
  }, [fetchTables])

  // Merge saved extras with defaults (in case new extras were added)
  function mergeExtras(saved: ExtraTable[] | null): ExtraTable[] {
    const defaults = buildDefaultExtras()
    if (!saved || !Array.isArray(saved)) return defaults

    const savedMap = new Map(saved.map((e) => [e.id, e]))
    return defaults.map((d) => {
      const s = savedMap.get(d.id)
      return s ? { ...d, ...s } : d
    })
  }

  // ---- Save ----
  const saveTables = useCallback(async () => {
    setSaveStatus('saving')

    try {
      const res = await fetch('/api/couple/tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...tables, is_draft: false }),
      })

      if (!res.ok) throw new Error('Save failed')

      setSaveStatus('saved')
      setTables((prev) => ({ ...prev, is_draft: false }))
      setTimeout(() => setSaveStatus('idle'), 2500)
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }, [tables])

  // ---- Update helpers ----
  const update = useCallback(<K extends keyof WeddingTables>(field: K, value: WeddingTables[K]) => {
    setTables((prev) => ({ ...prev, [field]: value }))
  }, [])

  const updateExtra = useCallback((id: string, changes: Partial<ExtraTable>) => {
    setTables((prev) => ({
      ...prev,
      extra_tables: prev.extra_tables.map((e) =>
        e.id === id ? { ...e, ...changes } : e
      ),
    }))
  }, [])

  // ---- Calculations ----
  const calculations = useMemo(() => {
    const {
      guest_count,
      guests_per_table,
      sweetheart_table,
      head_table,
      head_table_people,
      head_table_sided,
      kids_table,
      kids_count,
      cocktail_tables,
      table_shape,
      rect_table_count,
      extra_tables,
      linen_color,
      napkin_color,
    } = tables

    // Seated guests = total - sweetheart - head table - kids
    let seatedGuests = guest_count
    if (sweetheart_table) seatedGuests -= 2
    if (head_table) seatedGuests -= head_table_people
    if (kids_table) seatedGuests -= kids_count
    seatedGuests = Math.max(0, seatedGuests)

    // Guest tables
    const guestTables = guests_per_table > 0 ? Math.ceil(seatedGuests / guests_per_table) : 0

    // For mixed: calculate split
    let roundTables = guestTables
    let rectTables = 0
    if (table_shape === 'mixed') {
      rectTables = Math.min(rect_table_count, guestTables)
      roundTables = guestTables - rectTables
    }

    // Head table count (long tables)
    let headTableCount = 0
    if (head_table) {
      if (head_table_sided === 'two') {
        // Two-sided: people on both sides, seats = people + 4 buffer, divided by 2 sides, 3 per section
        headTableCount = Math.ceil(((head_table_people + 4) / 2) / 3)
      } else {
        // One-sided: people + 2 buffer, 3 per section
        headTableCount = Math.ceil((head_table_people + 2) / 3)
      }
    }

    const kidsTableCount = kids_table ? Math.ceil(kids_count / 8) : 0
    const sweetheartCount = sweetheart_table ? 1 : 0

    const totalGuestTables = guestTables + headTableCount + kidsTableCount + sweetheartCount

    // Extra tables that need linens
    const extraTablesWithLinens = extra_tables
      .filter((e) => e.selected)
      .reduce((sum, e) => sum + e.count, 0)

    const tableclothsNeeded = totalGuestTables + cocktail_tables + extraTablesWithLinens
    const napkinsNeeded = guest_count + 10

    // Selected extras list
    const selectedExtras = extra_tables.filter((e) => e.selected)

    return {
      seatedGuests,
      guestTables,
      roundTables,
      rectTables,
      headTableCount,
      kidsTableCount,
      sweetheartCount,
      totalGuestTables,
      cocktailTables: cocktail_tables,
      extraTablesWithLinens,
      tableclothsNeeded,
      napkinsNeeded,
      selectedExtras,
      linenColor: linen_color,
      napkinColor: napkin_color,
    }
  }, [tables])

  // ---- Loading ----
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 text-[#7D8471] animate-spin" />
      </div>
    )
  }

  // ---- Extra table categories ----
  const extraCategories = [...new Set(EXTRA_TABLE_DEFS.map((d) => d.category))]

  return (
    <div className="space-y-6 pb-28">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Table Layout Planner</h1>
        <p className="text-sm text-gray-500 mt-1">
          Plan your table layout, linens, and special areas. The summary updates live as you make changes.
        </p>
      </div>

      {/* Info banner */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
        <span className="text-amber-500 mt-0.5 shrink-0">ℹ️</span>
        <p className="text-sm text-amber-800">
          This is a rough guide to help your venue or planner build your table layout map and to help you budget for table linens. Your coordinator will create the final floor plan based on your selections here.
        </p>
      </div>

      {/* Section 1: Guest Count */}
      <Section title="Guest Count" icon={Users}>
        <Field label="Total Guest Count" hint="Include all guests (adults and children)">
          <input
            type="number"
            min={20}
            max={300}
            value={tables.guest_count}
            onChange={(e) => update('guest_count', Math.max(20, Math.min(300, parseInt(e.target.value) || 20)))}
            className="w-40 px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
          />
        </Field>
      </Section>

      {/* Section 2: Table Style */}
      <Section title="Table Style" icon={LayoutGrid}>
        <Field label="Table Shape">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {TABLE_SHAPES.map((shape) => {
              const ShapeIcon = shape.icon
              return (
                <button
                  key={shape.key}
                  type="button"
                  onClick={() => {
                    update('table_shape', shape.key)
                    update('guests_per_table', shape.defaultPer)
                  }}
                  className={cn(
                    'flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all',
                    tables.table_shape === shape.key
                      ? 'border-[#7D8471] bg-[#7D8471]/5 shadow-sm'
                      : 'border-gray-200 hover:border-[#7D8471]/40'
                  )}
                >
                  <ShapeIcon
                    className={cn(
                      'w-8 h-8',
                      tables.table_shape === shape.key ? 'text-[#7D8471]' : 'text-gray-400'
                    )}
                  />
                  <span
                    className={cn(
                      'text-sm font-medium',
                      tables.table_shape === shape.key ? 'text-[#7D8471]' : 'text-gray-600'
                    )}
                  >
                    {shape.label}
                  </span>
                </button>
              )
            })}
          </div>
        </Field>

        {/* Guests per table */}
        <Field label="Guests per Table">
          <div className="relative w-48">
            <select
              value={tables.guests_per_table}
              onChange={(e) => update('guests_per_table', parseInt(e.target.value))}
              className="w-full appearance-none px-4 py-2.5 pr-10 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] bg-white"
            >
              {GUESTS_PER_TABLE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} guests
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          </div>
        </Field>

        {/* Mixed table split */}
        {tables.table_shape === 'mixed' && (
          <div className="p-4 rounded-lg bg-gray-50 border border-gray-100 space-y-3">
            <Field label="Rectangular Tables" hint={`Round tables: ${calculations.roundTables}`}>
              <input
                type="number"
                min={0}
                max={calculations.guestTables}
                value={tables.rect_table_count}
                onChange={(e) =>
                  update(
                    'rect_table_count',
                    Math.max(0, Math.min(calculations.guestTables, parseInt(e.target.value) || 0))
                  )
                }
                className="w-32 px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
              />
            </Field>
          </div>
        )}
      </Section>

      {/* Section 3: Special Tables */}
      <Section title="Special Tables" icon={Heart}>
        <div className="space-y-5">
          {/* Sweetheart */}
          <Toggle
            value={tables.sweetheart_table}
            onChange={(v) => update('sweetheart_table', v)}
            label="Sweetheart table (just the two of you)"
          />

          {/* Head table */}
          <div className="space-y-3">
            <Toggle
              value={tables.head_table}
              onChange={(v) => update('head_table', v)}
              label="Head table"
            />
            {tables.head_table && (
              <div className="ml-14 space-y-3 p-4 rounded-lg bg-gray-50 border border-gray-100">
                <Field label="People at head table">
                  <input
                    type="number"
                    min={2}
                    max={30}
                    value={tables.head_table_people}
                    onChange={(e) =>
                      update('head_table_people', Math.max(2, Math.min(30, parseInt(e.target.value) || 2)))
                    }
                    className="w-28 px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
                  />
                </Field>
                <Field label="Seating arrangement">
                  <div className="flex gap-2">
                    {(['one', 'two'] as HeadTableSided[]).map((side) => (
                      <button
                        key={side}
                        type="button"
                        onClick={() => update('head_table_sided', side)}
                        className={cn(
                          'px-4 py-2 rounded-lg text-sm font-medium transition-all border',
                          tables.head_table_sided === side
                            ? 'bg-[#7D8471] text-white border-[#7D8471]'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-[#7D8471]/40'
                        )}
                      >
                        {side === 'one' ? 'One-sided' : 'Two-sided'}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            )}
          </div>

          {/* Kids table */}
          <div className="space-y-3">
            <Toggle
              value={tables.kids_table}
              onChange={(v) => update('kids_table', v)}
              label="Kids table"
            />
            {tables.kids_table && (
              <div className="ml-14">
                <Field label="Number of kids">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={tables.kids_count}
                    onChange={(e) =>
                      update('kids_count', Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))
                    }
                    className="w-28 px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
                  />
                </Field>
              </div>
            )}
          </div>

          {/* Cocktail tables */}
          <Field label="Cocktail high-top tables" hint="For cocktail hour or standing areas">
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={0}
                max={5}
                value={tables.cocktail_tables}
                onChange={(e) =>
                  update('cocktail_tables', Math.max(0, Math.min(5, parseInt(e.target.value) || 0)))
                }
                className="w-24 px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
              />
              <span className="text-sm text-gray-500">tables (0-5)</span>
            </div>
          </Field>
        </div>
      </Section>

      {/* Section 4: Linens */}
      <Section title="Linens" icon={Palette}>
        <ColorPicker
          value={tables.linen_color}
          onChange={(v) => update('linen_color', v)}
          label="Tablecloth Color"
        />

        <ColorPicker
          value={tables.napkin_color}
          onChange={(v) => update('napkin_color', v)}
          label="Napkin Color"
        />
      </Section>

      {/* Section 5: Tablecloth Details */}
      <Section title="Tablecloth Details" icon={Sparkles}>
        <label
          className={cn(
            'flex items-center gap-3 p-4 rounded-lg border cursor-pointer transition-colors',
            tables.linen_venue_choice
              ? 'bg-[#7D8471]/5 border-[#7D8471]/30'
              : 'bg-white border-gray-200 hover:border-gray-300'
          )}
        >
          <div
            className={cn(
              'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0',
              tables.linen_venue_choice
                ? 'bg-[#7D8471] border-[#7D8471]'
                : 'border-gray-300'
            )}
          >
            {tables.linen_venue_choice && <Check className="w-3 h-3 text-white" />}
          </div>
          <div>
            <span className="text-sm font-medium text-gray-700">Leave it to us</span>
            <p className="text-xs text-gray-400">We will handle the tablecloth selection based on your color choices above</p>
          </div>
          <input
            type="checkbox"
            checked={tables.linen_venue_choice}
            onChange={(e) => update('linen_venue_choice', e.target.checked)}
            className="sr-only"
          />
        </label>

        {!tables.linen_venue_choice && (
          <>
            <Field label="Runner / Overlay Style">
              <div className="flex flex-wrap gap-2">
                {RUNNER_STYLES.map((style) => (
                  <button
                    key={style.key}
                    type="button"
                    onClick={() => update('runner_style', style.key)}
                    className={cn(
                      'px-4 py-2 rounded-lg text-sm font-medium transition-all border',
                      tables.runner_style === style.key
                        ? 'bg-[#7D8471] text-white border-[#7D8471] shadow-sm'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-[#7D8471]/40'
                    )}
                  >
                    {style.label}
                  </button>
                ))}
              </div>
            </Field>

            <Toggle
              value={tables.chargers}
              onChange={(v) => update('chargers', v)}
              label="Charger plates under place settings"
            />
          </>
        )}

        <Field label="Linen Notes" hint="Special requests, rental company info, etc.">
          <textarea
            value={tables.linen_notes}
            onChange={(e) => update('linen_notes', e.target.value)}
            placeholder="Any specific linen details or preferences..."
            rows={3}
            className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] resize-none"
          />
        </Field>
      </Section>

      {/* Section 6: Layout Preferences */}
      <Section title="Layout Preferences" icon={Armchair}>
        <div className="space-y-4">
          <Toggle
            value={tables.checkered_dance_floor}
            onChange={(v) => update('checkered_dance_floor', v)}
            label="Checkered dance floor"
          />
          <Toggle
            value={tables.lounge_area}
            onChange={(v) => update('lounge_area', v)}
            label="Lounge / seating area"
          />
        </div>
      </Section>

      {/* Section 7: Centerpiece Ideas */}
      <Section title="Centerpiece Ideas" icon={Sparkles}>
        <textarea
          value={tables.centerpiece_notes}
          onChange={(e) => update('centerpiece_notes', e.target.value)}
          placeholder="Describe your centerpiece vision... tall arrangements, candles, greenery, lanterns, etc."
          rows={5}
          className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] resize-none"
        />
      </Section>

      {/* Section 8: Layout Notes */}
      <Section title="Layout Notes" icon={StickyNote}>
        <textarea
          value={tables.layout_notes}
          onChange={(e) => update('layout_notes', e.target.value)}
          placeholder="Any additional notes about your layout... dance floor placement, where you'd like the DJ, flow of the room..."
          rows={5}
          className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471] resize-none"
        />
      </Section>

      {/* Section 9: Extra Tables */}
      <Section title="Extra Tables & Stations" icon={LayoutGrid}>
        <p className="text-sm text-gray-500 -mt-2">
          Select any additional tables or stations you would like at your event.
        </p>

        {extraCategories.map((category) => {
          const items = tables.extra_tables.filter((e) => e.category === category)
          return (
            <div key={category} className="space-y-2">
              <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
                {category}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {items.map((item) => (
                  <label
                    key={item.id}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                      item.selected
                        ? 'bg-[#7D8471]/5 border-[#7D8471]/30'
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    )}
                  >
                    <div
                      className={cn(
                        'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0',
                        item.selected
                          ? 'bg-[#7D8471] border-[#7D8471]'
                          : 'border-gray-300'
                      )}
                      onClick={(e) => {
                        e.preventDefault()
                        updateExtra(item.id, { selected: !item.selected })
                      }}
                    >
                      {item.selected && <Check className="w-3 h-3 text-white" />}
                    </div>
                    <span className="text-sm text-gray-700 flex-1">{item.label}</span>
                    {item.selected && (
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={item.count}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation()
                          updateExtra(item.id, {
                            count: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)),
                          })
                        }}
                        className="w-16 px-2 py-1 text-center rounded border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#7D8471]/30 focus:border-[#7D8471]"
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          )
        })}
      </Section>

      {/* Section 10: Summary */}
      <div className="bg-[#7D8471] rounded-xl shadow-sm overflow-hidden text-white">
        <div className="px-6 py-4 border-b border-white/10 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center">
            <LayoutGrid className="w-5 h-5 text-white" />
          </div>
          <h2 className="text-lg font-semibold">Layout Summary</h2>
        </div>
        <div className="p-6 space-y-4">
          {/* Table breakdown */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <SummaryItem label="Guest Tables" value={calculations.guestTables} />
            {calculations.sweetheartCount > 0 && (
              <SummaryItem label="Sweetheart" value={calculations.sweetheartCount} />
            )}
            {calculations.headTableCount > 0 && (
              <SummaryItem
                label={`Head Table (${tables.head_table_sided === 'two' ? '2-sided' : '1-sided'})`}
                value={`${calculations.headTableCount} section${calculations.headTableCount > 1 ? 's' : ''}`}
              />
            )}
            {calculations.kidsTableCount > 0 && (
              <SummaryItem label="Kids Tables" value={calculations.kidsTableCount} />
            )}
            {calculations.cocktailTables > 0 && (
              <SummaryItem label="Cocktail High-tops" value={calculations.cocktailTables} />
            )}
            <SummaryItem label="Total Seating Tables" value={calculations.totalGuestTables} highlight />
          </div>

          {/* Mixed breakdown */}
          {tables.table_shape === 'mixed' && (
            <div className="pt-2 border-t border-white/10 grid grid-cols-2 gap-4">
              <SummaryItem label="Round Tables" value={calculations.roundTables} />
              <SummaryItem label="Rectangular Tables" value={calculations.rectTables} />
            </div>
          )}

          {/* Linen needs */}
          <div className="pt-2 border-t border-white/10 grid grid-cols-2 sm:grid-cols-3 gap-4">
            <SummaryItem label="Tablecloths Needed" value={calculations.tableclothsNeeded} />
            <SummaryItem label="Napkins Needed" value={calculations.napkinsNeeded} />
            <SummaryItem
              label="Linen Colors"
              value={
                tables.linen_color === tables.napkin_color
                  ? capitalize(tables.linen_color)
                  : `${capitalize(tables.linen_color)} / ${capitalize(tables.napkin_color)}`
              }
            />
          </div>

          {/* Extras */}
          {calculations.selectedExtras.length > 0 && (
            <div className="pt-2 border-t border-white/10">
              <p className="text-xs uppercase tracking-wide text-white/60 mb-2">
                Extra Tables & Stations ({calculations.selectedExtras.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {calculations.selectedExtras.map((e) => (
                  <span
                    key={e.id}
                    className="px-2.5 py-1 bg-white/10 rounded-full text-xs text-white/90"
                  >
                    {e.label}
                    {e.count > 1 && ` (x${e.count})`}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Layout features */}
          {(tables.checkered_dance_floor || tables.lounge_area) && (
            <div className="pt-2 border-t border-white/10">
              <p className="text-xs uppercase tracking-wide text-white/60 mb-2">Layout Features</p>
              <div className="flex flex-wrap gap-2">
                {tables.checkered_dance_floor && (
                  <span className="px-2.5 py-1 bg-white/10 rounded-full text-xs text-white/90">
                    Checkered dance floor
                  </span>
                )}
                {tables.lounge_area && (
                  <span className="px-2.5 py-1 bg-white/10 rounded-full text-xs text-white/90">
                    Lounge area
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sticky Save Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-sm border-t border-gray-200 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="text-sm text-gray-500">
            {tables.is_draft ? (
              <span className="text-amber-600 font-medium">Draft -- not yet saved</span>
            ) : (
              <span className="text-[#7D8471]">Saved</span>
            )}
          </div>
          <button
            onClick={saveTables}
            disabled={saveStatus === 'saving'}
            className={cn(
              'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-all shadow-sm',
              saveStatus === 'saving'
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : saveStatus === 'saved'
                  ? 'bg-[#7D8471] text-white'
                  : 'bg-[#7D8471] text-white hover:bg-[#6B7361] active:scale-[0.98]'
            )}
          >
            {saveStatus === 'saving' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : saveStatus === 'saved' ? (
              <>
                <Check className="w-4 h-4" />
                Saved!
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Layout
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Summary Item
// ---------------------------------------------------------------------------

function SummaryItem({
  label,
  value,
  highlight,
}: {
  label: string
  value: string | number
  highlight?: boolean
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-white/60">{label}</p>
      <p
        className={cn(
          'text-lg font-bold mt-0.5',
          highlight ? 'text-[#A6894A]' : 'text-white'
        )}
      >
        {value}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalize(str: string): string {
  if (!str) return ''
  return str
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
