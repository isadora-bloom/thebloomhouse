'use client'

import { useState, useEffect, useCallback } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { FONT_PAIRS, getFontUrl } from '@/config/fonts'
import { useScope, type Scope } from '@/lib/hooks/use-scope'
import {
  Settings, Palette, Type, Save, Eye, Building2, User, Clock, DollarSign,
  Layers, ArrowRight, Plus, Trash2, Image as ImageIcon, X,
} from 'lucide-react'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface VenueConfig {
  id: string
  venue_id: string
  business_name: string | null
  coordinator_name: string | null
  coordinator_email: string | null
  coordinator_phone: string | null
  timezone: string
  capacity: number | null
  base_price: number | null
  catering_model: string
  bar_model: string
  primary_color: string
  secondary_color: string
  accent_color: string
  font_pair: string
  portal_tagline: string | null
  logo_url: string | null
}

interface VenueRow {
  id: string
  name: string
  slug: string | null
  capacity: number | null
  base_price: number | null
  coordinator_name: string | null
  logo_url: string | null
  primary_color: string | null
  secondary_color: string | null
  accent_color: string | null
  business_name: string | null
  brand_description: string | null
}

interface BrandAsset {
  id: string
  venue_id: string
  asset_type: string
  label: string
  url: string
  sort_order: number
  created_at: string
  venues?: { name: string | null } | null
}

const ASSET_TYPE_OPTIONS = [
  { value: 'logo', label: 'Logo' },
  { value: 'hero_image', label: 'Hero Image' },
  { value: 'watercolor', label: 'Watercolor' },
  { value: 'photography', label: 'Photography' },
  { value: 'texture', label: 'Texture' },
  { value: 'icon', label: 'Icon' },
  { value: 'other', label: 'Other' },
]

const ASSET_TYPE_COLORS: Record<string, string> = {
  logo: 'bg-purple-50 text-purple-700',
  hero_image: 'bg-teal-50 text-teal-700',
  watercolor: 'bg-sky-50 text-sky-700',
  photography: 'bg-amber-50 text-amber-700',
  texture: 'bg-rose-50 text-rose-700',
  icon: 'bg-indigo-50 text-indigo-700',
  other: 'bg-sage-50 text-sage-700',
}

const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
]

const CATERING_OPTIONS = [
  { value: 'in_house', label: 'In-House Catering' },
  { value: 'byob', label: 'BYOB (Bring Your Own)' },
  { value: 'preferred_list', label: 'Preferred Vendor List' },
]

const BAR_OPTIONS = [
  { value: 'in_house', label: 'In-House Bar' },
  { value: 'byob', label: 'BYOB (Bring Your Own)' },
  { value: 'hybrid', label: 'Hybrid' },
]

const fontPairKeys = Object.keys(FONT_PAIRS)

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors'

const selectClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors'

// Hex color helper to lighten for background tint
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function switchToVenue(venueId: string, venueName: string, companyName?: string) {
  const newScope = { level: 'venue', venueId, venueName, companyName }
  document.cookie = `bloom_scope=${encodeURIComponent(JSON.stringify(newScope))}; path=/; max-age=${60 * 60 * 24 * 365}`
  document.cookie = `bloom_venue=${venueId}; path=/; max-age=${60 * 60 * 24 * 365}`
  window.location.reload()
}

export default function SettingsPage() {
  const scope = useScope()

  if (scope.level === 'venue') {
    return <VenueSettings scope={scope} />
  }
  return <BrandSettings scope={scope} />
}

