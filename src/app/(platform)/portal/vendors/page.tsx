'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  VENDOR_ATTRIBUTES,
  VENDOR_TYPE_KEYS,
  normaliseVendorType,
  vendorTypeLabel,
} from '@/lib/vendors/vendor-types'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  Store,
  Plus,
  Star,
  Mail,
  Phone,
  Globe,
  Edit,
  X,
  Search,
  MousePointerClick,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vendor {
  id: string
  venue_id: string
  vendor_name: string
  vendor_type: string
  contact_email: string | null
  contact_phone: string | null
  website_url: string | null
  description: string | null
  is_preferred: boolean
  click_count: number
  created_at: string
  // Couple-facing filters and badges (migration 417).
  is_local: boolean | null
  is_budget_friendly: boolean | null
  has_multiple_events: boolean | null
}

interface VendorForm {
  name: string
  type: string
  email: string
  phone: string
  website: string
  description: string
  preferred: boolean
  isLocal: boolean
  isBudgetFriendly: boolean
  hasMultipleEvents: boolean
}

const EMPTY_FORM: VendorForm = {
  name: '',
  type: '',
  email: '',
  phone: '',
  website: '',
  description: '',
  preferred: false,
  isLocal: false,
  isBudgetFriendly: false,
  hasMultipleEvents: false,
}

/**
 * The dropdown used to offer Title Case labels and write them straight
 * into vendor_type, while the couple page keyed its labels on lowercase
 * snake_case. Every vendor added here showed up to couples as "Other".
 * The options now carry the canonical key as their value.
 */
