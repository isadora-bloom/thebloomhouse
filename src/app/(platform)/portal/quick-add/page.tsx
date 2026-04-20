'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Upload,
  FileText,
  FileSpreadsheet,
  Image,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  ArrowRight,
  RotateCcw,
  ClipboardPaste,
  Sparkles,
  Users,
  Heart,
  DollarSign,
  Store,
  MapPin,
  TrendingUp,
  Calendar,
  HelpCircle,
  Star,
  Megaphone,
  Share2,
  ThumbsDown,
  Shield,
  CreditCard,
  GlassWater,
  UtensilsCrossed,
  HeartHandshake,
  UserCheck,
  Briefcase,
  BedDouble,
  Bus,
  Palette,
  ListChecks,
  BookOpen,
  Settings,
  Info,
  FileJson,
  FileCode,
} from 'lucide-react'
import type { DataType, DetectionResult } from '@/lib/services/data-detection'
import { WEDDING_REQUIRED_TYPES, DATA_TYPE_GROUPS } from '@/lib/services/data-detection'
import type { ImportResult } from '@/lib/services/data-import'

// ---------------------------------------------------------------------------
// Data type metadata for display
// ---------------------------------------------------------------------------

const DATA_TYPE_META: Record<
  DataType,
  { label: string; icon: typeof Users; description: string; color: string; expects: string }
