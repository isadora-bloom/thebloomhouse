'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Store,
  Plus,
  X,
  Check,
  Edit3,
  Trash2,
  Upload,
  FileText,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  Eye,
} from 'lucide-react'

// TODO: Get from auth session / couple context
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'
const SLUG = 'hawthorne-manor'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BookedVendor {
  id: string
  venue_id: string
  wedding_id: string
  vendor_type: string
  vendor_name: string | null
  vendor_contact: string | null
  notes: string | null
  is_booked: boolean
  contract_uploaded: boolean
  contract_url: string | null
  contract_storage_path: string | null
  contract_date: string | null
  created_at: string
  updated_at: string
}

interface VendorFormData {
  vendor_type: string
  vendor_name: string
  vendor_contact: string
  notes: string
  is_booked: boolean
}

const EMPTY_FORM: VendorFormData = {
  vendor_type: '',
  vendor_name: '',
  vendor_contact: '',
  notes: '',
  is_booked: false,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VENDOR_TYPES = [
  { key: 'photographer', label: 'Photographer', color: '#5D7A7A' },
  { key: 'videographer', label: 'Videographer', color: '#7D8471' },
  { key: 'caterer', label: 'Caterer', color: '#2D8A4E' },
  { key: 'florist', label: 'Florist', color: '#B8908A' },
  { key: 'dj', label: 'DJ', color: '#A6894A' },
  { key: 'band', label: 'Band', color: '#8B6914' },
  { key: 'officiant', label: 'Officiant', color: '#6B7280' },
  { key: 'cake', label: 'Cake / Dessert', color: '#D97706' },
  { key: 'hair', label: 'Hair', color: '#EC4899' },
  { key: 'makeup', label: 'Makeup', color: '#DB2777' },
  { key: 'coordinator', label: 'Coordinator', color: '#3B82F6' },
  { key: 'rentals', label: 'Rentals', color: '#7C3AED' },
  { key: 'transportation', label: 'Transportation', color: '#0891B2' },
] as const

const VENDOR_TYPE_MAP: Record<string, { label: string; color: string }> = {}
for (const vt of VENDOR_TYPES) {
  VENDOR_TYPE_MAP[vt.key] = { label: vt.label, color: vt.color }
}

function getTypeConfig(type: string) {
  return VENDOR_TYPE_MAP[type] || { label: type, color: '#9CA3AF' }
}

// ---------------------------------------------------------------------------
// VendorCard
// ---------------------------------------------------------------------------

function VendorCard({
  vendor,
  onEdit,
  onDelete,
  onUploadContract,
  onViewContract,
  onRemoveContract,
  isUploading,
}: {
  vendor: BookedVendor
  onEdit: () => void
  onDelete: () => void
  onUploadContract: (file: File) => void
  onViewContract: () => void
  onRemoveContract: () => void
  isUploading: boolean
}) {
  const typeConfig = getTypeConfig(vendor.vendor_type)
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div
      className={cn(
        'bg-white rounded-xl shadow-sm border transition-all',
        vendor.is_booked ? 'border-green-300 ring-1 ring-green-100' : 'border-gray-100'
      )}
    >
      <div className="p-5">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: typeConfig.color + '15' }}
            >
              <Store className="w-5 h-5" style={{ color: typeConfig.color }} />
            </div>
            <div className="min-w-0">
              <h3
                className="text-base font-semibold truncate"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {vendor.vendor_name || getTypeConfig(vendor.vendor_type).label}
              </h3>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold text-white"
                  style={{ backgroundColor: typeConfig.color }}
                >
                  {typeConfig.label}
                </span>
                {vendor.is_booked && (
                  <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">
                    <Check className="w-2.5 h-2.5" />
                    Booked
                  </span>
                )}
                {vendor.contract_uploaded && (
                  <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700">
                    <FileText className="w-2.5 h-2.5" />
                    Contract
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onEdit}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
              title="Edit"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Contact */}
        {vendor.vendor_contact && (
          <p className="text-sm text-gray-500 mb-2">{vendor.vendor_contact}</p>
        )}

        {/* Notes */}
        {vendor.notes && (
          <p className="text-sm text-gray-600 leading-relaxed mb-3 line-clamp-3">{vendor.notes}</p>
        )}

        {/* Contract section */}
        <div className="flex items-center gap-2 flex-wrap">
          {vendor.contract_uploaded ? (
            <>
              <button
                onClick={onViewContract}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
              >
                <Eye className="w-3 h-3" />
                View Contract
              </button>
              <button
                onClick={onRemoveContract}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
              >
                <X className="w-3 h-3" />
                Remove
              </button>
              {vendor.contract_date && (
                <span className="text-[11px] text-gray-400">
                  Uploaded {new Date(vendor.contract_date).toLocaleDateString()}
                </span>
              )}
            </>
          ) : (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) onUploadContract(file)
                  e.target.value = ''
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={isUploading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                {isUploading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Upload className="w-3 h-3" />
                )}
                {isUploading ? 'Uploading...' : 'Upload Contract'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty Type Card
// ---------------------------------------------------------------------------

function EmptyTypeCard({
  vendorType,
  onAdd,
}: {
  vendorType: { key: string; label: string; color: string }
  onAdd: () => void
}) {
  return (
    <div className="bg-white/50 rounded-xl border border-dashed border-gray-200 p-5 flex items-center gap-3">
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 opacity-30"
        style={{ backgroundColor: vendorType.color + '15' }}
      >
        <Store className="w-5 h-5" style={{ color: vendorType.color }} />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-gray-400">{vendorType.label}</h3>
        <p className="text-xs text-gray-300">Not yet booked</p>
      </div>
      <button
        onClick={onAdd}
        className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-500 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
      >
        <Plus className="w-3 h-3" />
        Add
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VendorsPage() {
  const [vendors, setVendors] = useState<BookedVendor[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<VendorFormData>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set())
  const [customTypeName, setCustomTypeName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const supabase = createClient()

  // ---- Fetch vendors ----
  const fetchVendors = useCallback(async () => {
    const { data, error: fetchErr } = await supabase
      .from('booked_vendors')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('created_at', { ascending: true })

    if (fetchErr) {
      console.error('Error fetching vendors:', fetchErr)
    }
    if (data) {
      setVendors(data as BookedVendor[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchVendors()
  }, [fetchVendors])

  // ---- Add / Edit vendor ----
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const resolvedType = form.vendor_type === '__custom__' ? (customTypeName.trim() || 'other') : form.vendor_type
    if (!resolvedType) return

    setSaving(true)
    setError(null)

    try {
      if (editingId) {
        // Update
        const { error: updateErr } = await supabase
          .from('booked_vendors')
          .update({
            vendor_type: resolvedType,
            vendor_name: form.vendor_name || null,
            vendor_contact: form.vendor_contact || null,
            notes: form.notes || null,
            is_booked: form.is_booked,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingId)
          .eq('wedding_id', WEDDING_ID)

        if (updateErr) throw updateErr
      } else {
        // Insert
        const { error: insertErr } = await supabase
          .from('booked_vendors')
          .insert({
            venue_id: VENUE_ID,
            wedding_id: WEDDING_ID,
            vendor_type: resolvedType,
            vendor_name: form.vendor_name || null,
            vendor_contact: form.vendor_contact || null,
            notes: form.notes || null,
            is_booked: form.is_booked,
          })

        if (insertErr) throw insertErr
      }

      setCustomTypeName('')
      resetForm()
      fetchVendors()
    } catch (err) {
      console.error('Error saving vendor:', err)
      setError('Failed to save vendor. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  function handleEdit(vendor: BookedVendor) {
    setForm({
      vendor_type: vendor.vendor_type,
      vendor_name: vendor.vendor_name || '',
      vendor_contact: vendor.vendor_contact || '',
      notes: vendor.notes || '',
      is_booked: vendor.is_booked,
    })
    setEditingId(vendor.id)
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this vendor?')) return

    const vendor = vendors.find(v => v.id === id)

    // Remove contract from storage if exists
    if (vendor?.contract_storage_path) {
      await supabase.storage
        .from('vendor-contracts')
        .remove([vendor.contract_storage_path])
    }

    await supabase.from('booked_vendors').delete().eq('id', id)
    fetchVendors()
  }

  function resetForm() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowForm(false)
    setError(null)
  }

  function handleAddForType(typeKey: string) {
    setForm({ ...EMPTY_FORM, vendor_type: typeKey })
    setEditingId(null)
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ---- Contract upload per vendor ----
  async function handleContractUpload(vendorId: string, file: File) {
    setUploadingId(vendorId)

    try {
      const timestamp = Date.now()
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const storagePath = `${WEDDING_ID}/${vendorId}_${timestamp}_${safeName}`

      // Upload to Supabase Storage
      const { error: uploadErr } = await supabase.storage
        .from('vendor-contracts')
        .upload(storagePath, file, { upsert: true })

      if (uploadErr) throw uploadErr

      // Get signed URL (valid for 1 year)
      const { data: urlData } = await supabase.storage
        .from('vendor-contracts')
        .createSignedUrl(storagePath, 60 * 60 * 24 * 365)

      const signedUrl = urlData?.signedUrl || null

      // Update vendor record
      await supabase
        .from('booked_vendors')
        .update({
          contract_uploaded: true,
          contract_url: signedUrl,
          contract_storage_path: storagePath,
          contract_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', vendorId)

      // Also create a contract record for the contracts page
      const ext = file.name.split('.').pop()?.toLowerCase() || ''
      const fileType = ext === 'pdf' ? 'pdf' : ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? 'image' : 'doc'
      const vendor = vendors.find(v => v.id === vendorId)

      await supabase.from('contracts').insert({
        venue_id: VENUE_ID,
        wedding_id: WEDDING_ID,
        filename: file.name,
        file_type: fileType,
        storage_path: storagePath,
        file_url: signedUrl,
        vendor_id: vendorId,
        vendor_name: vendor?.vendor_name || getTypeConfig(vendor?.vendor_type || '').label,
        status: 'uploaded',
      })

      // Trigger AI extraction in the background
      const formData = new FormData()
      if (fileType === 'image') {
        const reader = new FileReader()
        reader.onload = async () => {
          const base64 = (reader.result as string).split(',')[1]
          const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
          }
          try {
            await fetch('/api/couple/contracts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'analyze',
                contractId: vendorId, // Will be the contract record
                imageBase64: base64,
                mediaType: mimeMap[ext] || 'image/jpeg',
              }),
            })
          } catch {
            // Non-blocking — analysis can be triggered from contracts page
          }
        }
        reader.readAsDataURL(file)
      }

      fetchVendors()
    } catch (err) {
      console.error('Contract upload failed:', err)
      setError('Failed to upload contract. Please try again.')
    } finally {
      setUploadingId(null)
    }
  }

  function handleViewContract(vendor: BookedVendor) {
    if (vendor.contract_url) {
      window.open(vendor.contract_url, '_blank')
    }
  }

  async function handleRemoveContract(vendorId: string) {
    if (!confirm('Remove this contract?')) return

    const vendor = vendors.find(v => v.id === vendorId)

    if (vendor?.contract_storage_path) {
      await supabase.storage
        .from('vendor-contracts')
        .remove([vendor.contract_storage_path])
    }

    await supabase
      .from('booked_vendors')
      .update({
        contract_uploaded: false,
        contract_url: null,
        contract_storage_path: null,
        contract_date: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', vendorId)

    fetchVendors()
  }

  // ---- Toggle type section expansion ----
  function toggleType(typeKey: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(typeKey)) {
        next.delete(typeKey)
      } else {
        next.add(typeKey)
      }
      return next
    })
  }

  // ---- Derived data ----
  const bookedCount = vendors.filter(v => v.is_booked).length
  const contractCount = vendors.filter(v => v.contract_uploaded).length
  const typesWithVendors = new Set(vendors.map(v => v.vendor_type))

  // Group vendors by type
  const vendorsByType: Record<string, BookedVendor[]> = {}
  for (const v of vendors) {
    if (!vendorsByType[v.vendor_type]) vendorsByType[v.vendor_type] = []
    vendorsByType[v.vendor_type].push(v)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Your Vendors
          </h1>
          <p className="text-gray-500 text-sm">
            Track your wedding vendors, upload contracts, and keep everything organized.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => { setForm(EMPTY_FORM); setEditingId(null); setShowForm(true) }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add Vendor
          </button>
        )}
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
          <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {bookedCount}
            <span className="text-sm font-normal text-gray-400">/{VENDOR_TYPES.length}</span>
          </p>
          <p className="text-xs text-gray-500 font-medium">Types Booked</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
          <p className="text-2xl font-bold tabular-nums text-emerald-600">{vendors.length}</p>
          <p className="text-xs text-gray-500 font-medium">Total Vendors</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
          <p className="text-2xl font-bold tabular-nums text-blue-600">{contractCount}</p>
          <p className="text-xs text-gray-500 font-medium">Contracts</p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Add / Edit Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between mb-2">
            <h2
              className="text-lg font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              {editingId ? 'Edit Vendor' : 'Add Vendor'}
            </h2>
            <button type="button" onClick={resetForm} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Vendor Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Type *</label>
              <select
                value={form.vendor_type}
                onChange={(e) => setForm({ ...form, vendor_type: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent bg-white text-gray-900"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                required
              >
                <option value="">Select type...</option>
                {VENDOR_TYPES.map(vt => (
                  <option key={vt.key} value={vt.key}>{vt.label}</option>
                ))}
                <option value="__custom__">Other / Custom...</option>
              </select>
              {form.vendor_type === '__custom__' && (
                <input
                  type="text"
                  value={customTypeName}
                  onChange={(e) => setCustomTypeName(e.target.value)}
                  placeholder="e.g., Photo Booth, Calligrapher, Planner..."
                  className="w-full mt-2 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent text-gray-900 placeholder:text-gray-400"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  autoFocus
                />
              )}
            </div>

            {/* Vendor Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Name</label>
              <input
                type="text"
                value={form.vendor_name}
                onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
                placeholder="Company or person name"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent text-gray-900 placeholder:text-gray-400"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>
          </div>

          {/* Contact */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contact Info</label>
            <input
              type="text"
              value={form.vendor_contact}
              onChange={(e) => setForm({ ...form, vendor_contact: e.target.value })}
              placeholder="Email or phone number"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent text-gray-900 placeholder:text-gray-400"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Package details, pricing, special arrangements..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent text-gray-900 placeholder:text-gray-400 resize-none"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          </div>

          {/* Booked toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <div
              className={cn(
                'relative w-10 h-6 rounded-full transition-colors',
                form.is_booked ? 'bg-green-500' : 'bg-gray-200'
              )}
              onClick={() => setForm({ ...form, is_booked: !form.is_booked })}
            >
              <div
                className={cn(
                  'absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform',
                  form.is_booked ? 'translate-x-[18px]' : 'translate-x-0.5'
                )}
              />
            </div>
            <span className="text-sm text-gray-700 font-medium">
              {form.is_booked ? 'Booked & Confirmed' : 'Not yet booked'}
            </span>
          </label>

          {/* Submit */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving || !form.vendor_type}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {saving ? 'Saving...' : editingId ? 'Update Vendor' : 'Add Vendor'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="px-5 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Vendor list by type */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-28 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {VENDOR_TYPES.map((vt) => {
            const typeVendors = vendorsByType[vt.key] || []
            const hasVendors = typeVendors.length > 0
            const isExpanded = expandedTypes.has(vt.key) || hasVendors
            const bookedInType = typeVendors.filter(v => v.is_booked).length

            return (
              <div key={vt.key} className="space-y-2">
                {/* Type header */}
                <button
                  onClick={() => toggleType(vt.key)}
                  className="w-full flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100 shadow-sm hover:bg-gray-50 transition-colors"
                >
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: vt.color }}
                  />
                  <span
                    className="text-sm font-semibold flex-1 text-left"
                    style={{ color: 'var(--couple-primary)' }}
                  >
                    {vt.label}
                  </span>
                  {hasVendors ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">
                        {typeVendors.length} vendor{typeVendors.length !== 1 ? 's' : ''}
                      </span>
                      {bookedInType > 0 && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">
                          <Check className="w-2 h-2" />
                          {bookedInType} booked
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-gray-300">Not added</span>
                  )}
                  {hasVendors ? (
                    isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />
                  ) : (
                    <Plus
                      className="w-4 h-4 text-gray-300"
                      onClick={(e) => { e.stopPropagation(); handleAddForType(vt.key) }}
                    />
                  )}
                </button>

                {/* Expanded cards */}
                {isExpanded && hasVendors && (
                  <div className="pl-6 space-y-3">
                    {typeVendors.map((vendor) => (
                      <VendorCard
                        key={vendor.id}
                        vendor={vendor}
                        onEdit={() => handleEdit(vendor)}
                        onDelete={() => handleDelete(vendor.id)}
                        onUploadContract={(file) => handleContractUpload(vendor.id, file)}
                        onViewContract={() => handleViewContract(vendor)}
                        onRemoveContract={() => handleRemoveContract(vendor.id)}
                        isUploading={uploadingId === vendor.id}
                      />
                    ))}
                    {/* Add another of this type */}
                    <button
                      onClick={() => handleAddForType(vt.key)}
                      className="w-full flex items-center justify-center gap-2 p-3 border border-dashed border-gray-200 rounded-xl text-sm text-gray-400 hover:text-gray-600 hover:border-gray-300 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add another {vt.label.toLowerCase()}
                    </button>
                  </div>
                )}

                {/* Empty: show add prompt when expanded */}
                {isExpanded && !hasVendors && (
                  <div className="pl-6">
                    <EmptyTypeCard vendorType={vt} onAdd={() => handleAddForType(vt.key)} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Bottom: link to preferred vendors */}
      {!loading && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 text-center">
          <p className="text-sm text-gray-500 mb-2">
            Looking for vendor recommendations from your venue?
          </p>
          <a
            href={`/couple/${SLUG}/preferred-vendors`}
            className="inline-flex items-center gap-1.5 text-sm font-medium transition-colors hover:opacity-80"
            style={{ color: 'var(--couple-accent)' }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            View Preferred Vendors
          </a>
        </div>
      )}
    </div>
  )
}
