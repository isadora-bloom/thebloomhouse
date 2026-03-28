'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  AlertTriangle,
  Plus,
  X,
  Edit2,
  Trash2,
  Search,
  ShieldAlert,
  ArrowUpDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AllergyRecord {
  id: string
  guest_name: string
  allergy_type: string
  severity: 'mild' | 'moderate' | 'severe' | 'life_threatening'
  notes: string | null
  is_important: boolean
  created_at: string
}

interface AllergyFormData {
  guest_name: string
  allergy_type: string
  severity: string
  notes: string
  is_important: boolean
}

const EMPTY_FORM: AllergyFormData = {
  guest_name: '',
  allergy_type: '',
  severity: 'mild',
  notes: '',
  is_important: false,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = {
  life_threatening: 0,
  severe: 1,
  moderate: 2,
  mild: 3,
}

function severityConfig(severity: string) {
  switch (severity) {
    case 'life_threatening':
      return { label: 'Life-Threatening', className: 'bg-red-100 text-red-800 border-red-300' }
    case 'severe':
      return { label: 'Severe', className: 'bg-orange-100 text-orange-800 border-orange-300' }
    case 'moderate':
      return { label: 'Moderate', className: 'bg-amber-50 text-amber-700 border-amber-200' }
    default:
      return { label: 'Mild', className: 'bg-green-50 text-green-700 border-green-200' }
  }
}

// ---------------------------------------------------------------------------
// Allergy Registry Page
// ---------------------------------------------------------------------------

export default function AllergyRegistryPage() {
  const [records, setRecords] = useState<AllergyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<AllergyFormData>(EMPTY_FORM)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBySeverity, setSortBySeverity] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchRecords = useCallback(async () => {
    const { data, error } = await supabase
      .from('allergy_registry')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('created_at', { ascending: true })

    if (!error && data) {
      setRecords(data as AllergyRecord[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchRecords()
  }, [fetchRecords])

  // ---- Derived data ----
  const criticalCount = records.filter(
    (r) => r.severity === 'life_threatening' || r.severity === 'severe' || r.is_important
  ).length

  const filtered = records
    .filter((r) => {
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase()
      return (
        r.guest_name.toLowerCase().includes(q) ||
        r.allergy_type.toLowerCase().includes(q)
      )
    })
    .sort((a, b) => {
      if (sortBySeverity) {
        const diff = (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4)
        if (diff !== 0) return diff
        // Within same severity, important first
        if (a.is_important && !b.is_important) return -1
        if (!a.is_important && b.is_important) return 1
      }
      return 0
    })

  // ---- Modal ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(record: AllergyRecord) {
    setForm({
      guest_name: record.guest_name,
      allergy_type: record.allergy_type,
      severity: record.severity,
      notes: record.notes || '',
      is_important: record.is_important,
    })
    setEditingId(record.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.guest_name.trim() || !form.allergy_type.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      guest_name: form.guest_name.trim(),
      allergy_type: form.allergy_type.trim(),
      severity: form.severity,
      notes: form.notes.trim() || null,
      is_important: form.is_important,
    }

    if (editingId) {
      await supabase.from('allergy_registry').update(payload).eq('id', editingId)
    } else {
      await supabase.from('allergy_registry').insert(payload)
    }

    setShowModal(false)
    setEditingId(null)
    fetchRecords()
  }

  async function handleDelete(record: AllergyRecord) {
    if (!confirm(`Remove allergy record for ${record.guest_name}?`)) return
    await supabase.from('allergy_registry').delete().eq('id', record.id)
    fetchRecords()
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
            Allergy Registry
          </h1>
          <p className="text-gray-500 text-sm">
            Track guest allergies for safe catering coordination.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Allergy
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
          <p className="text-2xl font-bold text-gray-800 tabular-nums">{records.length}</p>
          <p className="text-xs text-gray-500 font-medium">Total Allergies</p>
        </div>
        <div className="bg-red-50 rounded-xl p-4 border border-red-100 text-center">
          <p className="text-2xl font-bold text-red-700 tabular-nums">{criticalCount}</p>
          <p className="text-xs text-red-600 font-medium">Critical / Flagged</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center sm:col-span-1 col-span-2">
          <p className="text-2xl font-bold text-gray-800 tabular-nums">
            {new Set(records.map((r) => r.guest_name)).size}
          </p>
          <p className="text-xs text-gray-500 font-medium">Guests with Allergies</p>
        </div>
      </div>

      {/* Search + Sort */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by guest or allergy..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent w-full"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>
        <button
          onClick={() => setSortBySeverity(!sortBySeverity)}
          className={cn(
            'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors',
            sortBySeverity
              ? 'border-gray-300 bg-gray-50 text-gray-700'
              : 'border-gray-200 text-gray-500 hover:bg-gray-50'
          )}
        >
          <ArrowUpDown className="w-4 h-4" />
          Sort by Severity
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <ShieldAlert className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {searchQuery ? 'No matching records' : 'No allergies logged yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {searchQuery
              ? 'Try a different search term.'
              : 'Track guest allergies so your catering team is prepared.'}
          </p>
          {!searchQuery && (
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add First Allergy
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((record) => {
            const sev = severityConfig(record.severity)
            const isCritical = record.severity === 'life_threatening' || record.severity === 'severe' || record.is_important

            return (
              <div
                key={record.id}
                className={cn(
                  'bg-white rounded-xl border shadow-sm p-4 group hover:shadow-md transition-shadow',
                  isCritical ? 'border-red-200 bg-red-50/30' : 'border-gray-100'
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-medium text-gray-800">{record.guest_name}</span>
                      {record.is_important && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 border border-red-200 uppercase tracking-wide">
                          <AlertTriangle className="w-3 h-3" />
                          Important
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-gray-700">{record.allergy_type}</span>
                      <span className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border',
                        sev.className
                      )}>
                        {sev.label}
                      </span>
                    </div>
                    {record.notes && (
                      <p className="text-xs text-gray-500 mt-1">{record.notes}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => openEdit(record)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(record)}
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
                {editingId ? 'Edit Allergy' : 'Add Allergy'}
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Allergy Type</label>
                <input
                  type="text"
                  value={form.allergy_type}
                  onChange={(e) => setForm({ ...form, allergy_type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Peanuts, Shellfish, Gluten"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Severity</label>
                <select
                  value={form.severity}
                  onChange={(e) => setForm({ ...form, severity: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  <option value="mild">Mild</option>
                  <option value="moderate">Moderate</option>
                  <option value="severe">Severe</option>
                  <option value="life_threatening">Life-Threatening</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={3}
                  placeholder="Additional details (e.g., EpiPen on hand)"
                />
              </div>

              <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  checked={form.is_important}
                  onChange={(e) => setForm({ ...form, is_important: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300"
                  style={{ accentColor: 'var(--couple-primary)' }}
                />
                Flag as critical (highlighted for catering team)
              </label>
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
                disabled={!form.guest_name.trim() || !form.allergy_type.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Allergy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
