'use client'

// Feature: configurable via venue_config.feature_flags
// Table: allergy_registry

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  Plus,
  Trash2,
  ShieldAlert,
  Check,
  X,
  Moon,
  Bell,
  Download,
  Link2,
  Loader2,
} from 'lucide-react'


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = 'mild' | 'moderate' | 'severe'

interface AllergyRecord {
  id: string
  guest_name: string
  allergy: string
  severity: Severity
  caterer_alerted: boolean
  staying_overnight: boolean
  notes: string | null
  guest_id: string | null
  created_at: string
}

interface AllergyFormData {
  guest_name: string
  allergy: string
  severity: Severity
  caterer_alerted: boolean
  staying_overnight: boolean
  notes: string
}

const EMPTY_FORM: AllergyFormData = {
  guest_name: '',
  allergy: '',
  severity: 'mild',
  caterer_alerted: false,
  staying_overnight: false,
  notes: '',
}

// ---------------------------------------------------------------------------
// Severity configs
// ---------------------------------------------------------------------------

const SEVERITY_OPTIONS: { key: Severity; label: string }[] = [
  { key: 'mild', label: 'Mild' },
  { key: 'moderate', label: 'Moderate' },
  { key: 'severe', label: 'Severe / Anaphylactic' },
]

function severityCardBg(severity: Severity): string {
  switch (severity) {
    case 'severe': return 'bg-red-50 border-red-200'
    case 'moderate': return 'bg-amber-50 border-amber-200'
    default: return 'bg-white border-gray-100'
  }
}

