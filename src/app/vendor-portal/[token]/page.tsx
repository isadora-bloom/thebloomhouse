'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import {
  Save,
  Loader2,
  CheckCircle,
  AlertCircle,
  Globe,
  Phone,
  Mail,
  DollarSign,
  Tag,
  Image,
  Plus,
  X,
  Link2,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VendorData {
  id: string
  vendor_name: string
  vendor_type: string | null
  contact_email: string | null
  contact_phone: string | null
  website_url: string | null
  description: string | null
  logo_url: string | null
  bio: string | null
  instagram_url: string | null
  facebook_url: string | null
  pricing_info: string | null
  special_offer: string | null
  offer_expires_at: string | null
  portfolio_photos: string[] | null
  last_updated_by_vendor: string | null
  venue_name: string | null
}

// ---------------------------------------------------------------------------
// Vendor Portal Page
// ---------------------------------------------------------------------------

export default function VendorPortalPage() {
  const params = useParams()
  const token = params.token as string

  const [vendor, setVendor] = useState<VendorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Form state
  const [bio, setBio] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [instagramUrl, setInstagramUrl] = useState('')
  const [facebookUrl, setFacebookUrl] = useState('')
  const [pricingInfo, setPricingInfo] = useState('')
  const [specialOffer, setSpecialOffer] = useState('')
  const [offerExpiresAt, setOfferExpiresAt] = useState('')
  const [portfolioPhotos, setPortfolioPhotos] = useState<string[]>([])
  const [newPhotoUrl, setNewPhotoUrl] = useState('')

  // Load vendor data on mount
  useEffect(() => {
    async function loadVendor() {
      try {
        const res = await fetch(`/api/public/vendor-portal?token=${encodeURIComponent(token)}`)

        if (!res.ok) {
          if (res.status === 404) {
            setError('This vendor portal link is invalid or has expired.')
          } else {
            setError('Something went wrong. Please try again later.')
          }
          setLoading(false)
          return
        }

        const { data } = await res.json()
        setVendor(data)

        // Populate form
        setBio(data.bio || '')
        setContactEmail(data.contact_email || '')
        setContactPhone(data.contact_phone || '')
        setWebsiteUrl(data.website_url || '')
        setInstagramUrl(data.instagram_url || '')
        setFacebookUrl(data.facebook_url || '')
        setPricingInfo(data.pricing_info || '')
        setSpecialOffer(data.special_offer || '')
        setOfferExpiresAt(data.offer_expires_at || '')
        setPortfolioPhotos(data.portfolio_photos || [])
      } catch {
        setError('Failed to load vendor information.')
      } finally {
        setLoading(false)
      }
    }

    loadVendor()
  }, [token])

  // Clear toast after 4 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/public/vendor-portal', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          bio: bio || null,
          contact_email: contactEmail || null,
          contact_phone: contactPhone || null,
          website_url: websiteUrl || null,
          instagram_url: instagramUrl || null,
          facebook_url: facebookUrl || null,
          pricing_info: pricingInfo || null,
          special_offer: specialOffer || null,
          offer_expires_at: offerExpiresAt || null,
          portfolio_photos: portfolioPhotos,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Save failed')
      }

      const { data } = await res.json()
      setVendor((prev) => (prev ? { ...prev, ...data } : prev))
      setToast({ type: 'success', message: 'Your information has been saved.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save'
      setToast({ type: 'error', message })
    } finally {
      setSaving(false)
    }
  }

  function addPhoto() {
    const url = newPhotoUrl.trim()
    if (!url) return
    if (portfolioPhotos.length >= 8) {
      setToast({ type: 'error', message: 'Maximum 8 photos allowed.' })
      return
    }
    setPortfolioPhotos((prev) => [...prev, url])
    setNewPhotoUrl('')
  }

  function removePhoto(index: number) {
    setPortfolioPhotos((prev) => prev.filter((_, i) => i !== index))
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h1 className="text-lg font-semibold text-gray-700 mb-2">Portal Not Available</h1>
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    )
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    )
  }

  if (!vendor) return null

  return (
    <div className="min-h-screen bg-white">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 animate-in fade-in slide-in-from-top-2">
          <div
            className={`flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
              toast.type === 'success'
                ? 'bg-green-50 text-green-800 border border-green-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            {toast.type === 'success' ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
            {toast.message}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="border-b border-gray-100">
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="flex items-center gap-3">
            {vendor.logo_url ? (
              <img
                src={vendor.logo_url}
                alt={vendor.vendor_name}
                className="w-12 h-12 rounded-lg object-cover"
              />
            ) : (
              <div className="w-12 h-12 rounded-lg bg-sage-100 flex items-center justify-center">
                <span className="text-sage-600 font-semibold text-lg">
                  {vendor.vendor_name.charAt(0)}
                </span>
              </div>
            )}
            <div>
              <h1 className="text-xl font-semibold text-gray-900" style={{ fontFamily: 'var(--font-heading)' }}>
                {vendor.vendor_name}
              </h1>
              <p className="text-sm text-gray-500">
                {vendor.vendor_type ? `${vendor.vendor_type} vendor` : 'Vendor'} at {vendor.venue_name || 'venue'}
              </p>
            </div>
          </div>
          {vendor.last_updated_by_vendor && (
            <p className="text-xs text-gray-400 mt-2">
              Last updated {new Date(vendor.last_updated_by_vendor).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>

      {/* Form */}
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        {/* Bio */}
        <section>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            About Your Business
          </label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={4}
            placeholder="Tell couples about your business, experience, and what makes you unique..."
            className="w-full rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent resize-none"
          />
        </section>

        {/* Contact Info */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 mb-3 uppercase tracking-wider">
            Contact Information
          </h2>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Mail className="w-4 h-4 text-gray-400 shrink-0" />
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="your@email.com"
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-3">
              <Phone className="w-4 h-4 text-gray-400 shrink-0" />
              <input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="(555) 123-4567"
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-3">
              <Globe className="w-4 h-4 text-gray-400 shrink-0" />
              <input
                type="url"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://yourwebsite.com"
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
              />
            </div>
          </div>
        </section>

        {/* Social Links */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 mb-3 uppercase tracking-wider">
            Social Media
          </h2>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Link2 className="w-4 h-4 text-gray-400 shrink-0" />
              <input
                type="url"
                value={instagramUrl}
                onChange={(e) => setInstagramUrl(e.target.value)}
                placeholder="https://instagram.com/yourbusiness"
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-3">
              <Link2 className="w-4 h-4 text-gray-400 shrink-0" />
              <input
                type="url"
                value={facebookUrl}
                onChange={(e) => setFacebookUrl(e.target.value)}
                placeholder="https://facebook.com/yourbusiness"
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
              />
            </div>
          </div>
        </section>

        {/* Pricing Info */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 mb-3 uppercase tracking-wider">
            Pricing
          </h2>
          <div className="flex items-start gap-3">
            <DollarSign className="w-4 h-4 text-gray-400 shrink-0 mt-3" />
            <textarea
              value={pricingInfo}
              onChange={(e) => setPricingInfo(e.target.value)}
              rows={3}
              placeholder="Describe your pricing structure, packages, starting rates, etc."
              className="flex-1 rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent resize-none"
            />
          </div>
        </section>

        {/* Special Offer */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 mb-3 uppercase tracking-wider">
            Special Offer
          </h2>
          <div className="flex items-start gap-3">
            <Tag className="w-4 h-4 text-gray-400 shrink-0 mt-3" />
            <div className="flex-1 space-y-3">
              <textarea
                value={specialOffer}
                onChange={(e) => setSpecialOffer(e.target.value)}
                rows={2}
                placeholder="Any current promotion or special offer for couples at this venue?"
                className="w-full rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent resize-none"
              />
              <div>
                <label className="block text-xs text-gray-500 mb-1">Offer expires</label>
                <input
                  type="date"
                  value={offerExpiresAt}
                  onChange={(e) => setOfferExpiresAt(e.target.value)}
                  className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Portfolio Photos */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 mb-3 uppercase tracking-wider">
            Portfolio Photos
          </h2>
          <p className="text-xs text-gray-500 mb-3">
            Add up to 8 photo URLs to showcase your work.
          </p>

          {/* Current photos grid */}
          {portfolioPhotos.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              {portfolioPhotos.map((url, i) => (
                <div key={i} className="relative group aspect-square rounded-lg overflow-hidden bg-gray-100">
                  <img
                    src={url}
                    alt={`Portfolio ${i + 1}`}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).src = ''
                      ;(e.target as HTMLImageElement).className = 'hidden'
                    }}
                  />
                  <button
                    onClick={() => removePhoto(i)}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add photo URL */}
          {portfolioPhotos.length < 8 && (
            <div className="flex items-center gap-3">
              <Image className="w-4 h-4 text-gray-400 shrink-0" />
              <input
                type="url"
                value={newPhotoUrl}
                onChange={(e) => setNewPhotoUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addPhoto()
                  }
                }}
                placeholder="https://example.com/photo.jpg"
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
              />
              <button
                onClick={addPhoto}
                disabled={!newPhotoUrl.trim()}
                className="shrink-0 px-3 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
        </section>

        {/* Save Button */}
        <div className="pt-4 border-t border-gray-100">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full sm:w-auto px-8 py-3 rounded-lg bg-sage-500 text-white text-sm font-medium hover:bg-sage-600 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Changes
              </>
            )}
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 py-6 text-center">
        <p className="text-xs text-gray-400">
          Powered by{' '}
          <span className="font-medium text-sage-500">Bloom House</span>
        </p>
      </div>
    </div>
  )
}
