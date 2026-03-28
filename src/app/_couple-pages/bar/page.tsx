'use client'

// Feature: configurable via venue_config.feature_flags
// Table: bar_planning, bar_recipes, bar_shopping_list

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Wine,
  Plus,
  X,
  Edit2,
  Trash2,
  Calculator,
  ShoppingCart,
  ChevronDown,
  ChevronUp,
  Beer,
  GlassWater,
  DollarSign,
  Info,
  Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BarType = 'none' | 'beer_wine' | 'signature_cocktails' | 'modified_full' | 'full_bar'
type BarModel = 'byob' | 'in_house' | 'hybrid'

interface BarPlan {
  id: string
  bar_type: BarType
  bar_model: BarModel
  guest_count: number
  event_duration_hours: number
  notes: string | null
  cost_estimate: number | null
}

interface BarRecipe {
  id: string
  name: string
  ingredients: string
  servings_per_batch: number
  notes: string | null
  sort_order: number
}

interface ShoppingItem {
  id: string
  item_name: string
  quantity: number
  unit: string
  category: string
  estimated_cost: number | null
  purchased: boolean
  notes: string | null
}

interface RecipeFormData {
  name: string
  ingredients: string
  servings_per_batch: string
  notes: string
}

interface ShoppingFormData {
  item_name: string
  quantity: string
  unit: string
  category: string
  estimated_cost: string
  notes: string
}

const BAR_TYPES: { key: BarType; label: string; description: string }[] = [
  { key: 'none', label: 'No Bar', description: 'Non-alcoholic beverages only' },
  { key: 'beer_wine', label: 'Beer & Wine', description: 'Beer and wine service' },
  { key: 'signature_cocktails', label: 'Signature Cocktails', description: 'Curated cocktail menu with beer and wine' },
  { key: 'modified_full', label: 'Modified Full Bar', description: 'Select spirits with beer and wine' },
  { key: 'full_bar', label: 'Full Bar', description: 'Complete spirits, beer, and wine selection' },
]

const BAR_MODELS: { key: BarModel; label: string; description: string }[] = [
  { key: 'byob', label: 'Bring Your Own', description: 'You supply the beverages' },
  { key: 'in_house', label: 'Included with Venue', description: 'Beverages provided by your venue' },
  { key: 'hybrid', label: 'Hybrid', description: 'Some included, some you supply' },
]

const SHOPPING_CATEGORIES = ['Beer', 'Wine', 'Spirits', 'Mixers', 'Garnishes', 'Supplies', 'Non-Alcoholic', 'Other']
const UNITS = ['bottles', 'cases', 'kegs', 'handles', 'liters', 'cans', 'packs', 'each', 'lbs', 'bags']

const EMPTY_RECIPE: RecipeFormData = { name: '', ingredients: '', servings_per_batch: '25', notes: '' }
const EMPTY_SHOPPING: ShoppingFormData = { item_name: '', quantity: '1', unit: 'bottles', category: 'Beer', estimated_cost: '', notes: '' }

// ---------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------

function calcBartenders(guestCount: number): number {
  if (guestCount <= 0) return 0
  return Math.max(2, Math.ceil(guestCount / 50))
}

function calcAlcohol(guestCount: number, durationHours: number, barType: BarType) {
  if (guestCount <= 0 || barType === 'none') return null
  const drinksPerGuest = durationHours * 1.0 // ~1 drink per hour per guest
  const totalDrinks = Math.ceil(guestCount * drinksPerGuest)

  let beerPct = 0.4, winePct = 0.3, spiritPct = 0.3
  if (barType === 'beer_wine') { beerPct = 0.55; winePct = 0.45; spiritPct = 0 }
  if (barType === 'signature_cocktails') { beerPct = 0.3; winePct = 0.25; spiritPct = 0.45 }

  const beerDrinks = Math.ceil(totalDrinks * beerPct)
  const wineDrinks = Math.ceil(totalDrinks * winePct)
  const spiritDrinks = Math.ceil(totalDrinks * spiritPct)

  return {
    totalDrinks,
    beer: { drinks: beerDrinks, cases: Math.ceil(beerDrinks / 24), kegs: Math.ceil(beerDrinks / 165) },
    wine: { drinks: wineDrinks, bottles: Math.ceil(wineDrinks / 5) },
    spirits: { drinks: spiritDrinks, handles: Math.ceil(spiritDrinks / 40), bottles: Math.ceil(spiritDrinks / 17) },
  }
}

