'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  CheckSquare,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  Trash2,
  Eye,
  Edit2,
  Home,
  Users,
  Scissors,
  Palette,
  Clock,
  UserCheck,
  MoreHorizontal,
  ChevronDown,
  ChevronUp,
  Tag,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TemplateTask {
  id: string
  task_text: string
  category: string
  due_offset: string
  description: string
  is_custom: boolean
  included: boolean
}

interface ChecklistTemplate {
  tasks: TemplateTask[]
  custom_categories: string[]
}

// ---------------------------------------------------------------------------
// Default tasks — mirrors the couple checklist exactly
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORIES = [
  'Venue',
  'Vendors',
  'Attire & Beauty',
  'Decor',
  'Timeline',
  'Guests',
  'Other',
] as const

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Venue: Home,
  Vendors: Users,
  'Attire & Beauty': Scissors,
  Decor: Palette,
  Timeline: Clock,
  Guests: UserCheck,
  Other: MoreHorizontal,
}

const DUE_OFFSET_OPTIONS = [
  { value: '', label: 'No default' },
  { value: '12_months', label: '12 months before' },
  { value: '10_months', label: '10 months before' },
  { value: '8_months', label: '8 months before' },
  { value: '6_months', label: '6 months before' },
  { value: '4_months', label: '4 months before' },
  { value: '3_months', label: '3 months before' },
  { value: '2_months', label: '2 months before' },
  { value: '6_weeks', label: '6 weeks before' },
  { value: '1_month', label: '1 month before' },
  { value: '2_weeks', label: '2 weeks before' },
  { value: '1_week', label: '1 week before' },
  { value: '3_days', label: '3 days before' },
  { value: '1_day', label: '1 day before' },
  { value: 'day_of', label: 'Day of wedding' },
]

