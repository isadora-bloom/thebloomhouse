'use client'

// Feature: configurable via venue_config.feature_flags
// Table: staffing_assignments (calculator data stored as role='_calculator' with answers in notes)

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  Users,
  Info,
  ChevronLeft,
  ChevronRight,
  Check,
  Beer,
  UtensilsCrossed,
  Truck,
  Sparkles,
  Save,
  RotateCcw,
  AlertTriangle,
  DollarSign,
  Wine,
  GlassWater,
  Gem,
  Hand,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const STAFF_RATE = 350 // 2026 rate per person per day

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StaffingAnswers {
  guestCount: number
  hasFridayEvent: boolean
  fridayAlcoholForNonStaying: boolean
  fridayDinnerOnsite: boolean
  fridayDinnerCatered: boolean
  fridayGuestCount: number
  // Saturday bar add-ons
  champagneWelcome: boolean
  patioBar: boolean
  tableWineService: boolean
  realGlassware: boolean
  // Catering
  foodTrucks: boolean
  bringOwnFood: boolean
  cateringNoHelp: boolean
  // Extra hands triggers
  newVendorTeam: boolean
  largeWedding: boolean
  multipleGatherings: boolean
  earlyCeremony: boolean
  lotsDIYDecor: boolean
  noShuttles: boolean
  diyFlowers: boolean
}

interface FridayCalc {
  bartenders: number
  extraHands: number
  reasons: string[]
  total: number
}

interface SaturdayCalc {
  bartenders: number
  extraHands: number
  bartenderReasons: string[]
  extraHandsReasons: string[]
  total: number
}

const DEFAULT_ANSWERS: StaffingAnswers = {
  guestCount: 100,
  hasFridayEvent: false,
  fridayAlcoholForNonStaying: false,
  fridayDinnerOnsite: false,
  fridayDinnerCatered: true,
  fridayGuestCount: 50,
  champagneWelcome: false,
  patioBar: false,
  tableWineService: false,
  realGlassware: false,
  foodTrucks: false,
  bringOwnFood: false,
  cateringNoHelp: false,
  newVendorTeam: false,
  largeWedding: false,
  multipleGatherings: false,
  earlyCeremony: false,
  lotsDIYDecor: false,
  noShuttles: false,
  diyFlowers: false,
}

// ---------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------

function calculateFriday(a: StaffingAnswers): FridayCalc {
  if (!a.hasFridayEvent) {
    return { bartenders: 0, extraHands: 0, reasons: [], total: 0 }
  }

  let bartenders = 0
  let extraHands = 0
  const reasons: string[] = []

  // Friday bartenders
  if (a.fridayAlcoholForNonStaying) {
    bartenders = Math.ceil(a.fridayGuestCount / 50)
    reasons.push(`${bartenders} bartender(s) for ${a.fridayGuestCount} guests`)
  }

  // Friday extra hands for dinner
  if (a.fridayDinnerOnsite) {
    if (!a.fridayDinnerCatered) {
      extraHands = Math.ceil(a.fridayGuestCount / 25)
      reasons.push(`${extraHands} extra hand(s) for uncatered dinner (1 per 25 guests)`)
    } else {
      extraHands = 1
      reasons.push('1 extra hand for setup/cleanup support')
    }
  }

  return { bartenders, extraHands, reasons, total: bartenders + extraHands }
}

