'use client'

// Feature: configurable via venue_config.feature_flags
// Table: bar_planning, bar_recipes, bar_shopping_list

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Wine,
  Beer,
  Plus,
  X,
  Edit2,
  Trash2,
  Calculator,
  ShoppingCart,
  Martini,
  Printer,
  Check,
  ChevronDown,
  ChevronUp,
  Info,
  Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { key: 'beer', label: 'Beer', emoji: '\u{1F37A}' },
  { key: 'wine', label: 'Wine', emoji: '\u{1F377}' },
  { key: 'spirits', label: 'Spirits', emoji: '\u{1F943}' },
  { key: 'mixers', label: 'Mixers', emoji: '\u{1F9C3}' },
  { key: 'garnish', label: 'Garnishes', emoji: '\u{1F34B}' },
  { key: 'supplies', label: 'Supplies', emoji: '\u{1F9CA}' },
  { key: 'non-alc', label: 'Non-Alcoholic', emoji: '\u{1F964}' },
  { key: 'other', label: 'Other', emoji: '\u{1F4E6}' },
] as const

type CategoryKey = (typeof CATEGORIES)[number]['key']

const BAR_TYPES = [
  { key: 'beer-wine', label: 'Beer & Wine', beerPct: 35, winePct: 65, spiritsPct: 0 },
  { key: 'specialty', label: 'Specialty Cocktails', beerPct: 25, winePct: 50, spiritsPct: 25 },
  { key: 'full', label: 'Modified Full Bar', beerPct: 25, winePct: 40, spiritsPct: 35 },
] as const

type BarTypeKey = (typeof BAR_TYPES)[number]['key']

const DRINK_LEVELS = [
  { label: 'None', scale: 0 },
  { label: 'Light', scale: 0.6 },
  { label: 'Average', scale: 1.0 },
  { label: 'Heavy', scale: 1.5 },
] as const

const SHOPPING_CATEGORIES = CATEGORIES.map((c) => c.key)
const UNITS = ['bottles', 'cases', 'kegs', 'handles', 'liters', 'cans', 'packs', 'each', 'lbs', 'bags', 'gallons', 'jars', 'large cans']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CalcItem {
  item_name: string
  quantity: number
  unit: string
  category: CategoryKey
}

interface RecipeIngredient {
  name: string
  quantity: number
  unit: string
  per_serving: boolean
  category: CategoryKey
}

interface Recipe {
  id: string
  name: string
  ingredients: RecipeIngredient[]
  servings_per_batch: number
  notes: string | null
  sort_order: number
}

interface ShoppingItem {
  id: string
  item_name: string
  quantity: number
  unit: string
  category: CategoryKey
  purchased: boolean
  notes: string | null
  from_calculator?: boolean
}

interface PerDrinkerStat {
  drinkers: number
  total: number
  each: number
}

// ---------------------------------------------------------------------------
// Unit conversion — scale recipe ingredients to meaningful buy quantities
// ---------------------------------------------------------------------------

function toOz(qty: number, unit: string): number | null {
  const u = (unit || '').toLowerCase().trim()
  if (u === 'oz' || u === 'fl oz' || u === 'ounce' || u === 'ounces') return qty
  if (u === 'ml') return qty / 29.574
  if (u === 'l' || u === 'liter' || u === 'liters') return qty * 33.814
  if (u === 'cup' || u === 'cups') return qty * 8
  if (u === 'tbsp' || u === 'tablespoon' || u === 'tablespoons') return qty * 0.5
  if (u === 'tsp' || u === 'teaspoon' || u === 'teaspoons') return qty / 6
  if (u === 'shot' || u === 'shots') return qty * 1.5
  return null
}

function scaleIngredient(
  perServingQty: number,
  unit: string,
  category: string,
  guests: number
): { qty: number; unit: string; note: string | null } {
  const total = perServingQty * guests
  const u = (unit || '').toLowerCase().trim()

  // Dashes (bitters) — ~200 dashes per bottle
  if (u === 'dash' || u === 'dashes') {
    const bottles = Math.ceil(total / 200)
    return { qty: bottles, unit: bottles === 1 ? 'bottle' : 'bottles', note: `${Math.ceil(total)} dashes` }
  }

  // Whole items (fruit, eggs, etc.)
  if (!u || u === 'each' || u === 'piece' || u === 'pieces' || u === 'wedge' || u === 'wedges' || u === 'slice' || u === 'slices') {
    return { qty: Math.ceil(total), unit: u || '', note: null }
  }

  const totalOz = toOz(total, unit)
  if (totalOz === null) {
    return { qty: Math.ceil(total * 10) / 10, unit, note: null }
  }

  // Spirits: handles (59.2 oz = 1.75L) then 750ml bottles (25.4 oz)
  if (category === 'spirits') {
    if (totalOz >= 30) {
      const handles = totalOz / 59.2
      const rounded = Math.ceil(handles * 4) / 4
      return { qty: rounded, unit: rounded === 1 ? 'handle (1.75L)' : 'handles (1.75L)', note: `${Math.round(totalOz)} oz total` }
    }
    const bottles = totalOz / 25.4
    const rounded = Math.ceil(bottles * 2) / 2
    return { qty: rounded, unit: rounded === 1 ? 'bottle (750ml)' : 'bottles (750ml)', note: `${Math.round(totalOz)} oz total` }
  }

  // Mixers/juices: gallons (128oz) then quarts (32oz) then oz
  if (category === 'mixers') {
    if (totalOz >= 64) {
      const gallons = totalOz / 128
      const rounded = Math.ceil(gallons * 4) / 4
      return { qty: rounded, unit: rounded === 1 ? 'gallon' : 'gallons', note: `${Math.round(totalOz)} oz total` }
    }
    if (totalOz >= 24) {
      const quarts = totalOz / 32
      const rounded = Math.ceil(quarts * 2) / 2
      return { qty: rounded, unit: rounded === 1 ? 'quart' : 'quarts', note: `${Math.round(totalOz)} oz total` }
    }
    return { qty: Math.ceil(totalOz), unit: 'oz', note: null }
  }

  // Everything else (syrups, liqueurs) — 750ml bottles then oz
  if (totalOz >= 20) {
    const bottles = totalOz / 25.4
    const rounded = Math.ceil(bottles * 2) / 2
    return { qty: rounded, unit: rounded === 1 ? 'bottle (750ml)' : 'bottles (750ml)', note: `${Math.round(totalOz)} oz total` }
  }
  return { qty: Math.ceil(totalOz * 10) / 10, unit: 'oz', note: null }
}

// ---------------------------------------------------------------------------
// Quantity Calculator — all the math
// ---------------------------------------------------------------------------

interface CalcParams {
  guests: number
  hours: number
  barType: BarTypeKey
  season: 'summer' | 'winter'
  beerPct: number
  winePct: number
  spiritsPct: number
  nonAlcPct: number
  champagneToast: boolean
  tableWine: boolean
}

