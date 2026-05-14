'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import { Clock, Save, RotateCcw, AlertTriangle, Plus, Trash2 } from 'lucide-react'

// ---------------------------------------------------------------------------
// Per-platform identity match windows admin (T2-D / ARCH-8.5.3)
//
// Backed by venue_config.identity_match_config.per_platform jsonb.
// Coordinators tune the time window the candidate-resolver allows
// between a platform signal (Knot view, Pinterest save, Instagram
// follow, GMB profile click) and the eventual email inquiry the
// signal should match against.
//
// Defaults are platform-aware (mirrors DEFAULT_PER_PLATFORM_WINDOWS in
// src/lib/services/identity-windows.ts). Saving an override writes
// per-platform rows; deleting them all reverts the venue to defaults.
// ---------------------------------------------------------------------------

// 2026-05-01 (review pass 4): single source of truth for defaults
// lives in identity-windows-constants.ts. Pre-pass-4 this page had a
// local copy that was drift-prone.
import {
  DEFAULT_PER_PLATFORM_WINDOWS as DEFAULTS,
  type PerPlatformWindow,
  type PerPlatformWindowMap as WindowMap,
} from '@/lib/services/identity/windows-constants'

// Display order — most-trafficked sources first, default last.
const PLATFORM_ORDER = [
  'the_knot', 'weddingwire', 'zola', 'pinterest', 'instagram',
  'facebook', 'google_business', 'here_comes_the_guide', 'default',
]

const PLATFORM_LABEL: Record<string, string> = {
  the_knot: 'The Knot',
  knot: 'The Knot (alias)',
  weddingwire: 'WeddingWire',
  wedding_wire: 'WeddingWire (alias)',
  zola: 'Zola',
  pinterest: 'Pinterest',
  instagram: 'Instagram',
  facebook: 'Facebook',
  google_business: 'Google Business Profile',
  google: 'Google (alias)',
  here_comes_the_guide: 'Here Comes The Guide',
  default: 'Default (any other platform)',
}

