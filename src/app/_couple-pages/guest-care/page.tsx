'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Heart,
  Plus,
  X,
  Edit2,
  Trash2,
  Search,
  Accessibility,
  UtensilsCrossed,
  Users,
  Star,
  Stethoscope,
  MoreHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CareNote {
  id: string
  guest_name: string
  care_type: 'mobility' | 'dietary' | 'family' | 'vip' | 'medical' | 'other'
  note: string | null
  created_at: string
}

interface CareFormData {
  guest_name: string
  care_type: string
  note: string
}

const EMPTY_FORM: CareFormData = {
  guest_name: '',
  care_type: 'other',
  note: '',
}

type CareTypeFilter = 'all' | 'mobility' | 'dietary' | 'family' | 'vip' | 'medical' | 'other'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function careTypeConfig(type: string) {
  switch (type) {
    case 'mobility':
      return { label: 'Mobility', icon: Accessibility, className: 'bg-blue-50 text-blue-700 border-blue-200' }
    case 'dietary':
      return { label: 'Dietary', icon: UtensilsCrossed, className: 'bg-green-50 text-green-700 border-green-200' }
    case 'family':
      return { label: 'Family', icon: Users, className: 'bg-purple-50 text-purple-700 border-purple-200' }
    case 'vip':
      return { label: 'VIP', icon: Star, className: 'bg-amber-50 text-amber-700 border-amber-200' }
    case 'medical':
      return { label: 'Medical', icon: Stethoscope, className: 'bg-red-50 text-red-700 border-red-200' }
    default:
      return { label: 'Other', icon: MoreHorizontal, className: 'bg-gray-50 text-gray-600 border-gray-200' }
  }
}

const CARE_TYPES: { key: CareTypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mobility', label: 'Mobility' },
  { key: 'dietary', label: 'Dietary' },
  { key: 'family', label: 'Family' },
  { key: 'vip', label: 'VIP' },
  { key: 'medical', label: 'Medical' },
  { key: 'other', label: 'Other' },
]

// ---------------------------------------------------------------------------
// Guest Care Page
// ---------------------------------------------------------------------------

export default function GuestCarePage() {
  const [notes, setNotes] = useState<CareNote[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<CareFormData>(EMPTY_FORM)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<CareTypeFilter>('all')

  const supabase = createClient()

  // ---- Fetch ----
  const fetchNotes = useCallback(async () => {
    const { data, error } = await supabase
      .from('guest_care_notes')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('created_at', { ascending: true })

    if (!error && data) {
      setNotes(data as CareNote[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchNotes()
  }, [fetchNotes])

  // ---- Derived data ----
  const typeCounts = notes.reduce<Record<string, number>>((acc, n) => {
    acc[n.care_type] = (acc[n.care_type] || 0) + 1
    return acc
  }, {})

  const filtered = notes.filter((n) => {
    if (typeFilter !== 'all' && n.care_type !== typeFilter) return false
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return (
        n.guest_name.toLowerCase().includes(q) ||
        (n.note || '').toLowerCase().includes(q)
      )
    }
    return true
  })

  // ---- Modal ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(note: CareNote) {
    setForm({
      guest_name: note.guest_name,
      care_type: note.care_type,
      note: note.note || '',
    })
    setEditingId(note.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.guest_name.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      guest_name: form.guest_name.trim(),
      care_type: form.care_type,
      note: form.note.trim() || null,
    }

    if (editingId) {
      await supabase.from('guest_care_notes').update(payload).eq('id', editingId)
    } else {
      await supabase.from('guest_care_notes').insert(payload)
    }

    setShowModal(false)
    setEditingId(null)
    fetchNotes()
  }

  async function handleDelete(note: CareNote) {
    if (!confirm(`Remove care note for ${note.guest_name}?`)) return
    await supabase.from('guest_care_notes').delete().eq('id', note.id)
    fetchNotes()
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Guest Care
          </h1>
          <p className="text-gray-500 text-sm">
            Special notes your venue coordinator should know about your guests.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Note
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {(['mobility', 'dietary', 'family', 'vip', 'medical', 'other'] as const).map((type) => {
          const config = careTypeConfig(type)
          const Icon = config.icon
          return (
            <button
              key={type}
              onClick={() => setTypeFilter(typeFilter === type ? 'all' : type)}
              className={cn(
                'rounded-xl p-3 border text-center transition-all',
                typeFilter === type
                  ? 'ring-2 ring-offset-1'
                  : 'hover:shadow-sm',
                config.className
              )}
              style={typeFilter === type ? { '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties : undefined}
            >
              <Icon className="w-4 h-4 mx-auto mb-1" />
              <p className="text-lg font-bold tabular-nums">{typeCounts[type] || 0}</p>
              <p className="text-[10px] font-medium">{config.label}</p>
            </button>
          )
        })}
      </div>

      {/* Search + Filter pills */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex flex-wrap gap-2">
          {CARE_TYPES.map((ct) => (
            <button
              key={ct.key}
              onClick={() => setTypeFilter(ct.key)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                typeFilter === ct.key
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
              style={typeFilter === ct.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
            >
              {ct.label}
              {ct.key !== 'all' && (
                <span className={cn(
                  'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px]',
                  typeFilter === ct.key ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-500'
                )}>
                  {typeCounts[ct.key] || 0}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search guests or notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent w-full sm:w-56"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>
      </div>

      {/* Notes List */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Heart className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {searchQuery || typeFilter !== 'all' ? 'No matching notes' : 'No guest care notes yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {searchQuery || typeFilter !== 'all'
              ? 'Try adjusting your filters.'
              : 'Add notes about guests who need special attention on your wedding day.'}
          </p>
          {!searchQuery && typeFilter === 'all' && (
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add First Note
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((note) => {
            const config = careTypeConfig(note.care_type)
            const TypeIcon = config.icon

            return (
              <div
                key={note.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 group hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-medium text-gray-800">{note.guest_name}</span>
                      <span className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border',
                        config.className
                      )}>
                        <TypeIcon className="w-3 h-3" />
                        {config.label}
                      </span>
                    </div>
                    {note.note && (
                      <p className="text-sm text-gray-600">{note.note}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => openEdit(note)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(note)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
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
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingId ? 'Edit Care Note' : 'Add Care Note'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Guest Name</label>
                <input
                  type="text"
                  value={form.guest_name}
                  onChange={(e) => setForm({ ...form, guest_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Guest's full name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Care Type</label>
                <select
                  value={form.care_type}
                  onChange={(e) => setForm({ ...form, care_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  <option value="mobility">Mobility</option>
                  <option value="dietary">Dietary</option>
                  <option value="family">Family</option>
                  <option value="vip">VIP</option>
                  <option value="medical">Medical</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Note</label>
                <textarea
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={4}
                  placeholder="What should the venue team know about this guest?"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!form.guest_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Note'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
