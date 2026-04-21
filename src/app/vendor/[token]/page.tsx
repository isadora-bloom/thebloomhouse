'use client'

// Public vendor self-service page: vendors update their own info via token link
// No auth required — the token IS the auth

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Check, Loader2, Save, ExternalLink } from 'lucide-react'

interface VendorData {
  id: string
  vendor_type: string
  vendor_name: string
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  website: string | null
  instagram: string | null
  arrival_time: string | null
  departure_time: string | null
  notes: string | null
  wedding_date: string | null
  couple_names: string | null
}

export default function VendorPortalPage() {
  const { token } = useParams<{ token: string }>()
  const [vendor, setVendor] = useState<VendorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    fetch(`/api/vendor-portal/${token}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => { setVendor(d); setLoading(false) })
      .catch(() => { setNotFound(true); setLoading(false) })
  }, [token])

  const handleSave = async () => {
    if (!vendor) return
    setSaving(true); setError(null); setSaved(false)
    try {
      const res = await fetch(`/api/vendor-portal/${token}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vendor),
      })
      if (!res.ok) throw new Error('Save failed')
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch {
      setError('Could not save. Please try again.')
    }
    setSaving(false)
  }

  const set = (field: keyof VendorData, value: string) => {
    setVendor(prev => prev ? { ...prev, [field]: value } : null)
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
    </div>
  )

  if (notFound || !vendor) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center text-center px-6">
      <div>
        <p className="text-2xl font-serif text-gray-800 mb-2">Link not found</p>
        <p className="text-gray-500 text-sm">This vendor link may have expired or been removed.</p>
      </div>
    </div>
  )

  const inputCls = "w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-300"

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <p className="text-sm text-gray-500 mb-1">Vendor Portal</p>
          <h1 className="text-2xl font-serif text-gray-900">{vendor.vendor_name || vendor.vendor_type}</h1>
          {vendor.couple_names && (
            <p className="text-gray-500 mt-1">{vendor.couple_names}{vendor.wedding_date ? ` — ${new Date(vendor.wedding_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}</p>
          )}
        </div>

        {/* Form */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contact Name</label>
            <input className={inputCls} value={vendor.contact_name || ''} onChange={e => set('contact_name', e.target.value)} placeholder="Your name" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" className={inputCls} value={vendor.contact_email || ''} onChange={e => set('contact_email', e.target.value)} placeholder="email@company.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input type="tel" className={inputCls} value={vendor.contact_phone || ''} onChange={e => set('contact_phone', e.target.value)} placeholder="(555) 123-4567" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Website</label>
              <input type="url" className={inputCls} value={vendor.website || ''} onChange={e => set('website', e.target.value)} placeholder="https://..." />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Instagram</label>
              <input className={inputCls} value={vendor.instagram || ''} onChange={e => set('instagram', e.target.value)} placeholder="@handle" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Time</label>
              <input className={inputCls} value={vendor.arrival_time || ''} onChange={e => set('arrival_time', e.target.value)} placeholder="e.g. 11:00 AM" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Departure Time</label>
              <input className={inputCls} value={vendor.departure_time || ''} onChange={e => set('departure_time', e.target.value)} placeholder="e.g. 10:00 PM" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes for the Coordinator</label>
            <textarea className={inputCls} rows={3} value={vendor.notes || ''} onChange={e => set('notes', e.target.value)}
              placeholder="Setup requirements, crew size, special requests..." />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button onClick={handleSave} disabled={saving}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 transition">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : saved ? 'Saved!' : 'Update Information'}
          </button>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          This link is unique to you. Please don&apos;t share it.
        </p>
      </div>
    </div>
  )
}
