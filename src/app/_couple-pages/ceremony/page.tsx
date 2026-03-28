'use client'

// Feature: configurable via venue_config.feature_flags
// Table: ceremony_order

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Users,
  Plus,
  X,
  Edit2,
  Trash2,
  ChevronUp,
  ChevronDown,
  Heart,
  ArrowDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CeremonyRole =
  | 'officiant'
  | 'partner_1'
  | 'partner_2'
  | 'honor_attendant'
  | 'best_person'
  | 'attendant'
  | 'flower_child'
  | 'ring_bearer'
  | 'usher'
  | 'reader'
  | 'musician'
  | 'other'

type CeremonySide = 'partner_1' | 'partner_2' | 'both'

interface CeremonyParticipant {
  id: string
  name: string
  role: CeremonyRole
  side: CeremonySide
  sort_order: number
  notes: string | null
}

interface ParticipantFormData {
  name: string
  role: CeremonyRole
  side: CeremonySide
  notes: string
}

const ROLES: { key: CeremonyRole; label: string }[] = [
  { key: 'officiant', label: 'Officiant' },
  { key: 'partner_1', label: 'Partner 1' },
  { key: 'partner_2', label: 'Partner 2' },
  { key: 'honor_attendant', label: 'Honor Attendant' },
  { key: 'best_person', label: 'Best Person' },
  { key: 'attendant', label: 'Attendant' },
  { key: 'flower_child', label: 'Flower Child' },
  { key: 'ring_bearer', label: 'Ring Bearer' },
  { key: 'usher', label: 'Usher' },
  { key: 'reader', label: 'Reader' },
  { key: 'musician', label: 'Musician' },
  { key: 'other', label: 'Other' },
]

const SIDES: { key: CeremonySide; label: string }[] = [
  { key: 'partner_1', label: 'Partner 1' },
  { key: 'partner_2', label: 'Partner 2' },
  { key: 'both', label: 'Both / Shared' },
]