function calcQuantities(p: CalcParams): CalcItem[] {
  const bt = BAR_TYPES.find((b) => b.key === p.barType) || BAR_TYPES[0]

  // Scale factors: slider vs bar-type default. If default is 0, use 1 as fallback.
  const beerScale = bt.beerPct > 0 ? p.beerPct / bt.beerPct : p.beerPct > 0 ? 1 : 0
  const wineScale = bt.winePct > 0 ? p.winePct / bt.winePct : p.winePct > 0 ? 1 : 0
  const spiritsScale = bt.spiritsPct > 0 ? p.spiritsPct / bt.spiritsPct : p.spiritsPct > 0 ? 1 : 0
  const nonAlcScale = p.nonAlcPct / 15 // 15% is the baseline

  const s = p.guests / 120 // guest scale (baseline 120)
  const h = p.hours / 8 // hours scale (baseline 8)
  const isWinter = p.season === 'winter'
  const r: CalcItem[] = []

  // ── Beer (kegs) ──
  if (p.beerPct > 0) {
    const rawKegs = Math.ceil(2 * s * h * beerScale)
    const kegQty = Math.max(1, rawKegs)
    r.push({ item_name: '1/6th barrel keg (~55 beers each)', quantity: kegQty, unit: 'kegs', category: 'beer' })
    r.push({ item_name: '1/4 barrel keg (~82 beers each)', quantity: kegQty, unit: 'kegs', category: 'beer' })
  }

  // ── Wine ──
  // Base: 8 cases for beer+wine/specialty, 6 for full bar
  // Work in individual bottles for fine-grained red/white split
  if (p.winePct > 0) {
    const baseCases = p.barType === 'full' ? 6 : 8
    const totalBottles = Math.max(12, Math.ceil(baseCases * 12 * s * h * wineScale))
    const sparklingBottles = Math.max(3, Math.round(totalBottles / 8))
    const remaining = totalBottles - sparklingBottles
    const whiteBottles = isWinter ? Math.ceil(remaining * 3 / 7) : Math.ceil(remaining * 4 / 7)
    const redBottles = remaining - whiteBottles

    r.push({ item_name: 'Sparkling wine / prosecco', quantity: sparklingBottles, unit: 'bottles', category: 'wine' })
    r.push({
      item_name: `White wine & ros\u00E9${isWinter ? ' (winter \u2014 less white)' : ' (summer \u2014 more white)'}`,
      quantity: whiteBottles,
      unit: 'bottles',
      category: 'wine',
    })
    if (redBottles > 0) {
      r.push({
        item_name: `Red wine${isWinter ? ' (winter \u2014 more red)' : ' (summer \u2014 less red)'}`,
        quantity: redBottles,
        unit: 'bottles',
        category: 'wine',
      })
    }
  }

  // ── Spirits (full bar only) ──
  if (p.barType === 'full' && p.spiritsPct > 0) {
    r.push({ item_name: 'Vodka (1.75L handles)', quantity: Math.max(1, Math.ceil(2 * s * h * spiritsScale)), unit: 'handles', category: 'spirits' })
    r.push({ item_name: 'Rum (1.75L handles)', quantity: Math.max(1, Math.ceil(1.5 * s * h * spiritsScale)), unit: 'handles', category: 'spirits' })
    r.push({ item_name: 'Gin (1.75L handles)', quantity: Math.max(1, Math.ceil(1.5 * s * h * spiritsScale)), unit: 'handles', category: 'spirits' })
    r.push({ item_name: "Jack Daniel's (1.75L handles)", quantity: Math.max(2, Math.ceil(2.5 * s * h * spiritsScale)), unit: 'handles', category: 'spirits' })
    r.push({ item_name: 'Fireball (1.75L handles)', quantity: Math.max(1, Math.ceil(1 * s * h * spiritsScale)), unit: 'handles', category: 'spirits' })
  }

  // ── Mixers ──
  r.push({ item_name: 'Coke (12-packs)', quantity: Math.max(2, Math.ceil(4 * s * h * nonAlcScale)), unit: 'cases', category: 'mixers' })
  r.push({ item_name: 'Sprite (12-packs)', quantity: Math.max(1, Math.ceil(2 * s * h * nonAlcScale)), unit: 'cases', category: 'mixers' })
  r.push({ item_name: 'Diet Coke (12-packs)', quantity: Math.max(1, Math.ceil(2 * s * h * nonAlcScale)), unit: 'cases', category: 'mixers' })
  r.push({ item_name: 'Ginger Ale (12-packs)', quantity: Math.max(1, Math.ceil(1 * s * h * nonAlcScale)), unit: 'cases', category: 'mixers' })

  // Tonic + soda water: spirits bars need more; beer+wine just soda water
  if (p.barType !== 'beer-wine') {
    r.push({ item_name: 'Tonic Water (12-packs)', quantity: Math.max(1, Math.ceil(2 * s * h * spiritsScale)), unit: 'cases', category: 'mixers' })
    r.push({ item_name: 'Soda Water (12-packs)', quantity: Math.max(1, Math.ceil(2 * s * h * spiritsScale)), unit: 'cases', category: 'mixers' })
    r.push({ item_name: 'Sour mix', quantity: Math.max(1, Math.ceil(p.guests / 30)), unit: 'bottles', category: 'mixers' })
  } else {
    r.push({ item_name: 'Soda Water (12-packs)', quantity: Math.max(1, Math.ceil(1 * s * h)), unit: 'cases', category: 'mixers' })
  }

  // OJ: beer+wine bars mainly use it for mimosas
  r.push({
    item_name: 'Orange juice (mimosas, mixing)',
    quantity: Math.max(1, Math.ceil(p.guests / (p.barType === 'beer-wine' ? 50 : 30))),
    unit: 'gallons',
    category: 'mixers',
  })
  // Cranberry juice
  r.push({
    item_name: 'Cranberry juice',
    quantity: Math.max(1, Math.ceil(p.guests / (p.barType === 'beer-wine' ? 70 : 40))),
    unit: 'gallons',
    category: 'mixers',
  })
  // Pineapple juice: spirits bars only
  if (p.barType !== 'beer-wine') {
    r.push({ item_name: 'Pineapple juice', quantity: Math.max(1, Math.ceil(p.guests / 50)), unit: 'large cans', category: 'mixers' })
  }

  // Water bottles
  r.push({ item_name: 'Water (small bottles)', quantity: Math.max(6, Math.ceil(p.guests / 20)), unit: 'cases', category: 'non-alc' })

  // ── Garnishes ──
  r.push({ item_name: 'Lemons', quantity: Math.ceil(p.guests / 8), unit: '', category: 'garnish' })
  r.push({ item_name: 'Limes', quantity: Math.ceil(p.guests / 8), unit: '', category: 'garnish' })
  r.push({ item_name: 'Oranges', quantity: Math.ceil(p.guests / 12), unit: '', category: 'garnish' })
  if (p.barType !== 'beer-wine') {
    r.push({ item_name: 'Olives', quantity: Math.max(1, Math.ceil(p.guests / 30)), unit: 'jars', category: 'garnish' })
    r.push({ item_name: 'Maraschino cherries', quantity: Math.max(1, Math.ceil(p.guests / 30)), unit: 'jars', category: 'garnish' })
  }

  // ── Supplies ──
  const iceLbs = Math.max(60, Math.round((p.guests * 0.65) / 10) * 10)
  r.push({ item_name: 'Ice', quantity: iceLbs, unit: 'lbs', category: 'supplies' })
  r.push({ item_name: 'Cups / glasses', quantity: Math.ceil(p.guests * 2), unit: '', category: 'supplies' })
  r.push({ item_name: 'Cocktail napkins', quantity: Math.ceil(p.guests * 4), unit: '', category: 'supplies' })

  // ── Optional extras ──
  if (p.champagneToast) {
    r.push({ item_name: 'Champagne / prosecco (toast)', quantity: Math.ceil(p.guests / 8), unit: 'bottles', category: 'wine' })
  }
  if (p.tableWine) {
    r.push({ item_name: 'Red wine \u2014 poured at table', quantity: Math.ceil(p.guests / 12), unit: 'bottles', category: 'wine' })
    r.push({ item_name: 'White wine \u2014 poured at table', quantity: Math.ceil(p.guests / 12), unit: 'bottles', category: 'wine' })
  }

  return r
}

