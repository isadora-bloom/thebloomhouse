'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  CheckSquare,
  Plus,
  X,
  Edit2,
  Trash2,
  Calendar,
  Tag,
  Square,
  CheckCircle,
  AlertTriangle,
  Search,
  ChevronDown,
  ChevronUp,
  StickyNote,
  Filter,
  Eye,
  EyeOff,
  Home,
  Users,
  Scissors,
  Palette,
  Clock,
  UserCheck,
  MoreHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChecklistItem {
  id: string
  title: string
  category: string
  due_date: string | null
  is_completed: boolean
  completed_at: string | null
  description: string | null
  sort_order: number
}

interface ChecklistFormData {
  title: string
  category: string
  due_date: string
  description: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  'Venue',
  'Vendors',
  'Attire & Beauty',
  'Decor',
  'Timeline',
  'Guests',
  'Other',
] as const

type Category = (typeof CATEGORIES)[number]

const CATEGORY_ICONS: Record<Category, React.ReactNode> = {
  Venue: <Home className="w-4 h-4" />,
  Vendors: <Users className="w-4 h-4" />,
  'Attire & Beauty': <Scissors className="w-4 h-4" />,
  Decor: <Palette className="w-4 h-4" />,
  Timeline: <Clock className="w-4 h-4" />,
  Guests: <UserCheck className="w-4 h-4" />,
  Other: <MoreHorizontal className="w-4 h-4" />,
}

const DEFAULT_TASKS: { title: string; category: Category; sort_order: number }[] = [
  // Venue (1-2)
  { title: 'Set your budget', category: 'Venue', sort_order: 1 },
  { title: 'Complete alignment worksheets', category: 'Venue', sort_order: 2 },
  // Vendors (3-13)
  { title: 'Book photographer', category: 'Vendors', sort_order: 3 },
  { title: 'Book videographer', category: 'Vendors', sort_order: 4 },
  { title: 'Book DJ or band', category: 'Vendors', sort_order: 5 },
  { title: 'Book hair & makeup', category: 'Vendors', sort_order: 6 },
  { title: 'Book officiant', category: 'Vendors', sort_order: 7 },
  { title: 'Hire florist', category: 'Vendors', sort_order: 8 },
  { title: 'Choose caterer and menu', category: 'Vendors', sort_order: 9 },
  { title: 'Schedule engagement photos', category: 'Vendors', sort_order: 10 },
  { title: 'Confirm with all vendors (times/locations)', category: 'Vendors', sort_order: 11 },
  // Attire & Beauty (12-16)
  { title: 'Find wedding dress/attire', category: 'Attire & Beauty', sort_order: 12 },
  { title: 'Schedule alterations', category: 'Attire & Beauty', sort_order: 13 },
  { title: 'Coordinate wedding party attire', category: 'Attire & Beauty', sort_order: 14 },
  { title: 'Buy wedding rings', category: 'Attire & Beauty', sort_order: 15 },
  { title: 'Final dress fitting', category: 'Attire & Beauty', sort_order: 16 },
  // Decor (17-19)
  { title: 'Plan big rentals', category: 'Decor', sort_order: 17 },
  { title: 'Arrange smaller rentals and decor', category: 'Decor', sort_order: 18 },
  { title: 'Pack decor items (labeled by area)', category: 'Decor', sort_order: 19 },
  // Timeline (20-22)
  { title: 'Draft guest list', category: 'Timeline', sort_order: 20 },
  { title: 'Build day-of timeline', category: 'Timeline', sort_order: 21 },
  { title: 'Finalize detailed timeline with team', category: 'Timeline', sort_order: 22 },
  // Guests (23-31)
  { title: 'Send save-the-dates', category: 'Guests', sort_order: 23 },
  { title: 'Create wedding website', category: 'Guests', sort_order: 24 },
  { title: 'Design invitations', category: 'Guests', sort_order: 25 },
  { title: 'Send invitations (2 months before)', category: 'Guests', sort_order: 26 },
  { title: 'Track RSVPs', category: 'Guests', sort_order: 27 },
  { title: 'Chase non-responders', category: 'Guests', sort_order: 28 },
  { title: 'Finalize guest count for caterer', category: 'Guests', sort_order: 29 },
  { title: 'Create seating chart', category: 'Guests', sort_order: 30 },
  { title: 'Reserve hotel room block', category: 'Guests', sort_order: 31 },
  // Other (32-41)
  { title: 'Arrange transportation', category: 'Other', sort_order: 32 },
  { title: 'Plan rehearsal dinner', category: 'Other', sort_order: 33 },
  { title: 'Obtain marriage license', category: 'Other', sort_order: 34 },
  { title: 'Prepare tips and final payment envelopes', category: 'Other', sort_order: 35 },
  { title: 'Final vendor confirmations', category: 'Other', sort_order: 36 },
  { title: 'Prepare emergency kit', category: 'Other', sort_order: 37 },
  { title: 'Gather ceremony items', category: 'Other', sort_order: 38 },
  { title: 'Plan day-of meals', category: 'Other', sort_order: 39 },
  { title: 'Write vows', category: 'Other', sort_order: 40 },
]

