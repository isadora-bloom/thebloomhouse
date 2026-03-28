'use client'

// Feature: configurable via venue_config.feature_flags
// Table: staffing_assignments

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Users,
  Plus,
  X,
  Edit2,
  Trash2,
  DollarSign,
  Calculator,
  Info,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceType = 'buffet' | 'plated' | 'passed' | 'family_style' | 'stations'
type StaffRole = 'bartender' | 'server' | 'runner' | 'line_cook' | 'coordinator' | 'dj_band' | 'photographer' | 'videographer' | 'florist' | 'officiant' | 'other'
type StaffModel = 'in_house' | 'external' | 'hybrid'

interface StaffAssignment {
  id: string
  role: StaffRole
  person_name: string | null
  company_name: string | null
  count: number
  hourly_rate: number | null
  hours: number | null
  tip_amount: number | null
  is_venue_provided: boolean
  notes: string | null
  sort_order: number
}

interface StaffFormData {
  role: StaffRole
  person_name: string
  company_name: string
  count: string
  hourly_rate: string
  hours: string
  tip_amount: string
  is_venue_provided: boolean
  notes: string
}

const SERVICE_TYPES: { key: ServiceType; label: string; description: string }[] = [
  { key: 'buffet', label: 'Buffet', description: 'Self-serve food stations' },
  { key: 'plated', label: 'Plated', description: 'Individual courses served to each guest' },
  { key: 'passed', label: 'Passed Appetizers', description: 'Tray-passed hors d\'oeuvres' },
  { key: 'family_style', label: 'Family Style', description: 'Shared platters at each table' },
  { key: 'stations', label: 'Food Stations', description: 'Themed food stations with attendants' },
]

const STAFF_ROLES: { key: StaffRole; label: string; category: 'service' | 'vendor' }[] = [
  { key: 'bartender', label: 'Bartender', category: 'service' },
  { key: 'server', label: 'Server', category: 'service' },
  { key: 'runner', label: 'Runner', category: 'service' },
  { key: 'line_cook', label: 'Line Cook', category: 'service' },
  { key: 'coordinator', label: 'Coordinator', category: 'vendor' },
  { key: 'dj_band', label: 'DJ / Band', category: 'vendor' },
  { key: 'photographer', label: 'Photographer', category: 'vendor' },
  { key: 'videographer', label: 'Videographer', category: 'vendor' },
  { key: 'florist', label: 'Florist', category: 'vendor' },
  { key: 'officiant', label: 'Officiant', category: 'vendor' },
  { key: 'other', label: 'Other', category: 'vendor' },
]

const EMPTY_FORM: StaffFormData = {
  role: 'server',
  person_name: '',
  company_name: '',
  count: '1',
  hourly_rate: '',
  hours: '',
  tip_amount: '',
  is_venue_provided: false,
  notes: '',
}

// ---------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------

function calcRecommendedStaff(guestCount: number, serviceType: ServiceType) {
  if (guestCount <= 0) return null

  const recs: Record<string, { count: number; ratio: string }> = {}

  // Bartenders: 1 per 50 guests, min 2
  recs.bartender = { count: Math.max(2, Math.ceil(guestCount / 50)), ratio: '1 per 50 guests' }

  // Service staff depends on service type
  switch (serviceType) {
    case 'plated':
      recs.server = { count: Math.ceil(guestCount / 12), ratio: '1 per 12 guests' }
      recs.runner = { count: Math.ceil(guestCount / 30), ratio: '1 per 30 guests' }
      recs.line_cook = { count: Math.max(2, Math.ceil(guestCount / 40)), ratio: '1 per 40 guests' }
      break
    case 'buffet':
      recs.server = { count: Math.ceil(guestCount / 25), ratio: '1 per 25 guests' }
      recs.runner = { count: Math.ceil(guestCount / 50), ratio: '1 per 50 guests' }
      recs.line_cook = { count: Math.max(2, Math.ceil(guestCount / 50)), ratio: '1 per 50 guests' }
      break
    case 'family_style':
      recs.server = { count: Math.ceil(guestCount / 15), ratio: '1 per 15 guests' }
      recs.runner = { count: Math.ceil(guestCount / 40), ratio: '1 per 40 guests' }
      recs.line_cook = { count: Math.max(2, Math.ceil(guestCount / 40)), ratio: '1 per 40 guests' }
      break
    case 'passed':
      recs.server = { count: Math.ceil(guestCount / 20), ratio: '1 per 20 guests' }
      recs.runner = { count: Math.ceil(guestCount / 50), ratio: '1 per 50 guests' }
      recs.line_cook = { count: Math.max(1, Math.ceil(guestCount / 50)), ratio: '1 per 50 guests' }
      break
    case 'stations':
      recs.server = { count: Math.ceil(guestCount / 20), ratio: '1 per 20 guests' }
      recs.runner = { count: Math.ceil(guestCount / 40), ratio: '1 per 40 guests' }
      recs.line_cook = { count: Math.max(2, Math.ceil(guestCount / 35)), ratio: '1 per 35 guests' }
      break
  }

  return recs
}