/* ================================================================== */
/* Venue Settings — existing editor, now scoped by scope.venueId        */
/* ================================================================== */
function VenueSettings({ scope }: { scope: Scope & { loading: boolean } }) {
  const [config, setConfig] = useState<VenueConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  // Brand assets state
  const [brandAssets, setBrandAssets] = useState<BrandAsset[]>([])
  const [showAssetForm, setShowAssetForm] = useState(false)
  const [newAssetType, setNewAssetType] = useState('photography')
  const [newAssetLabel, setNewAssetLabel] = useState('')
  const [newAssetUrl, setNewAssetUrl] = useState('')
  const [savingAsset, setSavingAsset] = useState(false)

  // Load venue config for the scoped venue
  useEffect(() => {
    if (scope.loading) return
    async function load() {
      if (!scope.venueId) {
        setLoading(false)
        return
      }
      const { data, error } = await supabase
        .from('venue_config')
        .select('*')
        .eq('venue_id', scope.venueId)
        .maybeSingle()

      if (error) {
        console.error('Failed to load venue config:', error)
      }
      if (data) {
        setConfig(data as VenueConfig)
      }

      // Load brand assets
      if (scope.venueId) {
        const { data: assets } = await supabase
          .from('brand_assets')
          .select('*')
          .eq('venue_id', scope.venueId)
          .order('sort_order', { ascending: true })
        setBrandAssets((assets ?? []) as BrandAsset[])
      }

      setLoading(false)
    }
    load()
  }, [scope.venueId, scope.loading])

  // Save handler
  const handleSave = useCallback(async () => {
    if (!config) return
    setSaving(true)
    setSaveMessage(null)

    const { error } = await supabase
      .from('venue_config')
      .update({
        business_name: config.business_name,
        coordinator_name: config.coordinator_name,
        coordinator_email: config.coordinator_email,
        coordinator_phone: config.coordinator_phone,
        timezone: config.timezone,
        capacity: config.capacity,
        base_price: config.base_price,
        catering_model: config.catering_model,
        bar_model: config.bar_model,
        primary_color: config.primary_color,
        secondary_color: config.secondary_color,
        accent_color: config.accent_color,
        font_pair: config.font_pair,
        portal_tagline: config.portal_tagline,
        logo_url: config.logo_url,
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id)

    if (error) {
      console.error('Save failed:', error)
      setSaveMessage('Failed to save. Please try again.')
    } else {
      setSaveMessage('Settings saved successfully.')
    }
    setSaving(false)
    setTimeout(() => setSaveMessage(null), 3000)
  }, [config])

  // Updater helper
  function update<K extends keyof VenueConfig>(key: K, value: VenueConfig[K]) {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  // Brand asset handlers
  const handleAddAsset = useCallback(async () => {
    if (!scope.venueId || !newAssetLabel.trim() || !newAssetUrl.trim()) return
    setSavingAsset(true)
    const { data, error } = await supabase
      .from('brand_assets')
      .insert({
        venue_id: scope.venueId,
        asset_type: newAssetType,
        label: newAssetLabel.trim(),
        url: newAssetUrl.trim(),
        sort_order: brandAssets.length,
      })
      .select()
      .single()
    if (!error && data) {
      setBrandAssets((prev) => [...prev, data as BrandAsset])
      setNewAssetLabel('')
      setNewAssetUrl('')
      setNewAssetType('photography')
      setShowAssetForm(false)
    }
    setSavingAsset(false)
  }, [scope.venueId, newAssetType, newAssetLabel, newAssetUrl, brandAssets.length])

  const handleDeleteAsset = useCallback(async (assetId: string) => {
    const { error } = await supabase.from('brand_assets').delete().eq('id', assetId)
    if (!error) {
      setBrandAssets((prev) => prev.filter((a) => a.id !== assetId))
    }
  }, [])

  // Current font pair for preview
  const currentFontPair = FONT_PAIRS[config?.font_pair ?? 'playfair_inter'] ?? FONT_PAIRS.playfair_inter
  const fontUrl = getFontUrl(config?.font_pair ?? 'playfair_inter')

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-pulse text-sage-500 text-sm">Loading venue settings...</div>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-sage-500 text-sm">
          No venue configuration found for {scope.venueName ?? 'this venue'}. Please seed your database first.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Inject Google Font for preview */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href={fontUrl} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <Settings className="w-8 h-8 text-sage-500" />
            Venue Settings {scope.venueName && <span className="text-sage-500">— {scope.venueName}</span>}
          </h1>
          <p className="text-sage-600">Configure your venue&apos;s core details — business info, contact details, pricing, branding colors, fonts, and logo. Changes here affect your couple portal, AI emails, and all client-facing materials.</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-6 py-2.5 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Save feedback */}
      {saveMessage && (
        <div className={`px-4 py-2 rounded-lg text-sm font-medium ${
          saveMessage.includes('success') ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {saveMessage}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* General Info Section                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Building2 className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">General Information</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Business Name */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Business Name</label>
            <input
              type="text"
              value={config.business_name ?? ''}
              onChange={(e) => update('business_name', e.target.value)}
              placeholder="Your Venue Name"
              className={inputClasses}
            />
          </div>

          {/* Timezone */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />Timezone</span>
            </label>
            <select
              value={config.timezone}
              onChange={(e) => update('timezone', e.target.value)}
              className={selectClasses}
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          {/* Capacity */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Max Capacity</label>
            <input
              type="number"
              value={config.capacity ?? ''}
              onChange={(e) => update('capacity', e.target.value ? parseInt(e.target.value, 10) : null)}
              placeholder="250"
              className={inputClasses}
            />
          </div>

          {/* Base Price */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              <span className="flex items-center gap-1.5"><DollarSign className="w-3.5 h-3.5" />Base Price</span>
            </label>
            <input
              type="number"
              value={config.base_price ?? ''}
              onChange={(e) => update('base_price', e.target.value ? parseFloat(e.target.value) : null)}
              placeholder="8500"
              className={inputClasses}
            />
          </div>

          {/* Catering Model */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Catering Model</label>
            <select
              value={config.catering_model}
              onChange={(e) => update('catering_model', e.target.value)}
              className={selectClasses}
            >
              {CATERING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Bar Model */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Bar Model</label>
            <select
              value={config.bar_model}
              onChange={(e) => update('bar_model', e.target.value)}
              className={selectClasses}
            >
              {BAR_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Coordinator */}
        <div className="pt-4 border-t border-border">
          <div className="flex items-center gap-2 mb-4">
            <User className="w-4 h-4 text-sage-500" />
            <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider">Coordinator</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">Name</label>
              <input
                type="text"
                value={config.coordinator_name ?? ''}
                onChange={(e) => update('coordinator_name', e.target.value)}
                placeholder="Jane Smith"
                className={inputClasses}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">Email</label>
              <input
                type="email"
                value={config.coordinator_email ?? ''}
                onChange={(e) => update('coordinator_email', e.target.value)}
                placeholder="coordinator@venue.com"
                className={inputClasses}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">Phone</label>
              <input
                type="tel"
                value={config.coordinator_phone ?? ''}
                onChange={(e) => update('coordinator_phone', e.target.value)}
                placeholder="(555) 123-4567"
                className={inputClasses}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Branding Section                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-8">
        <div className="flex items-center gap-2 mb-2">
          <Palette className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Branding</h2>
        </div>

        {/* Colors */}
        <div>
          <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider mb-4">Brand Colors</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {/* Primary Color */}
            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">Primary Color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={config.primary_color}
                  onChange={(e) => update('primary_color', e.target.value)}
                  className="w-12 h-10 rounded-lg border border-border cursor-pointer"
                />
                <input
                  type="text"
                  value={config.primary_color}
                  onChange={(e) => {
                    const val = e.target.value
                    if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) update('primary_color', val)
                  }}
                  className={inputClasses + ' font-mono text-sm'}
                  maxLength={7}
                />
              </div>
            </div>

            {/* Secondary Color */}
            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">Secondary Color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={config.secondary_color}
                  onChange={(e) => update('secondary_color', e.target.value)}
                  className="w-12 h-10 rounded-lg border border-border cursor-pointer"
                />
                <input
                  type="text"
                  value={config.secondary_color}
                  onChange={(e) => {
                    const val = e.target.value
                    if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) update('secondary_color', val)
                  }}
                  className={inputClasses + ' font-mono text-sm'}
                  maxLength={7}
                />
              </div>
            </div>

            {/* Accent Color */}
            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">Accent Color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={config.accent_color}
                  onChange={(e) => update('accent_color', e.target.value)}
                  className="w-12 h-10 rounded-lg border border-border cursor-pointer"
                />
                <input
                  type="text"
                  value={config.accent_color}
                  onChange={(e) => {
                    const val = e.target.value
                    if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) update('accent_color', val)
                  }}
                  className={inputClasses + ' font-mono text-sm'}
                  maxLength={7}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Font Pair Selector */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Type className="w-4 h-4 text-sage-500" />
            <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider">Font Pair</h3>
          </div>
          <select
            value={config.font_pair}
            onChange={(e) => update('font_pair', e.target.value)}
            className={selectClasses + ' max-w-md'}
          >
            {fontPairKeys.map((key) => {
              const pair = FONT_PAIRS[key]
              return (
                <option key={key} value={key}>
                  {pair.label} &mdash; {pair.description}
                </option>
              )
            })}
          </select>
          <p className="text-xs text-sage-500 mt-2">
            {currentFontPair.label}: {currentFontPair.description}
          </p>
        </div>

        {/* Portal Tagline */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-1">Portal Tagline</label>
          <input
            type="text"
            value={config.portal_tagline ?? ''}
            onChange={(e) => update('portal_tagline', e.target.value)}
            placeholder="Your dream wedding starts here"
            className={inputClasses + ' max-w-lg'}
          />
          <p className="text-xs text-sage-500 mt-1">Shown on the couple portal login page.</p>
        </div>

        {/* Logo Upload */}
        <div>
          <label className="block text-sm font-medium text-sage-700 mb-1">Business Logo</label>
          <div className="flex items-start gap-4">
            {config.logo_url && (
              <div className="shrink-0">
                <img
                  src={config.logo_url}
                  alt="Business logo"
                  className="w-20 h-20 object-contain rounded-lg border border-sage-200 bg-white p-1"
                />
              </div>
            )}
            <div className="flex-1 space-y-2">
              <input
                type="text"
                value={config.logo_url ?? ''}
                onChange={(e) => update('logo_url', e.target.value || null)}
                placeholder="Paste a logo URL or upload to Supabase Storage"
                className={inputClasses + ' max-w-lg'}
              />
              <p className="text-xs text-sage-500">
                Appears in the portal, client-facing emails, and branded materials.
                Upload your logo to Supabase Storage and paste the public URL here.
              </p>
            </div>
          </div>
        </div>

        {/* Brand Assets */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <label className="block text-sm font-medium text-sage-700">Brand Assets</label>
              <p className="text-xs text-sage-500 mt-0.5">
                Venue photography, watercolors, textures, and icons used across emails, proposals, and the portal.
              </p>
            </div>
            <button
              onClick={() => setShowAssetForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Upload Asset
            </button>
          </div>

          {/* Add asset form */}
          {showAssetForm && (
            <div className="mb-4 p-4 border border-sage-200 rounded-xl bg-warm-white space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-sage-800">New Brand Asset</h4>
                <button onClick={() => setShowAssetForm(false)} className="p-1 text-sage-400 hover:text-sage-600">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">Type</label>
                  <select
                    value={newAssetType}
                    onChange={(e) => setNewAssetType(e.target.value)}
                    className={selectClasses + ' text-sm'}
                  >
                    {ASSET_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">Label</label>
                  <input
                    type="text"
                    value={newAssetLabel}
                    onChange={(e) => setNewAssetLabel(e.target.value)}
                    placeholder="e.g. Garden Ceremony Shot"
                    className={inputClasses + ' text-sm'}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">URL</label>
                  <input
                    type="text"
                    value={newAssetUrl}
                    onChange={(e) => setNewAssetUrl(e.target.value)}
                    placeholder="https://..."
                    className={inputClasses + ' text-sm'}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleAddAsset}
                  disabled={!newAssetLabel.trim() || !newAssetUrl.trim() || savingAsset}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingAsset ? 'Saving...' : 'Save Asset'}
                </button>
              </div>
            </div>
          )}

          {/* Asset grid */}
          {brandAssets.length === 0 && !showAssetForm ? (
            <div className="p-4 border border-dashed border-sage-300 rounded-xl text-center bg-warm-white">
              <ImageIcon className="w-6 h-6 text-sage-300 mx-auto mb-2" />
              <p className="text-sm text-sage-500">No brand assets yet.</p>
              <p className="text-xs text-sage-400 mt-1">Add logos, hero images, watercolors, photography, and textures.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {brandAssets.map((asset) => (
                <div
                  key={asset.id}
                  className="group relative border border-border rounded-xl overflow-hidden bg-warm-white hover:shadow-md transition-shadow"
                >
                  <div className="aspect-[4/3] bg-sage-50 flex items-center justify-center overflow-hidden">
                    <img
                      src={asset.url}
                      alt={asset.label}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.display = 'none'
                      }}
                    />
                  </div>
                  <div className="p-2.5">
                    <p className="text-xs font-medium text-sage-800 truncate">{asset.label}</p>
                    <span className={`inline-block mt-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${ASSET_TYPE_COLORS[asset.asset_type] ?? ASSET_TYPE_COLORS.other}`}>
                      {ASSET_TYPE_OPTIONS.find((o) => o.value === asset.asset_type)?.label ?? asset.asset_type}
                    </span>
                  </div>
                  <button
                    onClick={() => handleDeleteAsset(asset.id)}
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/80 text-red-500 opacity-0 group-hover:opacity-100 hover:bg-red-50 transition-all"
                    title="Delete asset"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Live Preview                                                      */}
        {/* ---------------------------------------------------------------- */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Eye className="w-4 h-4 text-sage-500" />
            <h3 className="text-sm font-semibold text-sage-800 uppercase tracking-wider">Live Preview</h3>
          </div>

          <div
            className="rounded-xl border border-border p-8 transition-all duration-300"
            style={{
              backgroundColor: hexToRgba(config.primary_color, 0.06),
              fontFamily: currentFontPair.body.family,
            }}
          >
            {/* Preview heading */}
            <h3
              className="text-2xl font-bold mb-3"
              style={{
                fontFamily: currentFontPair.heading.family,
                color: config.primary_color,
              }}
            >
              {config.business_name || 'Your Venue Name'}
            </h3>

            {/* Preview body text */}
            <p
              className="mb-4 text-sm leading-relaxed"
              style={{
                fontFamily: currentFontPair.body.family,
                color: '#4a5568',
              }}
            >
              Welcome to your wedding planning portal. We are so excited to help you create the most magical day.
              Every detail matters, and we are here to make sure everything is absolutely perfect.
            </p>

            {/* Preview tagline */}
            {config.portal_tagline && (
              <p
                className="mb-5 text-sm italic"
                style={{
                  fontFamily: currentFontPair.body.family,
                  color: config.secondary_color,
                }}
              >
                &ldquo;{config.portal_tagline}&rdquo;
              </p>
            )}

            {/* Preview button + badge */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                className="px-5 py-2 rounded-lg text-white text-sm font-medium transition-opacity hover:opacity-90"
                style={{ backgroundColor: config.primary_color }}
              >
                Book a Tour
              </button>
              <button
                className="px-5 py-2 rounded-lg text-white text-sm font-medium transition-opacity hover:opacity-90"
                style={{ backgroundColor: config.secondary_color }}
              >
                View Pricing
              </button>
              <span
                className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold text-white"
                style={{ backgroundColor: config.accent_color }}
              >
                Featured Venue
              </span>
            </div>

            {/* Font pair label */}
            <p className="mt-6 text-xs opacity-50" style={{ color: config.primary_color }}>
              Font: {currentFontPair.label} ({currentFontPair.heading.family.split(',')[0].replace(/'/g, '')} +{' '}
              {currentFontPair.body.family.split(',')[0].replace(/'/g, '')})
            </p>
          </div>
        </div>
      </section>

      {/* Bottom Save */}
      <div className="flex justify-end pb-8">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-6 py-2.5 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}

/* ================================================================== */
/* Brand Settings — company/group scope                                 */
/* ================================================================== */
interface BrandVenue {
  venueId: string
  name: string
  slug: string | null
  capacity: number | null
  basePrice: number | null
  coordinatorName: string | null
  logoUrl: string | null
  primaryColor: string
  secondaryColor: string
  accentColor: string
  businessName: string | null
  brandDescription: string | null
  configId: string | null
}

function BrandSettings({ scope }: { scope: Scope & { loading: boolean } }) {
  const [venues, setVenues] = useState<BrandVenue[]>([])
  const [orgId, setOrgId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [showAddVenue, setShowAddVenue] = useState(false)
  const [addVenueForm, setAddVenueForm] = useState({ name: '', city: '', state: '', capacity: '', priceRange: '' })
  const [addingVenue, setAddingVenue] = useState(false)

  // Brand assets across all in-scope venues
  const [allBrandAssets, setAllBrandAssets] = useState<BrandAsset[]>([])

  // Brand-level editable state (sourced from organisations table)
  const [brandDescription, setBrandDescription] = useState<string>('')
  const [logoUrl, setLogoUrl] = useState<string>('')
  const [primaryColor, setPrimaryColor] = useState<string>('#7D8471')
  const [secondaryColor, setSecondaryColor] = useState<string>('#5D7A7A')
  const [accentColor, setAccentColor] = useState<string>('#A6894A')

  const headerTitle =
    scope.level === 'group'
      ? scope.groupName ?? 'Group'
      : scope.companyName ?? 'Brand'

  useEffect(() => {
    if (scope.loading) return
    async function load() {
      setLoading(true)
      try {
        // 1) Resolve in-scope venue IDs
        let venueIds: string[] | null = null
        if (scope.level === 'group' && scope.groupId) {
          const { data: members } = await supabase
            .from('venue_group_members')
            .select('venue_id')
            .eq('group_id', scope.groupId)
          venueIds = (members ?? []).map((m) => m.venue_id as string)
        }
        // For company scope: filter by org_id to prevent cross-org data leak

        // 2) Load venues (now also pulling org_id so we can resolve the brand)
        let vq = supabase
          .from('venues')
          .select('id, name, slug, org_id')
          .order('name', { ascending: true })
        if (venueIds && venueIds.length > 0) {
          vq = vq.in('id', venueIds)
        } else if (venueIds && venueIds.length === 0) {
          setVenues([])
          setOrgId(null)
          setLoading(false)
          return
        } else if (scope.orgId) {
          // Company scope — filter to user's org only
          vq = vq.eq('org_id', scope.orgId)
        }
        const { data: venueRows, error: vErr } = await vq
        if (vErr) throw vErr

        const ids = (venueRows ?? []).map((v) => v.id as string)
        if (ids.length === 0) {
          setVenues([])
          setOrgId(null)
          setLoading(false)
          return
        }

        // 3) Resolve org_id from one of the in-scope venues
        const resolvedOrgId =
          (venueRows ?? []).map((v: any) => v.org_id).find((id: string | null) => !!id) ?? null
        setOrgId(resolvedOrgId)

        // 4) Load venue_config rows for those venues (still needed for the venue grid below)
        const { data: configRows, error: cErr } = await supabase
          .from('venue_config')
          .select('id, venue_id, business_name, logo_url, primary_color, secondary_color, accent_color, capacity, base_price, coordinator_name, brand_description')
          .in('venue_id', ids)
        if (cErr) {
          // brand_description column may not exist — retry without it
          console.warn('venue_config query failed, retrying without brand_description:', cErr)
        }

        let safeConfigRows: any[] | null = configRows as any
        if (cErr) {
          const retry = await supabase
            .from('venue_config')
            .select('id, venue_id, business_name, logo_url, primary_color, secondary_color, accent_color, capacity, base_price, coordinator_name')
            .in('venue_id', ids)
          safeConfigRows = (retry.data ?? null) as any[] | null
        }

        const configByVenueId = new Map<string, VenueRow>()
        ;(safeConfigRows ?? []).forEach((r: any) => configByVenueId.set(r.venue_id, r))

        const joined: BrandVenue[] = (venueRows ?? []).map((v: any) => {
          const c = configByVenueId.get(v.id)
          return {
            venueId: v.id,
            name: v.name,
            slug: v.slug ?? null,
            capacity: c?.capacity ?? null,
            basePrice: c?.base_price ?? null,
            coordinatorName: c?.coordinator_name ?? null,
            logoUrl: c?.logo_url ?? null,
            primaryColor: c?.primary_color ?? '#7D8471',
            secondaryColor: c?.secondary_color ?? '#5D7A7A',
            accentColor: c?.accent_color ?? '#A6894A',
            businessName: c?.business_name ?? null,
            brandDescription: (c as any)?.brand_description ?? null,
            configId: c?.id ?? null,
          }
        })

        setVenues(joined)

        // Load brand assets across all in-scope venues
        if (ids.length > 0) {
          const { data: assetRows } = await supabase
            .from('brand_assets')
            .select('*, venues:venue_id(name)')
            .in('venue_id', ids)
            .order('sort_order', { ascending: true })
          setAllBrandAssets((assetRows ?? []) as BrandAsset[])
        }

        // 5) Load brand-level fields from the organisations table
        if (resolvedOrgId) {
          const { data: org, error: orgErr } = await supabase
            .from('organisations')
            .select('logo_url, brand_description, primary_color, secondary_color, accent_color')
            .eq('id', resolvedOrgId)
            .maybeSingle()
          if (orgErr) {
            console.warn('Failed to load organisations brand fields:', orgErr)
          }
          if (org) {
            setLogoUrl((org as any).logo_url ?? '')
            setBrandDescription((org as any).brand_description ?? '')
            setPrimaryColor((org as any).primary_color ?? '#7D8471')
            setSecondaryColor((org as any).secondary_color ?? '#5D7A7A')
            setAccentColor((org as any).accent_color ?? '#A6894A')
          } else {
            // Fall back to first venue config so the editor isn't empty
            const first = joined[0]
            if (first) {
              setLogoUrl(first.logoUrl ?? '')
              setBrandDescription(first.brandDescription ?? '')
              setPrimaryColor(first.primaryColor)
              setSecondaryColor(first.secondaryColor)
              setAccentColor(first.accentColor)
            }
          }
        } else {
          // No org context — fall back to first venue config
          const first = joined[0]
          if (first) {
            setLogoUrl(first.logoUrl ?? '')
            setBrandDescription(first.brandDescription ?? '')
            setPrimaryColor(first.primaryColor)
            setSecondaryColor(first.secondaryColor)
            setAccentColor(first.accentColor)
          }
        }
      } catch (err) {
        console.error('Failed to load brand settings:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [scope.level, scope.groupId, scope.companyName, scope.loading])

  const handleSave = useCallback(async () => {
    if (venues.length === 0) return
    setSaving(true)
    setSaveMessage(null)

    try {
      const venueIds = venues.map((v) => v.venueId)

      // 1) Persist brand-level fields on the organisations row (the source of truth)
      if (orgId) {
        const { error: orgErr } = await supabase
          .from('organisations')
          .update({
            logo_url: logoUrl || null,
            brand_description: brandDescription || null,
            primary_color: primaryColor,
            secondary_color: secondaryColor,
            accent_color: accentColor,
          })
          .eq('id', orgId)
        if (orgErr) throw orgErr
      } else {
        console.warn('No org_id resolved for current scope — brand fields not saved to organisations table.')
      }

      // 2) Cascade brand colors to ALL in-scope venue_config rows (preserves
      //    existing per-venue color rendering and keeps backwards compatibility)
      const { error: colorErr } = await supabase
        .from('venue_config')
        .update({
          primary_color: primaryColor,
          secondary_color: secondaryColor,
          accent_color: accentColor,
          updated_at: new Date().toISOString(),
        })
        .in('venue_id', venueIds)

      if (colorErr) throw colorErr

      setSaveMessage('Brand settings saved successfully.')
    } catch (err) {
      console.error('Brand save failed:', err)
      setSaveMessage('Failed to save brand settings.')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMessage(null), 3000)
    }
  }, [venues, orgId, primaryColor, secondaryColor, accentColor, logoUrl, brandDescription])

  const handleAddVenue = useCallback(async () => {
    if (!addVenueForm.name.trim() || !orgId) return
    setAddingVenue(true)
    try {
      const slug = addVenueForm.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      // Create venue
      const { data: venue, error: venueErr } = await supabase
        .from('venues')
        .insert({
          name: addVenueForm.name.trim(),
          slug,
          org_id: orgId,
          city: addVenueForm.city.trim() || null,
          state: addVenueForm.state.trim() || null,
          status: 'trial',
          is_demo: false,
        })
        .select('id, name, slug')
        .single()
      if (venueErr) throw venueErr

      // Create venue_config
      const { error: configErr } = await supabase
        .from('venue_config')
        .insert({
          venue_id: venue.id,
          business_name: addVenueForm.name.trim(),
          capacity: addVenueForm.capacity ? parseInt(addVenueForm.capacity) : null,
          base_price: addVenueForm.priceRange ? parseFloat(addVenueForm.priceRange) : null,
          onboarding_completed: false,
          primary_color: primaryColor,
          secondary_color: secondaryColor,
          accent_color: accentColor,
        })
      if (configErr) throw configErr

      // Ask if they want to configure now
      setShowAddVenue(false)
      setAddVenueForm({ name: '', city: '', state: '', capacity: '', priceRange: '' })

      const configureNow = window.confirm(`"${venue.name}" created! Configure this venue now? This will switch your scope to the new venue and start onboarding.`)
      if (configureNow) {
        switchToVenue(venue.id, venue.name, scope.companyName)
        // After reload, dashboard will detect onboarding_completed=false and redirect to /onboarding
      } else {
        // Refresh the venue list
        window.location.reload()
      }
    } catch (err) {
      console.error('Failed to add venue:', err)
      setSaveMessage('Failed to add venue. Please try again.')
      setTimeout(() => setSaveMessage(null), 3000)
    } finally {
      setAddingVenue(false)
    }
  }, [addVenueForm, orgId, primaryColor, secondaryColor, accentColor, scope.companyName])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-pulse text-sage-500 text-sm">Loading brand settings...</div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <Layers className="w-8 h-8 text-sage-500" />
            Brand Settings <span className="text-sage-500">— {headerTitle}</span>
          </h1>
          <p className="text-sage-600">
            Configure brand-level details that apply across{' '}
            {venues.length > 0 ? `${venues.length} venue${venues.length === 1 ? '' : 's'}` : 'all venues'} in your{' '}
            {scope.level === 'group' ? 'group' : 'company'}. To edit a specific venue&apos;s details, click{' '}
            <span className="font-medium">Configure</span> on a venue card below.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || venues.length === 0}
          className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-6 py-2.5 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save Brand Settings'}
        </button>
      </div>

      {/* Save feedback */}
      {saveMessage && (
        <div className={`px-4 py-2 rounded-lg text-sm font-medium ${
          saveMessage.includes('success') ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {saveMessage}
        </div>
      )}

      {/* ---------------------------------------------------------- */}
      {/* Brand Info                                                  */}
      {/* ---------------------------------------------------------- */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Building2 className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Brand Info</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Company Name</label>
            <input
              type="text"
              value={scope.companyName ?? ''}
              readOnly
              className={inputClasses + ' opacity-70 cursor-not-allowed'}
            />
            <p className="text-xs text-sage-500 mt-1">
              Company name is set at the organization level.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Brand Logo URL</label>
            <div className="flex items-start gap-3">
              {logoUrl && (
                <img
                  src={logoUrl}
                  alt="Brand logo"
                  className="w-16 h-16 object-contain rounded-lg border border-sage-200 bg-white p-1 shrink-0"
                />
              )}
              <input
                type="text"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://..."
                className={inputClasses}
              />
            </div>
            <p className="text-xs text-sage-500 mt-1">
              Stored on your organisation and shared across every venue in the brand.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-sage-700 mb-1">Brand Description</label>
          <textarea
            value={brandDescription}
            onChange={(e) => setBrandDescription(e.target.value)}
            placeholder="A short description of your brand — voice, positioning, promise to couples."
            rows={3}
            className={inputClasses}
          />
          <p className="text-xs text-sage-500 mt-1">
            Used as context for AI-generated emails and portal copy across all venues.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Brand Colors                                                */}
      {/* ---------------------------------------------------------- */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Palette className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Brand Colors</h2>
        </div>
        <p className="text-sm text-sage-600 -mt-2">
          These colors will be applied to <strong>all {venues.length} venue{venues.length === 1 ? '' : 's'}</strong> in your {scope.level === 'group' ? 'group' : 'brand'} when you save.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Primary Color</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="w-12 h-10 rounded-lg border border-border cursor-pointer"
              />
              <input
                type="text"
                value={primaryColor}
                onChange={(e) => {
                  const val = e.target.value
                  if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) setPrimaryColor(val)
                }}
                className={inputClasses + ' font-mono text-sm'}
                maxLength={7}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Secondary Color</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={secondaryColor}
                onChange={(e) => setSecondaryColor(e.target.value)}
                className="w-12 h-10 rounded-lg border border-border cursor-pointer"
              />
              <input
                type="text"
                value={secondaryColor}
                onChange={(e) => {
                  const val = e.target.value
                  if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) setSecondaryColor(val)
                }}
                className={inputClasses + ' font-mono text-sm'}
                maxLength={7}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Accent Color</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={accentColor}
                onChange={(e) => setAccentColor(e.target.value)}
                className="w-12 h-10 rounded-lg border border-border cursor-pointer"
              />
              <input
                type="text"
                value={accentColor}
                onChange={(e) => {
                  const val = e.target.value
                  if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) setAccentColor(val)
                }}
                className={inputClasses + ' font-mono text-sm'}
                maxLength={7}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Venues in scope                                             */}
      {/* ---------------------------------------------------------- */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-sage-500" />
            <h2 className="font-heading text-xl font-semibold text-sage-900">
              Venues ({venues.length})
            </h2>
          </div>
          <p className="text-xs text-sage-500">Click Configure to jump into a specific venue.</p>
        </div>

        {venues.length === 0 ? (
          <div className="p-8 text-center text-sage-500 text-sm border border-dashed border-sage-300 rounded-xl">
            No venues found in this {scope.level === 'group' ? 'group' : 'brand'}.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {venues.map((v) => (
              <div
                key={v.venueId}
                className="border border-border rounded-xl p-5 bg-warm-white hover:shadow-md transition-shadow"
              >
                <div className="flex items-start gap-3 mb-4">
                  {v.logoUrl ? (
                    <img
                      src={v.logoUrl}
                      alt={v.name}
                      className="w-12 h-12 object-contain rounded-lg border border-sage-200 bg-white p-1 shrink-0"
                    />
                  ) : (
                    <div
                      className="w-12 h-12 rounded-lg shrink-0 flex items-center justify-center text-white font-bold"
                      style={{ backgroundColor: v.primaryColor }}
                    >
                      {v.name.charAt(0)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-heading text-base font-semibold text-sage-900 truncate">{v.name}</h3>
                    {v.businessName && v.businessName !== v.name && (
                      <p className="text-xs text-sage-500 truncate">{v.businessName}</p>
                    )}
                  </div>
                </div>

                <dl className="space-y-1.5 text-xs text-sage-600 mb-4">
                  <div className="flex justify-between">
                    <dt className="text-sage-500">Capacity</dt>
                    <dd className="font-medium text-sage-800">
                      {v.capacity != null ? `${v.capacity} guests` : '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-sage-500">Base Price</dt>
                    <dd className="font-medium text-sage-800">
                      {v.basePrice != null ? `$${v.basePrice.toLocaleString()}` : '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-sage-500">Coordinator</dt>
                    <dd className="font-medium text-sage-800 truncate max-w-[60%]">
                      {v.coordinatorName ?? '—'}
                    </dd>
                  </div>
                </dl>

                <button
                  onClick={() => switchToVenue(v.venueId, v.name, scope.companyName)}
                  className="w-full flex items-center justify-center gap-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  Configure
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            ))}
            {/* Add Venue Card */}
            <div
              onClick={() => setShowAddVenue(true)}
              className="border-2 border-dashed border-sage-300 rounded-xl p-6 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-sage-500 hover:bg-sage-50/50 transition-colors min-h-[200px]"
            >
              <Plus className="w-8 h-8 text-sage-400" />
              <p className="text-sm font-medium text-sage-600">Add Venue</p>
            </div>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Brand Assets across venues                                  */}
      {/* ---------------------------------------------------------- */}
      <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-sage-500" />
          <h2 className="font-heading text-xl font-semibold text-sage-900">Brand Assets</h2>
          <span className="text-xs text-sage-500 ml-1">({allBrandAssets.length})</span>
        </div>
        <p className="text-sm text-sage-600 -mt-2">
          All brand assets across your venues. To add or remove assets, configure each venue individually.
        </p>

        {allBrandAssets.length === 0 ? (
          <div className="p-8 text-center text-sage-500 text-sm border border-dashed border-sage-300 rounded-xl">
            No brand assets found. Add assets from individual venue settings.
          </div>
        ) : (
          (() => {
            // Group assets by venue
            const grouped = new Map<string, { name: string; assets: BrandAsset[] }>()
            for (const asset of allBrandAssets) {
              const venueName = (asset.venues as { name: string | null } | null)?.name ?? 'Unknown Venue'
              const key = asset.venue_id
              if (!grouped.has(key)) {
                grouped.set(key, { name: venueName, assets: [] })
              }
              grouped.get(key)!.assets.push(asset)
            }
            return (
              <div className="space-y-6">
                {Array.from(grouped.entries()).map(([venueId, group]) => (
                  <div key={venueId}>
                    <h3 className="text-sm font-semibold text-sage-800 mb-3 flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-sage-400" />
                      {group.name}
                      <span className="text-xs font-normal text-sage-500">({group.assets.length} asset{group.assets.length === 1 ? '' : 's'})</span>
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {group.assets.map((asset) => (
                        <div
                          key={asset.id}
                          className="border border-border rounded-xl overflow-hidden bg-warm-white"
                        >
                          <div className="aspect-[4/3] bg-sage-50 flex items-center justify-center overflow-hidden">
                            <img
                              src={asset.url}
                              alt={asset.label}
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                ;(e.target as HTMLImageElement).style.display = 'none'
                              }}
                            />
                          </div>
                          <div className="p-2.5">
                            <p className="text-xs font-medium text-sage-800 truncate">{asset.label}</p>
                            <span className={`inline-block mt-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${ASSET_TYPE_COLORS[asset.asset_type] ?? ASSET_TYPE_COLORS.other}`}>
                              {ASSET_TYPE_OPTIONS.find((o) => o.value === asset.asset_type)?.label ?? asset.asset_type}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          })()
        )}
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Add Venue Modal                                             */}
      {/* ---------------------------------------------------------- */}
      {showAddVenue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowAddVenue(false)} />
          <div className="relative bg-surface rounded-xl shadow-xl w-full max-w-md p-6 mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-heading text-lg font-semibold text-sage-900">Add Venue</h3>
              <button onClick={() => setShowAddVenue(false)} className="p-1.5 rounded-lg hover:bg-sage-50">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Venue Name *</label>
                <input
                  type="text"
                  value={addVenueForm.name}
                  onChange={(e) => setAddVenueForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Rose Hill Gardens"
                  className={inputClasses}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">City</label>
                  <input
                    type="text"
                    value={addVenueForm.city}
                    onChange={(e) => setAddVenueForm((f) => ({ ...f, city: e.target.value }))}
                    placeholder="Richmond"
                    className={inputClasses}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">State</label>
                  <input
                    type="text"
                    value={addVenueForm.state}
                    onChange={(e) => setAddVenueForm((f) => ({ ...f, state: e.target.value }))}
                    placeholder="VA"
                    className={inputClasses}
                    maxLength={2}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Max Capacity</label>
                  <input
                    type="number"
                    value={addVenueForm.capacity}
                    onChange={(e) => setAddVenueForm((f) => ({ ...f, capacity: e.target.value }))}
                    placeholder="250"
                    className={inputClasses}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Base Price ($)</label>
                  <input
                    type="number"
                    value={addVenueForm.priceRange}
                    onChange={(e) => setAddVenueForm((f) => ({ ...f, priceRange: e.target.value }))}
                    placeholder="8500"
                    className={inputClasses}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={() => setShowAddVenue(false)}
                  className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddVenue}
                  disabled={!addVenueForm.name.trim() || addingVenue}
                  className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2.5 transition-colors text-sm"
                >
                  <Plus className="w-4 h-4" />
                  {addingVenue ? 'Creating...' : 'Create Venue'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