const EMPTY_FORM: ChecklistFormData = {
  title: '',
  category: '',
  due_date: '',
  description: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOverdue(item: ChecklistItem): boolean {
  if (item.is_completed || !item.due_date) return false
  const due = new Date(item.due_date + 'T23:59:59')
  return due < new Date()
}

function formatDueDate(dateStr: string | null): { text: string; color: string } {
  if (!dateStr) return { text: '', color: '' }
  const due = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const diffMs = due.getTime() - now.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 0) {
    return { text: `${Math.abs(diffDays)}d overdue`, color: 'text-red-600 bg-red-50' }
  }
  if (diffDays === 0) {
    return { text: 'Due today', color: 'text-amber-700 bg-amber-50' }
  }
  if (diffDays === 1) {
    return { text: 'Tomorrow', color: 'text-amber-600 bg-amber-50' }
  }
  if (diffDays <= 7) {
    return { text: `in ${diffDays} days`, color: 'text-blue-600 bg-blue-50' }
  }
  if (diffDays <= 14) {
    return { text: `in ${Math.floor(diffDays / 7)} week${diffDays >= 14 ? 's' : ''}`, color: 'text-gray-500 bg-gray-50' }
  }
  const formatted = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return { text: formatted, color: 'text-gray-500 bg-gray-50' }
}

// ---------------------------------------------------------------------------
// Checklist Page
// ---------------------------------------------------------------------------

