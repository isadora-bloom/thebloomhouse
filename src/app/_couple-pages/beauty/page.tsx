'use client'

// Feature: configurable via venue_config.feature_flags
// Table: makeup_schedule

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  Sparkles,
  Plus,
  X,
  Edit2,
  Trash2,
  Clock,
  Scissors,
  Users,
  Info,
} from 'lucide-react'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BeautyAppointment {
  id: string
  person_name: string
  role: string
  hair_time: string | null
  makeup_time: string | null
  hair_duration: number | null
  makeup_duration: number | null
  notes: string | null
  sort_order: number
}

interface AppointmentFormData {
  person_name: string
  role: string
  hair_time: string
  makeup_time: string
  hair_duration: number
  makeup_duration: number
  notes: string
}

const ROLES = [
  'Partner 1',
  'Partner 2',
  'Honor Attendant',
  'Attendant',
  'Parent',
  'Grandparent',
  'Flower Child',
  'Guest',
  'Other',
]

const EMPTY_FORM: AppointmentFormData = {
  person_name: '',
  role: 'Attendant',
  hair_time: '',
  makeup_time: '',
  hair_duration: 45,
  makeup_duration: 45,
  notes: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(timeStr: string | null): string {
  if (!timeStr) return '--'
  const [hours, minutes] = timeStr.split(':').map(Number)
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`
}

function earliestTime(appt: BeautyAppointment): string {
  const times = [appt.hair_time, appt.makeup_time].filter(Boolean) as string[]
  if (times.length === 0) return 'zz:zz' // sort to end
  return times.sort()[0]
}

function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + m
}

// ---------------------------------------------------------------------------
// Beauty Schedule Page
// ---------------------------------------------------------------------------

export default function BeautySchedulePage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [appointments, setAppointments] = useState<BeautyAppointment[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<AppointmentFormData>(EMPTY_FORM)
  const [hairStylists, setHairStylists] = useState(1)
  const [makeupArtists, setMakeupArtists] = useState(1)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchAppointments = useCallback(async () => {
    const { data, error } = await supabase
      .from('makeup_schedule')
      .select('*')
      .eq('wedding_id', weddingId)
      .order('sort_order', { ascending: true })

    if (!error && data) {
      setAppointments(data as BeautyAppointment[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchAppointments()
  }, [fetchAppointments])

  // ---- Sorted by earliest appointment ----
  const sortedAppointments = useMemo(() => {
    return [...appointments].sort((a, b) => {
      const aTime = earliestTime(a)
      const bTime = earliestTime(b)
      return aTime.localeCompare(bTime)
    })
  }, [appointments])

  // ---- Timeline data ----
  const timelineSlots = useMemo(() => {
    const slots: { time: string; entries: { name: string; type: 'hair' | 'makeup' }[] }[] = []
    const timeMap = new Map<string, { name: string; type: 'hair' | 'makeup' }[]>()

    for (const appt of appointments) {
      if (appt.hair_time) {
        const key = appt.hair_time
        if (!timeMap.has(key)) timeMap.set(key, [])
        timeMap.get(key)!.push({ name: appt.person_name, type: 'hair' })
      }
      if (appt.makeup_time) {
        const key = appt.makeup_time
        if (!timeMap.has(key)) timeMap.set(key, [])
        timeMap.get(key)!.push({ name: appt.person_name, type: 'makeup' })
      }
    }

    const sortedKeys = Array.from(timeMap.keys()).sort()
    for (const key of sortedKeys) {
      slots.push({ time: key, entries: timeMap.get(key)! })
    }
    return slots
  }, [appointments])

  // ---- Calculate time range for visualization ----
  const timeRange = useMemo(() => {
    if (timelineSlots.length === 0) return null
    const firstMin = timeToMinutes(timelineSlots[0].time)
    const lastMin = timeToMinutes(timelineSlots[timelineSlots.length - 1].time)
    return { start: firstMin, end: lastMin, duration: lastMin - firstMin || 60 }
  }, [timelineSlots])

  // ---- Scheduling calculations ----
  const scheduleEstimate = useMemo(() => {
    const hairCount = appointments.filter((a) => a.hair_time).length
    const makeupCount = appointments.filter((a) => a.makeup_time).length
    const avgHairDuration = hairCount > 0
      ? Math.round(appointments.filter((a) => a.hair_time).reduce((sum, a) => sum + (a.hair_duration || 45), 0) / hairCount)
      : 45
    const avgMakeupDuration = makeupCount > 0
      ? Math.round(appointments.filter((a) => a.makeup_time).reduce((sum, a) => sum + (a.makeup_duration || 45), 0) / makeupCount)
      : 45

    const hairSlots = Math.ceil(hairCount / hairStylists)
    const makeupSlots = Math.ceil(makeupCount / makeupArtists)
    const totalHairMinutes = hairSlots * avgHairDuration
    const totalMakeupMinutes = makeupSlots * avgMakeupDuration
    // Hair and makeup can run in parallel, so total time is the max
    const totalMinutes = Math.max(totalHairMinutes, totalMakeupMinutes)
    const totalHours = Math.floor(totalMinutes / 60)
    const remainderMinutes = totalMinutes % 60
    const parallelSlots = hairStylists + makeupArtists

    return {
      hairCount,
      makeupCount,
      avgHairDuration,
      avgMakeupDuration,
      totalHairMinutes,
      totalMakeupMinutes,
      totalMinutes,
      totalHours,
      remainderMinutes,
      parallelSlots,
      hairSlots,
      makeupSlots,
    }
  }, [appointments, hairStylists, makeupArtists])

  // ---- Modal helpers ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(appt: BeautyAppointment) {
    setForm({
      person_name: appt.person_name,
      role: appt.role,
      hair_time: appt.hair_time || '',
      makeup_time: appt.makeup_time || '',
      hair_duration: appt.hair_duration || 45,
      makeup_duration: appt.makeup_duration || 45,
      notes: appt.notes || '',
    })
    setEditingId(appt.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.person_name.trim()) return

    const payload = {
      venue_id: venueId,
      wedding_id: weddingId,
      person_name: form.person_name.trim(),
      role: form.role,
      hair_time: form.hair_time || null,
      makeup_time: form.makeup_time || null,
      hair_duration: form.hair_duration || 45,
      makeup_duration: form.makeup_duration || 45,
      notes: form.notes.trim() || null,
    }

    if (editingId) {
      await supabase.from('makeup_schedule').update(payload).eq('id', editingId)
    } else {
      await supabase.from('makeup_schedule').insert({
        ...payload,
        sort_order: appointments.length,
      })
    }

    setShowModal(false)
    setEditingId(null)
    fetchAppointments()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this person from the beauty schedule?')) return
    await supabase.from('makeup_schedule').delete().eq('id', id)
    fetchAppointments()
  }

  if (contextLoading || !weddingId || !venueId || loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-20 bg-gray-100 rounded-xl" />
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
            Beauty Schedule
          </h1>
          <p className="text-gray-500 text-sm">Coordinate hair and makeup appointments for your party.</p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Person
        </button>
      </div>

      {/* Stylist Configuration */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h2
          className="text-sm font-semibold mb-4 flex items-center gap-2"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          <Users className="w-4 h-4" />
          Your Beauty Team
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <Scissors className="w-3.5 h-3.5 inline mr-1" />
              How many hair stylists?
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={hairStylists}
              onChange={(e) => setHairStylists(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <Sparkles className="w-3.5 h-3.5 inline mr-1" />
              How many makeup artists?
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={makeupArtists}
              onChange={(e) => setMakeupArtists(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          </div>
        </div>

        {/* Capacity info */}
        <div
          className="rounded-lg px-4 py-3 text-sm"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--couple-primary) 6%, white)',
            borderLeft: '3px solid var(--couple-primary)',
          }}
        >
          <p className="font-medium text-gray-700">
            With {hairStylists} hair stylist{hairStylists > 1 ? 's' : ''} and {makeupArtists} makeup artist{makeupArtists > 1 ? 's' : ''},{' '}
            you can have <strong style={{ color: 'var(--couple-primary)' }}>{scheduleEstimate.parallelSlots} people</strong> getting
            ready simultaneously.
          </p>
        </div>

        {/* Scheduling estimate — only show when there are appointments */}
        {appointments.length > 0 && (
          <div className="mt-3 rounded-lg bg-gray-50 px-4 py-3 text-xs text-gray-600 space-y-1.5">
            <div className="flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400" />
              <div className="space-y-1">
                {scheduleEstimate.hairCount > 0 && (
                  <p>
                    With {hairStylists} hair stylist{hairStylists > 1 ? 's' : ''}, each{' '}
                    {scheduleEstimate.avgHairDuration}-minute slot can handle {hairStylists} {hairStylists > 1 ? 'people' : 'person'}.
                    For {scheduleEstimate.hairCount} {scheduleEstimate.hairCount === 1 ? 'person' : 'people'}, that&apos;s ~{Math.floor(scheduleEstimate.totalHairMinutes / 60)}h{scheduleEstimate.totalHairMinutes % 60 > 0 ? ` ${scheduleEstimate.totalHairMinutes % 60}m` : ''} of hair.
                  </p>
                )}
                {scheduleEstimate.makeupCount > 0 && (
                  <p>
                    With {makeupArtists} makeup artist{makeupArtists > 1 ? 's' : ''}, each{' '}
                    {scheduleEstimate.avgMakeupDuration}-minute slot can handle {makeupArtists} {makeupArtists > 1 ? 'people' : 'person'}.
                    For {scheduleEstimate.makeupCount} {scheduleEstimate.makeupCount === 1 ? 'person' : 'people'}, that&apos;s ~{Math.floor(scheduleEstimate.totalMakeupMinutes / 60)}h{scheduleEstimate.totalMakeupMinutes % 60 > 0 ? ` ${scheduleEstimate.totalMakeupMinutes % 60}m` : ''} of makeup.
                  </p>
                )}
                {(scheduleEstimate.hairCount > 0 || scheduleEstimate.makeupCount > 0) && (
                  <p className="font-medium pt-1 border-t border-gray-200" style={{ color: 'var(--couple-primary)' }}>
                    Total estimated prep time: ~{scheduleEstimate.totalHours > 0 ? `${scheduleEstimate.totalHours}h` : ''}{scheduleEstimate.remainderMinutes > 0 ? ` ${scheduleEstimate.remainderMinutes}m` : ''}{scheduleEstimate.totalMinutes === 0 ? '0m' : ''}
                    {' '}(hair and makeup run in parallel)
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Timeline Visualization */}
      {timelineSlots.length > 0 && timeRange && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2
            className="text-sm font-semibold mb-4"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Appointment Timeline
          </h2>

          <div className="relative pl-20">
            {/* Vertical line */}
            <div
              className="absolute left-[4.5rem] top-0 bottom-0 w-0.5"
              style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.15 }}
            />

            <div className="space-y-4">
              {timelineSlots.map((slot, idx) => (
                <div key={idx} className="flex items-start gap-4 relative">
                  {/* Time label */}
                  <div className="absolute -left-20 w-16 text-right">
                    <span className="text-xs font-semibold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
                      {formatTime(slot.time)}
                    </span>
                  </div>

                  {/* Dot */}
                  <div className="relative -left-[0.35rem] shrink-0">
                    <div
                      className="w-3 h-3 rounded-full border-2 bg-white"
                      style={{ borderColor: 'var(--couple-primary)' }}
                    />
                  </div>

                  {/* Entries */}
                  <div className="flex flex-wrap gap-2">
                    {slot.entries.map((entry, eidx) => (
                      <div
                        key={eidx}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border"
                        style={
                          entry.type === 'hair'
                            ? { backgroundColor: '#FEF3C7', color: '#92400E', borderColor: '#FDE68A' }
                            : { backgroundColor: '#FCE7F3', color: '#9D174D', borderColor: '#FBCFE8' }
                        }
                      >
                        {entry.type === 'hair' ? (
                          <Scissors className="w-3 h-3" />
                        ) : (
                          <Sparkles className="w-3 h-3" />
                        )}
                        {entry.name}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Appointments List */}
      {sortedAppointments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Sparkles className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No beauty appointments yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Add your party members to schedule hair and makeup.</p>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Person
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-5 py-3 font-medium text-gray-500">Name</th>
                  <th className="px-5 py-3 font-medium text-gray-500">Role</th>
                  <th className="px-5 py-3 font-medium text-gray-500">
                    <div className="flex items-center gap-1">
                      <Scissors className="w-3.5 h-3.5" />
                      Hair
                    </div>
                  </th>
                  <th className="px-5 py-3 font-medium text-gray-500">
                    <div className="flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5" />
                      Makeup
                    </div>
                  </th>
                  <th className="px-5 py-3 font-medium text-gray-500 hidden lg:table-cell">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      Duration
                    </div>
                  </th>
                  <th className="px-5 py-3 font-medium text-gray-500 hidden md:table-cell">Notes</th>
                  <th className="px-5 py-3 w-20" />
                </tr>
              </thead>
              <tbody>
                {sortedAppointments.map((appt) => (
                  <tr key={appt.id} className="border-b border-gray-50 group hover:bg-gray-50/50">
                    <td className="px-5 py-3 font-medium text-gray-800">{appt.person_name}</td>
                    <td className="px-5 py-3 text-gray-600 text-xs">
                      <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                        {appt.role}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {appt.hair_time ? (
                        <div className="flex items-center gap-1 text-amber-700">
                          <Clock className="w-3 h-3" />
                          <span className="text-xs font-medium tabular-nums">{formatTime(appt.hair_time)}</span>
                        </div>
                      ) : (
                        <span className="text-gray-300 text-xs">--</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {appt.makeup_time ? (
                        <div className="flex items-center gap-1 text-pink-700">
                          <Clock className="w-3 h-3" />
                          <span className="text-xs font-medium tabular-nums">{formatTime(appt.makeup_time)}</span>
                        </div>
                      ) : (
                        <span className="text-gray-300 text-xs">--</span>
                      )}
                    </td>
                    <td className="px-5 py-3 hidden lg:table-cell">
                      <div className="flex flex-col gap-0.5 text-xs">
                        {appt.hair_time && (
                          <span className="text-amber-600">{appt.hair_duration || 45}m hair</span>
                        )}
                        {appt.makeup_time && (
                          <span className="text-pink-600">{appt.makeup_duration || 45}m makeup</span>
                        )}
                        {!appt.hair_time && !appt.makeup_time && (
                          <span className="text-gray-300">--</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-400 hidden md:table-cell max-w-[200px] truncate">
                      {appt.notes || <span className="text-gray-300">--</span>}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => openEdit(appt)}
                          className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(appt.id)}
                          className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                {editingId ? 'Edit Appointment' : 'Add Person'}
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
                  value={form.person_name}
                  onChange={(e) => setForm({ ...form, person_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Full name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Scissors className="w-3.5 h-3.5 inline mr-1" />
                    Hair Time
                  </label>
                  <input
                    type="time"
                    value={form.hair_time}
                    onChange={(e) => setForm({ ...form, hair_time: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Sparkles className="w-3.5 h-3.5 inline mr-1" />
                    Makeup Time
                  </label>
                  <input
                    type="time"
                    value={form.makeup_time}
                    onChange={(e) => setForm({ ...form, makeup_time: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Clock className="w-3.5 h-3.5 inline mr-1" />
                    Hair Duration (min)
                  </label>
                  <input
                    type="number"
                    min={15}
                    max={180}
                    step={5}
                    value={form.hair_duration}
                    onChange={(e) => setForm({ ...form, hair_duration: parseInt(e.target.value) || 45 })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Clock className="w-3.5 h-3.5 inline mr-1" />
                    Makeup Duration (min)
                  </label>
                  <input
                    type="number"
                    min={15}
                    max={180}
                    step={5}
                    value={form.makeup_duration}
                    onChange={(e) => setForm({ ...form, makeup_duration: parseInt(e.target.value) || 45 })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
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
                  placeholder="Special requests, allergies, etc."
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
                disabled={!form.person_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Person'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
