'use client'

import { useState, useEffect, useCallback } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { FONT_PAIRS, getFontUrl } from '@/config/fonts'
import {
  Settings, Palette, Type, Save, Eye, Building2, User, Clock, DollarSign,
} from 'lucide-react'

// TODO: Wire venue selector — for now we load the first venue_config row
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

export default function SettingsPage() {
  const [config, setConfig] = useState<VenueConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  // Load venue config
  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('venue_config')
        .select('*')
        .limit(1)
        .single()

      if (error) {
        console.error('Failed to load venue config:', error)
      }
      if (data) {
        setConfig(data as VenueConfig)
      }
      setLoading(false)
    }
    load()
  }, [])

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

  // Current font pair for preview
  const currentFontPair = FONT_PAIRS[config?.font_pair ?? 'playfair_inter'] ?? FONT_PAIRS.playfair_inter
  const fontUrl = getFontUrl(config?.font_pair ?? 'playfair_inter')

  // Hex color helper to lighten for background tint
  function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

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
        <div className="text-sage-500 text-sm">No venue configuration found. Please seed your database first.</div>
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
            Venue Settings
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
          <label className="block text-sm font-medium text-sage-700 mb-1">Brand Assets</label>
          <p className="text-xs text-sage-500 mb-3">
            Upload venue photography, watercolor images, and textures.
            These can be used across the platform — emails, proposals, and the client portal.
            Add assets via the <code className="text-sage-600">brand_assets</code> table in Supabase
            (type: hero_image, watercolor, photography, texture).
          </p>
          <div className="p-4 border border-dashed border-sage-300 rounded-xl text-center bg-warm-white">
            <Palette className="w-6 h-6 text-sage-300 mx-auto mb-2" />
            <p className="text-sm text-sage-500">Brand asset management coming with Supabase Storage integration.</p>
            <p className="text-xs text-sage-400 mt-1">For now, add image URLs directly to the brand_assets table.</p>
          </div>
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