// ---------------------------------------------------------------------------
// Bar Planner Page
// ---------------------------------------------------------------------------

export default function BarPlannerPage() {
  const [plan, setPlan] = useState<BarPlan | null>(null)
  const [recipes, setRecipes] = useState<BarRecipe[]>([])
  const [shoppingList, setShoppingList] = useState<ShoppingItem[]>([])
  const [loading, setLoading] = useState(true)

  // Form state
  const [barType, setBarType] = useState<BarType>('beer_wine')
  const [barModel, setBarModel] = useState<BarModel>('byob')
  const [guestCount, setGuestCount] = useState(100)
  const [eventDuration, setEventDuration] = useState(5)
  const [planNotes, setPlanNotes] = useState('')
  const [costEstimate, setCostEstimate] = useState('')

  // Modals
  const [showRecipeModal, setShowRecipeModal] = useState(false)
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null)
  const [recipeForm, setRecipeForm] = useState<RecipeFormData>(EMPTY_RECIPE)
  const [showShoppingModal, setShowShoppingModal] = useState(false)
  const [editingShoppingId, setEditingShoppingId] = useState<string | null>(null)
  const [shoppingForm, setShoppingForm] = useState<ShoppingFormData>(EMPTY_SHOPPING)

  // Sections
  const [showCalc, setShowCalc] = useState(true)
  const [showRecipes, setShowRecipes] = useState(true)
  const [showShopping, setShowShopping] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [planRes, recipesRes, shoppingRes] = await Promise.all([
      supabase.from('bar_planning').select('*').eq('wedding_id', WEDDING_ID).maybeSingle(),
      supabase.from('bar_recipes').select('*').eq('wedding_id', WEDDING_ID).order('sort_order', { ascending: true }),
      supabase.from('bar_shopping_list').select('*').eq('wedding_id', WEDDING_ID).order('category').order('item_name'),
    ])

    if (planRes.data) {
      const p = planRes.data as BarPlan
      setPlan(p)
      setBarType(p.bar_type)
      setBarModel(p.bar_model)
      setGuestCount(p.guest_count)
      setEventDuration(p.event_duration_hours)
      setPlanNotes(p.notes || '')
      setCostEstimate(p.cost_estimate?.toString() || '')
    }
    if (recipesRes.data) setRecipes(recipesRes.data as BarRecipe[])
    if (shoppingRes.data) setShoppingList(shoppingRes.data as ShoppingItem[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { fetchData() }, [fetchData])

  // ---- Save plan ----
  async function savePlan() {
    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      bar_type: barType,
      bar_model: barModel,
      guest_count: guestCount,
      event_duration_hours: eventDuration,
      notes: planNotes || null,
      cost_estimate: costEstimate ? parseFloat(costEstimate) : null,
    }

    if (plan) {
      await supabase.from('bar_planning').update(payload).eq('id', plan.id)
    } else {
      await supabase.from('bar_planning').insert(payload)
    }
    fetchData()
  }

  // ---- Recipes ----
  function openAddRecipe() {
    setRecipeForm(EMPTY_RECIPE)
    setEditingRecipeId(null)
    setShowRecipeModal(true)
  }

  function openEditRecipe(recipe: BarRecipe) {
    setRecipeForm({
      name: recipe.name,
      ingredients: recipe.ingredients,
      servings_per_batch: recipe.servings_per_batch.toString(),
      notes: recipe.notes || '',
    })
    setEditingRecipeId(recipe.id)
    setShowRecipeModal(true)
  }

  async function handleSaveRecipe() {
    if (!recipeForm.name.trim()) return
    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      name: recipeForm.name.trim(),
      ingredients: recipeForm.ingredients.trim(),
      servings_per_batch: parseInt(recipeForm.servings_per_batch) || 25,
      notes: recipeForm.notes.trim() || null,
      sort_order: editingRecipeId ? undefined : recipes.length,
    }

    if (editingRecipeId) {
      await supabase.from('bar_recipes').update(payload).eq('id', editingRecipeId)
    } else {
      await supabase.from('bar_recipes').insert(payload)
    }
    setShowRecipeModal(false)
    setEditingRecipeId(null)
    fetchData()
  }

  async function handleDeleteRecipe(id: string) {
    if (!confirm('Remove this recipe?')) return
    await supabase.from('bar_recipes').delete().eq('id', id)
    fetchData()
  }

  // ---- Shopping ----
  function openAddShopping() {
    setShoppingForm(EMPTY_SHOPPING)
    setEditingShoppingId(null)
    setShowShoppingModal(true)
  }

  function openEditShopping(item: ShoppingItem) {
    setShoppingForm({
      item_name: item.item_name,
      quantity: item.quantity.toString(),
      unit: item.unit,
      category: item.category,
      estimated_cost: item.estimated_cost?.toString() || '',
      notes: item.notes || '',
    })
    setEditingShoppingId(item.id)
    setShowShoppingModal(true)
  }

  async function handleSaveShopping() {
    if (!shoppingForm.item_name.trim()) return
    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      item_name: shoppingForm.item_name.trim(),
      quantity: parseFloat(shoppingForm.quantity) || 1,
      unit: shoppingForm.unit,
      category: shoppingForm.category,
      estimated_cost: shoppingForm.estimated_cost ? parseFloat(shoppingForm.estimated_cost) : null,
      notes: shoppingForm.notes.trim() || null,
    }

    if (editingShoppingId) {
      await supabase.from('bar_shopping_list').update(payload).eq('id', editingShoppingId)
    } else {
      await supabase.from('bar_shopping_list').insert({ ...payload, purchased: false })
    }
    setShowShoppingModal(false)
    setEditingShoppingId(null)
    fetchData()
  }

  async function togglePurchased(item: ShoppingItem) {
    await supabase.from('bar_shopping_list').update({ purchased: !item.purchased }).eq('id', item.id)
    fetchData()
  }

  async function handleDeleteShopping(id: string) {
    if (!confirm('Remove this item?')) return
    await supabase.from('bar_shopping_list').delete().eq('id', id)
    fetchData()
  }

  // ---- Calculations ----
  const bartenderCount = calcBartenders(guestCount)
  const alcoholEstimate = calcAlcohol(guestCount, eventDuration, barType)

  const shoppingTotal = useMemo(() => {
    return shoppingList.reduce((sum, item) => sum + (item.estimated_cost || 0), 0)
  }, [shoppingList])

  const shoppingByCategory = useMemo(() => {
    const grouped: Record<string, ShoppingItem[]> = {}
    for (const item of shoppingList) {
      if (!grouped[item.category]) grouped[item.category] = []
      grouped[item.category].push(item)
    }
    return grouped
  }, [shoppingList])

  function exportShoppingCSV() {
    const headers = ['Item', 'Quantity', 'Unit', 'Category', 'Est. Cost', 'Purchased', 'Notes']
    const rows = shoppingList.map((item) => [
      item.item_name, item.quantity, item.unit, item.category,
      item.estimated_cost?.toFixed(2) || '', item.purchased ? 'Yes' : 'No', item.notes || '',
    ])
    const csv = [headers, ...rows].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bar-shopping-list.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-32 bg-gray-100 rounded-xl" />
        <div className="h-64 bg-gray-100 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Bar Planner
        </h1>
        <p className="text-gray-500 text-sm">Plan your bar service, calculate quantities, and build your shopping list.</p>
      </div>

      {/* Bar Type Selection */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
        <h2
          className="text-lg font-semibold"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Bar Setup
        </h2>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Bar Type</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            {BAR_TYPES.map((bt) => (
              <button
                key={bt.key}
                onClick={() => setBarType(bt.key)}
                className={cn(
                  'text-left p-3 rounded-lg border text-sm transition-colors',
                  barType === bt.key
                    ? 'text-white border-transparent'
                    : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white'
                )}
                style={barType === bt.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
              >
                <div className="font-medium">{bt.label}</div>
                <div className={cn('text-xs mt-0.5', barType === bt.key ? 'text-white/80' : 'text-gray-400')}>
                  {bt.description}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Bar Model</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {BAR_MODELS.map((bm) => (
              <button
                key={bm.key}
                onClick={() => setBarModel(bm.key)}
                className={cn(
                  'text-left p-3 rounded-lg border text-sm transition-colors',
                  barModel === bm.key
                    ? 'text-white border-transparent'
                    : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white'
                )}
                style={barModel === bm.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
              >
                <div className="font-medium">{bm.label}</div>
                <div className={cn('text-xs mt-0.5', barModel === bm.key ? 'text-white/80' : 'text-gray-400')}>
                  {bm.description}
                </div>
              </button>
            ))}
          </div>
        </div>

        {barModel === 'byob' && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-lg text-sm text-amber-800">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Since you are supplying beverages, use the calculator and shopping list below to plan quantities. Check with your venue for any requirements around delivery, ice, and leftover pickup.</p>
          </div>
        )}

        {barModel === 'in_house' && (
          <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-100 rounded-lg text-sm text-emerald-800">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Your venue provides bar service. The calculator below can still help you understand quantities and set expectations with your venue coordinator.</p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Guest Count</label>
            <input
              type="number"
              value={guestCount}
              onChange={(e) => setGuestCount(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              min={0}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Event Duration (hours)</label>
            <input
              type="number"
              value={eventDuration}
              onChange={(e) => setEventDuration(parseInt(e.target.value) || 1)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              min={1}
              max={12}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Estimated Budget</label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="number"
                value={costEstimate}
                onChange={(e) => setCostEstimate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                placeholder="Optional"
                min={0}
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
          <textarea
            value={planNotes}
            onChange={(e) => setPlanNotes(e.target.value)}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            rows={2}
            placeholder="Any preferences, restrictions, or notes for your bar service..."
          />
        </div>

        <div className="flex justify-end">
          <button
            onClick={savePlan}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            Save Bar Plan
          </button>
        </div>
      </div>

      {/* Quantity Calculator */}
      {barType !== 'none' && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowCalc(!showCalc)}
            className="w-full flex items-center justify-between p-5"
          >
            <div className="flex items-center gap-2">
              <Calculator className="w-5 h-5" style={{ color: 'var(--couple-primary)' }} />
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Quantity Calculator
              </h2>
            </div>
            {showCalc ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
          </button>

          {showCalc && alcoholEstimate && (
            <div className="px-5 pb-5 space-y-4">
              {/* Bartender recommendation */}
              <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--couple-primary)' }}>
                  <span className="text-white font-bold text-sm">{bartenderCount}</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-800">Recommended Bartenders</p>
                  <p className="text-xs text-gray-500">1 bartender per 50 guests (minimum 2)</p>
                </div>
              </div>

              <div className="text-xs text-gray-500 text-center">
                Estimated {alcoholEstimate.totalDrinks} total drinks for {guestCount} guests over {eventDuration} hours
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Beer */}
                {alcoholEstimate.beer.drinks > 0 && (
                  <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                    <div className="flex items-center gap-2 mb-3">
                      <Beer className="w-5 h-5 text-amber-600" />
                      <h3 className="font-semibold text-amber-800 text-sm">Beer</h3>
                    </div>
                    <p className="text-2xl font-bold text-amber-700 tabular-nums">{alcoholEstimate.beer.drinks}</p>
                    <p className="text-xs text-amber-600 mb-2">servings</p>
                    <div className="space-y-1 text-xs text-amber-700">
                      <p>{alcoholEstimate.beer.cases} cases (24-pack)</p>
                      <p className="text-amber-500">or {alcoholEstimate.beer.kegs} half-barrel keg{alcoholEstimate.beer.kegs !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                )}

                {/* Wine */}
                {alcoholEstimate.wine.drinks > 0 && (
                  <div className="p-4 bg-rose-50 rounded-xl border border-rose-100">
                    <div className="flex items-center gap-2 mb-3">
                      <Wine className="w-5 h-5 text-rose-600" />
                      <h3 className="font-semibold text-rose-800 text-sm">Wine</h3>
                    </div>
                    <p className="text-2xl font-bold text-rose-700 tabular-nums">{alcoholEstimate.wine.drinks}</p>
                    <p className="text-xs text-rose-600 mb-2">servings</p>
                    <div className="text-xs text-rose-700">
                      <p>{alcoholEstimate.wine.bottles} bottles (750ml)</p>
                    </div>
                  </div>
                )}

                {/* Spirits */}
                {alcoholEstimate.spirits.drinks > 0 && (
                  <div className="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
                    <div className="flex items-center gap-2 mb-3">
                      <GlassWater className="w-5 h-5 text-indigo-600" />
                      <h3 className="font-semibold text-indigo-800 text-sm">Spirits</h3>
                    </div>
                    <p className="text-2xl font-bold text-indigo-700 tabular-nums">{alcoholEstimate.spirits.drinks}</p>
                    <p className="text-xs text-indigo-600 mb-2">servings</p>
                    <div className="space-y-1 text-xs text-indigo-700">
                      <p>{alcoholEstimate.spirits.handles} handles (1.75L)</p>
                      <p className="text-indigo-500">or {alcoholEstimate.spirits.bottles} standard bottles (750ml)</p>
                    </div>
                  </div>
                )}
              </div>

              <p className="text-xs text-gray-400 text-center">
                These are estimates based on industry averages. Adjust based on your crowd and preferences.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Signature Cocktail Recipes */}
      {(barType === 'signature_cocktails' || barType === 'modified_full' || barType === 'full_bar') && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowRecipes(!showRecipes)}
            className="w-full flex items-center justify-between p-5"
          >
            <div className="flex items-center gap-2">
              <Wine className="w-5 h-5" style={{ color: 'var(--couple-primary)' }} />
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Cocktail Recipes
              </h2>
              <span className="text-xs text-gray-400">({recipes.length})</span>
            </div>
            {showRecipes ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
          </button>

          {showRecipes && (
            <div className="px-5 pb-5 space-y-3">
              {recipes.length === 0 ? (
                <div className="text-center py-8">
                  <Wine className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
                  <p className="text-sm text-gray-500 mb-3">No cocktail recipes yet. Add your signature drinks.</p>
                </div>
              ) : (
                recipes.map((recipe) => {
                  const batchesNeeded = Math.ceil(guestCount / (recipe.servings_per_batch || 25))
                  return (
                    <div key={recipe.id} className="p-4 bg-gray-50 rounded-lg group">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h3 className="font-semibold text-gray-800 text-sm">{recipe.name}</h3>
                          <p className="text-xs text-gray-500 mt-1 whitespace-pre-wrap">{recipe.ingredients}</p>
                          <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                            <span>{recipe.servings_per_batch} servings/batch</span>
                            <span className="font-medium" style={{ color: 'var(--couple-primary)' }}>
                              ~{batchesNeeded} batch{batchesNeeded !== 1 ? 'es' : ''} for {guestCount} guests
                            </span>
                          </div>
                          {recipe.notes && <p className="text-xs text-gray-400 mt-1 italic">{recipe.notes}</p>}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => openEditRecipe(recipe)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDeleteRecipe(recipe.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              <button
                onClick={openAddRecipe}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                <Plus className="w-4 h-4" />
                Add Recipe
              </button>
            </div>
          )}
        </div>
      )}

      {/* Shopping List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <button
          onClick={() => setShowShopping(!showShopping)}
          className="w-full flex items-center justify-between p-5"
        >
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5" style={{ color: 'var(--couple-primary)' }} />
            <h2
              className="text-lg font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              Shopping List
            </h2>
            <span className="text-xs text-gray-400">({shoppingList.length} items)</span>
          </div>
          {showShopping ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
        </button>

        {showShopping && (
          <div className="px-5 pb-5 space-y-4">
            {shoppingList.length > 0 && (
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  Estimated total: <span className="font-semibold text-gray-700">${shoppingTotal.toFixed(2)}</span>
                </div>
                <button
                  onClick={exportShoppingCSV}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export CSV
                </button>
              </div>
            )}

            {shoppingList.length === 0 ? (
              <div className="text-center py-8">
                <ShoppingCart className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
                <p className="text-sm text-gray-500 mb-3">No items in your shopping list yet.</p>
              </div>
            ) : (
              Object.entries(shoppingByCategory).map(([category, items]) => (
                <div key={category}>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{category}</h3>
                  <div className="space-y-1">
                    {items.map((item) => (
                      <div key={item.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 group">
                        <input
                          type="checkbox"
                          checked={item.purchased}
                          onChange={() => togglePurchased(item)}
                          className="w-4 h-4 rounded border-gray-300"
                          style={{ accentColor: 'var(--couple-primary)' }}
                        />
                        <div className={cn('flex-1 min-w-0 text-sm', item.purchased && 'line-through text-gray-400')}>
                          <span className="font-medium text-gray-700">{item.item_name}</span>
                          <span className="text-gray-400 ml-2">{item.quantity} {item.unit}</span>
                        </div>
                        {item.estimated_cost && (
                          <span className="text-xs text-gray-400">${item.estimated_cost.toFixed(2)}</span>
                        )}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => openEditShopping(item)} className="p-1 rounded text-gray-400 hover:text-gray-600">
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button onClick={() => handleDeleteShopping(item.id)} className="p-1 rounded text-gray-400 hover:text-red-500">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}

            <button
              onClick={openAddShopping}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add Item
            </button>
          </div>
        )}
      </div>

      {/* Recipe Modal */}
      {showRecipeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowRecipeModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingRecipeId ? 'Edit Recipe' : 'Add Cocktail Recipe'}
              </h2>
              <button onClick={() => setShowRecipeModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cocktail Name</label>
                <input
                  type="text"
                  value={recipeForm.name}
                  onChange={(e) => setRecipeForm({ ...recipeForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Lavender Lemon Drop"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ingredients</label>
                <textarea
                  value={recipeForm.ingredients}
                  onChange={(e) => setRecipeForm({ ...recipeForm, ingredients: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={4}
                  placeholder="List ingredients and amounts, one per line..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Servings Per Batch</label>
                <input
                  type="number"
                  value={recipeForm.servings_per_batch}
                  onChange={(e) => setRecipeForm({ ...recipeForm, servings_per_batch: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  min={1}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={recipeForm.notes}
                  onChange={(e) => setRecipeForm({ ...recipeForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Optional notes..."
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowRecipeModal(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleSaveRecipe}
                disabled={!recipeForm.name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingRecipeId ? 'Save Changes' : 'Add Recipe'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shopping Item Modal */}
      {showShoppingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowShoppingModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingShoppingId ? 'Edit Item' : 'Add Shopping Item'}
              </h2>
              <button onClick={() => setShowShoppingModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                <input
                  type="text"
                  value={shoppingForm.item_name}
                  onChange={(e) => setShoppingForm({ ...shoppingForm, item_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Prosecco"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
                  <input
                    type="number"
                    value={shoppingForm.quantity}
                    onChange={(e) => setShoppingForm({ ...shoppingForm, quantity: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    min={0}
                    step="0.5"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
                  <select
                    value={shoppingForm.unit}
                    onChange={(e) => setShoppingForm({ ...shoppingForm, unit: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={shoppingForm.category}
                  onChange={(e) => setShoppingForm({ ...shoppingForm, category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  {SHOPPING_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Estimated Cost</label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="number"
                    value={shoppingForm.estimated_cost}
                    onChange={(e) => setShoppingForm({ ...shoppingForm, estimated_cost: e.target.value })}
                    className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="Optional"
                    min={0}
                    step="0.01"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input
                  type="text"
                  value={shoppingForm.notes}
                  onChange={(e) => setShoppingForm({ ...shoppingForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Optional notes..."
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowShoppingModal(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleSaveShopping}
                disabled={!shoppingForm.item_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingShoppingId ? 'Save Changes' : 'Add Item'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