> = {
  client_list: {
    label: 'Client List',
    icon: Users,
    description: 'Couples with names, emails, wedding dates',
    color: 'text-sage-600 bg-sage-50 border-sage-200',
    expects: 'Columns: Name, Email, Phone, Wedding Date, Guest Count, Source',
  },
  guest_list: {
    label: 'Guest List',
    icon: Heart,
    description: 'Guest names, RSVPs, meal preferences',
    color: 'text-rose-600 bg-rose-50 border-rose-200',
    expects: 'Columns: Name, RSVP Status, Meal, Dietary Restrictions, Plus One',
  },
  advertising_spend: {
    label: 'Advertising Spend',
    icon: TrendingUp,
    description: 'Monthly spend by marketing source',
    color: 'text-blue-600 bg-blue-50 border-blue-200',
    expects: 'Columns: Source, Month, Amount, Notes',
  },
  invoice: {
    label: 'Invoice / Receipt',
    icon: DollarSign,
    description: 'Vendor, amount, date, line items',
    color: 'text-amber-600 bg-amber-50 border-amber-200',
    expects: 'Columns: Vendor Name, Category, Item, Amount, Date',
  },
  vendor_list: {
    label: 'Vendor List',
    icon: Store,
    description: 'Vendor names, types, contact info',
    color: 'text-purple-600 bg-purple-50 border-purple-200',
    expects: 'Columns: Vendor Name, Type, Email, Phone, Website',
  },
  tour_records: {
    label: 'Tour Records',
    icon: MapPin,
    description: 'Tour dates, outcomes, notes',
    color: 'text-teal-600 bg-teal-50 border-teal-200',
    expects: 'Columns: Couple Name, Date, Tour Type, Source, Outcome',
  },
  historical_weddings: {
    label: 'Historical Weddings',
    icon: Calendar,
    description: 'Past weddings with dates, revenue, guest counts',
    color: 'text-indigo-600 bg-indigo-50 border-indigo-200',
    expects: 'Columns: Couple Name, Wedding Date, Guest Count, Revenue, Status',
  },
  campaigns: {
    label: 'Campaigns',
    icon: Megaphone,
    description: 'Ad campaigns with spend, leads, and ROI',
    color: 'text-orange-600 bg-orange-50 border-orange-200',
    expects: 'Columns: Campaign Name, Channel, Spend, Inquiries, Bookings, Revenue',
  },
  social_posts: {
    label: 'Social Posts',
    icon: Share2,
    description: 'Social media posts with engagement metrics',
    color: 'text-pink-600 bg-pink-50 border-pink-200',
    expects: 'Columns: Platform, Date, Caption, Likes, Comments, Shares, Reach',
  },
  reviews: {
    label: 'Reviews',
    icon: Star,
    description: 'Customer reviews with ratings and text',
    color: 'text-yellow-600 bg-yellow-50 border-yellow-200',
    expects: 'Columns: Source, Reviewer Name, Rating (1-5), Review Text, Date',
  },
  lost_deals: {
    label: 'Lost Deals',
    icon: ThumbsDown,
    description: 'Lost bookings with reasons and competitors',
    color: 'text-red-600 bg-red-50 border-red-200',
    expects: 'Columns: Couple Name, Reason, Competitor, Stage Lost, Date',
  },
  competitor_info: {
    label: 'Competitor Intel',
    icon: Shield,
    description: 'Competitor venue details and pricing',
    color: 'text-slate-600 bg-slate-50 border-slate-200',
    expects: 'Columns: Competitor Name, Region, Pricing, Features, Notes',
  },
  budget_payments: {
    label: 'Budget Payments',
    icon: CreditCard,
    description: 'Payment records linked to budget items',
    color: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    expects: 'Columns: Budget Item Name, Amount, Payment Date, Method',
  },
  bar_recipes: {
    label: 'Bar Recipes',
    icon: GlassWater,
    description: 'Cocktail recipes with ingredients',
    color: 'text-violet-600 bg-violet-50 border-violet-200',
    expects: 'Columns: Cocktail Name, Ingredients, Instructions, Servings',
  },
  meal_options: {
    label: 'Meal Options',
    icon: UtensilsCrossed,
    description: 'Entree options for guest selection',
    color: 'text-orange-600 bg-orange-50 border-orange-200',
    expects: 'Columns: Option Name, Description, Is Default',
  },
  guest_care: {
    label: 'Guest Care Notes',
    icon: HeartHandshake,
    description: 'Special needs and VIP notes for guests',
    color: 'text-rose-600 bg-rose-50 border-rose-200',
    expects: 'Columns: Guest Name, Care Type (mobility/dietary/VIP/medical), Note',
  },
  wedding_party: {
    label: 'Wedding Party',
    icon: UserCheck,
    description: 'Bridal party members with roles',
    color: 'text-fuchsia-600 bg-fuchsia-50 border-fuchsia-200',
    expects: 'Columns: Name, Role, Side (Bride/Groom), Relationship, Bio',
  },
  staff_roster: {
    label: 'Staff Roster',
    icon: Briefcase,
    description: 'Staff assignments with rates and hours',
    color: 'text-cyan-600 bg-cyan-50 border-cyan-200',
    expects: 'Columns: Role, Person Name, Count, Hourly Rate, Hours',
  },
  room_assignments: {
    label: 'Room Assignments',
    icon: BedDouble,
    description: 'Bedroom assignments for overnight guests',
    color: 'text-amber-600 bg-amber-50 border-amber-200',
    expects: 'Columns: Room Name, Description, Guests (comma-separated)',
  },
  shuttle_schedule: {
    label: 'Shuttle Schedule',
    icon: Bus,
    description: 'Transport routes with times and capacity',
    color: 'text-sky-600 bg-sky-50 border-sky-200',
    expects: 'Columns: Route Name, Pickup, Dropoff, Departure Time, Capacity',
  },
  decor_items: {
    label: 'Decor Inventory',
    icon: Palette,
    description: 'Decoration items with quantities and sources',
    color: 'text-lime-600 bg-lime-50 border-lime-200',
    expects: 'Columns: Item Name, Category, Quantity, Source, Vendor',
  },
  checklist_items: {
    label: 'Checklist Items',
    icon: ListChecks,
    description: 'To-do items with due dates and categories',
    color: 'text-green-600 bg-green-50 border-green-200',
    expects: 'Columns: Title, Description, Due Date, Category, Completed',
  },
  knowledge_base: {
    label: 'Knowledge Base',
    icon: BookOpen,
    description: 'FAQ entries for Sage AI assistant',
    color: 'text-indigo-600 bg-indigo-50 border-indigo-200',
    expects: 'Columns: Category, Question, Answer, Keywords',
  },
  unknown: {
    label: 'Unknown',
    icon: HelpCircle,
    description: 'Could not determine data type',
    color: 'text-gray-600 bg-gray-50 border-gray-200',
    expects: '',
  },
}

// ---------------------------------------------------------------------------
// Setup Mode — batch import data type checklist
// ---------------------------------------------------------------------------

interface SetupDataType {
  type: DataType
  checked: boolean
  status: 'pending' | 'importing' | 'done' | 'skipped'
  result?: ImportResult
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

type Step = 'upload' | 'detecting' | 'preview' | 'importing' | 'done' | 'error'

const STEPS: { key: Step; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'detecting', label: 'Analyzing' },
  { key: 'preview', label: 'Review' },
  { key: 'importing', label: 'Importing' },
  { key: 'done', label: 'Done' },
]