function calculateSaturday(a: StaffingAnswers): SaturdayCalc {
  let bartenders = Math.max(2, Math.ceil(a.guestCount / 50))
  const bartenderReasons: string[] = [`Base: ${bartenders} (min 2, or 1 per 50 guests)`]
  let extraHands = 0
  const extraHandsReasons: string[] = []

  // Bar add-ons: 1 bartender per 2 add-ons
  const addOns: string[] = []
  let addOnCount = 0
  if (a.champagneWelcome) { addOns.push('Champagne welcome'); addOnCount++ }
  if (a.patioBar) { addOns.push('Patio bar'); addOnCount++ }
  if (a.realGlassware) { addOns.push('Real glassware'); addOnCount++ }

  // Table wine: for 100+ guests => +2 bartenders (not counted as add-on)
  if (a.tableWineService) {
    if (a.guestCount > 100) {
      bartenders += 2
      bartenderReasons.push('+2 for table wine service (larger wedding)')
    } else {
      addOns.push('Table service')
      addOnCount++
    }
  }

  if (addOnCount > 0) {
    const addOnBartenders = Math.ceil(addOnCount / 2)
    bartenders += addOnBartenders
    bartenderReasons.push(`+${addOnBartenders} for extras (${addOns.join(', ')})`)
  }

  // Extra hands
  if (a.foodTrucks) {
    extraHands = 1 + Math.ceil(a.guestCount / 30)
    extraHandsReasons.push('Food truck event: Captain + 1 per 30 guests')
  } else {
    const triggers: { key: keyof StaffingAnswers; reason: string }[] = [
      { key: 'newVendorTeam', reason: 'New vendor coordination' },
      { key: 'cateringNoHelp', reason: 'Catering without service staff' },
      { key: 'bringOwnFood', reason: 'Self-catered food' },
      { key: 'largeWedding', reason: 'Large wedding coverage' },
      { key: 'multipleGatherings', reason: 'Multiple gatherings' },
      { key: 'earlyCeremony', reason: 'Early ceremony' },
      { key: 'lotsDIYDecor', reason: 'DIY decor setup' },
      { key: 'noShuttles', reason: 'Parking help' },
      { key: 'diyFlowers', reason: 'Flower arranging' },
    ]

    let taskCount = 0
    const tasks: string[] = []
    triggers.forEach((t) => {
      if (a[t.key]) { taskCount++; tasks.push(t.reason) }
    })

    if (taskCount > 0) {
      extraHands = Math.ceil(taskCount / 2)
      extraHandsReasons.push(`${extraHands} for: ${tasks.join(', ')} (1 person per 2 tasks)`)
    }
  }

  // Always minimum 1 extra hand on Saturday
  if (extraHands === 0) {
    extraHands = 1
    extraHandsReasons.push('Baseline: 1 to cover vendor gaps')
  }

  return { bartenders, extraHands, bartenderReasons, extraHandsReasons, total: bartenders + extraHands }
}