// ---------------------------------------------------------------------------
// Per-drinker stats — reads from calcPreview to get real totals
// ---------------------------------------------------------------------------

function perDedicatedDrinkerStats(
  calcPreview: CalcItem[],
  guests: number,
  beerPct: number,
  winePct: number,
  spiritsPct: number
): Record<string, PerDrinkerStat | null> {
  const result: Record<string, PerDrinkerStat | null> = {}

  // Wine: 5 glasses per bottle; exclude rows from toast/table wine
  if (winePct > 0 && guests > 0) {
    const wineBottles = calcPreview
      .filter(
        (i) =>
          i.category === 'wine' &&
          i.unit === 'bottles' &&
          !i.item_name.toLowerCase().includes('toast') &&
          !i.item_name.toLowerCase().includes('at table')
      )
      .reduce((sum, i) => sum + (i.quantity || 0), 0)
    const totalGlasses = wineBottles * 5
    const drinkers = Math.round((guests * winePct) / 100)
    result.wine = drinkers > 0 ? { drinkers, total: totalGlasses, each: Math.round(totalGlasses / drinkers) } : null
  }

  // Beer: 1/6th = ~55 beers, 1/4 = ~82 beers
  if (beerPct > 0 && guests > 0) {
    let totalBeers = 0
    calcPreview
      .filter((i) => i.category === 'beer' && i.unit === 'kegs')
      .forEach((i) => {
        const beersPerKeg = i.item_name.includes('1/4') ? 82 : 55
        totalBeers += (i.quantity || 0) * beersPerKeg
      })
    const drinkers = Math.round((guests * beerPct) / 100)
    result.beer = drinkers > 0 ? { drinkers, total: totalBeers, each: Math.round(totalBeers / drinkers) } : null
  }

  // Spirits: 39 cocktails per handle (1.75L, ~1.5oz pours)
  if (spiritsPct > 0 && guests > 0) {
    const handles = calcPreview
      .filter((i) => i.category === 'spirits' && (i.unit === 'handles' || i.unit === 'handles (1.75L)'))
      .reduce((sum, i) => sum + (i.quantity || 0), 0)
    const totalCocktails = handles * 39
    const drinkers = Math.round((guests * spiritsPct) / 100)
    result.spirits = drinkers > 0 ? { drinkers, total: totalCocktails, each: Math.round(totalCocktails / drinkers) } : null
  }

  return result
}

function bartenderCount(guests: number): number {
  return Math.max(2, Math.ceil(guests / 50))
}

// ---------------------------------------------------------------------------
// Print helper
// ---------------------------------------------------------------------------

function printList(items: ShoppingItem[]) {
  const grouped: Record<string, ShoppingItem[]> = {}
  CATEGORIES.forEach((c) => {
    grouped[c.key] = []
  })
  items
    .filter((i) => !i.purchased)
    .forEach((i) => {
      if (grouped[i.category]) grouped[i.category].push(i)
    })
  const lines: string[] = ['Bar Shopping List', '']
  CATEGORIES.forEach((cat) => {
    if (!grouped[cat.key]?.length) return
    lines.push(`${cat.emoji} ${cat.label.toUpperCase()}`)
    grouped[cat.key].forEach((i) => {
      lines.push(`  [ ]  ${i.item_name}${i.quantity ? `  --  ${i.quantity} ${i.unit || ''}`.trim() : ''}${i.notes ? `  (${i.notes})` : ''}`)
    })
    lines.push('')
  })
  const w = window.open('', '_blank')
  if (w) {
    w.document.write(`<pre style="font-family:monospace;font-size:13px;padding:24px;white-space:pre-wrap">${lines.join('\n')}</pre>`)
    w.document.close()
    w.print()
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NotesBox({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="mt-6 border-t border-gray-100 pt-4">
      <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--couple-primary)' }}>
        Notes
      </p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || 'Any notes for this section...'}
        rows={3}
        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 resize-none"
        style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
      />
    </div>
  )
}