function StepIndicator({ current }: { current: Step }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current)
  const isError = current === 'error'

  return (
    <div className="flex items-center gap-2 mb-8">
      {STEPS.map((step, i) => {
        const isComplete = i < currentIdx
        const isActive = step.key === current
        const isPending = i > currentIdx

        return (
          <div key={step.key} className="flex items-center gap-2">
            <div
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all',
                isComplete && 'bg-sage-100 text-sage-700',
                isActive && !isError && 'bg-sage-500 text-white',
                isActive && isError && 'bg-red-500 text-white',
                isPending && 'bg-gray-100 text-gray-400'
              )}
            >
              {isComplete && <CheckCircle2 className="w-3.5 h-3.5" />}
              {isActive && current === 'detecting' && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {isActive && current === 'importing' && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              <span>{step.label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <ArrowRight
                className={cn(
                  'w-3.5 h-3.5',
                  isComplete ? 'text-sage-400' : 'text-gray-300'
                )}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File icon helper
// ---------------------------------------------------------------------------

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'xls')
    return <FileSpreadsheet className="w-5 h-5 text-green-600" />
  if (ext === 'pdf') return <FileText className="w-5 h-5 text-red-600" />
  if (ext === 'json') return <FileJson className="w-5 h-5 text-yellow-600" />
  if (ext === 'vcf') return <FileCode className="w-5 h-5 text-purple-600" />
  if (ext === 'docx' || ext === 'doc') return <FileText className="w-5 h-5 text-blue-600" />
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext || ''))
    return <Image className="w-5 h-5 text-blue-600" />
  return <FileText className="w-5 h-5 text-gray-600" />
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function QuickAddPage() {
  const scope = useScope()

  // State
  const [step, setStep] = useState<Step>('upload')
  const [dragActive, setDragActive] = useState(false)
  const [pasteMode, setPasteMode] = useState(false)
  const [pastedText, setPastedText] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [detection, setDetection] = useState<DetectionResult | null>(null)
  const [detectedContent, setDetectedContent] = useState<string>('')
  const [overrideType, setOverrideType] = useState<DataType | null>(null)
  const [showTypeDropdown, setShowTypeDropdown] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [fileWarning, setFileWarning] = useState<string | null>(null)
  const [weddings, setWeddings] = useState<{ id: string; label: string }[]>([])
  const [selectedWeddingId, setSelectedWeddingId] = useState('')
  const [showExpects, setShowExpects] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Setup mode state
  const [setupMode, setSetupMode] = useState(false)
  const [setupTypes, setSetupTypes] = useState<SetupDataType[]>([])
  const [setupCurrentIdx, setSetupCurrentIdx] = useState(-1) // -1 = checklist phase
  const [setupStarted, setSetupStarted] = useState(false)

  const venueId = scope.venueId || ''
  const effectiveType = overrideType || detection?.type || 'unknown'
  const meta = DATA_TYPE_META[effectiveType]
  const needsWedding = WEDDING_REQUIRED_TYPES.includes(effectiveType)

  // Load weddings for types that need them
  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    supabase
      .from('weddings')
      .select('id, wedding_date, people(first_name, last_name)')
      .eq('venue_id', venueId)
      .in('status', ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent', 'booked'])
      .order('wedding_date', { ascending: true })
      .limit(50)
      .then(({ data }) => {
        if (data) {
          setWeddings(
            data.map((w) => {
              const people = (w.people as { first_name: string; last_name: string }[]) || []
              const names = people
                .filter((p) => p.first_name)
                .map((p) => `${p.first_name} ${p.last_name || ''}`.trim())
                .join(' & ')
              const date = w.wedding_date
                ? new Date(w.wedding_date).toLocaleDateString()
                : 'No date'
              return { id: w.id, label: names ? `${names} -- ${date}` : date }
            })
          )
        }
      })
  }, [venueId])

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const reset = useCallback(() => {
    setStep('upload')
    setSelectedFile(null)
    setPasteMode(false)
    setPastedText('')
    setDetection(null)
    setDetectedContent('')
    setOverrideType(null)
    setShowTypeDropdown(false)
    setImportResult(null)
    setErrorMessage('')
    setFileWarning(null)
    setSelectedWeddingId('')
    setShowExpects(false)
  }, [])

  const resetSetupMode = useCallback(() => {
    setSetupMode(false)
    setSetupTypes([])
    setSetupCurrentIdx(-1)
    setSetupStarted(false)
    reset()
  }, [reset])

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true)
    else if (e.type === 'dragleave') setDragActive(false)
  }, [])

  const processFile = useCallback(
    async (file: File) => {
      setSelectedFile(file)
      setStep('detecting')
      setErrorMessage('')
      setFileWarning(null)

      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('venueId', venueId)
        formData.append('action', 'detect')

        const res = await fetch('/api/portal/quick-add', {
          method: 'POST',
          body: formData,
        })

        const data = await res.json()

        if (!res.ok) {
          throw new Error(data.error || 'Detection failed')
        }

        setDetection(data.detection)
        setDetectedContent(data.content)
        if (data.fileWarning) setFileWarning(data.fileWarning)
        setStep('preview')
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to analyze file')
        setStep('error')
      }
    },
    [venueId]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragActive(false)

      const files = e.dataTransfer.files
      if (files.length > 0) {
        processFile(files[0])
      }
    },
    [processFile]
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        processFile(files[0])
      }
    },
    [processFile]
  )

  const handlePasteSubmit = useCallback(async () => {
    if (!pastedText.trim()) return
    setStep('detecting')
    setErrorMessage('')

    try {
      const formData = new FormData()
      formData.append('pastedData', pastedText)
      formData.append('venueId', venueId)
      formData.append('action', 'detect')

      const res = await fetch('/api/portal/quick-add', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Detection failed')
      }

      setDetection(data.detection)
      setDetectedContent(data.content)
      setStep('preview')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to analyze data')
      setStep('error')
    }
  }, [pastedText, venueId])

  const handleImport = useCallback(async () => {
    setStep('importing')
    setErrorMessage('')

    try {
      const formData = new FormData()
      formData.append('venueId', venueId)
      formData.append('action', 'import')
      formData.append('content', detectedContent)
      formData.append('detectedType', effectiveType)
      if (overrideType) formData.append('overrideType', overrideType)
      if (selectedWeddingId) formData.append('weddingId', selectedWeddingId)

      const res = await fetch('/api/portal/quick-add', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Import failed')
      }

      setImportResult(data.result)
      setStep('done')

      // If in setup mode, update the setup type status and advance
      if (setupMode && setupStarted && setupCurrentIdx >= 0) {
        setSetupTypes((prev) => {
          const next = [...prev]
          const checkedItems = next.filter((t) => t.checked)
          if (setupCurrentIdx < checkedItems.length) {
            checkedItems[setupCurrentIdx].status = 'done'
            checkedItems[setupCurrentIdx].result = data.result
          }
          return next
        })
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Import failed')
      setStep('error')
    }
  }, [venueId, detectedContent, effectiveType, overrideType, selectedWeddingId, setupMode, setupStarted, setupCurrentIdx])

  // Setup mode: advance to next data type
  const setupAdvance = useCallback(() => {
    const checkedItems = setupTypes.filter((t) => t.checked)
    const nextIdx = setupCurrentIdx + 1
    if (nextIdx >= checkedItems.length) {
      // All done
      setSetupCurrentIdx(checkedItems.length)
      return
    }
    setSetupCurrentIdx(nextIdx)
    // Reset the single-file import state for the next type
    reset()
    // Pre-set the override type for this step
    setOverrideType(checkedItems[nextIdx].type)
  }, [setupTypes, setupCurrentIdx, reset])

  const setupSkipCurrent = useCallback(() => {
    setSetupTypes((prev) => {
      const next = [...prev]
      const checkedItems = next.filter((t) => t.checked)
      if (setupCurrentIdx < checkedItems.length) {
        checkedItems[setupCurrentIdx].status = 'skipped'
      }
      return next
    })
    setupAdvance()
  }, [setupCurrentIdx, setupAdvance])

  // -----------------------------------------------------------------------
  // Render: Loading guard
  // -----------------------------------------------------------------------

  if (scope.loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-6 h-6 animate-spin text-sage-500" />
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // Setup mode completed screen
  // -----------------------------------------------------------------------

  const checkedSetupItems = setupTypes.filter((t) => t.checked)
  const setupComplete = setupStarted && setupCurrentIdx >= checkedSetupItems.length

  if (setupMode && setupComplete) {
    const totalImported = checkedSetupItems.reduce((sum, t) => sum + (t.result?.imported || 0), 0)
    const totalSkipped = checkedSetupItems.filter((t) => t.status === 'skipped').length
    const totalDone = checkedSetupItems.filter((t) => t.status === 'done').length

    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-sage-100">
              <Sparkles className="w-5 h-5 text-sage-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-sage-900 font-display">
                Setup Complete
              </h1>
              <p className="text-sm text-sage-500">
                All selected data sets have been processed
              </p>
            </div>
          </div>
        </div>

        <div className="p-8 rounded-xl border-2 border-green-200 bg-green-50 text-center mb-6">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
          <p className="text-xl font-semibold text-sage-800 mb-2">
            {totalImported} total records imported across {totalDone} data set{totalDone !== 1 ? 's' : ''}
          </p>
          {totalSkipped > 0 && (
            <p className="text-sm text-sage-500">
              {totalSkipped} data set{totalSkipped !== 1 ? 's' : ''} skipped
            </p>
          )}
        </div>

        {/* Summary of each type */}
        <div className="space-y-2 mb-6">
          {checkedSetupItems.map((item) => {
            const typeMeta = DATA_TYPE_META[item.type]
            return (
              <div
                key={item.type}
                className={cn(
                  'flex items-center justify-between p-3 rounded-lg border',
                  item.status === 'done' ? 'bg-green-50 border-green-200' :
                  item.status === 'skipped' ? 'bg-gray-50 border-gray-200' :
                  'bg-white border-sage-200'
                )}
              >
                <div className="flex items-center gap-2">
                  <typeMeta.icon className="w-4 h-4 text-sage-500" />
                  <span className="text-sm font-medium text-sage-700">{typeMeta.label}</span>
                </div>
                <span className="text-xs text-sage-500">
                  {item.status === 'done'
                    ? `${item.result?.imported || 0} imported`
                    : item.status === 'skipped'
                    ? 'Skipped'
                    : 'Pending'}
                </span>
              </div>
            )
          })}
        </div>

        <div className="flex justify-center gap-3">
          <button
            onClick={resetSetupMode}
            className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium bg-sage-600 text-white hover:bg-sage-700 transition-all"
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // Setup mode: checklist phase (before importing starts)
  // -----------------------------------------------------------------------

  if (setupMode && !setupStarted) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-sage-100">
              <Settings className="w-5 h-5 text-sage-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-sage-900 font-display">
                Setup Mode
              </h1>
              <p className="text-sm text-sage-500">
                Select all the data you have available, then import each one by one
              </p>
            </div>
          </div>
        </div>

        {/* Cancel setup */}
        <div className="flex justify-end mb-4">
          <button
            onClick={resetSetupMode}
            className="text-sm text-sage-500 hover:text-sage-700 transition-colors"
          >
            Cancel setup
          </button>
        </div>

        {/* Grouped checklist */}
        <div className="space-y-4 mb-8">
          {DATA_TYPE_GROUPS.map((group) => (
            <div key={group.label} className="border border-sage-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-sage-50 border-b border-sage-200">
                <p className="text-xs font-semibold text-sage-600 uppercase tracking-wider">
                  {group.label}
                </p>
              </div>
              <div className="divide-y divide-sage-100">
                {group.types.map((type) => {
                  const typeMeta = DATA_TYPE_META[type]
                  const isChecked = setupTypes.find((t) => t.type === type)?.checked || false

                  return (
                    <label
                      key={type}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-sage-50/50 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          setSetupTypes((prev) => {
                            const existing = prev.find((t) => t.type === type)
                            if (existing) {
                              return prev.map((t) =>
                                t.type === type ? { ...t, checked: !t.checked } : t
                              )
                            }
                            return [
                              ...prev,
                              { type, checked: true, status: 'pending' as const },
                            ]
                          })
                        }}
                        className="w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
                      />
                      <typeMeta.icon className="w-4 h-4 text-sage-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-sage-700">{typeMeta.label}</p>
                        <p className="text-xs text-sage-400">{typeMeta.description}</p>
                      </div>
                      {WEDDING_REQUIRED_TYPES.includes(type) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-600">
                          per wedding
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Start button */}
        <div className="flex items-center justify-between pt-4 border-t border-sage-100">
          <p className="text-sm text-sage-500">
            {checkedSetupItems.length} data set{checkedSetupItems.length !== 1 ? 's' : ''} selected
          </p>
          <button
            onClick={() => {
              if (checkedSetupItems.length === 0) return
              setSetupStarted(true)
              setSetupCurrentIdx(0)
              setOverrideType(checkedSetupItems[0].type)
            }}
            disabled={checkedSetupItems.length === 0}
            className={cn(
              'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-all',
              checkedSetupItems.length > 0
                ? 'bg-sage-600 text-white hover:bg-sage-700 shadow-sm'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            )}
          >
            Start importing
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  // -----------------------------------------------------------------------
  // Setup mode: active importing phase (per-type)
  // -----------------------------------------------------------------------

  const setupProgressBar = setupMode && setupStarted && setupCurrentIdx >= 0 && setupCurrentIdx < checkedSetupItems.length

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-sage-100">
            <Sparkles className="w-5 h-5 text-sage-600" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-sage-900 font-display">
              Quick Add
            </h1>
            <p className="text-sm text-sage-500">
              Drop a file and the AI figures out what it is
            </p>
          </div>
        </div>
      </div>

      {/* Setup mode toggle (only show when not in setup mode and on upload step) */}
      {!setupMode && step === 'upload' && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => {
              setSetupMode(true)
              // Initialize setup types from all available types
              setSetupTypes(
                DATA_TYPE_GROUPS.flatMap((g) => g.types).map((type) => ({
                  type,
                  checked: false,
                  status: 'pending' as const,
                }))
              )
            }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-sage-200 text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            Setup Mode -- bulk import
          </button>
        </div>
      )}

      {/* Setup mode progress tracker */}
      {setupProgressBar && (
        <div className="mb-6 p-4 rounded-xl border border-sage-200 bg-sage-50/50">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-sage-700">
              Importing: {DATA_TYPE_META[checkedSetupItems[setupCurrentIdx].type].label}
            </p>
            <p className="text-xs text-sage-500">
              {setupCurrentIdx + 1} of {checkedSetupItems.length} data sets
            </p>
          </div>
          <div className="w-full bg-sage-200 rounded-full h-2">
            <div
              className="bg-sage-500 rounded-full h-2 transition-all"
              style={{ width: `${((setupCurrentIdx) / checkedSetupItems.length) * 100}%` }}
            />
          </div>
          <div className="flex gap-1 mt-2">
            {checkedSetupItems.map((item, idx) => {
              const typeMeta = DATA_TYPE_META[item.type]
              return (
                <div
                  key={item.type}
                  title={typeMeta.label}
                  className={cn(
                    'flex-1 h-1 rounded-full',
                    item.status === 'done' ? 'bg-green-400' :
                    item.status === 'skipped' ? 'bg-gray-300' :
                    idx === setupCurrentIdx ? 'bg-sage-500' :
                    'bg-sage-200'
                  )}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Step indicator (non-setup mode) */}
      {!setupProgressBar && <StepIndicator current={step} />}

      {/* ---- STEP: Upload ---- */}
      {step === 'upload' && (
        <div className="space-y-6">
          {/* Drop zone */}
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'relative border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all',
              dragActive
                ? 'border-sage-500 bg-sage-50 scale-[1.01]'
                : 'border-sage-200 bg-white hover:border-sage-300 hover:bg-sage-50/50'
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsb,.ods,.pdf,.jpg,.jpeg,.png,.webp,.json,.vcf,.docx"
              onChange={handleFileSelect}
              className="hidden"
            />

            <Upload
              className={cn(
                'w-10 h-10 mx-auto mb-4 transition-colors',
                dragActive ? 'text-sage-600' : 'text-sage-300'
              )}
            />

            <p className="text-lg font-medium text-sage-700 mb-1">
              {dragActive ? 'Drop it here' : setupMode ? `Upload ${DATA_TYPE_META[overrideType || 'unknown'].label} data` : 'Drop a file here'}
            </p>
            <p className="text-sm text-sage-400 mb-4">
              CSV, XLSX, PDF, JSON, VCF, DOCX, or image -- up to 10 MB
            </p>

            <div className="flex flex-wrap justify-center gap-2 text-xs text-sage-400">
              {setupMode && overrideType ? (
                <span className="px-2 py-1 rounded-full bg-sage-50 border border-sage-100">
                  {DATA_TYPE_META[overrideType].expects}
                </span>
              ) : (
                <>
                  <span className="px-2 py-1 rounded-full bg-sage-50 border border-sage-100">
                    Client lists
                  </span>
                  <span className="px-2 py-1 rounded-full bg-sage-50 border border-sage-100">
                    Guest lists
                  </span>
                  <span className="px-2 py-1 rounded-full bg-sage-50 border border-sage-100">
                    Invoices
                  </span>
                  <span className="px-2 py-1 rounded-full bg-sage-50 border border-sage-100">
                    Reviews
                  </span>
                  <span className="px-2 py-1 rounded-full bg-sage-50 border border-sage-100">
                    Campaigns
                  </span>
                  <span className="px-2 py-1 rounded-full bg-sage-50 border border-sage-100">
                    Social posts
                  </span>
                  <span className="px-2 py-1 rounded-full bg-sage-50 border border-sage-100">
                    + 17 more types
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Paste option */}
          <div className="text-center">
            <button
              onClick={() => setPasteMode(!pasteMode)}
              className="inline-flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700 transition-colors"
            >
              <ClipboardPaste className="w-4 h-4" />
              Or paste data directly
            </button>
          </div>

          {pasteMode && (
            <div className="space-y-3">
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste CSV data, tab-separated data, JSON array, or any structured text here..."
                className="w-full h-48 px-4 py-3 border border-sage-200 rounded-xl text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-sage-300 resize-y"
              />
              <div className="flex justify-end">
                <button
                  onClick={handlePasteSubmit}
                  disabled={!pastedText.trim()}
                  className={cn(
                    'px-6 py-2.5 rounded-lg text-sm font-medium transition-all',
                    pastedText.trim()
                      ? 'bg-sage-600 text-white hover:bg-sage-700'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  )}
                >
                  Analyze Data
                </button>
              </div>
            </div>
          )}

          {/* Setup mode: skip this type */}
          {setupMode && setupStarted && (
            <div className="text-center">
              <button
                onClick={setupSkipCurrent}
                className="text-sm text-sage-400 hover:text-sage-600 transition-colors"
              >
                Skip this data set
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---- STEP: Detecting ---- */}
      {step === 'detecting' && (
        <div className="text-center py-16">
          <Loader2 className="w-10 h-10 animate-spin text-sage-500 mx-auto mb-4" />
          <p className="text-lg font-medium text-sage-700 mb-1">
            Analyzing your data...
          </p>
          <p className="text-sm text-sage-400">
            {selectedFile
              ? `Reading ${selectedFile.name}`
              : 'Processing pasted data'}
          </p>
        </div>
      )}

      {/* ---- STEP: Preview ---- */}
      {step === 'preview' && detection && (
        <div className="space-y-6">
          {/* File warning (e.g., XLSX) */}
          {fileWarning && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-700">{fileWarning}</p>
            </div>
          )}

          {/* Detection result card */}
          <div
            className={cn(
              'p-6 rounded-xl border-2 transition-all',
              meta.color
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <meta.icon className="w-6 h-6 mt-0.5 shrink-0" />
                <div>
                  <p className="text-lg font-semibold">
                    This looks like a{' '}
                    <span className="underline decoration-2 underline-offset-2">
                      {meta.label}
                    </span>
                  </p>
                  <p className="text-sm opacity-75 mt-0.5">
                    {detection.description}
                  </p>
                  <p className="text-sm mt-1">
                    <span className="font-medium">{detection.rowCount}</span>{' '}
                    row{detection.rowCount !== 1 ? 's' : ''} detected
                    {detection.confidence < 0.7 && (
                      <span className="ml-2 text-amber-600">
                        (low confidence -- please verify)
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {/* Override type — grouped dropdown */}
              <div className="relative">
                <button
                  onClick={() => setShowTypeDropdown(!showTypeDropdown)}
                  className="text-xs px-3 py-1.5 rounded-lg border bg-white/80 hover:bg-white transition-colors flex items-center gap-1"
                >
                  Actually, this is...
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>

                {showTypeDropdown && (
                  <div className="absolute right-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-10 py-1 max-h-[400px] overflow-y-auto">
                    {DATA_TYPE_GROUPS.map((group) => (
                      <div key={group.label}>
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-sage-400 uppercase tracking-wider bg-sage-50/50">
                          {group.label}
                        </div>
                        {group.types.map((type) => {
                          const typeMeta = DATA_TYPE_META[type]
                          return (
                            <button
                              key={type}
                              onClick={() => {
                                setOverrideType(type)
                                setShowTypeDropdown(false)
                              }}
                              className={cn(
                                'w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2',
                                effectiveType === type && 'bg-sage-50 font-medium'
                              )}
                            >
                              <typeMeta.icon className="w-4 h-4 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <span className="block">{typeMeta.label}</span>
                                <span className="block text-[10px] text-sage-400 truncate">
                                  {typeMeta.description}
                                </span>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* "What does this type expect?" helper */}
          {meta.expects && (
            <button
              onClick={() => setShowExpects(!showExpects)}
              className="flex items-center gap-1.5 text-xs text-sage-400 hover:text-sage-600 transition-colors"
            >
              <Info className="w-3.5 h-3.5" />
              What columns does this type expect?
              <ChevronRight className={cn('w-3 h-3 transition-transform', showExpects && 'rotate-90')} />
            </button>
          )}
          {showExpects && meta.expects && (
            <div className="p-3 bg-sage-50 rounded-lg border border-sage-100">
              <p className="text-xs text-sage-600">{meta.expects}</p>
            </div>
          )}

          {/* File info */}
          {selectedFile && (
            <div className="flex items-center gap-2 text-sm text-sage-500">
              <FileIcon name={selectedFile.name} />
              <span>{selectedFile.name}</span>
              <span className="text-sage-300">
                ({(selectedFile.size / 1024).toFixed(1)} KB)
              </span>
            </div>
          )}

          {/* Wedding selector for types that need it */}
          {needsWedding && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl">
              <label className="block text-sm font-medium text-rose-700 mb-2">
                Which wedding is this {meta.label.toLowerCase()} for?
              </label>
              <select
                value={selectedWeddingId}
                onChange={(e) => setSelectedWeddingId(e.target.value)}
                className="w-full px-3 py-2 border border-rose-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-rose-300"
              >
                <option value="">Select a wedding...</option>
                {weddings.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Preview table */}
          {detection.preview.length > 0 && (
            <div className="border border-sage-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-sage-50 border-b border-sage-200">
                <p className="text-xs font-medium text-sage-600">
                  Data Preview (first {Math.min(detection.preview.length - 1, 5)} rows)
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-white">
                      {detection.preview[0]?.map((header, i) => (
                        <th
                          key={i}
                          className="px-3 py-2 text-left text-xs font-semibold text-sage-600 border-b border-sage-100 whitespace-nowrap"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detection.preview.slice(1).map((row, rowIdx) => (
                      <tr
                        key={rowIdx}
                        className={cn(
                          rowIdx % 2 === 0 ? 'bg-white' : 'bg-sage-50/30'
                        )}
                      >
                        {row.map((cell, cellIdx) => (
                          <td
                            key={cellIdx}
                            className="px-3 py-2 text-sage-700 border-b border-sage-50 whitespace-nowrap max-w-[200px] truncate"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Columns detected */}
          {detection.columns.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-sage-400 self-center mr-1">
                Columns:
              </span>
              {detection.columns.map((col, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 text-xs rounded-full bg-sage-50 border border-sage-100 text-sage-600"
                >
                  {col}
                </span>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-between pt-4 border-t border-sage-100">
            <button
              onClick={setupMode ? setupSkipCurrent : reset}
              className="flex items-center gap-2 px-4 py-2 text-sm text-sage-500 hover:text-sage-700 transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              {setupMode ? 'Skip this type' : 'Start over'}
            </button>

            <button
              onClick={handleImport}
              disabled={
                effectiveType === 'unknown' ||
                (needsWedding && !selectedWeddingId)
              }
              className={cn(
                'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-all',
                effectiveType !== 'unknown' &&
                  !(needsWedding && !selectedWeddingId)
                  ? 'bg-sage-600 text-white hover:bg-sage-700 shadow-sm'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              )}
            >
              Import as {meta.label}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ---- STEP: Importing ---- */}
      {step === 'importing' && (
        <div className="text-center py-16">
          <Loader2 className="w-10 h-10 animate-spin text-sage-500 mx-auto mb-4" />
          <p className="text-lg font-medium text-sage-700 mb-1">
            Importing {detection?.rowCount || 0} rows...
          </p>
          <p className="text-sm text-sage-400">
            Mapping columns and writing to database
          </p>
        </div>
      )}

      {/* ---- STEP: Done ---- */}
      {step === 'done' && importResult && (
        <div className="space-y-6">
          <div
            className={cn(
              'p-8 rounded-xl border-2 text-center',
              importResult.imported > 0
                ? 'border-green-200 bg-green-50'
                : 'border-amber-200 bg-amber-50'
            )}
          >
            {importResult.imported > 0 ? (
              <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
            ) : (
              <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
            )}

            <p className="text-xl font-semibold text-sage-800 mb-2">
              {importResult.details}
            </p>

            <div className="flex justify-center gap-6 text-sm">
              <div>
                <span className="font-semibold text-green-600">
                  {importResult.imported}
                </span>{' '}
                <span className="text-sage-500">imported</span>
              </div>
              {importResult.skipped > 0 && (
                <div>
                  <span className="font-semibold text-amber-600">
                    {importResult.skipped}
                  </span>{' '}
                  <span className="text-sage-500">skipped</span>
                </div>
              )}
            </div>
          </div>

          {/* Errors detail */}
          {importResult.errors.length > 0 && (
            <div className="border border-amber-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200">
                <p className="text-xs font-medium text-amber-700">
                  {importResult.errors.length} issue{importResult.errors.length !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="max-h-48 overflow-y-auto p-4 space-y-1">
                {importResult.errors.map((err, i) => (
                  <p key={i} className="text-xs text-amber-700">
                    {err}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-center gap-3 pt-4">
            {setupMode && setupStarted ? (
              <button
                onClick={setupAdvance}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium bg-sage-600 text-white hover:bg-sage-700 transition-all"
              >
                {setupCurrentIdx + 1 < checkedSetupItems.length ? (
                  <>
                    Next: {DATA_TYPE_META[checkedSetupItems[setupCurrentIdx + 1]?.type]?.label || 'Done'}
                    <ArrowRight className="w-4 h-4" />
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    Finish setup
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={reset}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium bg-sage-600 text-white hover:bg-sage-700 transition-all"
              >
                <Upload className="w-4 h-4" />
                Upload another file
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- STEP: Error ---- */}
      {step === 'error' && (
        <div className="space-y-6">
          <div className="p-8 rounded-xl border-2 border-red-200 bg-red-50 text-center">
            <XCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <p className="text-lg font-semibold text-red-700 mb-2">
              Something went wrong
            </p>
            <p className="text-sm text-red-600">{errorMessage}</p>
          </div>

          <div className="flex justify-center gap-3">
            <button
              onClick={reset}
              className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium bg-sage-600 text-white hover:bg-sage-700 transition-all"
            >
              <RotateCcw className="w-4 h-4" />
              Try again
            </button>
            {setupMode && setupStarted && (
              <button
                onClick={setupSkipCurrent}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium border border-sage-200 text-sage-600 hover:bg-sage-50 transition-all"
              >
                Skip this type
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