function roleLabel(role: StaffRole): string {
  return STAFF_ROLES.find((r) => r.key === role)?.label || role
}

// ---------------------------------------------------------------------------
// Staffing Guide Page
// ---------------------------------------------------------------------------

export default function StaffingGuidePage() {
  const [assignments, setAssignments] = useState<StaffAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<StaffFormData>(EMPTY_FORM)

  // Planning state
  const [guestCount, setGuestCount] = useState(100)
  const [serviceType, setServiceType] = useState<ServiceType>('plated')
  const [staffModel, setStaffModel] = useState<StaffModel>('external')
  const [showCalculator, setShowCalculator] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchAssignments = useCallback(async () => {
    const { data, error } = await supabase
      .from('staffing_assignments')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('sort_order', { ascending: true })

    if (!error && data) {
      setAssignments(data as StaffAssignment[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchAssignments()
  }, [fetchAssignments])

  // ---- Calculations ----
  const recommendations = calcRecommendedStaff(guestCount, serviceType)

  const totalCost = useMemo(() => {
    let total = 0
    for (const a of assignments) {
      if (a.hourly_rate && a.hours) {
        total += a.hourly_rate * a.hours * a.count
      }
      if (a.tip_amount) {
        total += a.tip_amount
      }
    }
    return total
  }, [assignments])

  const serviceStaff = assignments.filter((a) => STAFF_ROLES.find((r) => r.key === a.role)?.category === 'service')
  const vendorStaff = assignments.filter((a) => STAFF_ROLES.find((r) => r.key === a.role)?.category === 'vendor')

  // ---- Modal helpers ----
  function openAdd(role?: StaffRole) {
    setForm({ ...EMPTY_FORM, role: role || 'server' })
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(assignment: StaffAssignment) {
    setForm({
      role: assignment.role,
      person_name: assignment.person_name || '',
      company_name: assignment.company_name || '',
      count: assignment.count.toString(),
      hourly_rate: assignment.hourly_rate?.toString() || '',
      hours: assignment.hours?.toString() || '',
      tip_amount: assignment.tip_amount?.toString() || '',
      is_venue_provided: assignment.is_venue_provided,
      notes: assignment.notes || '',
    })
    setEditingId(assignment.id)
    setShowModal(true)
  }

  async function handleSave() {
    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      role: form.role,
      person_name: form.person_name.trim() || null,
      company_name: form.company_name.trim() || null,
      count: parseInt(form.count) || 1,
      hourly_rate: form.hourly_rate ? parseFloat(form.hourly_rate) : null,
      hours: form.hours ? parseFloat(form.hours) : null,
      tip_amount: form.tip_amount ? parseFloat(form.tip_amount) : null,
      is_venue_provided: form.is_venue_provided,
      notes: form.notes.trim() || null,
    }

    if (editingId) {
      await supabase.from('staffing_assignments').update(payload).eq('id', editingId)
    } else {
      await supabase.from('staffing_assignments').insert({
        ...payload,
        sort_order: assignments.length,
      })
    }

    setShowModal(false)
    setEditingId(null)
    fetchAssignments()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this staff assignment?')) return
    await supabase.from('staffing_assignments').delete().eq('id', id)
    fetchAssignments()
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-32 bg-gray-100 rounded-xl" />
        <div className="h-48 bg-gray-100 rounded-xl" />
      </div>
    )
  }

  function renderStaffRow(assignment: StaffAssignment) {
    const lineCost = (assignment.hourly_rate && assignment.hours)
      ? assignment.hourly_rate * assignment.hours * assignment.count
      : null

    return (
      <div key={assignment.id} className="flex items-start gap-3 px-4 py-3 group hover:bg-gray-50/50 transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-gray-800">{roleLabel(assignment.role)}</span>
            {assignment.count > 1 && (
              <span className="text-xs text-gray-400">x{assignment.count}</span>
            )}
            {assignment.is_venue_provided && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                Venue Provided
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400">
            {(assignment.person_name || assignment.company_name) && (
              <span>{[assignment.person_name, assignment.company_name].filter(Boolean).join(' - ')}</span>
            )}
            {assignment.hourly_rate && assignment.hours && (
              <span>${assignment.hourly_rate}/hr x {assignment.hours}h</span>
            )}
            {assignment.tip_amount && (
              <span>+ ${assignment.tip_amount} tip</span>
            )}
          </div>
          {assignment.notes && (
            <p className="text-xs text-gray-400 mt-1 italic">{assignment.notes}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lineCost !== null && (
            <span className="text-sm font-medium text-gray-600 tabular-nums">
              ${(lineCost + (assignment.tip_amount || 0)).toFixed(0)}
            </span>
          )}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => openEdit(assignment)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => handleDelete(assignment.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
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
            Staffing Guide
          </h1>
          <p className="text-gray-500 text-sm">Plan service staff and vendor assignments for your event.</p>
        </div>
        <button
          onClick={() => openAdd()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Staff
        </button>
      </div>

      {/* Service type + Staff model */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Service Style</label>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {SERVICE_TYPES.map((st) => (
              <button
                key={st.key}
                onClick={() => setServiceType(st.key)}
                className={cn(
                  'text-left p-2.5 rounded-lg border text-xs transition-colors',
                  serviceType === st.key
                    ? 'text-white border-transparent'
                    : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white'
                )}
                style={serviceType === st.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
              >
                <div className="font-medium">{st.label}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Guest Count</label>
            <input
              type="number"
              value={guestCount}
              onChange={(e) => setGuestCount(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              min={0}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Staff Model</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { key: 'in_house' as StaffModel, label: 'Venue Staff' },
                { key: 'external' as StaffModel, label: 'External' },
                { key: 'hybrid' as StaffModel, label: 'Hybrid' },
              ]).map((sm) => (
                <button
                  key={sm.key}
                  onClick={() => setStaffModel(sm.key)}
                  className={cn(
                    'px-3 py-2 rounded-lg border text-xs font-medium transition-colors',
                    staffModel === sm.key
                      ? 'text-white border-transparent'
                      : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white'
                  )}
                  style={staffModel === sm.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                >
                  {sm.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {staffModel === 'in_house' && (
          <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-100 rounded-lg text-sm text-emerald-800">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Your venue provides service staff. The recommendations below can help set expectations with your venue coordinator. You may still need external vendors for photography, music, etc.</p>
          </div>
        )}
      </div>

      {/* Staff Calculator */}
      {recommendations && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowCalculator(!showCalculator)}
            className="w-full flex items-center justify-between p-5"
          >
            <div className="flex items-center gap-2">
              <Calculator className="w-5 h-5" style={{ color: 'var(--couple-primary)' }} />
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Recommended Staffing
              </h2>
            </div>
            {showCalculator ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
          </button>

          {showCalculator && (
            <div className="px-5 pb-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {Object.entries(recommendations).map(([role, rec]) => (
                  <div key={role} className="p-3 bg-gray-50 rounded-lg text-center">
                    <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
                      {rec.count}
                    </p>
                    <p className="text-xs font-medium text-gray-700">{roleLabel(role as StaffRole)}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">{rec.ratio}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 text-center mt-3">
                Based on {guestCount} guests with {SERVICE_TYPES.find((s) => s.key === serviceType)?.label.toLowerCase()} service. Adjust to your needs.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Staff Assignments */}
      {assignments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Users className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No staff assigned yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Add your service staff and vendors to track assignments and costs.</p>
          <button
            onClick={() => openAdd()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Staff
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Service Staff */}
          {serviceStaff.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Service Staff</h3>
              </div>
              <div className="divide-y divide-gray-50">
                {serviceStaff.map(renderStaffRow)}
              </div>
            </div>
          )}

          {/* Vendors */}
          {vendorStaff.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Vendors</h3>
              </div>
              <div className="divide-y divide-gray-50">
                {vendorStaff.map(renderStaffRow)}
              </div>
            </div>
          )}

          {/* Total cost */}
          {totalCost > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <DollarSign className="w-5 h-5" style={{ color: 'var(--couple-primary)' }} />
                <span className="text-sm font-medium text-gray-700">Estimated Staff Cost</span>
              </div>
              <span className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
                ${totalCost.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </span>
            </div>
          )}
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
                {editingId ? 'Edit Staff' : 'Add Staff'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as StaffRole })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  <optgroup label="Service Staff">
                    {STAFF_ROLES.filter((r) => r.category === 'service').map((r) => (
                      <option key={r.key} value={r.key}>{r.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Vendors">
                    {STAFF_ROLES.filter((r) => r.category === 'vendor').map((r) => (
                      <option key={r.key} value={r.key}>{r.label}</option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Person Name</label>
                  <input
                    type="text"
                    value={form.person_name}
                    onChange={(e) => setForm({ ...form, person_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="Optional"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
                  <input
                    type="text"
                    value={form.company_name}
                    onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="Optional"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Count</label>
                <input
                  type="number"
                  value={form.count}
                  onChange={(e) => setForm({ ...form, count: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  min={1}
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">$/Hour</label>
                  <input
                    type="number"
                    value={form.hourly_rate}
                    onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="Rate"
                    min={0}
                    step="0.50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Hours</label>
                  <input
                    type="number"
                    value={form.hours}
                    onChange={(e) => setForm({ ...form, hours: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="Hours"
                    min={0}
                    step="0.5"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tip</label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                    <input
                      type="number"
                      value={form.tip_amount}
                      onChange={(e) => setForm({ ...form, tip_amount: e.target.value })}
                      className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                      placeholder="Tip"
                      min={0}
                    />
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  checked={form.is_venue_provided}
                  onChange={(e) => setForm({ ...form, is_venue_provided: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300"
                  style={{ accentColor: 'var(--couple-primary)' }}
                />
                Provided by venue (included in package)
              </label>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Arrival time, attire, special instructions..."
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
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Staff'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