function ShoppingRow({
  item,
  onToggle,
  onDelete,
  onUpdate,
}: {
  item: ShoppingItem
  onToggle: (id: string, purchased: boolean) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, fields: Partial<ShoppingItem>) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({
    item_name: item.item_name,
    quantity: item.quantity?.toString() || '',
    unit: item.unit || '',
    notes: item.notes || '',
  })

  const save = () => {
    onUpdate(item.id, {
      item_name: draft.item_name,
      quantity: parseFloat(draft.quantity) || 0,
      unit: draft.unit,
      notes: draft.notes || null,
    })
    setEditing(false)
  }

  return (
    <div className={cn('flex items-start gap-3 py-2.5 border-b border-gray-100 last:border-0', item.purchased && 'opacity-50')}>
      <button onClick={() => onToggle(item.id, !item.purchased)} className="mt-0.5 flex-shrink-0">
        <div
          className={cn(
            'w-5 h-5 rounded border-2 flex items-center justify-center transition',
            item.purchased ? 'border-transparent' : 'border-gray-300 hover:border-gray-400'
          )}
          style={item.purchased ? { backgroundColor: 'var(--couple-primary)', borderColor: 'var(--couple-primary)' } : undefined}
        >
          {item.purchased && <Check className="w-3 h-3 text-white" />}
        </div>
      </button>

      {editing ? (
        <div className="flex-1 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <input
              value={draft.item_name}
              onChange={(e) => setDraft((d) => ({ ...d, item_name: e.target.value }))}
              className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
            <input
              value={draft.quantity}
              onChange={(e) => setDraft((d) => ({ ...d, quantity: e.target.value }))}
              placeholder="Qty"
              className="w-16 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
            <input
              value={draft.unit}
              onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
              placeholder="Unit"
              className="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          </div>
          <input
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            placeholder="Notes..."
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
          <div className="flex gap-2">
            <button
              onClick={save}
              className="text-xs px-3 py-1 text-white rounded hover:opacity-90"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              Save
            </button>
            <button onClick={() => setEditing(false)} className="text-xs px-3 py-1 text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className={cn('text-sm font-medium text-gray-700', item.purchased && 'line-through')}>{item.item_name}</span>
              {(item.quantity || item.unit) && (
                <span className="text-xs text-gray-400">
                  {item.quantity} {item.unit}
                </span>
              )}
            </div>
            {item.notes && <p className="text-xs text-gray-400 mt-0.5">{item.notes}</p>}
          </div>
          <div className="flex gap-1 flex-shrink-0">
            <button onClick={() => setEditing(true)} className="text-gray-300 hover:text-gray-600 p-1">
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => onDelete(item.id)} className="text-red-200 hover:text-red-500 p-1">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function BarPlannerPage() {
  const [tab, setTab] = useState<'calculator' | 'list' | 'recipes'>('calculator')
  const [loading, setLoading] = useState(true)

  // Shopping list
  const [items, setItems] = useState<ShoppingItem[]>([])
  // Recipes
  const [recipes, setRecipes] = useState<Recipe[]>([])

  // Calculator state
  const [guests, setGuests] = useState(120)
  const [hours, setHours] = useState(5)
  const [barType, setBarType] = useState<BarTypeKey>('beer-wine')
  const [season, setSeason] = useState<'summer' | 'winter'>(() =>
    new Date().getMonth() >= 4 && new Date().getMonth() <= 9 ? 'summer' : 'winter'
  )
  const [beerLevel, setBeerLevel] = useState(2) // index into DRINK_LEVELS
  const [wineLevel, setWineLevel] = useState(2)
  const [spiritsLevel, setSpiritsLevel] = useState(2)
  const [nonAlcLevel, setNonAlcLevel] = useState(2)
  const [champagneToast, setChampagneToast] = useState(false)
  const [tableWine, setTableWine] = useState(false)
  const [calcPreview, setCalcPreview] = useState<CalcItem[]>([])

  // Add item form
  const [addingItem, setAddingItem] = useState(false)
  const [newItem, setNewItem] = useState({ item_name: '', quantity: '', unit: '', category: 'other' as CategoryKey, notes: '' })

  // Recipe form
  const [addingRecipe, setAddingRecipe] = useState(false)
  const [recipeName, setRecipeName] = useState('')
  const [recipeServings, setRecipeServings] = useState('25')
  const [recipeNotes, setRecipeNotes] = useState('')
  const [editableIngredients, setEditableIngredients] = useState<RecipeIngredient[]>([])

  // Notes per tab
  const [notes, setNotes] = useState({ calculator: '', list: '', recipes: '' })
  const [showCalcSummary, setShowCalcSummary] = useState(false)

  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const supabase = createClient()

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      const [shoppingRes, recipesRes, planRes, configRes] = await Promise.all([
        supabase.from('bar_shopping_list').select('*').eq('wedding_id', WEDDING_ID).order('category').order('item_name'),
        supabase.from('bar_recipes').select('*').eq('wedding_id', WEDDING_ID).order('created_at', { ascending: true }),
        supabase.from('bar_planning').select('*').eq('wedding_id', WEDDING_ID).maybeSingle(),
        supabase.from('venue_config').select('bar_model, feature_flags').eq('venue_id', VENUE_ID).maybeSingle(),
      ])
      if (shoppingRes.data) setItems(shoppingRes.data as ShoppingItem[])
      if (recipesRes.data) setRecipes(recipesRes.data as Recipe[])
      if (planRes.data) {
        const p = planRes.data as {
          guest_count?: number
          event_duration_hours?: number
          notes?: string
          notes_calculator?: string
          notes_list?: string
          notes_recipes?: string
        }
        if (p.guest_count) setGuests(p.guest_count)
        if (p.event_duration_hours) setHours(p.event_duration_hours)
        setNotes({
          calculator: p.notes_calculator || p.notes || '',
          list: p.notes_list || '',
          recipes: p.notes_recipes || '',
        })
      }
      // Read venue bar config — set default bar type based on venue's bar model
      if (configRes.data) {
        const barModel = configRes.data.bar_model as string | null
        if (barModel === 'in_house') {
          // In-house bars typically offer full bar
          setBarType('full')
        }
        // Also check feature_flags for bar-specific overrides
        const flags = (configRes.data.feature_flags ?? {}) as Record<string, unknown>
        const barConfig = flags.bar_config as Record<string, unknown> | undefined
        if (barConfig) {
          if (barConfig.default_bar_type && BAR_TYPES.some(b => b.key === barConfig.default_bar_type)) {
            setBarType(barConfig.default_bar_type as BarTypeKey)
          }
          if (typeof barConfig.default_guest_count === 'number' && !planRes.data?.guest_count) {
            setGuests(barConfig.default_guest_count)
          }
        }
      }
    } catch (err) {
      console.error('[BarPlanner] Load failed:', err)
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    loadData()
  }, [loadData])

  // ── Recalculate preview when inputs change ────────────────────────────────

  useEffect(() => {
    const bt = BAR_TYPES.find((b) => b.key === barType) || BAR_TYPES[0]
    const beerPct = bt.beerPct * DRINK_LEVELS[beerLevel].scale
    const winePct = bt.winePct * DRINK_LEVELS[wineLevel].scale
    const spiritsPct = bt.spiritsPct * DRINK_LEVELS[spiritsLevel].scale
    const nonAlcPct = 15 * DRINK_LEVELS[nonAlcLevel].scale
    setCalcPreview(calcQuantities({ guests, hours, barType, season, beerPct, winePct, spiritsPct, nonAlcPct, champagneToast, tableWine }))
  }, [guests, hours, barType, season, beerLevel, wineLevel, spiritsLevel, nonAlcLevel, champagneToast, tableWine])

  // ── Auto-save notes ───────────────────────────────────────────────────────

  const updateNotes = useCallback(
    (tabKey: string, val: string) => {
      setNotes((prev) => {
        const next = { ...prev, [tabKey]: val }
        if (notesTimer.current) clearTimeout(notesTimer.current)
        notesTimer.current = setTimeout(async () => {
          try {
            await supabase.from('bar_planning').upsert(
              {
                venue_id: VENUE_ID,
                wedding_id: WEDDING_ID,
                guest_count: guests,
                event_duration_hours: hours,
                notes_calculator: next.calculator,
                notes_list: next.list,
                notes_recipes: next.recipes,
              },
              { onConflict: 'wedding_id' }
            )
          } catch (err) {
            console.error('[BarPlanner] Notes save error:', err)
          }
        }, 800)
        return next
      })
    },
    [supabase, guests, hours]
  )

  // ── Select bar type (resets drink levels) ─────────────────────────────────

  const selectBarType = (key: BarTypeKey) => {
    setBarType(key)
    setBeerLevel(2)
    setWineLevel(2)
    setSpiritsLevel(2)
  }

  // ── Shopping list operations ──────────────────────────────────────────────

  const addItem = async () => {
    if (!newItem.item_name.trim()) return
    try {
      const { data, error } = await supabase.from('bar_shopping_list').insert({
        venue_id: VENUE_ID,
        wedding_id: WEDDING_ID,
        item_name: newItem.item_name.trim(),
        quantity: parseFloat(newItem.quantity) || 1,
        unit: newItem.unit || '',
        category: newItem.category,
        purchased: false,
        notes: newItem.notes || null,
      }).select().single()
      if (error) throw error
      if (data) setItems((prev) => [...prev, data as ShoppingItem])
      setNewItem({ item_name: '', quantity: '', unit: '', category: 'other', notes: '' })
      setAddingItem(false)
    } catch (err) {
      console.error('[BarPlanner] Add item failed:', err)
    }
  }

  const toggleItem = async (id: string, purchased: boolean) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, purchased } : i)))
    await supabase.from('bar_shopping_list').update({ purchased }).eq('id', id)
  }

  const updateItem = async (id: string, fields: Partial<ShoppingItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...fields } : i)))
    await supabase.from('bar_shopping_list').update(fields).eq('id', id)
  }

  const deleteItem = async (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
    await supabase.from('bar_shopping_list').delete().eq('id', id)
  }

  const clearList = async () => {
    if (!window.confirm("Clear everything on the shopping list? This can't be undone.")) return
    const snapshot = [...items]
    setItems([])
    for (const item of snapshot) {
      await supabase.from('bar_shopping_list').delete().eq('id', item.id)
    }
  }

  const importFromCalculator = async () => {
    // Remove previously-imported calculator items, keep manual
    const toRemove = items.filter((i) => i.from_calculator)
    for (const item of toRemove) {
      await supabase.from('bar_shopping_list').delete().eq('id', item.id)
    }

    const added: ShoppingItem[] = []
    for (const item of calcPreview) {
      // Wine: show bottles in calculator, save as cases on shopping list
      const listItem =
        item.category === 'wine' && item.unit === 'bottles'
          ? { ...item, quantity: Math.ceil(item.quantity / 12), unit: 'cases of 12' }
          : item

      const { data } = await supabase
        .from('bar_shopping_list')
        .insert({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          item_name: listItem.item_name,
          quantity: listItem.quantity,
          unit: listItem.unit,
          category: listItem.category,
          purchased: false,
          from_calculator: true,
          notes: null,
        })
        .select()
        .single()

      if (data) added.push(data as ShoppingItem)
    }

    setItems((prev) => [...prev.filter((i) => !i.from_calculator), ...added])
    setTab('list')
  }

  // ── Recipe operations ─────────────────────────────────────────────────────

  const startAddRecipe = () => {
    setRecipeName('')
    setRecipeServings('25')
    setRecipeNotes('')
    setEditableIngredients([{ name: '', quantity: 0, unit: 'oz', per_serving: true, category: 'spirits' }])
    setAddingRecipe(true)
  }

  const addIngredientRow = () => {
    setEditableIngredients((prev) => [...prev, { name: '', quantity: 0, unit: 'oz', per_serving: true, category: 'spirits' }])
  }

  const updateIngredient = (i: number, field: string, val: string | number | boolean) => {
    setEditableIngredients((prev) =>
      prev.map((ing, idx) => (idx === i ? { ...ing, [field]: val } : ing))
    )
  }

  const removeIngredient = (i: number) => {
    setEditableIngredients((prev) => prev.filter((_, idx) => idx !== i))
  }

  const saveRecipe = async () => {
    if (!recipeName.trim()) return
    const ingredients = editableIngredients.filter((i) => i.name.trim())
    try {
      const { data, error } = await supabase
        .from('bar_recipes')
        .insert({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          name: recipeName.trim(),
          ingredients: JSON.stringify(ingredients),
          servings_per_batch: parseInt(recipeServings) || 25,
          notes: recipeNotes.trim() || null,
          sort_order: recipes.length,
        })
        .select()
        .single()
      if (error) throw error
      if (data) {
        const saved = data as Record<string, unknown>
        setRecipes((prev) => [
          ...prev,
          {
            ...saved,
            ingredients: typeof saved.ingredients === 'string' ? JSON.parse(saved.ingredients) : saved.ingredients,
          } as Recipe,
        ])
      }
      setAddingRecipe(false)
    } catch (err) {
      console.error('[BarPlanner] Save recipe failed:', err)
    }
  }

  const deleteRecipe = async (id: string) => {
    if (!confirm('Remove this recipe?')) return
    setRecipes((prev) => prev.filter((r) => r.id !== id))
    await supabase.from('bar_recipes').delete().eq('id', id)
  }

  const addRecipeToList = async (recipe: Recipe) => {
    const ingredients = typeof recipe.ingredients === 'string' ? JSON.parse(recipe.ingredients) : recipe.ingredients
    if (!ingredients?.length) return
    const added: ShoppingItem[] = []
    for (const ing of ingredients) {
      const scaled = ing.per_serving
        ? scaleIngredient(ing.quantity, ing.unit, ing.category, guests)
        : { qty: ing.quantity, unit: ing.unit, note: null }
      const { data } = await supabase
        .from('bar_shopping_list')
        .insert({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          item_name: ing.name,
          quantity: scaled.qty,
          unit: scaled.unit,
          category: ing.category || 'other',
          purchased: false,
          notes: `For ${recipe.name}${scaled.note ? ` (${scaled.note})` : ` (scaled to ${guests} guests)`}`,
        })
        .select()
        .single()
      if (data) added.push(data as ShoppingItem)
    }
    setItems((prev) => [...prev, ...added])
    setTab('list')
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const checkedCount = items.filter((i) => i.purchased).length
  const totalCount = items.length

  const bt = BAR_TYPES.find((b) => b.key === barType) || BAR_TYPES[0]
  const beerScale = DRINK_LEVELS[beerLevel].scale
  const wineScale = DRINK_LEVELS[wineLevel].scale
  const spiritsScale = DRINK_LEVELS[spiritsLevel].scale

  const stats = useMemo(
    () => perDedicatedDrinkerStats(calcPreview, guests, bt.beerPct, bt.winePct, bt.spiritsPct),
    [calcPreview, guests, bt]
  )

  const totalDrinks = useMemo(
    () =>
      calcPreview.reduce((sum, item) => {
        if (item.category === 'beer' && item.unit === 'kegs') return sum + item.quantity * (item.item_name.includes('1/4') ? 82 : 55)
        if (item.category === 'wine' && item.unit === 'bottles') return sum + item.quantity * 5
        if (item.category === 'spirits' && (item.unit === 'handles' || item.unit === 'handles (1.75L)')) return sum + item.quantity * 39
        return sum
      }, 0),
    [calcPreview]
  )

  const bartenders = bartenderCount(guests)
  const bartenderCost = bartenders * 350

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-32 bg-gray-100 rounded-xl" />
        <div className="h-64 bg-gray-100 rounded-xl" />
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold mb-1" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
          Bar Planner
        </h1>
        <p className="text-gray-500 text-sm">Calculate quantities, build a shopping list, and add cocktail recipes.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {(
          [
            { id: 'calculator' as const, label: 'Quantity Calculator', icon: Calculator },
            { id: 'list' as const, label: `Shopping List${totalCount ? ` \u00B7 ${checkedCount}/${totalCount}` : ''}`, icon: ShoppingCart },
            { id: 'recipes' as const, label: `Cocktail Recipes${recipes.length ? ` (${recipes.length})` : ''}`, icon: Martini },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition',
              tab === t.id ? 'text-gray-700' : 'border-transparent text-gray-400 hover:text-gray-600'
            )}
            style={tab === t.id ? { borderColor: 'var(--couple-primary)', color: 'var(--couple-primary)' } : undefined}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
         TAB 1: QUANTITY CALCULATOR
         ════════════════════════════════════════════════════════════════════════ */}
      {tab === 'calculator' && (
        <div className="space-y-6">
          {/* Info banner */}
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Based on ~1 drink per person per hour. Baseline is 120 guests over 8 hours. Adjust the sliders and quantities update live.</p>
          </div>

          {/* Bar type selector */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--couple-primary)' }}>
              Bar Type
            </p>
            <div className="space-y-2">
              {BAR_TYPES.map((b) => (
                <label key={b.key} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="barType"
                    value={b.key}
                    checked={barType === b.key}
                    onChange={() => selectBarType(b.key)}
                    className="mt-0.5"
                    style={{ accentColor: 'var(--couple-primary)' }}
                  />
                  <div>
                    <p className={cn('text-sm font-medium', barType === b.key ? 'text-gray-700' : 'text-gray-500')}>{b.label}</p>
                    <p className="text-xs text-gray-400">
                      {b.beerPct}% beer, {b.winePct}% wine, {b.spiritsPct}% spirits
                    </p>
                    {b.key === 'specialty' && barType === 'specialty' && (
                      <p className="text-xs text-gray-400 mt-0.5">Add recipes in the Cocktail Recipes tab -- they will scale to your guest count</p>
                    )}
                    {b.key === 'full' && barType === 'full' && (
                      <p className="text-xs text-gray-400 mt-0.5">Vodka, rum, gin, Jack Daniel's, Fireball -- go easy on tequila (shots-only liquors slow service)</p>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Season selector */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--couple-primary)' }}>
              Season <span className="font-normal normal-case text-gray-400">-- affects red vs white wine split</span>
            </p>
            <div className="flex gap-3">
              {(
                [
                  { key: 'summer' as const, label: 'Spring / Summer', note: 'More white & ros\u00E9 (60/40)' },
                  { key: 'winter' as const, label: 'Autumn / Winter', note: 'More red (57/43)' },
                ] as const
              ).map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSeason(s.key)}
                  className={cn(
                    'flex-1 py-2.5 px-3 rounded-xl border-2 text-sm text-left transition',
                    season === s.key ? 'bg-gray-50' : 'border-gray-200 hover:border-gray-300'
                  )}
                  style={season === s.key ? { borderColor: 'var(--couple-primary)' } : undefined}
                >
                  <p className={cn('font-medium', season === s.key ? 'text-gray-700' : 'text-gray-500')}>
                    {s.key === 'summer' ? '\u2600\uFE0F' : '\u{1F342}'} {s.label}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{s.note}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Extras toggles */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--couple-primary)' }}>
              Extras
            </p>
            <div className="space-y-3">
              {[
                {
                  state: champagneToast,
                  set: setChampagneToast,
                  label: '\u{1F942} Champagne toast',
                  note: `+${Math.ceil((guests || 1) / 8)} bottles (1 per 8 guests)`,
                },
                {
                  state: tableWine,
                  set: setTableWine,
                  label: '\u{1F377} Wine poured at the table',
                  note: `+${Math.ceil((guests || 1) / 12)} red + ${Math.ceil((guests || 1) / 12)} white (1 bottle per 12 guests each)`,
                },
              ].map(({ state, set, label, note }) => (
                <label key={label} className="flex items-start gap-3 cursor-pointer">
                  <button
                    type="button"
                    onClick={() => set((v) => !v)}
                    className={cn('mt-0.5 w-10 h-5 rounded-full flex-shrink-0 transition-colors relative', !state && 'bg-gray-300')}
                    style={state ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                        state ? 'translate-x-5' : 'translate-x-0.5'
                      )}
                    />
                  </button>
                  <div>
                    <p className={cn('text-sm font-medium', state ? 'text-gray-700' : 'text-gray-500')}>{label}</p>
                    <p className="text-xs text-gray-400">{note}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Guest count slider */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--couple-primary)' }}>
                Guest Count
              </label>
              <input
                type="number"
                value={guests}
                min={10}
                max={300}
                onChange={(e) => setGuests(Math.min(300, Math.max(10, Number(e.target.value))))}
                className="w-20 border border-gray-300 rounded-lg px-2 py-1 text-sm text-center font-medium text-gray-700 focus:outline-none focus:ring-2"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>
            <input
              type="range"
              min={10}
              max={300}
              step={5}
              value={guests}
              onChange={(e) => setGuests(Number(e.target.value))}
              className="w-full"
              style={{ accentColor: 'var(--couple-primary)' }}
            />
            <div className="flex justify-between text-xs text-gray-300 mt-1">
              <span>10</span>
              <span>75</span>
              <span>150</span>
              <span>225</span>
              <span>300</span>
            </div>
          </div>

          {/* Event duration slider */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--couple-primary)' }}>
                Bar Open For
              </label>
              <span className="text-sm font-medium text-gray-700">
                {hours} {hours === 1 ? 'hour' : 'hours'}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={8}
              step={0.5}
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="w-full"
              style={{ accentColor: 'var(--couple-primary)' }}
            />
            <div className="flex justify-between text-xs text-gray-300 mt-1">
              <span>1 hr</span>
              <span>3</span>
              <span>5</span>
              <span>8 hrs</span>
            </div>
          </div>

          {/* Drink level selectors + Live quantities — side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* Left: drinking level selectors */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--couple-primary)' }}>
                  Adjust for Your Crowd
                </p>
                <p className="text-xs text-gray-400 mt-1">Quantities update live as you change these.</p>
              </div>

              <div className="space-y-4">
                {(
                  [
                    { label: '\u{1F37A} Beer', level: beerLevel, set: setBeerLevel, disabled: false },
                    { label: '\u{1F377} Wine', level: wineLevel, set: setWineLevel, disabled: false },
                    { label: '\u{1F943} Spirits', level: spiritsLevel, set: setSpiritsLevel, disabled: barType !== 'full' },
                    { label: '\u{1F964} Non-alcoholic', level: nonAlcLevel, set: setNonAlcLevel, disabled: false },
                  ] as const
                ).map(({ label, level, set, disabled }) => (
                  <div key={label} className={disabled ? 'opacity-30 pointer-events-none' : ''}>
                    <p className="text-sm text-gray-700 mb-1.5">{label}</p>
                    <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                      {DRINK_LEVELS.map((dl, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => set(i)}
                          className={cn(
                            'flex-1 py-1.5 text-xs font-medium transition border-r border-gray-200 last:border-r-0',
                            level !== i && 'bg-white text-gray-500 hover:bg-gray-50'
                          )}
                          style={level === i ? { backgroundColor: 'var(--couple-primary)', color: 'white' } : undefined}
                        >
                          {dl.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Per-drinker summary */}
              <div className="rounded-xl px-4 py-3 space-y-3 border" style={{ borderColor: 'var(--couple-accent)', backgroundColor: 'color-mix(in srgb, var(--couple-accent) 8%, white)' }}>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--couple-primary)' }}>
                    Per drinker over {hours}h
                  </p>
                  {(champagneToast || tableWine) && (
                    <p className="text-xs text-amber-600 mb-1.5">
                      Bar drinks only -- champagne toast{tableWine ? ' and table wine' : ''} not included.
                    </p>
                  )}
                  <p className="text-gray-700 text-sm leading-relaxed">
                    {bt.winePct > 0 && wineScale > 0 && (
                      <>
                        <strong>
                          {(hours * wineScale).toFixed(1)} {hours * wineScale === 1 ? 'glass wine' : 'glasses wine'}/wine drinker
                        </strong>
                        {(bt.beerPct > 0 && beerScale > 0) || (bt.spiritsPct > 0 && spiritsScale > 0) ? ', ' : ''}
                      </>
                    )}
                    {bt.beerPct > 0 && beerScale > 0 && (
                      <>
                        <strong>
                          {(hours * beerScale).toFixed(1)} {hours * beerScale === 1 ? 'beer' : 'beers'}/beer drinker
                        </strong>
                        {bt.spiritsPct > 0 && spiritsScale > 0 ? ', ' : ''}
                      </>
                    )}
                    {bt.spiritsPct > 0 && spiritsScale > 0 && (
                      <strong>
                        {(hours * spiritsScale).toFixed(1)} {hours * spiritsScale === 1 ? 'cocktail' : 'cocktails'}/cocktail drinker
                      </strong>
                    )}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    <strong>~{totalDrinks.toLocaleString()}</strong> total drinks available for {guests} guests
                  </p>
                </div>

                <div className="border-t pt-3" style={{ borderColor: 'var(--couple-accent)' }}>
                  <p className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--couple-primary)' }}>
                    If a guest drinks only their preferred type
                  </p>
                  <div className="space-y-1.5">
                    {stats.wine && (
                      <p className="text-sm text-gray-700">
                        {'\u{1F377}'} ~{stats.wine.drinkers} wine drinkers, {stats.wine.total} glasses available --{' '}
                        <strong>{stats.wine.each} glasses each</strong> over {hours}h
                      </p>
                    )}
                    {stats.beer && (
                      <p className="text-sm text-gray-700">
                        {'\u{1F37A}'} ~{stats.beer.drinkers} beer drinkers, {stats.beer.total} beers available --{' '}
                        <strong>{stats.beer.each} beers each</strong> over {hours}h
                      </p>
                    )}
                    {stats.spirits && (
                      <p className="text-sm text-gray-700">
                        {'\u{1F943}'} ~{stats.spirits.drinkers} cocktail drinkers, {stats.spirits.total} cocktails available --{' '}
                        <strong>{stats.spirits.each} cocktails each</strong> over {hours}h
                      </p>
                    )}
                    {nonAlcLevel > 0 && (
                      <p className="text-sm text-gray-700">
                        {'\u{1F964}'} ~{Math.round(guests * 0.15)} non-drinkers -- soft drinks + water provided
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Right: live quantities table */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--couple-primary)' }}>
                What to Buy
              </p>
              <div className="space-y-3">
                {CATEGORIES.filter((cat) => calcPreview.some((i) => i.category === cat.key)).map((cat) => (
                  <div key={cat.key}>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1 px-0.5">
                      {cat.emoji} {cat.label}
                    </p>
                    <div className="bg-gray-50 border border-gray-200 rounded-xl divide-y divide-gray-100">
                      {calcPreview
                        .filter((i) => i.category === cat.key)
                        .map((item, i) => (
                          <div key={i} className="flex items-center justify-between px-3 py-2">
                            <span className="text-xs text-gray-600 leading-snug">{item.item_name}</span>
                            <span className="text-sm font-bold text-gray-700 flex-shrink-0 ml-3 tabular-nums">
                              {item.quantity} <span className="font-normal text-xs text-gray-400">{item.unit}</span>
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
                {barType === 'specialty' && (
                  <p className="text-xs text-gray-400 italic">Cocktail ingredients not listed here -- add recipes in the Cocktail Recipes tab.</p>
                )}
              </div>
            </div>
          </div>

          {/* Bartender count */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="font-medium text-gray-700 mb-1">{'\u{1F64B}'} Bartenders</p>
            <p className="text-sm text-gray-600">
              Based on {guests} guests you will need at least <strong>{bartenders} bartenders</strong>. Add one more for each of:
              champagne welcome drink, rooftop bar, satellite bar, or table wine service.
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Minimum is always 2. At $350 per bartender, that is <strong>${bartenderCost.toLocaleString()}</strong>.
            </p>
          </div>

          {/* Import to shopping list */}
          <button
            onClick={importFromCalculator}
            className="w-full py-3 text-white rounded-xl text-sm font-medium hover:opacity-90 transition"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            Add to Shopping List
          </button>

          <NotesBox
            value={notes.calculator}
            onChange={(v) => updateNotes('calculator', v)}
            placeholder="Notes about the bar setup, preferences, restrictions..."
          />
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB 2: SHOPPING LIST
         ════════════════════════════════════════════════════════════════════════ */}
      {tab === 'list' && (
        <div className="space-y-4">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400">
              {totalCount === 0 ? 'No items yet' : `${checkedCount} of ${totalCount} items purchased`}
            </p>
            <div className="flex items-center gap-2">
              {calcPreview.length > 0 && (
                <button
                  onClick={() => setShowCalcSummary((v) => !v)}
                  className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5"
                >
                  {showCalcSummary ? 'Hide' : 'View'} last calculation
                </button>
              )}
              {items.filter((i) => !i.purchased).length > 0 && (
                <button
                  onClick={() => printList(items)}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Print
                </button>
              )}
              {totalCount > 0 && (
                <button
                  onClick={clearList}
                  className="text-xs text-red-400 hover:text-red-600 border border-red-100 hover:border-red-300 rounded-lg px-3 py-1.5 transition"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>

          {/* Last calculation summary */}
          {showCalcSummary && calcPreview.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
                Last calculation -- {guests} guests \u00B7 {hours}h \u00B7 {BAR_TYPES.find((b) => b.key === barType)?.label}
              </p>
              <div className="space-y-1">
                {calcPreview.map((item, i) => (
                  <div key={i} className="flex justify-between text-xs text-amber-800">
                    <span>{item.item_name}</span>
                    <span className="font-semibold ml-4">
                      {item.category === 'wine' && item.unit === 'bottles'
                        ? `${Math.ceil(item.quantity / 12)} cases (${item.quantity} btl)`
                        : `${item.quantity} ${item.unit}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add item form */}
          {addingItem ? (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--couple-primary)' }}>
                Add Item
              </p>
              <div className="flex gap-2 flex-wrap">
                <input
                  value={newItem.item_name}
                  onChange={(e) => setNewItem((p) => ({ ...p, item_name: e.target.value }))}
                  placeholder="e.g. Lavender syrup, Honey..."
                  autoFocus
                  className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
                <input
                  value={newItem.quantity}
                  onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                  placeholder="Qty"
                  className="w-16 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
                <input
                  value={newItem.unit}
                  onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
                  placeholder="Unit"
                  className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>
              <div className="flex gap-2 flex-wrap">
                <select
                  value={newItem.category}
                  onChange={(e) => setNewItem((p) => ({ ...p, category: e.target.value as CategoryKey }))}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.emoji} {c.label}
                    </option>
                  ))}
                </select>
                <input
                  value={newItem.notes}
                  onChange={(e) => setNewItem((p) => ({ ...p, notes: e.target.value }))}
                  placeholder="Notes (optional)"
                  className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={addItem}
                  className="px-4 py-2 text-white rounded-lg text-sm hover:opacity-90"
                  style={{ backgroundColor: 'var(--couple-primary)' }}
                >
                  Add item
                </button>
                <button onClick={() => setAddingItem(false)} className="px-4 py-2 text-gray-500 text-sm hover:text-gray-700">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAddingItem(true)}
              className="w-full py-2.5 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-gray-400 hover:text-gray-600 transition"
            >
              + Add item -- lavender syrup, honey, anything that doesn't fit the calculator
            </button>
          )}

          {/* Shopping list grouped by category */}
          {totalCount === 0 ? (
            <div className="text-center py-10 text-gray-400">
              <p className="text-3xl mb-3">{'\u{1F6D2}'}</p>
              <p className="text-sm mb-4">No items yet.</p>
              <button
                onClick={() => setTab('calculator')}
                className="px-4 py-2 text-white rounded-lg text-sm hover:opacity-90"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                Go to Quantity Calculator
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {CATEGORIES.filter((cat) => items.some((i) => i.category === cat.key)).map((cat) => (
                <div key={cat.key}>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    {cat.emoji} {cat.label}
                  </p>
                  <div className="bg-white border border-gray-200 rounded-xl px-4">
                    {items
                      .filter((i) => i.category === cat.key)
                      .map((item) => (
                        <ShoppingRow key={item.id} item={item} onToggle={toggleItem} onDelete={deleteItem} onUpdate={updateItem} />
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <NotesBox
            value={notes.list}
            onChange={(v) => updateNotes('list', v)}
            placeholder="Shopping notes -- where to buy, brands you like, things to remember..."
          />
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
         TAB 3: COCKTAIL RECIPES
         ════════════════════════════════════════════════════════════════════════ */}
      {tab === 'recipes' && (
        <div className="space-y-5">
          {recipes.length === 0 && !addingRecipe && (
            <div className="text-center py-10 text-gray-400">
              <p className="text-3xl mb-3">{'\u{1F379}'}</p>
              <p className="text-sm">No cocktail recipes yet. Add one and ingredients will scale to your guest count.</p>
            </div>
          )}

          {/* Recipe cards */}
          {recipes.map((recipe) => {
            const ingredients: RecipeIngredient[] =
              typeof recipe.ingredients === 'string' ? JSON.parse(recipe.ingredients) : recipe.ingredients || []
            return (
              <div key={recipe.id} className="bg-white border border-gray-200 rounded-xl p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="font-semibold text-gray-700">{recipe.name}</p>
                    {recipe.notes && <p className="text-xs text-gray-400 mt-0.5">{recipe.notes}</p>}
                    <p className="text-xs text-gray-400 mt-0.5">Serves {recipe.servings_per_batch} per batch</p>
                  </div>
                  <button onClick={() => deleteRecipe(recipe.id)} className="text-red-300 hover:text-red-500 flex-shrink-0 p-1">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {ingredients.length > 0 ? (
                  <>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                      Ingredients scaled to {guests} guests
                    </p>
                    <div className="bg-gray-50 rounded-xl divide-y divide-gray-100 mb-4">
                      {ingredients.map((ing, i) => {
                        const scaled = ing.per_serving
                          ? scaleIngredient(ing.quantity, ing.unit, ing.category, guests)
                          : { qty: ing.quantity, unit: ing.unit, note: null }
                        return (
                          <div key={i} className="flex items-center justify-between px-3 py-2">
                            <span className="text-sm text-gray-700">{ing.name}</span>
                            <span className="text-sm font-semibold text-gray-600 ml-4 flex-shrink-0 text-right">
                              {scaled.qty} <span className="font-normal text-xs text-gray-400">{scaled.unit}</span>
                              {scaled.note && <span className="block text-xs text-gray-300">{scaled.note}</span>}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                    <button
                      onClick={() => addRecipeToList(recipe)}
                      className="w-full py-2 text-sm font-medium rounded-lg transition border"
                      style={{
                        color: 'var(--couple-primary)',
                        borderColor: 'var(--couple-primary)',
                        backgroundColor: 'color-mix(in srgb, var(--couple-primary) 8%, white)',
                      }}
                    >
                      + Add all ingredients to shopping list
                    </button>
                  </>
                ) : (
                  <p className="text-sm text-gray-400 italic">No ingredients saved.</p>
                )}
              </div>
            )
          })}

          {/* Add recipe form */}
          {addingRecipe ? (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 space-y-4">
              <p className="font-medium text-gray-700">Add a Cocktail Recipe</p>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--couple-primary)' }}>
                  Cocktail Name
                </label>
                <input
                  value={recipeName}
                  onChange={(e) => setRecipeName(e.target.value)}
                  placeholder="e.g. Aperol Spritz, Lavender Martini..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--couple-primary)' }}>
                    Servings per Batch
                  </label>
                  <input
                    type="number"
                    value={recipeServings}
                    onChange={(e) => setRecipeServings(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    min={1}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--couple-primary)' }}>
                    Notes
                  </label>
                  <input
                    value={recipeNotes}
                    onChange={(e) => setRecipeNotes(e.target.value)}
                    placeholder="Batch prep, garnish tips..."
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
              </div>

              {/* Ingredients editor */}
              <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--couple-primary)' }}>
                  Ingredients
                </p>
                <p className="text-xs text-gray-400">
                  Enter per-serving quantities. They will be scaled to {guests} guests when added to the shopping list.
                </p>
                {editableIngredients.map((ing, i) => (
                  <div key={i} className="flex gap-2 items-center flex-wrap">
                    <input
                      value={ing.name}
                      onChange={(e) => updateIngredient(i, 'name', e.target.value)}
                      placeholder="Ingredient"
                      className="flex-1 min-w-[120px] border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    />
                    <input
                      type="number"
                      value={ing.quantity || ''}
                      onChange={(e) => updateIngredient(i, 'quantity', parseFloat(e.target.value) || 0)}
                      placeholder="Qty"
                      className="w-16 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    />
                    <select
                      value={ing.unit}
                      onChange={(e) => updateIngredient(i, 'unit', e.target.value)}
                      className="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    >
                      {['oz', 'ml', 'cups', 'tbsp', 'tsp', 'shots', 'dashes', 'each', 'slices', 'wedges'].map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                    <select
                      value={ing.category}
                      onChange={(e) => updateIngredient(i, 'category', e.target.value)}
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.emoji} {c.label}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs text-gray-500 whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={ing.per_serving}
                        onChange={(e) => updateIngredient(i, 'per_serving', e.target.checked)}
                        style={{ accentColor: 'var(--couple-primary)' }}
                      />
                      per serving
                    </label>
                    <button onClick={() => removeIngredient(i)} className="text-red-300 hover:text-red-500 px-1 text-sm">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button onClick={addIngredientRow} className="text-xs hover:underline" style={{ color: 'var(--couple-primary)' }}>
                  + Add ingredient
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={saveRecipe}
                  className="px-4 py-2 text-white rounded-lg text-sm hover:opacity-90"
                  style={{ backgroundColor: 'var(--couple-primary)' }}
                >
                  Save Recipe
                </button>
                <button
                  onClick={() => {
                    setAddingRecipe(false)
                    setEditableIngredients([])
                  }}
                  className="px-4 py-2 text-gray-500 text-sm hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button onClick={startAddRecipe} className="text-sm font-medium hover:underline" style={{ color: 'var(--couple-primary)' }}>
              + Add cocktail recipe
            </button>
          )}

          <NotesBox
            value={notes.recipes}
            onChange={(v) => updateNotes('recipes', v)}
            placeholder="Notes about cocktail choices, garnish ideas, batch prep instructions..."
          />
        </div>
      )}
    </div>
  )
}