export default function IdentityWindowsPage() {
  const venueId = useVenueId()
  const supabase = createClient()
  const [overrides, setOverrides] = useState<WindowMap>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [newPlatform, setNewPlatform] = useState('')

  const fetchConfig = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    try {
      const { data, error: fetchErr } = await supabase
        .from('venue_config')
        .select('identity_match_config')
        .eq('venue_id', venueId)
        .maybeSingle()
      if (fetchErr) throw fetchErr
      const cfg = (data?.identity_match_config ?? {}) as Record<string, unknown>
      const perPlatform = (cfg.per_platform ?? {}) as Record<string, Partial<PerPlatformWindow>>
      const cleaned: WindowMap = {}
      for (const [k, v] of Object.entries(perPlatform)) {
        cleaned[k] = {
          tier_1_hours: typeof v?.tier_1_hours === 'number' ? v.tier_1_hours : (DEFAULTS[k]?.tier_1_hours ?? DEFAULTS.default.tier_1_hours),
          tier_2_days: typeof v?.tier_2_days === 'number' ? v.tier_2_days : (DEFAULTS[k]?.tier_2_days ?? DEFAULTS.default.tier_2_days),
        }
      }
      setOverrides(cleaned)
      setError(null)
    } catch (err) {
      console.error('Failed to load identity windows:', err)
      setError('Failed to load identity windows')
    } finally {
      setLoading(false)
    }
  }, [venueId, supabase])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  function effectiveValue(platform: string): PerPlatformWindow {
    return overrides[platform] ?? DEFAULTS[platform] ?? DEFAULTS.default
  }

  function isOverridden(platform: string): boolean {
    const o = overrides[platform]
    const d = DEFAULTS[platform] ?? DEFAULTS.default
    if (!o) return false
    return o.tier_1_hours !== d.tier_1_hours || o.tier_2_days !== d.tier_2_days
  }

  function setOverride(platform: string, patch: Partial<PerPlatformWindow>) {
    setOverrides((prev) => {
      const cur = prev[platform] ?? DEFAULTS[platform] ?? DEFAULTS.default
      return { ...prev, [platform]: { ...cur, ...patch } }
    })
  }

  function clearOverride(platform: string) {
    setOverrides((prev) => {
      const next = { ...prev }
      delete next[platform]
      return next
    })
  }

  async function handleSave() {
    if (!venueId || saving) return
    setSaving(true)
    try {
      const { data: existing } = await supabase
        .from('venue_config')
        .select('identity_match_config')
        .eq('venue_id', venueId)
        .maybeSingle()
      const cfg = (existing?.identity_match_config ?? {}) as Record<string, unknown>
      const next = { ...cfg, per_platform: overrides }
      const { error: writeErr } = await supabase
        .from('venue_config')
        .update({ identity_match_config: next })
        .eq('venue_id', venueId)
      if (writeErr) throw writeErr
      setSavedAt(Date.now())
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  function handleAddCustomPlatform() {
    const key = newPlatform.trim().toLowerCase().replace(/\s+/g, '_')
    if (!key) return
    if (PLATFORM_ORDER.includes(key)) return
    setOverride(key, DEFAULTS.default)
    setNewPlatform('')
  }

  if (loading) {
    return <div className="p-8"><p className="text-sage-500 text-sm">Loading…</p></div>
  }

  const customPlatforms = Object.keys(overrides)
    .filter((k) => !PLATFORM_ORDER.includes(k))
    .sort()
  const allPlatforms = [...PLATFORM_ORDER, ...customPlatforms]

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Identity match windows</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          The candidate resolver matches platform signals (Knot views,
          Pinterest saves, Instagram follows, etc.) to wedding inquiries
          by checking whether the signal time sits within a window of
          the wedding&apos;s inquiry date. Different platforms have
          different decision horizons — Knot couples browse for ~12
          months, GMB clicks decide within a week. These windows tell
          the resolver how far back to look.
        </p>
        <p className="text-xs text-sage-500">
          <strong>Tier 1 hours:</strong> auto-link window. Within this,
          a single match auto-resolves at high confidence.{' '}
          <strong>Tier 2 days:</strong> wide window. Between Tier 1 and
          Tier 2, the AI reviewer gets the candidates with full context;
          never auto-link.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="rounded-lg border border-sage-200 bg-white overflow-x-auto">
        <table className="min-w-[640px] w-full text-sm">
          <thead className="bg-sage-50 text-xs text-sage-600 uppercase">
            <tr>
              <th className="text-left px-4 py-2">Platform</th>
              <th className="text-right px-4 py-2">Tier 1 (hours)</th>
              <th className="text-right px-4 py-2">Tier 2 (days)</th>
              <th className="text-right px-4 py-2">Override</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sage-100">
            {allPlatforms.map((platform) => {
              const eff = effectiveValue(platform)
              const isOver = isOverridden(platform)
              const def = DEFAULTS[platform] ?? DEFAULTS.default
              const isCustom = !PLATFORM_ORDER.includes(platform)
              return (
                <tr key={platform} className={isOver ? 'bg-amber-50/30' : ''}>
                  <td className="px-4 py-3 font-medium text-sage-900">
                    {PLATFORM_LABEL[platform] ?? platform}
                    {isCustom && (
                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-sage-50 text-[10px] font-medium text-sage-600 uppercase">custom</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <input
                      type="number"
                      min="1"
                      max="8760"
                      value={eff.tier_1_hours}
                      onChange={(e) => setOverride(platform, { tier_1_hours: Number(e.target.value) })}
                      className="w-20 rounded border border-sage-200 px-2 py-1 text-right font-mono"
                    />
                    {!isOver && (
                      <span className="ml-2 text-xs text-sage-400">default {def.tier_1_hours}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <input
                      type="number"
                      min="1"
                      max="1825"
                      value={eff.tier_2_days}
                      onChange={(e) => setOverride(platform, { tier_2_days: Number(e.target.value) })}
                      className="w-20 rounded border border-sage-200 px-2 py-1 text-right font-mono"
                    />
                    {!isOver && (
                      <span className="ml-2 text-xs text-sage-400">default {def.tier_2_days}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isOver ? (
                      <button
                        onClick={() => clearOverride(platform)}
                        className="inline-flex items-center gap-1 text-xs text-sage-500 hover:text-red-600 transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Reset
                      </button>
                    ) : (
                      <span className="text-xs text-sage-400">defaults</span>
                    )}
                    {isCustom && (
                      <button
                        onClick={() => clearOverride(platform)}
                        className="ml-2 inline-flex items-center gap-1 text-xs text-sage-400 hover:text-red-600 transition-colors"
                        title="Remove custom platform"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-dashed border-sage-200 bg-sage-50/30 p-4">
        <p className="text-sm font-medium text-sage-700 mb-2">Add a custom platform</p>
        <p className="text-xs text-sage-500 mb-3">
          For platforms not on the default list, e.g. a regional bridal
          magazine or a niche venue listing site. The key should match
          whatever your candidate-import pipeline labels the source as.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="platform_key (lowercase, underscores)"
            value={newPlatform}
            onChange={(e) => setNewPlatform(e.target.value)}
            className="flex-1 rounded border border-sage-200 px-3 py-2 text-sm focus:outline-none focus:border-sage-400"
          />
          <button
            onClick={handleAddCustomPlatform}
            disabled={!newPlatform.trim()}
            className="inline-flex items-center gap-1.5 rounded bg-sage-100 hover:bg-sage-200 disabled:opacity-50 text-sage-700 text-sm font-medium px-3 py-1.5"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-sage-500">
          {savedAt && Date.now() - savedAt < 5000 && 'Saved.'}
        </p>
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : 'Save windows'}
        </button>
      </div>
    </div>
  )
}