// ---------------------------------------------------------------------------
// Toggle button component
// ---------------------------------------------------------------------------

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  description?: string
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer p-3 rounded-xl hover:bg-gray-50 transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 w-5 h-5 rounded border-gray-300"
        style={{ accentColor: 'var(--couple-primary)' }}
      />
      <div>
        <span className="font-medium text-sm text-gray-800">{label}</span>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function StaffingCalculatorPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<StaffingAnswers>(DEFAULT_ANSWERS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  const supabase = createClient()
  const TOTAL_STEPS = 6

  // Load existing data from staffing_assignments (role='_calculator')
  const loadData = useCallback(async () => {
    if (!weddingId) return
    try {
      const { data } = await supabase
        .from('staffing_assignments')
        .select('notes')
        .eq('wedding_id', weddingId)
        .eq('role', '_calculator')
        .maybeSingle()

      if (data?.notes) {
        try {
          const parsed = JSON.parse(data.notes as string)
          if (parsed.answers) {
            setAnswers((prev) => ({ ...prev, ...parsed.answers }))
          }
        } catch { /* ignore parse errors */ }
      }
    } catch (err) {
      console.error('Failed to load staffing:', err)
    } finally {
      setLoading(false)
    }
  }, [supabase, weddingId])

  // BUG-04A: wait for weddingId before firing fetch.
  useEffect(() => {
    if (!weddingId) return
    loadData()
  }, [weddingId, loadData])

  const update = <K extends keyof StaffingAnswers>(key: K, value: StaffingAnswers[K]) => {
    setAnswers((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  // Calculations
  const friday = calculateFriday(answers)
  const saturday = calculateSaturday(answers)
  const totalStaff = friday.total + saturday.total
  const totalCost = totalStaff * STAFF_RATE

  // Save — store calculator state in staffing_assignments with role='_calculator'
  const handleSave = async () => {
    setSaving(true)
    try {
      const calculatorData = {
        answers,
        friday_bartenders: friday.bartenders,
        friday_extra_hands: friday.extraHands,
        friday_total: friday.total,
        saturday_bartenders: saturday.bartenders,
        saturday_extra_hands: saturday.extraHands,
        saturday_total: saturday.total,
        total_staff: totalStaff,
        total_cost: totalCost,
      }

      // Check if calculator row exists
      const { data: existing } = await supabase
        .from('staffing_assignments')
        .select('id')
        .eq('wedding_id', weddingId)
        .eq('role', '_calculator')
        .maybeSingle()

      if (existing) {
        await supabase
          .from('staffing_assignments')
          .update({ notes: JSON.stringify(calculatorData) })
          .eq('id', existing.id)
      } else {
        await supabase
          .from('staffing_assignments')
          .insert({
            venue_id: venueId,
            wedding_id: weddingId,
            role: '_calculator',
            notes: JSON.stringify(calculatorData),
          })
      }

      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Failed to save staffing:', err)
    }
    setSaving(false)
  }

  if (contextLoading || !weddingId || !venueId || loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-2 w-full bg-gray-100 rounded-full" />
        <div className="h-64 bg-gray-100 rounded-xl" />
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Step content
  // ---------------------------------------------------------------------------

  function renderStepContent() {
    switch (step) {
      // ====== STEP 0: Intro ======
      case 0:
        return (
          <div className="space-y-5">
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <DollarSign className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800">2026 Rate: ${STAFF_RATE} per person per event day</p>
                <p className="text-xs text-amber-700 mt-1">
                  Payment is collected via Venmo at your final walkthrough.
                </p>
              </div>
            </div>

            <p className="text-sm text-gray-600 leading-relaxed">
              This guide will help you understand approximately how many staff members you may need for your wedding weekend.
              Walk through each step and we will calculate an estimate based on your answers.
            </p>

            <div className="flex items-start gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl">
              <Info className="w-5 h-5 text-gray-400 mt-0.5 shrink-0" />
              <p className="text-xs text-gray-500">
                This calculator provides estimates only. Your coordinator will finalize staffing needs
                based on your specific event details at your planning meetings.
              </p>
            </div>
          </div>
        )

      // ====== STEP 1: Guest Count & Friday ======
      case 1:
        return (
          <div className="space-y-6">
            {/* Guest count */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                How many guests are you expecting on Saturday?
              </label>
              <input
                type="number"
                value={answers.guestCount}
                onChange={(e) => update('guestCount', parseInt(e.target.value) || 0)}
                className="w-full px-4 py-3 border border-gray-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                min={1}
                max={300}
              />
            </div>

            {/* Friday event toggle */}
            <div className="border-t border-gray-100 pt-5">
              <Toggle
                checked={answers.hasFridayEvent}
                onChange={(v) => update('hasFridayEvent', v)}
                label="Friday Event"
                description="Are you having a rehearsal dinner or welcome party on Friday?"
              />
            </div>

            {/* Friday details */}
            {answers.hasFridayEvent && (
              <div className="ml-4 sm:ml-8 space-y-4 bg-gray-50 rounded-xl p-4 border border-gray-100">
                {/* Dinner on-site */}
                <Toggle
                  checked={answers.fridayDinnerOnsite}
                  onChange={(v) => update('fridayDinnerOnsite', v)}
                  label="Dinner on-site Friday"
                  description="Will you be serving dinner at the venue on Friday?"
                />

                {answers.fridayDinnerOnsite && (
                  <div className="ml-4 sm:ml-8 space-y-3">
                    <p className="text-sm text-gray-600">Is Friday dinner fully catered with service staff?</p>
                    <div className="flex gap-3">
                      <button
                        onClick={() => update('fridayDinnerCatered', true)}
                        className={cn(
                          'flex-1 p-3 rounded-xl border-2 text-sm font-medium text-center transition-colors',
                          answers.fridayDinnerCatered
                            ? 'text-white border-transparent'
                            : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white'
                        )}
                        style={answers.fridayDinnerCatered ? { backgroundColor: 'var(--couple-primary)', borderColor: 'var(--couple-primary)' } : undefined}
                      >
                        Yes, fully catered
                      </button>
                      <button
                        onClick={() => update('fridayDinnerCatered', false)}
                        className={cn(
                          'flex-1 p-3 rounded-xl border-2 text-sm font-medium text-center transition-colors',
                          !answers.fridayDinnerCatered
                            ? 'text-white border-transparent'
                            : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white'
                        )}
                        style={!answers.fridayDinnerCatered ? { backgroundColor: 'var(--couple-primary)', borderColor: 'var(--couple-primary)' } : undefined}
                      >
                        No / Self-catered
                      </button>
                    </div>

                    {!answers.fridayDinnerCatered && (
                      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                        <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-sm font-medium text-amber-800">Extra hands required</p>
                          <p className="text-xs text-amber-700 mt-0.5">
                            For uncatered Friday dinners, you will need staff for setup, service, and cleanup — typically 1 person per 25 guests.
                          </p>
                        </div>
                      </div>
                    )}

                    {answers.fridayDinnerCatered && (
                      <div className="flex items-start gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                        <Info className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-gray-500">
                          We still recommend at least 1 extra hand for Friday to help with setup/cleanup between vendor gaps.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Alcohol for non-staying guests */}
                <Toggle
                  checked={answers.fridayAlcoholForNonStaying}
                  onChange={(v) => update('fridayAlcoholForNonStaying', v)}
                  label="Alcohol for non-staying guests"
                  description="Will alcohol be served to anyone not staying on site? (Requires a bartender)"
                />

                {answers.fridayAlcoholForNonStaying && (
                  <div className="ml-4 sm:ml-8">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      How many guests on Friday?
                    </label>
                    <input
                      type="number"
                      value={answers.fridayGuestCount}
                      onChange={(e) => update('fridayGuestCount', parseInt(e.target.value) || 0)}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                      min={1}
                    />
                    <p className="text-xs text-gray-400 mt-1">1 bartender per 50 guests</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )

      // ====== STEP 2: Saturday Bar Services ======
      case 2:
        return (
          <div className="space-y-5">
            <p className="text-sm text-gray-600">
              Saturday requires a minimum of 2 bartenders (bar must be attended at all times), plus 1 per 50 guests.
              Select any extras you are considering:
            </p>

            <div className="flex items-start gap-3 p-4 rounded-xl border" style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 8%, white)', borderColor: 'color-mix(in srgb, var(--couple-primary) 20%, white)' }}>
              <Beer className="w-5 h-5 mt-0.5 shrink-0" style={{ color: 'var(--couple-primary)' }} />
              <p className="text-sm" style={{ color: 'var(--couple-primary)' }}>
                <strong>Base requirement:</strong> {Math.max(2, Math.ceil(answers.guestCount / 50))} bartender(s) for {answers.guestCount} guests
              </p>
            </div>

            <div>
              <p className="text-sm font-medium text-gray-700 mb-1">Select any extras:</p>
              <p className="text-xs text-gray-400 mb-3">One bartender can typically handle 2 of these service additions</p>
            </div>

            <div className="space-y-1">
              <Toggle
                checked={answers.champagneWelcome}
                onChange={(v) => update('champagneWelcome', v)}
                label="Champagne welcome drink"
                description="Guests receive champagne on arrival"
              />
              <Toggle
                checked={answers.patioBar}
                onChange={(v) => update('patioBar', v)}
                label="Back patio satellite bar"
                description="Additional bar on the back patio"
              />
              <Toggle
                checked={answers.realGlassware}
                onChange={(v) => update('realGlassware', v)}
                label="Real glassware"
                description="Using glass instead of disposable cups"
              />
              <Toggle
                checked={answers.tableWineService}
                onChange={(v) => update('tableWineService', v)}
                label="Table wine/champagne service"
                description={answers.guestCount > 100
                  ? 'Wine and champagne poured at tables (+2 bartenders for larger wedding)'
                  : 'Wine and champagne poured at tables'
                }
              />
            </div>
          </div>
        )

      // ====== STEP 3: Catering Style ======
      case 3: {
        const isFullService = !answers.foodTrucks && !answers.bringOwnFood
        return (
          <div className="space-y-5">
            <p className="text-sm text-gray-600">How is your wedding being catered?</p>

            <div className="space-y-3">
              {/* Full-service caterer */}
              <button
                onClick={() => { update('foodTrucks', false); update('bringOwnFood', false) }}
                className={cn(
                  'w-full flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-colors',
                  isFullService ? 'border-transparent' : 'border-gray-200 hover:border-gray-300 bg-white'
                )}
                style={isFullService ? { backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, white)', borderColor: 'var(--couple-primary)' } : undefined}
              >
                <UtensilsCrossed className="w-5 h-5 mt-0.5 shrink-0" style={{ color: isFullService ? 'var(--couple-primary)' : '#9CA3AF' }} />
                <div>
                  <span className="font-medium text-sm text-gray-800">Full-service caterer</span>
                  <p className="text-xs text-gray-500 mt-0.5">Professional catering company handling food and service</p>
                </div>
              </button>

              {/* Food trucks */}
              <button
                onClick={() => { update('foodTrucks', true); update('bringOwnFood', false) }}
                className={cn(
                  'w-full flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-colors',
                  answers.foodTrucks ? 'border-transparent' : 'border-gray-200 hover:border-gray-300 bg-white'
                )}
                style={answers.foodTrucks ? { backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, white)', borderColor: 'var(--couple-primary)' } : undefined}
              >
                <Truck className="w-5 h-5 mt-0.5 shrink-0" style={{ color: answers.foodTrucks ? 'var(--couple-primary)' : '#9CA3AF' }} />
                <div>
                  <span className="font-medium text-sm text-gray-800">Food trucks</span>
                  <p className="text-xs text-gray-500 mt-0.5">Fun, casual option — requires additional staffing for setup/service</p>
                </div>
              </button>

              {/* Self-catered */}
              <button
                onClick={() => { update('bringOwnFood', true); update('foodTrucks', false) }}
                className={cn(
                  'w-full flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-colors',
                  answers.bringOwnFood ? 'border-transparent' : 'border-gray-200 hover:border-gray-300 bg-white'
                )}
                style={answers.bringOwnFood ? { backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, white)', borderColor: 'var(--couple-primary)' } : undefined}
              >
                <Hand className="w-5 h-5 mt-0.5 shrink-0" style={{ color: answers.bringOwnFood ? 'var(--couple-primary)' : '#9CA3AF' }} />
                <div>
                  <span className="font-medium text-sm text-gray-800">Self-catered / Family cooking</span>
                  <p className="text-xs text-gray-500 mt-0.5">Bringing in your own food or having family prepare meals</p>
                </div>
              </button>
            </div>

            {/* Food truck tips */}
            {answers.foodTrucks && (
              <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                <Truck className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800 mb-2">Food Truck Tips</p>
                  <ul className="text-xs text-amber-700 space-y-1">
                    <li>For ~120 guests: 3 dinner trucks + 1 dessert truck recommended</li>
                    <li>Have at least one truck provide cocktail hour apps</li>
                    <li>Wood-fired pizza is great for grab-and-go</li>
                    <li>Limit menu options and put menus on tables</li>
                    <li>Consider matching disposable plate sets from Amazon</li>
                    <li>You will need separate rentals for linens/napkins</li>
                  </ul>
                </div>
              </div>
            )}

            {/* Catering no help checkbox (only for non-food-truck) */}
            {!answers.foodTrucks && (
              <div className="border-t border-gray-100 pt-3">
                <Toggle
                  checked={answers.cateringNoHelp}
                  onChange={(v) => update('cateringNoHelp', v)}
                  label="Catering doesn't include serving/cleanup"
                  description="Some caterers (especially for Friday/Sunday) don't provide service staff"
                />
              </div>
            )}
          </div>
        )
      }

      // ====== STEP 4: Extra Hands Triggers ======
      case 4:
        return (
          <div className="space-y-5">
            <div className="flex items-start gap-3 p-4 rounded-xl border" style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 8%, white)', borderColor: 'color-mix(in srgb, var(--couple-primary) 20%, white)' }}>
              <Users className="w-5 h-5 mt-0.5 shrink-0" style={{ color: 'var(--couple-primary)' }} />
              <p className="text-sm" style={{ color: 'var(--couple-primary)' }}>
                <strong>We strongly recommend at least one extra set of hands</strong> at any wedding to cover the things
                that fall between the cracks of your other vendors' contracts.
              </p>
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-1">Select any that apply to your wedding:</p>
              <p className="text-xs text-gray-400">One person can typically handle at least 2 of these tasks</p>
            </div>

            {/* Friday dinner alert */}
            {answers.hasFridayEvent && answers.fridayDinnerOnsite && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800">Friday dinner on-site</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    You indicated dinner on Friday — extra hands for setup and cleanup is almost always required.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Toggle
                checked={answers.newVendorTeam}
                onChange={(v) => update('newVendorTeam', v)}
                label="Large team of new vendors"
                description="Especially new caterers or photographers who haven't worked here before"
              />
              <Toggle
                checked={answers.largeWedding}
                onChange={(v) => update('largeWedding', v)}
                label="Large wedding"
                description="Your coordinator needs to cover more ground with more guests"
              />
              <Toggle
                checked={answers.multipleGatherings}
                onChange={(v) => update('multipleGatherings', v)}
                label="Multiple large gatherings"
                description="E.g., ceremonial aspects on Friday night"
              />
              <Toggle
                checked={answers.earlyCeremony}
                onChange={(v) => update('earlyCeremony', v)}
                label="Early ceremony"
                description="Ceremony being held earlier in the day"
              />
              <Toggle
                checked={answers.lotsDIYDecor}
                onChange={(v) => update('lotsDIYDecor', v)}
                label="Lots of DIY decor"
                description="Significant setup required for decorations"
              />
              <Toggle
                checked={answers.noShuttles}
                onChange={(v) => update('noShuttles', v)}
                label="No shuttles"
                description="Extra help needed for parking assistance"
              />
              <Toggle
                checked={answers.diyFlowers}
                onChange={(v) => update('diyFlowers', v)}
                label="DIY flowers on site"
                description="Any flower arranging happening at the venue"
              />
            </div>
          </div>
        )

      // ====== STEP 5: Summary ======
      case 5:
        return (
          <div className="space-y-5">
            {/* Friday card */}
            {friday.total > 0 && (
              <div className="bg-white rounded-xl border border-amber-200 shadow-sm overflow-hidden">
                <div className="px-5 py-4 bg-amber-50 border-b border-amber-100 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🌅</span>
                    <h4 className="font-semibold text-amber-800">Friday Night</h4>
                  </div>
                  <span className="text-sm font-bold text-amber-800">{friday.total} staff</span>
                </div>
                <div className="p-5 space-y-3">
                  {friday.bartenders > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-600 flex items-center gap-2">
                        <Beer className="w-4 h-4" /> Bartenders
                      </span>
                      <span className="font-medium text-gray-800">{friday.bartenders}</span>
                    </div>
                  )}
                  {friday.extraHands > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-600 flex items-center gap-2">
                        <Users className="w-4 h-4" /> Extra Hands
                      </span>
                      <span className="font-medium text-gray-800">{friday.extraHands}</span>
                    </div>
                  )}
                  {friday.reasons.length > 0 && (
                    <div className="border-t border-amber-100 pt-3">
                      <ul className="text-xs text-gray-500 space-y-1">
                        {friday.reasons.map((r, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-amber-400 mt-0.5">&#8226;</span> {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="border-t border-amber-100 pt-3">
                    <p className="text-sm font-medium text-amber-700">
                      Friday: ${(friday.total * STAFF_RATE).toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Saturday card */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" style={{ borderColor: 'color-mix(in srgb, var(--couple-primary) 30%, white)' }}>
              <div className="px-5 py-4 border-b flex items-center justify-between" style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 8%, white)', borderColor: 'color-mix(in srgb, var(--couple-primary) 15%, white)' }}>
                <div className="flex items-center gap-2">
                  <span className="text-lg">💒</span>
                  <h4 className="font-semibold" style={{ color: 'var(--couple-primary)' }}>Saturday (Wedding Day)</h4>
                </div>
                <span className="text-sm font-bold" style={{ color: 'var(--couple-primary)' }}>{saturday.total} staff</span>
              </div>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 flex items-center gap-2">
                    <Beer className="w-4 h-4" /> Bartenders
                  </span>
                  <span className="font-medium text-gray-800">{saturday.bartenders}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 flex items-center gap-2">
                    <Users className="w-4 h-4" /> Extra Hands
                  </span>
                  <span className="font-medium text-gray-800">{saturday.extraHands}</span>
                </div>

                {/* Reasons */}
                <div className="border-t border-gray-100 pt-3 space-y-2">
                  {saturday.bartenderReasons.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">Bartenders:</p>
                      <ul className="text-xs text-gray-500 space-y-0.5">
                        {saturday.bartenderReasons.map((r, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="mt-0.5" style={{ color: 'var(--couple-primary)' }}>&#8226;</span> {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {saturday.extraHandsReasons.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">Extra Hands:</p>
                      <ul className="text-xs text-gray-500 space-y-0.5">
                        {saturday.extraHandsReasons.map((r, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="mt-0.5" style={{ color: 'var(--couple-primary)' }}>&#8226;</span> {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div className="border-t pt-3" style={{ borderColor: 'color-mix(in srgb, var(--couple-primary) 15%, white)' }}>
                  <p className="text-sm font-medium" style={{ color: 'var(--couple-primary)' }}>
                    Saturday: ${(saturday.total * STAFF_RATE).toLocaleString()}
                  </p>
                </div>
              </div>
            </div>

            {/* Weekend total */}
            <div
              className="rounded-xl border p-5 flex items-center justify-between"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--couple-primary) 8%, white)',
                borderColor: 'color-mix(in srgb, var(--couple-primary) 20%, white)',
              }}
            >
              <div>
                <p className="font-semibold text-gray-800">Weekend Total</p>
                <p className="text-xs text-gray-500">@ ${STAFF_RATE} per person per day</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
                  {totalStaff} staff
                </p>
                <p className="text-sm font-medium text-gray-600">${totalCost.toLocaleString()}</p>
              </div>
            </div>

            {/* Disclaimer */}
            <div className="flex items-start gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl">
              <Info className="w-5 h-5 text-gray-400 mt-0.5 shrink-0" />
              <p className="text-xs text-gray-500">
                <strong>Remember:</strong> This is an estimate to help you plan. Your coordinator will discuss
                your specific needs at your planning meetings and finalize staffing recommendations based on your unique event details.
              </p>
            </div>

            {/* Save button */}
            <button
              onClick={handleSave}
              disabled={saving}
              className={cn(
                'w-full py-3 rounded-xl text-sm font-medium text-white transition-all shadow-sm',
                saved ? 'bg-emerald-500' : 'hover:opacity-90'
              )}
              style={!saved ? { backgroundColor: 'var(--couple-primary)' } : undefined}
            >
              {saved ? (
                <span className="flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" /> Staffing Guide Saved!
                </span>
              ) : saving ? (
                'Saving...'
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <Save className="w-4 h-4" /> Save Staffing Guide
                </span>
              )}
            </button>
          </div>
        )

      default:
        return null
    }
  }

  // ---------------------------------------------------------------------------
  // Step titles
  // ---------------------------------------------------------------------------

  const stepTitles = [
    'Staffing Guide',
    'Guest Count & Friday Event',
    'Saturday Bar Services',
    'Catering Style',
    'Extra Hands',
    'Your Staffing Estimate',
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Staffing Calculator
        </h1>
        <p className="text-gray-500 text-sm">Estimate how many staff you will need for your wedding weekend.</p>
      </div>

      {/* Progress bar */}
      <div className="flex gap-1">
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <div
            key={i}
            className="flex-1 h-1.5 rounded-full transition-colors"
            style={{
              backgroundColor: i <= step
                ? 'var(--couple-primary)'
                : '#E5E7EB',
            }}
          />
        ))}
      </div>

      {/* Step content card */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        {/* Step title */}
        <h2
          className="text-xl font-semibold mb-5"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          {stepTitles[step]}
        </h2>

        {/* Content */}
        <div className="min-h-[280px]">
          {renderStepContent()}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-8 pt-5 border-t border-gray-100">
          {step > 0 ? (
            <button
              onClick={() => setStep(step - 1)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
          ) : (
            <div />
          )}

          {step < TOTAL_STEPS - 1 ? (
            <button
              onClick={() => setStep(step + 1)}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              Continue
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => setStep(0)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Start Over
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