const DEFAULT_TASKS: Omit<TemplateTask, 'id'>[] = [
  // Venue
  { task_text: 'Set your budget', category: 'Venue', due_offset: '12_months', description: '', is_custom: false, included: true },
  { task_text: 'Complete alignment worksheets', category: 'Venue', due_offset: '10_months', description: '', is_custom: false, included: true },
  // Vendors
  { task_text: 'Book photographer', category: 'Vendors', due_offset: '10_months', description: '', is_custom: false, included: true },
  { task_text: 'Book videographer', category: 'Vendors', due_offset: '10_months', description: '', is_custom: false, included: true },
  { task_text: 'Book DJ or band', category: 'Vendors', due_offset: '8_months', description: '', is_custom: false, included: true },
  { task_text: 'Book hair & makeup', category: 'Vendors', due_offset: '8_months', description: '', is_custom: false, included: true },
  { task_text: 'Book officiant', category: 'Vendors', due_offset: '8_months', description: '', is_custom: false, included: true },
  { task_text: 'Hire florist', category: 'Vendors', due_offset: '6_months', description: '', is_custom: false, included: true },
  { task_text: 'Choose caterer and menu', category: 'Vendors', due_offset: '6_months', description: '', is_custom: false, included: true },
  { task_text: 'Schedule engagement photos', category: 'Vendors', due_offset: '8_months', description: '', is_custom: false, included: true },
  { task_text: 'Confirm with all vendors (times/locations)', category: 'Vendors', due_offset: '2_weeks', description: '', is_custom: false, included: true },
  // Attire & Beauty
  { task_text: 'Find wedding dress/attire', category: 'Attire & Beauty', due_offset: '10_months', description: '', is_custom: false, included: true },
  { task_text: 'Schedule alterations', category: 'Attire & Beauty', due_offset: '4_months', description: '', is_custom: false, included: true },
  { task_text: 'Coordinate wedding party attire', category: 'Attire & Beauty', due_offset: '6_months', description: '', is_custom: false, included: true },
  { task_text: 'Buy wedding rings', category: 'Attire & Beauty', due_offset: '4_months', description: '', is_custom: false, included: true },
  { task_text: 'Final dress fitting', category: 'Attire & Beauty', due_offset: '2_weeks', description: '', is_custom: false, included: true },
  // Decor
  { task_text: 'Plan big rentals', category: 'Decor', due_offset: '6_months', description: '', is_custom: false, included: true },
  { task_text: 'Arrange smaller rentals and decor', category: 'Decor', due_offset: '3_months', description: '', is_custom: false, included: true },
  { task_text: 'Pack decor items (labeled by area)', category: 'Decor', due_offset: '1_week', description: '', is_custom: false, included: true },
  // Timeline
  { task_text: 'Draft guest list', category: 'Timeline', due_offset: '10_months', description: '', is_custom: false, included: true },
  { task_text: 'Build day-of timeline', category: 'Timeline', due_offset: '2_months', description: '', is_custom: false, included: true },
  { task_text: 'Finalize detailed timeline with team', category: 'Timeline', due_offset: '2_weeks', description: '', is_custom: false, included: true },
  // Guests
  { task_text: 'Send save-the-dates', category: 'Guests', due_offset: '8_months', description: '', is_custom: false, included: true },
  { task_text: 'Create wedding website', category: 'Guests', due_offset: '8_months', description: '', is_custom: false, included: true },
  { task_text: 'Design invitations', category: 'Guests', due_offset: '4_months', description: '', is_custom: false, included: true },
  { task_text: 'Send invitations (2 months before)', category: 'Guests', due_offset: '2_months', description: '', is_custom: false, included: true },
  { task_text: 'Track RSVPs', category: 'Guests', due_offset: '6_weeks', description: '', is_custom: false, included: true },
  { task_text: 'Chase non-responders', category: 'Guests', due_offset: '1_month', description: '', is_custom: false, included: true },
  { task_text: 'Finalize guest count for caterer', category: 'Guests', due_offset: '2_weeks', description: '', is_custom: false, included: true },
  { task_text: 'Create seating chart', category: 'Guests', due_offset: '2_weeks', description: '', is_custom: false, included: true },
  { task_text: 'Reserve hotel room block', category: 'Guests', due_offset: '8_months', description: '', is_custom: false, included: true },
  // Other
  { task_text: 'Arrange transportation', category: 'Other', due_offset: '4_months', description: '', is_custom: false, included: true },
  { task_text: 'Plan rehearsal dinner', category: 'Other', due_offset: '3_months', description: '', is_custom: false, included: true },
  { task_text: 'Obtain marriage license', category: 'Other', due_offset: '1_month', description: '', is_custom: false, included: true },
  { task_text: 'Prepare tips and final payment envelopes', category: 'Other', due_offset: '1_week', description: '', is_custom: false, included: true },
  { task_text: 'Final vendor confirmations', category: 'Other', due_offset: '1_week', description: '', is_custom: false, included: true },
  { task_text: 'Prepare emergency kit', category: 'Other', due_offset: '1_week', description: '', is_custom: false, included: true },
  { task_text: 'Gather ceremony items', category: 'Other', due_offset: '3_days', description: '', is_custom: false, included: true },
  { task_text: 'Plan day-of meals', category: 'Other', due_offset: '2_weeks', description: '', is_custom: false, included: true },
  { task_text: 'Write vows', category: 'Other', due_offset: '1_month', description: '', is_custom: false, included: true },
]

function generateId(): string {
  return Math.random().toString(36).substring(2, 10)
}

function buildDefaultTemplate(): ChecklistTemplate {
  return {
    tasks: DEFAULT_TASKS.map((t) => ({ ...t, id: generateId() })),
    custom_categories: [],
  }
}

// ---------------------------------------------------------------------------
// Reusable components
// ---------------------------------------------------------------------------