const VENDOR_TYPE_OPTIONS = VENDOR_TYPE_KEYS.map((key) => ({
  key,
  label: vendorTypeLabel(key),
}))

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keyed on the canonical vendor_type, so a legacy spelling still lands. */
function typeConfig(type: string): { bg: string; text: string } {
  const map: Record<string, { bg: string; text: string }> = {
    photographer:   { bg: 'bg-purple-50',   text: 'text-purple-700' },
    videographer:   { bg: 'bg-indigo-50',   text: 'text-indigo-700' },
    florist:        { bg: 'bg-rose-50',     text: 'text-rose-700' },
    dj:             { bg: 'bg-sky-50',      text: 'text-sky-700' },
    band:           { bg: 'bg-violet-50',   text: 'text-violet-700' },
    music:          { bg: 'bg-violet-50',   text: 'text-violet-700' },
    caterer:        { bg: 'bg-orange-50',   text: 'text-orange-700' },
    baker:          { bg: 'bg-amber-50',    text: 'text-amber-700' },
    bartender:      { bg: 'bg-cyan-50',     text: 'text-cyan-700' },
    officiant:      { bg: 'bg-teal-50',     text: 'text-teal-700' },
    hair_makeup:    { bg: 'bg-pink-50',     text: 'text-pink-700' },
    planner:        { bg: 'bg-emerald-50',  text: 'text-emerald-700' },
    rentals:        { bg: 'bg-cyan-50',     text: 'text-cyan-700' },
    lighting:       { bg: 'bg-gold-50',     text: 'text-gold-700' },
    transportation: { bg: 'bg-sage-100',    text: 'text-sage-700' },
    stationery:     { bg: 'bg-lime-50',     text: 'text-lime-700' },
  }
  return map[normaliseVendorType(type)] ?? { bg: 'bg-sage-50', text: 'text-sage-600' }
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function VendorCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-5 w-36 bg-sage-100 rounded" />
          <div className="h-5 w-20 bg-sage-100 rounded-full" />
        </div>
        <div className="h-4 w-full bg-sage-50 rounded" />
        <div className="h-4 w-2/3 bg-sage-50 rounded" />
        <div className="flex gap-3">
          <div className="h-4 w-24 bg-sage-50 rounded" />
          <div className="h-4 w-24 bg-sage-50 rounded" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vendor Card
// ---------------------------------------------------------------------------

function VendorCard({
  vendor,
  onEdit,
}: {
  vendor: Vendor
  onEdit: (vendor: Vendor) => void
}) {
  const config = typeConfig(vendor.vendor_type)

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="font-heading text-base font-semibold text-sage-900 truncate">
            {vendor.vendor_name}
          </h3>
          {vendor.is_preferred && (
            <Star className="w-4 h-4 text-gold-500 fill-gold-500 shrink-0" />
          )}
        </div>
        <button
          onClick={() => onEdit(vendor)}
          className="p-1.5 rounded-md hover:bg-sage-50 transition-colors shrink-0"
          title="Edit vendor"
        >
          <Edit className="w-4 h-4 text-sage-400" />
        </button>
      </div>

      {/* Type badge */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
          {vendorTypeLabel(vendor.vendor_type)}
        </span>
        {vendor.is_preferred && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gold-100 text-gold-700">
            Preferred
          </span>
        )}
        {/* The same badges the couple sees, so this page shows what they get */}
        {VENDOR_ATTRIBUTES.filter((a) => a.badgeLabel && a.test(vendor)).map((a) => (
          <span
            key={a.key}
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${a.badgeClass}`}
          >
            {a.badgeLabel}
          </span>
        ))}
        {vendor.click_count > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-sage-500">
            <MousePointerClick className="w-3 h-3" />
            {vendor.click_count} click{vendor.click_count !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Description */}
      {vendor.description && (
        <p className="text-sm text-sage-600 leading-relaxed mb-4 line-clamp-2">
          {vendor.description}
        </p>
      )}

      {/* Contact info */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-sage-500">
        {vendor.contact_email && (
          <a
            href={`mailto:${vendor.contact_email}`}
            className="flex items-center gap-1 hover:text-sage-700 transition-colors"
          >
            <Mail className="w-3 h-3" />
            {vendor.contact_email}
          </a>
        )}
        {vendor.contact_phone && (
          <a
            href={`tel:${vendor.contact_phone}`}
            className="flex items-center gap-1 hover:text-sage-700 transition-colors"
          >
            <Phone className="w-3 h-3" />
            {vendor.contact_phone}
          </a>
        )}
        {vendor.website_url && (
          <a
            href={vendor.website_url.startsWith('http') ? vendor.website_url : `https://${vendor.website_url}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-sage-700 transition-colors"
          >
            <Globe className="w-3 h-3" />
            Website
          </a>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add/Edit Modal
// ---------------------------------------------------------------------------

function VendorModal({
  form,
  setForm,
  onSave,
  onClose,
  saving,
  saveError,
  isEditing,
}: {
  form: VendorForm
  setForm: (fn: (f: VendorForm) => VendorForm) => void
  onSave: () => void
  onClose: () => void
  saving: boolean
  saveError: string | null
  isEditing: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-surface rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-border">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="font-heading text-xl font-bold text-sage-900">
            {isEditing ? 'Edit Vendor' : 'Add Vendor'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5 text-sage-500" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1.5">
              Vendor Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g., Sarah Jones Photography"
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1.5">
              Type
            </label>
            <select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            >
              <option value="">Select type...</option>
              {VENDOR_TYPE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
              {/* A stored spelling outside the canonical set keeps its
                  place in the dropdown, so editing a name does not
                  silently recategorise the vendor. */}
              {form.type && !VENDOR_TYPE_KEYS.includes(form.type) && (
                <option value={form.type}>{vendorTypeLabel(form.type)}</option>
              )}
            </select>
          </div>

          {/* Email + Phone */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="vendor@email.com"
                className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1.5">
                Phone
              </label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="(555) 123-4567"
                className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
              />
            </div>
          </div>

          {/* Website */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1.5">
              Website
            </label>
            <input
              type="url"
              value={form.website}
              onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
              placeholder="https://example.com"
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1.5">
              Description
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of this vendor..."
              rows={3}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none transition-colors"
            />
          </div>

          {/* Preferred toggle */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, preferred: !f.preferred }))}
              className={cn(
                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                form.preferred ? 'bg-gold-500' : 'bg-sage-200'
              )}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform',
                  form.preferred ? 'translate-x-6' : 'translate-x-1'
                )}
              />
            </button>
            <div className="flex items-center gap-1.5">
              <Star className={cn('w-4 h-4', form.preferred ? 'text-gold-500 fill-gold-500' : 'text-sage-300')} />
              <span className="text-sm font-medium text-sage-700">
                Preferred Vendor
              </span>
            </div>
          </div>

          {/* What couples can filter on. Migration 417 / Rixey parity. */}
          <div className="pt-2 border-t border-border">
            <p className="text-sm font-medium text-sage-700 mb-1">
              What couples can filter on
            </p>
            <p className="text-xs text-sage-500 mb-3">
              Each one becomes a filter at the top of the couple&apos;s vendor list, and a
              badge on this vendor&apos;s card.
            </p>
            <div className="space-y-2">
              {(
                [
                  ['isLocal', 'Local to the venue'],
                  ['isBudgetFriendly', 'Budget-friendly'],
                  ['hasMultipleEvents', 'Has worked here more than once'],
                ] as const
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center gap-2.5 text-sm text-sage-700 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                    className="w-4 h-4 rounded border-border text-sage-600 focus:ring-sage-300"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 p-6 border-t border-border">
          {saveError && (
            <p className="text-sm text-red-600" role="alert">
              {saveError}
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-sage-600 bg-sage-50 rounded-lg hover:bg-sage-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving || !form.name.trim() || !form.type}
            className="px-4 py-2 text-sm font-medium text-white bg-sage-600 rounded-lg hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Vendor'}
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function VendorsPage() {
  const VENUE_ID = useVenueId()
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null)
  const [form, setForm] = useState<VendorForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // ---- Fetch data ----
  const fetchData = useCallback(async () => {
    const supabase = createClient()

    try {
      const { data, error: fetchErr } = await supabase
        .from('vendor_recommendations')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .order('is_preferred', { ascending: false })
        .order('vendor_type', { ascending: true })
        .order('vendor_name', { ascending: true })

      if (fetchErr) throw fetchErr

      setVendors((data ?? []) as Vendor[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch vendors:', err)
      setError('Failed to load vendor recommendations')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Modal actions ----
  function openCreateModal() {
    setEditingVendor(null)
    setForm(EMPTY_FORM)
    setSaveError(null)
    setModalOpen(true)
  }

  function openEditModal(vendor: Vendor) {
    setEditingVendor(vendor)
    setForm({
      name: vendor.vendor_name,
      // Normalise on the way into the form so opening and saving an old
      // row quietly migrates its spelling.
      type: normaliseVendorType(vendor.vendor_type),
      email: vendor.contact_email ?? '',
      phone: vendor.contact_phone ?? '',
      website: vendor.website_url ?? '',
      description: vendor.description ?? '',
      preferred: vendor.is_preferred,
      isLocal: vendor.is_local === true,
      isBudgetFriendly: vendor.is_budget_friendly === true,
      hasMultipleEvents: vendor.has_multiple_events === true,
    })
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditingVendor(null)
    setForm(EMPTY_FORM)
    setSaveError(null)
  }

  async function handleSave() {
    const supabase = createClient()
    setSaving(true)

    const payload = {
      venue_id: VENUE_ID,
      vendor_name: form.name.trim(),
      vendor_type: normaliseVendorType(form.type),
      contact_email: form.email.trim() || null,
      contact_phone: form.phone.trim() || null,
      website_url: form.website.trim() || null,
      description: form.description.trim() || null,
      is_preferred: form.preferred,
      is_local: form.isLocal,
      is_budget_friendly: form.isBudgetFriendly,
      has_multiple_events: form.hasMultipleEvents,
    }

    setSaveError(null)
    try {
      if (editingVendor) {
        const { error: updateErr } = await supabase
          .from('vendor_recommendations')
          .update(payload)
          .eq('id', editingVendor.id)

        if (updateErr) throw updateErr
      } else {
        const { error: insertErr } = await supabase
          .from('vendor_recommendations')
          .insert(payload)

        if (insertErr) throw insertErr
      }

      closeModal()
      fetchData()
    } catch (err) {
      // The modal stays open on failure and used to say nothing at all,
      // so a coordinator who ticked a box and hit Save could not tell
      // whether it had landed. Theme 1 of the parity audit, staff side.
      console.error('Failed to save vendor:', err)
      setSaveError(
        err instanceof Error ? err.message : 'Could not save this vendor. Try again.'
      )
    } finally {
      setSaving(false)
    }
  }

  // ---- Filter + sort ----
  const vendorTypes = Array.from(new Set(vendors.map((v) => normaliseVendorType(v.vendor_type))))
    .sort((a, b) => vendorTypeLabel(a).localeCompare(vendorTypeLabel(b)))

  const filteredVendors = vendors.filter((v) => {
    if (typeFilter !== 'all' && normaliseVendorType(v.vendor_type) !== typeFilter) return false
    if (!searchQuery.trim()) return true
    const q = searchQuery.toLowerCase()
    return (
      v.vendor_name.toLowerCase().includes(q) ||
      // Both the stored value and its label, so "photography" still finds
      // a row now folded to photographer.
      v.vendor_type.toLowerCase().includes(q) ||
      vendorTypeLabel(v.vendor_type).toLowerCase().includes(q) ||
      (v.description ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Vendor Recommendations
          </h1>
          <p className="text-sage-600">
            Your curated list of preferred vendors that couples can browse and contact directly. Add vendor details, mark favorites, and track which vendors get the most interest.
          </p>
        </div>
        <button
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Vendor
        </button>
      </div>

      {/* ---- Error state ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Store className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Search + Type Filter ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Type filter pills */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setTypeFilter('all')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              typeFilter === 'all'
                ? 'bg-sage-600 text-white'
                : 'bg-sage-100 text-sage-700 hover:bg-sage-200'
            )}
          >
            All
          </button>
          {vendorTypes.map((type) => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                typeFilter === type
                  ? 'bg-sage-600 text-white'
                  : 'bg-sage-100 text-sage-700 hover:bg-sage-200'
              )}
            >
              {vendorTypeLabel(type)}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search vendors..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Vendor Cards ---- */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <VendorCardSkeleton key={i} />
          ))}
        </div>
      ) : filteredVendors.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Store className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {searchQuery || typeFilter !== 'all' ? 'No matching vendors' : 'No vendors yet'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {searchQuery
              ? `No vendors match "${searchQuery}". Try a different search.`
              : typeFilter !== 'all'
                ? `No ${vendorTypeLabel(typeFilter)} vendors found. Try a different filter.`
                : 'Add your first vendor recommendation to help couples find the best pros for their day.'}
          </p>
          {!searchQuery && typeFilter === 'all' && (
            <button
              onClick={openCreateModal}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Vendor
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredVendors.map((vendor) => (
            <VendorCard
              key={vendor.id}
              vendor={vendor}
              onEdit={openEditModal}
            />
          ))}
        </div>
      )}

      {/* ---- Modal ---- */}
      {modalOpen && (
        <VendorModal
          form={form}
          setForm={setForm}
          onSave={handleSave}
          onClose={closeModal}
          saving={saving}
          saveError={saveError}
          isEditing={!!editingVendor}
        />
      )}
    </div>
  )
}