const EMPTY_FORM: ParticipantFormData = {
  name: '',
  role: 'attendant',
  side: 'partner_1',
  notes: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roleBadgeColor(role: CeremonyRole): string {
  const colors: Record<string, string> = {
    officiant: '#6366F1',
    partner_1: '#EC4899',
    partner_2: '#3B82F6',
    honor_attendant: '#8B5CF6',
    best_person: '#8B5CF6',
    attendant: '#10B981',
    flower_child: '#F59E0B',
    ring_bearer: '#F59E0B',
    usher: '#14B8A6',
    reader: '#F97316',
    musician: '#EF4444',
    other: '#6B7280',
  }
  return colors[role] || '#6B7280'
}

function roleLabel(role: CeremonyRole): string {
  return ROLES.find((r) => r.key === role)?.label || role
}

function sideLabel(side: CeremonySide): string {
  return SIDES.find((s) => s.key === side)?.label || side
}

// ---------------------------------------------------------------------------
// Ceremony Lineup Page
// ---------------------------------------------------------------------------

export default function CeremonyLineupPage() {
  const [participants, setParticipants] = useState<CeremonyParticipant[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ParticipantFormData>(EMPTY_FORM)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchParticipants = useCallback(async () => {
    const { data, error } = await supabase
      .from('ceremony_order')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('sort_order', { ascending: true })

    if (!error && data) {
      setParticipants(data as CeremonyParticipant[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchParticipants()
  }, [fetchParticipants])

  // ---- Modal helpers ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(p: CeremonyParticipant) {
    setForm({
      name: p.name,
      role: p.role,
      side: p.side,
      notes: p.notes || '',
    })
    setEditingId(p.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.name.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      name: form.name.trim(),
      role: form.role,
      side: form.side,
      notes: form.notes.trim() || null,
    }

    if (editingId) {
      await supabase.from('ceremony_order').update(payload).eq('id', editingId)
    } else {
      await supabase.from('ceremony_order').insert({
        ...payload,
        sort_order: participants.length,
      })
    }

    setShowModal(false)
    setEditingId(null)
    fetchParticipants()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this participant from the ceremony lineup?')) return
    await supabase.from('ceremony_order').delete().eq('id', id)
    fetchParticipants()
  }

  // ---- Reorder ----
  async function moveUp(index: number) {
    if (index <= 0) return
    const updated = [...participants]
    const temp = updated[index - 1]
    updated[index - 1] = updated[index]
    updated[index] = temp

    // Update sort_order for both
    await Promise.all([
      supabase.from('ceremony_order').update({ sort_order: index - 1 }).eq('id', updated[index - 1].id),
      supabase.from('ceremony_order').update({ sort_order: index }).eq('id', updated[index].id),
    ])
    fetchParticipants()
  }

  async function moveDown(index: number) {
    if (index >= participants.length - 1) return
    const updated = [...participants]
    const temp = updated[index + 1]
    updated[index + 1] = updated[index]
    updated[index] = temp

    await Promise.all([
      supabase.from('ceremony_order').update({ sort_order: index + 1 }).eq('id', updated[index + 1].id),
      supabase.from('ceremony_order').update({ sort_order: index }).eq('id', updated[index].id),
    ])
    fetchParticipants()
  }

  // ---- Stats ----
  const statsBySide = {
    partner_1: participants.filter((p) => p.side === 'partner_1').length,
    partner_2: participants.filter((p) => p.side === 'partner_2').length,
    both: participants.filter((p) => p.side === 'both').length,
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-xl" />
        ))}
      </div>
    )
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
            Ceremony Lineup
          </h1>
          <p className="text-gray-500 text-sm">Organize your ceremony participants and processional order.</p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Participant
        </button>
      </div>

      {/* Stats */}
      {participants.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-pink-50 rounded-xl p-4 border border-pink-100 text-center">
            <p className="text-2xl font-bold text-pink-700 tabular-nums">{statsBySide.partner_1}</p>
            <p className="text-xs text-pink-600 font-medium">Partner 1 Side</p>
          </div>
          <div className="bg-blue-50 rounded-xl p-4 border border-blue-100 text-center">
            <p className="text-2xl font-bold text-blue-700 tabular-nums">{statsBySide.partner_2}</p>
            <p className="text-xs text-blue-600 font-medium">Partner 2 Side</p>
          </div>
          <div className="bg-purple-50 rounded-xl p-4 border border-purple-100 text-center">
            <p className="text-2xl font-bold text-purple-700 tabular-nums">{statsBySide.both}</p>
            <p className="text-xs text-purple-600 font-medium">Shared</p>
          </div>
        </div>
      )}

      {/* Processional Visualization */}
      {participants.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Heart className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No ceremony lineup yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Add participants to build your processional order.</p>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Participant
          </button>
        </div>
      ) : (
        <div className="relative">
          {/* Processional header */}
          <div className="flex items-center gap-2 mb-4">
            <ArrowDown className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--couple-primary)' }}>
              Processional Order
            </span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          {/* Vertical line */}
          <div
            className="absolute left-5 top-12 bottom-0 w-0.5 hidden sm:block"
            style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.15 }}
          />

          <div className="space-y-2">
            {participants.map((participant, index) => (
              <div key={participant.id} className="flex items-start gap-3 group">
                {/* Order number */}
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-sm font-bold text-white"
                  style={{ backgroundColor: roleBadgeColor(participant.role) }}
                >
                  {index + 1}
                </div>

                {/* Card */}
                <div className="flex-1 bg-white rounded-xl border border-gray-100 shadow-sm p-4 hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-gray-800 text-sm">{participant.name}</h3>
                        <span
                          className="px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
                          style={{ backgroundColor: roleBadgeColor(participant.role) }}
                        >
                          {roleLabel(participant.role)}
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600">
                          {sideLabel(participant.side)}
                        </span>
                      </div>
                      {participant.notes && (
                        <p className="text-xs text-gray-400 mt-1">{participant.notes}</p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => moveUp(index)}
                        disabled={index === 0}
                        className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => moveDown(index)}
                        disabled={index === participants.length - 1}
                        className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => openEdit(participant)}
                        className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-50"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(participant.id)}
                        className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
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
                {editingId ? 'Edit Participant' : 'Add Participant'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Full name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as CeremonyRole })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  {ROLES.map((r) => (
                    <option key={r.key} value={r.key}>{r.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Side</label>
                <div className="grid grid-cols-3 gap-2">
                  {SIDES.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setForm({ ...form, side: s.key })}
                      className={cn(
                        'px-3 py-2 rounded-lg border text-xs font-medium transition-colors',
                        form.side === s.key
                          ? 'text-white border-transparent'
                          : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white'
                      )}
                      style={form.side === s.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Optional notes (e.g., walking with grandmother)"
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
                disabled={!form.name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Participant'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