export default function ChecklistPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ChecklistFormData>(EMPTY_FORM)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [hideCompleted, setHideCompleted] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set())
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [savingNote, setSavingNote] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)

  const supabase = createClient()

  // ---- Seed default tasks if none exist ----
  // First checks venue_config.feature_flags.checklist_template for venue-specific tasks,
  // falls back to hardcoded DEFAULT_TASKS if no template configured.
  const seedDefaults = useCallback(async () => {
    // Try to load venue-specific checklist template
    const { data: configData } = await supabase
      .from('venue_config')
      .select('feature_flags')
      .eq('venue_id', venueId)
      .maybeSingle()

    const flags = (configData?.feature_flags ?? {}) as Record<string, unknown>
    const template = flags.checklist_template as { tasks?: { title?: string; task_text?: string; category: string; included?: boolean }[] } | undefined

    // Use venue template tasks (only included ones) if available, otherwise hardcoded defaults
    const tasksToSeed = template?.tasks?.filter(t => t.included !== false)

    const rows = tasksToSeed && tasksToSeed.length > 0
      ? tasksToSeed.map((t, i) => ({
          venue_id: venueId,
          wedding_id: weddingId,
          title: t.title || t.task_text || '',
          category: t.category,
          is_completed: false,
          sort_order: i + 1,
          description: null,
        }))
      : DEFAULT_TASKS.map((t) => ({
          venue_id: venueId,
          wedding_id: weddingId,
          title: t.title,
          category: t.category,
          is_completed: false,
          sort_order: t.sort_order,
          description: null,
        }))

    await supabase.from('checklist_items').insert(rows)
  }, [supabase])

  // ---- Fetch ----
  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from('checklist_items')
      .select('*')
      .eq('wedding_id', weddingId)
      .order('sort_order', { ascending: true })

    if (!error && data) {
      if (data.length === 0 && !initialized) {
        setInitialized(true)
        await seedDefaults()
        const { data: seeded } = await supabase
          .from('checklist_items')
          .select('*')
          .eq('wedding_id', weddingId)
          .order('sort_order', { ascending: true })
        if (seeded) setItems(seeded as ChecklistItem[])
      } else {
        setItems(data as ChecklistItem[])
      }
    }
    setLoading(false)
  }, [supabase, initialized, seedDefaults])

  useEffect(() => {
    fetchItems()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Computed ----
  const totalItems = items.length
  const completedItems = items.filter((i) => i.is_completed).length
  const overdueItems = items.filter((i) => isOverdue(i)).length
  const progressPercent = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0

  // ---- Filtering ----
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (hideCompleted && item.is_completed) return false
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        if (
          !item.title.toLowerCase().includes(q) &&
          !(item.description || '').toLowerCase().includes(q) &&
          !item.category.toLowerCase().includes(q)
        ) {
          return false
        }
      }
      return true
    })
  }, [items, hideCompleted, categoryFilter, searchQuery])

  // ---- Group by category ----
  const groupedItems = useMemo(() => {
    const groups: Record<string, ChecklistItem[]> = {}
    for (const cat of CATEGORIES) {
      groups[cat] = []
    }
    for (const item of filteredItems) {
      const cat = item.category || 'Other'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(item)
    }
    // Remove empty groups
    return Object.entries(groups).filter(([, items]) => items.length > 0)
  }, [filteredItems])

  // ---- Toggle completion ----
  async function toggleComplete(item: ChecklistItem) {
    const newCompleted = !item.is_completed
    const update = {
      is_completed: newCompleted,
      completed_at: newCompleted ? new Date().toISOString() : null,
      completed_via: newCompleted ? ('manual' as const) : null,
    }

    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, ...update } : i))
    )

    await supabase.from('checklist_items').update(update).eq('id', item.id)
  }

  // ---- Notes ----
  function toggleNotes(id: string) {
    setExpandedNotes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        const item = items.find((i) => i.id === id)
        setNoteDrafts((d) => ({ ...d, [id]: item?.description || '' }))
      }
      return next
    })
  }

  async function saveNote(id: string) {
    setSavingNote(id)
    const note = noteDrafts[id]?.trim() || null
    await supabase.from('checklist_items').update({ description: note }).eq('id', id)
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, description: note } : i))
    )
    setSavingNote(null)
  }

  // ---- Modal helpers ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(item: ChecklistItem) {
    setForm({
      title: item.title,
      category: item.category || '',
      due_date: item.due_date || '',
      description: item.description || '',
    })
    setEditingId(item.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.title.trim()) return

    const payload = {
      venue_id: venueId,
      wedding_id: weddingId,
      title: form.title.trim(),
      category: form.category || 'Other',
      due_date: form.due_date || null,
      description: form.description.trim() || null,
      sort_order: editingId
        ? items.find((i) => i.id === editingId)?.sort_order || 100
        : items.length + 1,
    }

    if (editingId) {
      await supabase.from('checklist_items').update(payload).eq('id', editingId)
    } else {
      await supabase.from('checklist_items').insert(payload)
    }

    setShowModal(false)
    setEditingId(null)
    fetchItems()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this task?')) return
    await supabase.from('checklist_items').delete().eq('id', id)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  async function handleSetDueDate(id: string, date: string) {
    await supabase
      .from('checklist_items')
      .update({ due_date: date || null })
      .eq('id', id)
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, due_date: date || null } : i))
    )
  }

  // ---- Unique categories in data (for filter dropdown) ----
  const activeCategories = useMemo(() => {
    const cats = new Set(items.map((i) => i.category))
    return [...CATEGORIES].filter((c) => cats.has(c))
  }, [items])

  // ---- Render ----
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Checklist
          </h1>
          <p className="text-gray-500 text-sm">
            {completedItems} of {totalItems} tasks complete
          </p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Task
        </button>
      </div>

      {/* Progress Header */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">Overall Progress</span>
          <span className="text-sm font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {progressPercent}%
          </span>
        </div>
        <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${progressPercent}%`, backgroundColor: 'var(--couple-primary)' }}
          />
        </div>
        <div className="flex items-center justify-between mt-2 text-xs text-gray-400">
          <span>{completedItems} completed</span>
          <div className="flex items-center gap-4">
            <span>{totalItems - completedItems} remaining</span>
            {overdueItems > 0 && (
              <span className="text-red-500 font-medium">{overdueItems} overdue</span>
            )}
          </div>
        </div>
      </div>

      {/* Overdue Alert */}
      {overdueItems > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
          <span>
            <span className="font-semibold">{overdueItems}</span>{' '}
            task{overdueItems > 1 ? 's' : ''} overdue — stay on top of your planning!
          </span>
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Category Dropdown */}
        <div className="relative">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="appearance-none pl-8 pr-8 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          >
            <option value="all">All Categories</option>
            {activeCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>

        {/* Hide/Show Completed Toggle */}
        <button
          onClick={() => setHideCompleted(!hideCompleted)}
          className={cn(
            'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors',
            hideCompleted
              ? 'border-gray-300 bg-gray-50 text-gray-700'
              : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
          )}
        >
          {hideCompleted ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {hideCompleted ? 'Show completed' : 'Hide completed'}
        </button>
      </div>

      {/* Task Groups */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="animate-pulse h-16 bg-gray-100 rounded-xl" />
          ))}
        </div>
      ) : groupedItems.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <CheckSquare className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {searchQuery ? 'No matching tasks' : hideCompleted ? 'All caught up!' : 'No tasks yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {searchQuery
              ? 'Try a different search.'
              : hideCompleted
                ? 'All your remaining tasks are done. Toggle to see completed.'
                : 'Add your first task to start planning.'}
          </p>
          {!searchQuery && !hideCompleted && (
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add First Task
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {groupedItems.map(([category, categoryItems]) => (
            <div key={category}>
              {/* Category Header */}
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-white"
                  style={{ backgroundColor: 'var(--couple-primary)' }}
                >
                  {CATEGORY_ICONS[category as Category] || <Tag className="w-4 h-4" />}
                </span>
                <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                  {category}
                </h2>
                <span className="text-xs text-gray-400">
                  {categoryItems.filter((i) => i.is_completed).length}/{categoryItems.length}
                </span>
              </div>

              {/* Tasks */}
              <div className="space-y-2">
                {categoryItems.map((item) => {
                  const overdue = isOverdue(item)
                  const dueInfo = formatDueDate(item.due_date)
                  const notesExpanded = expandedNotes.has(item.id)
                  const hasNotes = !!item.description

                  return (
                    <div key={item.id}>
                      <div
                        className={cn(
                          'bg-white rounded-xl border shadow-sm p-4 flex items-start gap-3 group transition-all',
                          overdue ? 'border-red-200 bg-red-50/30' : 'border-gray-100',
                          item.is_completed && 'opacity-60'
                        )}
                      >
                        {/* Checkbox */}
                        <button
                          onClick={() => toggleComplete(item)}
                          className="shrink-0 mt-0.5 transition-colors"
                          style={{ color: item.is_completed ? 'var(--couple-primary)' : '#D1D5DB' }}
                        >
                          {item.is_completed ? (
                            <CheckCircle className="w-5 h-5" />
                          ) : (
                            <Square className="w-5 h-5 hover:text-gray-400" />
                          )}
                        </button>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p
                                className={cn(
                                  'text-sm font-medium',
                                  item.is_completed ? 'line-through text-gray-400' : 'text-gray-800'
                                )}
                              >
                                {item.title}
                              </p>

                              {/* Badges row */}
                              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                                {/* Due date badge */}
                                {dueInfo.text && (
                                  <span
                                    className={cn(
                                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                                      dueInfo.color
                                    )}
                                  >
                                    <Calendar className="w-3 h-3" />
                                    {dueInfo.text}
                                  </span>
                                )}

                                {/* Notes indicator */}
                                {hasNotes && !notesExpanded && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-gray-400">
                                    <StickyNote className="w-3 h-3" />
                                    note
                                  </span>
                                )}

                                {/* Inline due date picker for tasks without one */}
                                {!item.due_date && !item.is_completed && (
                                  <input
                                    type="date"
                                    className="text-[11px] text-gray-400 border-0 bg-transparent p-0 focus:outline-none focus:ring-0 cursor-pointer"
                                    onChange={(e) => handleSetDueDate(item.id, e.target.value)}
                                    title="Set due date"
                                  />
                                )}
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button
                                onClick={() => toggleNotes(item.id)}
                                className={cn(
                                  'p-1.5 rounded-md transition-colors',
                                  notesExpanded
                                    ? 'text-amber-600 bg-amber-50'
                                    : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                                )}
                                title="Notes"
                              >
                                <StickyNote className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => openEdit(item)}
                                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDelete(item.id)}
                                className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Expanded Notes */}
                      {notesExpanded && (
                        <div className="ml-8 mt-1 mb-2 p-3 bg-amber-50/50 border border-amber-100 rounded-lg">
                          <textarea
                            value={noteDrafts[item.id] ?? item.description ?? ''}
                            onChange={(e) =>
                              setNoteDrafts((d) => ({ ...d, [item.id]: e.target.value }))
                            }
                            placeholder="Add a note..."
                            rows={2}
                            className="w-full text-sm bg-transparent border-0 resize-none focus:outline-none focus:ring-0 text-gray-700 placeholder:text-gray-400"
                          />
                          <div className="flex justify-end gap-2 mt-1">
                            <button
                              onClick={() => toggleNotes(item.id)}
                              className="text-xs text-gray-400 hover:text-gray-600"
                            >
                              Close
                            </button>
                            <button
                              onClick={() => saveNote(item.id)}
                              disabled={savingNote === item.id}
                              className="text-xs font-medium px-2 py-1 rounded text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                              style={{ backgroundColor: 'var(--couple-primary)' }}
                            >
                              {savingNote === item.id ? 'Saving...' : 'Save Note'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingId ? 'Edit Task' : 'Add Custom Task'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Task Text */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Task</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Book rehearsal dinner venue"
                  autoFocus
                />
              </div>

              {/* Category + Due Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Tag className="w-3.5 h-3.5 inline mr-1" />
                    Category
                  </label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    <option value="">Select...</option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Calendar className="w-3.5 h-3.5 inline mr-1" />
                    Due Date
                  </label>
                  <input
                    type="date"
                    value={form.due_date}
                    onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <StickyNote className="w-3.5 h-3.5 inline mr-1" />
                  Notes
                </label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Optional notes..."
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!form.title.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Task'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
