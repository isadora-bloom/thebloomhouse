'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Check, Plus, Trash2, ChevronRight, ChevronDown, Loader2 } from 'lucide-react'

interface ChecklistRow {
  id: string
  vendor_id: string
  task: string
  is_completed: boolean
  completed_at: string | null
  due_date: string | null
  notes: string | null
  sort_order: number
}

interface Props {
  weddingId: string
  venueId: string
  vendorId: string
  vendorType: string
}

// Default tasks per vendor type — port from rixey-portal's default vendor task lists
const DEFAULT_TASKS_BY_TYPE: Record<string, string[]> = {
  photographer: [
    'Contract signed',
    'Deposit paid',
    'Shot list shared',
    'Timeline confirmed',
    'Final payment scheduled',
    'Engagement session booked (if applicable)',
  ],
  videographer: [
    'Contract signed',
    'Deposit paid',
    'Shot list shared',
    'Timeline confirmed',
    'Final payment scheduled',
  ],
  florist: [
    'Contract signed',
    'Deposit paid',
    'Final flower count + items confirmed',
    'Delivery time + location confirmed',
    'Pickup of rentals scheduled',
  ],
  caterer: [
    'Contract signed',
    'Deposit paid',
    'Final guest count submitted',
    'Menu finalised',
    'Dietary restrictions sent',
    'Service style confirmed',
    'Final payment scheduled',
  ],
  dj: [
    'Contract signed',
    'Deposit paid',
    'Music preferences shared',
    'Do-not-play list shared',
    'Timeline + announcements confirmed',
  ],
  band: [
    'Contract signed',
    'Deposit paid',
    'Set list discussed',
    'Load-in details confirmed',
    'Power requirements confirmed',
  ],
  hair_makeup: [
    'Contract signed',
    'Deposit paid',
    'Trial booked',
    'Day-of schedule confirmed',
  ],
  bakery: [
    'Contract signed',
    'Deposit paid',
    'Cake design + flavors confirmed',
    'Delivery time + location confirmed',
  ],
  officiant: [
    'Contract signed',
    'Deposit paid',
    'Ceremony script reviewed',
    'Rehearsal attendance confirmed',
  ],
  rentals: [
    'Contract signed',
    'Deposit paid',
    'Final item list confirmed',
    'Delivery + pickup time confirmed',
  ],
  transportation: [
    'Contract signed',
    'Deposit paid',
    'Pickup schedule confirmed',
    'Driver contact shared',
  ],
}

const FALLBACK_TASKS = [
  'Contract signed',
  'Deposit paid',
  'Final payment scheduled',
  'Day-of details confirmed',
]

function defaultsFor(vendorType: string) {
  return DEFAULT_TASKS_BY_TYPE[vendorType] ?? FALLBACK_TASKS
}

export function VendorChecklistSection({ weddingId, venueId, vendorId, vendorType }: Props) {
  const [items, setItems] = useState<ChecklistRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [seeding, setSeeding] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase
      .from('vendor_checklist')
      .select('id, vendor_id, task, is_completed, completed_at, due_date, notes, sort_order')
      .eq('vendor_id', vendorId)
      .order('sort_order', { ascending: true })
    setItems((data ?? []) as ChecklistRow[])
    setLoading(false)
  }, [vendorId])

  useEffect(() => {
    if (expanded) load()
  }, [expanded, load])

  async function addTask(task: string) {
    if (!task.trim()) return
    setBusy(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from('vendor_checklist')
      .insert({
        venue_id: venueId,
        wedding_id: weddingId,
        vendor_id: vendorId,
        task: task.trim(),
        sort_order: items.length,
      })
      .select('id, vendor_id, task, is_completed, completed_at, due_date, notes, sort_order')
      .single()
    if (!error && data) {
      setItems((prev) => [...prev, data as ChecklistRow])
      setDraft('')
    }
    setBusy(false)
  }

  async function toggleComplete(item: ChecklistRow) {
    const next = !item.is_completed
    const supabase = createClient()
    const { error } = await supabase
      .from('vendor_checklist')
      .update({
        is_completed: next,
        completed_at: next ? new Date().toISOString() : null,
      })
      .eq('id', item.id)
    if (!error) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? { ...it, is_completed: next, completed_at: next ? new Date().toISOString() : null }
            : it
        )
      )
    }
  }

  async function remove(item: ChecklistRow) {
    const supabase = createClient()
    const { error } = await supabase.from('vendor_checklist').delete().eq('id', item.id)
    if (!error) setItems((prev) => prev.filter((it) => it.id !== item.id))
  }

  async function seedDefaults() {
    if (items.length > 0) return
    setSeeding(true)
    const tasks = defaultsFor(vendorType)
    const supabase = createClient()
    const rows = tasks.map((task, i) => ({
      venue_id: venueId,
      wedding_id: weddingId,
      vendor_id: vendorId,
      task,
      sort_order: i,
    }))
    const { data } = await supabase
      .from('vendor_checklist')
      .insert(rows)
      .select('id, vendor_id, task, is_completed, completed_at, due_date, notes, sort_order')
    if (data) setItems(data as ChecklistRow[])
    setSeeding(false)
  }

  const completedCount = items.filter((it) => it.is_completed).length
  const totalCount = items.length

  return (
    <div className="rounded-lg border border-sage-100 bg-warm-white">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-sage-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-sage-400" />
          )}
          <span className="text-xs font-medium text-sage-700">Checklist</span>
          {totalCount > 0 && (
            <span
              className={cn(
                'text-[11px] px-2 py-0.5 rounded-full',
                completedCount === totalCount
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-sage-100 text-sage-700'
              )}
            >
              {completedCount}/{totalCount}
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-sage-400">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="text-xs text-sage-500 space-y-2">
              <p>No tasks yet.</p>
              <button
                onClick={seedDefaults}
                disabled={seeding}
                className="text-xs text-sage-700 underline hover:text-sage-900 disabled:opacity-50"
              >
                {seeding ? 'Adding…' : `Add default ${vendorType.replace(/_/g, ' ')} tasks`}
              </button>
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map((item) => (
                <li key={item.id} className="flex items-center gap-2 group">
                  <button
                    onClick={() => toggleComplete(item)}
                    className={cn(
                      'flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-colors',
                      item.is_completed
                        ? 'bg-sage-700 border-sage-700 text-white'
                        : 'border-sage-300 hover:border-sage-500'
                    )}
                    aria-label={item.is_completed ? 'Mark incomplete' : 'Mark complete'}
                  >
                    {item.is_completed && <Check className="w-3 h-3" />}
                  </button>
                  <span
                    className={cn(
                      'flex-1 text-xs',
                      item.is_completed ? 'line-through text-sage-400' : 'text-sage-800'
                    )}
                  >
                    {item.task}
                  </span>
                  <button
                    onClick={() => remove(item)}
                    className="opacity-0 group-hover:opacity-100 text-sage-400 hover:text-rose-500"
                    aria-label="Remove task"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              addTask(draft)
            }}
            className="flex items-center gap-2 pt-2 border-t border-sage-100"
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a task…"
              className="flex-1 px-2 py-1 text-xs bg-transparent border-none focus:outline-none placeholder:text-sage-400 text-sage-800"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="text-xs text-sage-600 hover:text-sage-900 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
