'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChecklistItem {
  id: string
  title: string
  description: string | null
  due_date: string | null
  category: string | null
  is_completed: boolean
  completed_at: string | null
  sort_order: number | null
}

interface ChecklistFormData {
  title: string
  description: string
  due_date: string
  category: string
}

type FilterMode = 'all' | 'todo' | 'completed' | 'overdue'

const CATEGORIES = [
  'Venue',
  'Vendors',
  'Attire',
  'Invitations',
  'Decor',
  'Florals',
  'Music',
  'Photography',
  'Catering',
  'Legal',
  'Travel',
  'Other',
]

const EMPTY_FORM: ChecklistFormData = {
  title: '',
  description: '',
  due_date: '',
  category: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOverdue(item: ChecklistItem): boolean {
  if (item.is_completed || !item.due_date) return false
  const due = new Date(item.due_date + 'T23:59:59')
  return due < new Date()
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function daysUntilDue(dateStr: string | null): string {
  if (!dateStr) return ''
  const due = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const diff = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  if (diff < 0) return `${Math.abs(diff)}d overdue`
  if (diff === 0) return 'Due today'
  if (diff === 1) return 'Due tomorrow'
  if (diff <= 7) return `${diff} days left`
  return ''
}

// ---------------------------------------------------------------------------
// Checklist Page
// ---------------------------------------------------------------------------

export default function ChecklistPage() {
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ChecklistFormData>(EMPTY_FORM)
  const [filter, setFilter] = useState<FilterMode>('all')

  const supabase = createClient()

  // ---- Fetch ----
  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from('checklist_items')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('is_completed', { ascending: true })
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('sort_order', { ascending: true })

    if (!error && data) {
      setItems(data as ChecklistItem[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  // ---- Computed ----
  const totalItems = items.length
  const completedItems = items.filter((i) => i.is_completed).length
  const overdueItems = items.filter((i) => isOverdue(i)).length
  const progressPercent = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0

  // ---- Filter ----
  const filteredItems = items.filter((item) => {
    switch (filter) {
      case 'todo':
        return !item.is_completed
      case 'completed':
        return item.is_completed
      case 'overdue':
        return isOverdue(item)
      default:
        return true
    }
  })

  // ---- Toggle completion ----
  async function toggleComplete(item: ChecklistItem) {
    const newCompleted = !item.is_completed
    await supabase
      .from('checklist_items')
      .update({
        is_completed: newCompleted,
        completed_at: newCompleted ? new Date().toISOString() : null,
      })
      .eq('id', item.id)

    // Optimistic update
    setItems((prev) =>
      prev.map((i) =>
        i.id === item.id
          ? { ...i, is_completed: newCompleted, completed_at: newCompleted ? new Date().toISOString() : null }
          : i
      )
    )
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
      description: item.description || '',
      due_date: item.due_date || '',
      category: item.category || '',
    })
    setEditingId(item.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.title.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      title: form.title.trim(),
      description: form.description.trim() || null,
      due_date: form.due_date || null,
      category: form.category || null,
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
    if (!confirm('Remove this checklist item?')) return
    await supabase.from('checklist_items').delete().eq('id', id)
    fetchItems()
  }

  const filters: { key: FilterMode; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: totalItems },
    { key: 'todo', label: 'To Do', count: totalItems - completedItems },
    { key: 'completed', label: 'Completed', count: completedItems },
    { key: 'overdue', label: 'Overdue', count: overdueItems },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Checklist
            <span className="ml-2 text-lg font-normal text-gray-400">
              ({completedItems} of {totalItems})
            </span>
          </h1>
          <p className="text-gray-500 text-sm">Stay on track with your wedding planning tasks.</p>
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

      {/* Progress Bar */}
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
            style={{
              width: `${progressPercent}%`,
              backgroundColor: 'var(--couple-primary)',
            }}
          />
        </div>
        <div className="flex items-center justify-between mt-2 text-xs text-gray-400">
          <span>{completedItems} completed</span>
          <span>{totalItems - completedItems} remaining</span>
        </div>
      </div>

      {/* Overdue Alert */}
      {overdueItems > 0 && filter !== 'overdue' && (
        <button
          onClick={() => setFilter('overdue')}
          className="w-full flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-100 rounded-xl text-sm text-red-700 hover:bg-red-100 transition-colors"
        >
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
          <span>
            <span className="font-semibold">{overdueItems} task{overdueItems > 1 ? 's' : ''}</span> overdue. Tap to view.
          </span>
        </button>
      )}

      {/* Filter Pills */}
      <div className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              filter === f.key
                ? 'text-white'
                : f.key === 'overdue' && f.count > 0
                  ? 'bg-red-50 text-red-600 hover:bg-red-100'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            )}
            style={filter === f.key ? { backgroundColor: f.key === 'overdue' ? '#EF4444' : 'var(--couple-primary)' } : undefined}
          >
            {f.label}
            <span className={cn(
              'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px]',
              filter === f.key
                ? 'bg-white/20 text-white'
                : 'bg-gray-200 text-gray-500'
            )}>
              {f.count}
            </span>
          </button>
        ))}
      </div>

      {/* Checklist Items */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="animate-pulse h-16 bg-gray-100 rounded-xl" />
          ))}
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <CheckSquare className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {filter === 'completed'
              ? 'No completed tasks yet'
              : filter === 'overdue'
                ? 'No overdue tasks'
                : filter === 'todo'
                  ? 'All caught up!'
                  : 'No checklist items yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {filter === 'all'
              ? 'Add your first planning task to get started.'
              : 'Try a different filter.'}
          </p>
          {filter === 'all' && (
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
        <div className="space-y-2">
          {filteredItems.map((item) => {
            const overdue = isOverdue(item)
            const dueText = daysUntilDue(item.due_date)

            return (
              <div
                key={item.id}
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
                    <div className="min-w-0">
                      <p className={cn(
                        'text-sm font-medium',
                        item.is_completed ? 'line-through text-gray-400' : 'text-gray-800'
                      )}>
                        {item.title}
                      </p>
                      {item.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                          {item.description}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-1.5">
                        {item.due_date && (
                          <span className={cn(
                            'inline-flex items-center gap-1 text-xs',
                            overdue ? 'text-red-600 font-medium' : 'text-gray-400'
                          )}>
                            <Calendar className="w-3 h-3" />
                            {formatDate(item.due_date)}
                            {dueText && (
                              <span className={cn(
                                'ml-1',
                                overdue ? 'text-red-500' : 'text-gray-400'
                              )}>
                                ({dueText})
                              </span>
                            )}
                          </span>
                        )}
                        {item.category && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
                            style={{ backgroundColor: 'var(--couple-accent)' }}
                          >
                            <Tag className="w-2.5 h-2.5" />
                            {item.category}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
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
            )
          })}
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
                {editingId ? 'Edit Task' : 'Add Task'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Book photographer"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Optional details..."
                />
              </div>

              {/* Due Date + Category */}
              <div className="grid grid-cols-2 gap-3">
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
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
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