function severityBadge(severity: Severity): { bg: string; text: string; label: string } {
  switch (severity) {
    case 'severe':
      return { bg: 'bg-red-100', text: 'text-red-800', label: 'Severe / Anaphylactic' }
    case 'moderate':
      return { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Moderate' }
    default:
      return { bg: 'bg-sage-100 bg-green-100', text: 'text-green-800', label: 'Mild' }
  }
}

// ---------------------------------------------------------------------------
// CheckToggle component
// ---------------------------------------------------------------------------

function CheckToggle({
  label,
  checked,
  onChange,
  icon,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  icon?: React.ReactNode
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600 mb-1.5">
        {icon}
        {label}
      </label>
      <div className="flex gap-2">
        {[true, false].map((opt) => (
          <button
            key={String(opt)}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
              checked === opt
                ? 'text-white border-transparent'
                : 'text-gray-500 border-gray-200 hover:border-gray-300 bg-white',
            )}
            style={checked === opt ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            {opt ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AllergyRegistryPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [records, setRecords] = useState<AllergyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState<string | null>(null)

  // Inline form state
  const [formMode, setFormMode] = useState<'hidden' | 'add' | 'edit'>('hidden')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<AllergyFormData>(EMPTY_FORM)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchRecords = useCallback(async () => {
    if (!weddingId) return
    const { data, error } = await supabase
      .from('allergy_registry')
      .select('*')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: true })

    if (!error && data) {
      setRecords(data as AllergyRecord[])
    }
    setLoading(false)
  }, [supabase, weddingId])

  useEffect(() => {
    if (weddingId) fetchRecords()
  }, [fetchRecords, weddingId])

  // ---- Derived ----
  const severeCount = records.filter((r) => r.severity === 'severe').length
  const unalertedCount = records.filter((r) => !r.caterer_alerted).length

  // ---- Form actions ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setFormMode('add')
  }

  function openEdit(record: AllergyRecord) {
    setForm({
      guest_name: record.guest_name,
      allergy: record.allergy,
      severity: record.severity,
      caterer_alerted: record.caterer_alerted,
      staying_overnight: record.staying_overnight,
      notes: record.notes || '',
    })
    setEditingId(record.id)
    setFormMode('edit')
  }

  function cancelForm() {
    setFormMode('hidden')
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  async function handleSave() {
    if (!form.guest_name.trim() || !form.allergy.trim()) return
    if (!venueId || !weddingId) return

    const payload = {
      venue_id: venueId,
      wedding_id: weddingId,
      guest_name: form.guest_name.trim(),
      allergy: form.allergy.trim(),
      severity: form.severity,
      caterer_alerted: form.caterer_alerted,
      staying_overnight: form.staying_overnight,
      notes: form.notes.trim() || null,
    }

    if (editingId) {
      await supabase.from('allergy_registry').update(payload).eq('id', editingId)
    } else {
      await supabase.from('allergy_registry').insert(payload)
    }

    cancelForm()
    fetchRecords()
  }

  async function handleDelete(id: string) {
    await supabase.from('allergy_registry').delete().eq('id', id)
    setDeleteConfirm(null)
    fetchRecords()
  }

  // ---- Import from Guest List ----
  async function handleImportFromGuests() {
    if (!venueId || !weddingId) return
    setImporting(true)
    setImportMessage(null)

    try {
      // Fetch guests with dietary restrictions
      const { data: guestsWithDietary, error: guestError } = await supabase
        .from('guest_list')
        .select('id, first_name, last_name, dietary_restrictions')
        .eq('wedding_id', weddingId)
        .not('dietary_restrictions', 'is', null)
        .neq('dietary_restrictions', '')

      if (guestError) {
        setImportMessage(`Error fetching guests: ${guestError.message}`)
        return
      }

      if (!guestsWithDietary || guestsWithDietary.length === 0) {
        setImportMessage('No guests with dietary information found.')
        return
      }

      // Check which guests already have allergy entries
      const existingGuestIds = new Set(
        records.filter((r) => r.guest_id).map((r) => r.guest_id)
      )
      const existingGuestNames = new Set(
        records.map((r) => r.guest_name.toLowerCase())
      )

      let importedCount = 0

      for (const guest of guestsWithDietary) {
        const guestName = [guest.first_name, guest.last_name].filter(Boolean).join(' ').trim()
        if (!guestName) continue

        // Skip if already exists by guest_id or guest_name
        if (existingGuestIds.has(guest.id)) continue
        if (existingGuestNames.has(guestName.toLowerCase())) continue

        const { error: insertError } = await supabase.from('allergy_registry').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          guest_name: guestName,
          allergy: guest.dietary_restrictions,
          severity: 'moderate',
          guest_id: guest.id,
        })

        if (!insertError) {
          importedCount++
          // Add to existing sets to prevent duplicates within this batch
          existingGuestIds.add(guest.id)
          existingGuestNames.add(guestName.toLowerCase())
        }
      }

      if (importedCount > 0) {
        setImportMessage(`Imported ${importedCount} guest${importedCount !== 1 ? 's' : ''} with dietary information.`)
        fetchRecords()
      } else {
        setImportMessage('All guests with dietary info are already in the registry.')
      }
    } catch (err) {
      setImportMessage('Import failed. Please try again.')
    } finally {
      setImporting(false)
    }
  }

  // ---- Loading ----
  if (contextLoading || !venueId || !weddingId || loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-lg" />
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
            Allergy Registry
          </h1>
          <p className="text-gray-500 text-sm">
            Track guest allergies for safe catering coordination.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleImportFromGuests}
            disabled={importing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {importing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {importing ? 'Importing...' : 'Import from Guest List'}
          </button>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add Allergy
          </button>
        </div>
      </div>

      {/* Import message */}
      {importMessage && (
        <div className="flex items-center justify-between gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
          <p>{importMessage}</p>
          <button
            onClick={() => setImportMessage(null)}
            className="text-blue-400 hover:text-blue-600 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Alert banner */}
      <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
        <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-500" />
        <div>
          <p className="font-medium">Share this list with your caterer before the wedding</p>
          {unalertedCount > 0 && (
            <p className="text-xs text-amber-600 mt-1">
              {unalertedCount} allerg{unalertedCount === 1 ? 'y' : 'ies'} not yet communicated to caterer.
            </p>
          )}
        </div>
      </div>

      {/* Summary stats */}
      {records.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {records.length}
            </p>
            <p className="text-xs text-gray-500 font-medium">Total Entries</p>
          </div>
          <div className="bg-red-50 rounded-xl p-4 border border-red-100 text-center">
            <p className="text-2xl font-bold text-red-700 tabular-nums">{severeCount}</p>
            <p className="text-xs text-red-600 font-medium">Severe</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {new Set(records.map((r) => r.guest_name)).size}
            </p>
            <p className="text-xs text-gray-500 font-medium">Guests</p>
          </div>
        </div>
      )}

      {/* Records list */}
      {records.length === 0 && formMode === 'hidden' ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <ShieldAlert
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No allergies logged yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            Track guest allergies so your catering team is prepared.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handleImportFromGuests}
              disabled={importing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              Import from Guest List
            </button>
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add First Allergy
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {records.map((record) => {
            const sev = severityBadge(record.severity)
            const cardBg = severityCardBg(record.severity)
            const isDeleting = deleteConfirm === record.id

            return (
              <div
                key={record.id}
                className={cn(
                  'rounded-xl border shadow-sm p-4 group hover:shadow-md transition-shadow',
                  cardBg,
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Name + severity + linked icon */}
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-medium text-gray-800">{record.guest_name}</span>
                      {record.guest_id && (
                        <span
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-600"
                          title="Linked to guest list"
                        >
                          <Link2 className="w-3 h-3" />
                        </span>
                      )}
                      <span
                        className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium',
                          sev.bg,
                          sev.text,
                        )}
                      >
                        {sev.label}
                      </span>
                    </div>

                    {/* Allergy */}
                    <p className="text-sm text-gray-700 mb-1">{record.allergy}</p>

                    {/* Status indicators */}
                    <div className="flex items-center gap-3 flex-wrap text-xs">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium',
                          record.caterer_alerted
                            ? 'bg-green-100 text-green-700'
                            : 'bg-orange-100 text-orange-700',
                        )}
                      >
                        <Bell className="w-3 h-3" />
                        {record.caterer_alerted ? 'Caterer alerted' : 'Not alerted'}
                      </span>
                      {record.staying_overnight && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                          <Moon className="w-3 h-3" />
                          Staying overnight
                        </span>
                      )}
                    </div>

                    {/* Notes */}
                    {record.notes && (
                      <p className="text-xs text-gray-500 mt-2 italic">{record.notes}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {isDeleting ? (
                      <>
                        <button
                          onClick={() => handleDelete(record.id)}
                          className="p-1.5 rounded-md text-red-500 hover:bg-red-50"
                          title="Confirm delete"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100"
                          title="Cancel"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => openEdit(record)}
                          className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Edit"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(record.id)}
                          className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Inline add/edit form */}
      {formMode !== 'hidden' && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
          <h3
            className="text-sm font-semibold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {formMode === 'edit' ? 'Edit Allergy' : 'Add Allergy'}
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Guest name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Guest Name *</label>
              <input
                type="text"
                value={form.guest_name}
                onChange={(e) => setForm({ ...form, guest_name: e.target.value })}
                placeholder="Guest's full name"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>

            {/* Allergy */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Allergy *</label>
              <input
                type="text"
                value={form.allergy}
                onChange={(e) => setForm({ ...form, allergy: e.target.value })}
                placeholder="e.g. Peanuts, Shellfish, Gluten"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>
          </div>

          {/* Severity buttons */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Severity</label>
            <div className="flex flex-wrap gap-2">
              {SEVERITY_OPTIONS.map((opt) => {
                const selected = form.severity === opt.key
                let activeBg = 'var(--couple-primary)'
                if (opt.key === 'severe') activeBg = '#dc2626'
                if (opt.key === 'moderate') activeBg = '#d97706'

                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setForm({ ...form, severity: opt.key })}
                    className={cn(
                      'px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors',
                      selected
                        ? 'text-white border-transparent'
                        : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white',
                    )}
                    style={selected ? { backgroundColor: activeBg } : undefined}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Toggles row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CheckToggle
              label="Caterer Alerted"
              checked={form.caterer_alerted}
              onChange={(v) => setForm({ ...form, caterer_alerted: v })}
              icon={<Bell className="w-3.5 h-3.5 text-gray-400" />}
            />
            <CheckToggle
              label="Staying Overnight"
              checked={form.staying_overnight}
              onChange={(v) => setForm({ ...form, staying_overnight: v })}
              icon={<Moon className="w-3.5 h-3.5 text-gray-400" />}
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              placeholder="EpiPen on hand, specific brand reactions, dietary substitutes..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-3 pt-1">
            <button
              onClick={cancelForm}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!form.guest_name.trim() || !form.allergy.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              {formMode === 'edit' ? 'Save Changes' : 'Add Allergy'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