function ConfigSection({
  title,
  icon: Icon,
  children,
  count,
  collapsible,
  defaultOpen,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  count?: number
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen ?? true)

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={collapsible ? () => setOpen(!open) : undefined}
        className={cn(
          'w-full px-6 py-4 border-b border-border flex items-center gap-3',
          collapsible && 'cursor-pointer hover:bg-sage-50/50 transition-colors'
        )}
      >
        <div className="w-9 h-9 rounded-lg bg-sage-100 flex items-center justify-center">
          <Icon className="w-5 h-5 text-sage-600" />
        </div>
        <h2 className="font-heading text-lg font-semibold text-sage-900 flex-1 text-left">
          {title}
        </h2>
        {count !== undefined && (
          <span className="text-xs text-sage-500 bg-sage-100 px-2 py-0.5 rounded-full">
            {count}
          </span>
        )}
        {collapsible && (
          open ? <ChevronUp className="w-4 h-4 text-sage-400" /> : <ChevronDown className="w-4 h-4 text-sage-400" />
        )}
      </button>
      {open && <div className="p-6 space-y-4">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Task Row (inline editing)
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  allCategories,
  onUpdate,
  onRemove,
}: {
  task: TemplateTask
  allCategories: string[]
  onUpdate: (updates: Partial<TemplateTask>) => void
  onRemove?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(task.task_text)
  const [editCategory, setEditCategory] = useState(task.category)
  const [editOffset, setEditOffset] = useState(task.due_offset)
  const [editDescription, setEditDescription] = useState(task.description)

  const saveEdit = () => {
    onUpdate({
      task_text: editText,
      category: editCategory,
      due_offset: editOffset,
      description: editDescription,
    })
    setEditing(false)
  }

  const cancelEdit = () => {
    setEditText(task.task_text)
    setEditCategory(task.category)
    setEditOffset(task.due_offset)
    setEditDescription(task.description)
    setEditing(false)
  }

  const offsetLabel = DUE_OFFSET_OPTIONS.find((o) => o.value === task.due_offset)?.label ?? ''

  if (editing) {
    return (
      <div className="bg-warm-white border border-sage-300 rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-sage-600 mb-1">Task Text</label>
            <input
              type="text"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-600 mb-1">Category</label>
            <select
              value={editCategory}
              onChange={(e) => setEditCategory(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            >
              {allCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-sage-600 mb-1">Due Date Offset</label>
            <select
              value={editOffset}
              onChange={(e) => setEditOffset(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            >
              {DUE_OFFSET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-sage-600 mb-1">Notes (optional)</label>
            <input
              type="text"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Extra info for the couple"
              className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={saveEdit}
            className="px-3 py-1.5 bg-sage-600 text-white rounded-lg text-xs font-medium hover:bg-sage-700 transition-colors"
          >
            Done
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            className="px-3 py-1.5 bg-sage-100 text-sage-700 rounded-lg text-xs font-medium hover:bg-sage-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 rounded-lg border transition-colors',
        task.included
          ? 'border-border bg-white'
          : 'border-border bg-gray-50 opacity-60'
      )}
    >
      {/* Include toggle */}
      <button
        type="button"
        onClick={() => onUpdate({ included: !task.included })}
        className={cn(
          'w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors',
          task.included
            ? 'bg-sage-500 border-sage-500 text-white'
            : 'bg-white border-sage-300'
        )}
      >
        {task.included && <CheckCircle className="w-3.5 h-3.5" />}
      </button>

      {/* Task info */}
      <div className="flex-1 min-w-0">
        <span className={cn('text-sm text-sage-800', !task.included && 'line-through text-sage-400')}>
          {task.task_text}
        </span>
        <div className="flex items-center gap-2 mt-0.5">
          {offsetLabel && (
            <span className="text-[10px] text-sage-500">{offsetLabel}</span>
          )}
          {task.is_custom && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gold-100 text-gold-700 font-medium">
              Custom
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="p-1.5 rounded-md hover:bg-sage-100 text-sage-400 hover:text-sage-600 transition-colors shrink-0"
        title="Edit task"
      >
        <Edit2 className="w-3.5 h-3.5" />
      </button>
      {(task.is_custom || onRemove) && (
        <button
          type="button"
          onClick={onRemove}
          className="p-1.5 rounded-md hover:bg-red-50 text-sage-400 hover:text-red-500 transition-colors shrink-0"
          title="Remove task"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Custom Task Form
// ---------------------------------------------------------------------------

function AddTaskForm({
  allCategories,
  onAdd,
}: {
  allCategories: string[]
  onAdd: (task: TemplateTask) => void
}) {
  const [text, setText] = useState('')
  const [category, setCategory] = useState(allCategories[0] ?? 'Other')
  const [offset, setOffset] = useState('')
  const [description, setDescription] = useState('')

  const handleAdd = () => {
    if (!text.trim()) return
    onAdd({
      id: generateId(),
      task_text: text.trim(),
      category,
      due_offset: offset,
      description: description.trim(),
      is_custom: true,
      included: true,
    })
    setText('')
    setDescription('')
    setOffset('')
  }

  return (
    <div className="bg-warm-white border border-border rounded-lg p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-sage-600 mb-1">Task Text</label>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd() } }}
            placeholder="e.g., Submit floor plan to venue"
            className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-sage-600 mb-1">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
          >
            {allCategories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-sage-600 mb-1">Due Offset</label>
          <select
            value={offset}
            onChange={(e) => setOffset(e.target.value)}
            className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
          >
            {DUE_OFFSET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-sage-600 mb-1">Notes (optional)</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Additional instructions"
            className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
          />
        </div>
      </div>
      <button
        type="button"
        onClick={handleAdd}
        disabled={!text.trim()}
        className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus className="w-4 h-4" />
        Add Task
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview Panel
// ---------------------------------------------------------------------------

function PreviewPanel({ tasks, allCategories }: { tasks: TemplateTask[]; allCategories: string[] }) {
  const included = tasks.filter((t) => t.included)
  const grouped = useMemo(() => {
    const g: Record<string, TemplateTask[]> = {}
    for (const t of included) {
      if (!g[t.category]) g[t.category] = []
      g[t.category].push(t)
    }
    return g
  }, [included])

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Eye className="w-4 h-4 text-teal-500" />
        <h3 className="text-sm font-semibold text-sage-900">Couple Preview</h3>
        <span className="text-xs text-sage-500">
          ({included.length} tasks across {Object.keys(grouped).length} categories)
        </span>
      </div>
      {included.length === 0 ? (
        <p className="text-xs text-sage-400 italic">
          No tasks included. Couples will see an empty checklist.
        </p>
      ) : (
        <div className="space-y-3">
          {allCategories.map((cat) => {
            const catTasks = grouped[cat]
            if (!catTasks || catTasks.length === 0) return null
            const CatIcon = CATEGORY_ICONS[cat] ?? MoreHorizontal
            return (
              <div key={cat}>
                <div className="flex items-center gap-1.5 mb-1">
                  <CatIcon className="w-3 h-3 text-sage-500" />
                  <span className="text-xs font-semibold text-sage-600">{cat}</span>
                  <span className="text-[10px] text-sage-400">({catTasks.length})</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {catTasks.map((t) => (
                    <span
                      key={t.id}
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border',
                        t.is_custom
                          ? 'bg-gold-50 text-gold-700 border-gold-200'
                          : 'bg-sage-50 text-sage-700 border-sage-200'
                      )}
                    >
                      {t.task_text}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ChecklistConfigPage() {
  const VENUE_ID = useVenueId()
  const [template, setTemplate] = useState<ChecklistTemplate>(buildDefaultTemplate)
  const [originalTemplate, setOriginalTemplate] = useState<ChecklistTemplate>(buildDefaultTemplate)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newCategoryInput, setNewCategoryInput] = useState('')

  const allCategories = useMemo(() => {
    const cats = [...DEFAULT_CATEGORIES, ...template.custom_categories]
    // Also include any categories from existing tasks that aren't in the list
    for (const t of template.tasks) {
      if (!cats.includes(t.category)) cats.push(t.category)
    }
    return cats
  }, [template.custom_categories, template.tasks])

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
        const ct = flags.checklist_template as ChecklistTemplate | undefined
        if (ct && Array.isArray(ct.tasks) && ct.tasks.length > 0) {
          setTemplate(ct)
          setOriginalTemplate(ct)
        }
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch checklist config:', err)
      setError('Failed to load checklist template')
    } finally {
      setLoading(false)
    }
  }, [VENUE_ID])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const hasChanges = JSON.stringify(template) !== JSON.stringify(originalTemplate)

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
      flags.checklist_template = template

      const { error: updateErr } = await supabase
        .from('venue_config')
        .update({
          feature_flags: flags,
          updated_at: new Date().toISOString(),
        })
        .eq('venue_id', VENUE_ID)

      if (updateErr) throw updateErr

      setOriginalTemplate({ ...template, tasks: template.tasks.map((t) => ({ ...t })) })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Save failed:', err)
      setError('Failed to save checklist template')
    } finally {
      setSaving(false)
    }
  }

  const updateTask = (taskId: string, updates: Partial<TemplateTask>) => {
    setTemplate((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
    }))
    setSaved(false)
  }

  const removeTask = (taskId: string) => {
    setTemplate((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((t) => t.id !== taskId),
    }))
    setSaved(false)
  }

  const addTask = (task: TemplateTask) => {
    setTemplate((prev) => ({
      ...prev,
      tasks: [...prev.tasks, task],
    }))
    setSaved(false)
  }

  const addCustomCategory = () => {
    const trimmed = newCategoryInput.trim()
    if (trimmed && !allCategories.includes(trimmed)) {
      setTemplate((prev) => ({
        ...prev,
        custom_categories: [...prev.custom_categories, trimmed],
      }))
      setNewCategoryInput('')
      setSaved(false)
    }
  }

  const removeCustomCategory = (cat: string) => {
    setTemplate((prev) => ({
      ...prev,
      custom_categories: prev.custom_categories.filter((c) => c !== cat),
    }))
    setSaved(false)
  }

  // Group tasks by category
  const tasksByCategory = useMemo(() => {
    const grouped: Record<string, TemplateTask[]> = {}
    for (const t of template.tasks) {
      if (!grouped[t.category]) grouped[t.category] = []
      grouped[t.category].push(t)
    }
    return grouped
  }, [template.tasks])

  const includedCount = template.tasks.filter((t) => t.included).length
  const totalCount = template.tasks.length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Checklist Templates
          </h1>
          <p className="text-sage-600">
            Create and manage the default wedding planning checklist that couples see on their portal. Add, reorder, or customize items — each couple gets their own copy they can check off.{' '}
            <span className="text-sage-500">
              {includedCount}/{totalCount} tasks included
            </span>
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
                <div className="h-10 w-full bg-sage-50 rounded" />
                <div className="h-10 w-full bg-sage-50 rounded" />
                <div className="h-10 w-full bg-sage-50 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Preview */}
          <PreviewPanel tasks={template.tasks} allCategories={allCategories} />

          {/* Categories */}
          <ConfigSection title="Categories" icon={Tag} count={allCategories.length}>
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_CATEGORIES.map((cat) => {
                const CatIcon = CATEGORY_ICONS[cat] ?? MoreHorizontal
                return (
                  <span
                    key={cat}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-sage-100 text-sage-700 border border-sage-200"
                  >
                    <CatIcon className="w-3 h-3" />
                    {cat}
                  </span>
                )
              })}
              {template.custom_categories.map((cat) => (
                <span
                  key={cat}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gold-50 text-gold-700 border border-gold-200"
                >
                  {cat}
                  <button
                    type="button"
                    onClick={() => removeCustomCategory(cat)}
                    className="hover:text-red-600 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <input
                type="text"
                value={newCategoryInput}
                onChange={(e) => setNewCategoryInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomCategory() } }}
                placeholder="Add custom category..."
                className="flex-1 px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
              />
              <button
                type="button"
                onClick={addCustomCategory}
                disabled={!newCategoryInput.trim()}
                className="px-3 py-2 bg-sage-100 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </ConfigSection>

          {/* Tasks by category */}
          {allCategories.map((cat) => {
            const catTasks = tasksByCategory[cat]
            if (!catTasks || catTasks.length === 0) return null
            const CatIcon = CATEGORY_ICONS[cat] ?? MoreHorizontal
            const includedInCat = catTasks.filter((t) => t.included).length
            return (
              <ConfigSection
                key={cat}
                title={cat}
                icon={CatIcon}
                count={includedInCat}
                collapsible
                defaultOpen
              >
                <div className="space-y-1.5">
                  {catTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      allCategories={allCategories}
                      onUpdate={(updates) => updateTask(task.id, updates)}
                      onRemove={task.is_custom ? () => removeTask(task.id) : undefined}
                    />
                  ))}
                </div>
              </ConfigSection>
            )
          })}

          {/* Add Custom Task */}
          <ConfigSection title="Add Custom Task" icon={Plus}>
            <p className="text-sm text-sage-600 mb-3">
              Add venue-specific tasks to the default checklist.
            </p>
            <AddTaskForm
              allCategories={allCategories}
              onAdd={addTask}
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
