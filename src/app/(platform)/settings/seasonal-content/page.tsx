'use client'

/**
 * Settings → Seasonal Content
 *
 * Coordinator editor for `venue_seasonal_content`. Four seasons, one
 * row per (venue, season). Each row carries:
 *   - imagery: a short imagery phrase ("dogwood blooms on the hilltop")
 *   - phrases: an array of seasonal hooks ("Spring tours fill fastest",
 *     "Fall foliage peaks the third weekend of October")
 *
 * Why this lives in /settings/ and not /portal/: AI brains
 * (sage-brain, inquiry-brain, client-brain) consume seasonal content
 * at prompt-build time to colour AI-written replies with seasonal
 * imagery the venue actually uses. It's a venue-voice setting, not a
 * portal config.
 *
 * Migration 096 added a unique constraint on (venue_id, season) so
 * upsert is the natural write path — one row per season per venue.
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { ArrowLeft, Sparkles, Plus, Trash2, Loader2, Save } from 'lucide-react'

type Season = 'spring' | 'summer' | 'fall' | 'winter'

interface SeasonalRow {
  id: string | null
  season: Season
  imagery: string
  phrases: string[]
}

const SEASONS: Array<{ key: Season; label: string; emoji: string; hint: string }> = [
  { key: 'spring', label: 'Spring', emoji: '🌸', hint: 'March–May. Soft blooms, awakening, longer light.' },
  { key: 'summer', label: 'Summer', emoji: '☀️', hint: 'June–August. Heat, golden hour, peak demand.' },
  { key: 'fall',   label: 'Fall',   emoji: '🍂', hint: 'September–November. Foliage, harvest, premium pricing.' },
  { key: 'winter', label: 'Winter', emoji: '❄️', hint: 'December–February. Soft demand, intimate weddings, lower rates.' },
]

export default function SeasonalContentPage() {
  const venueId = useVenueId()
  const [rows, setRows] = useState<Record<Season, SeasonalRow>>(() => emptyRows())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Season | null>(null)
  const [error, setError] = useState<string | null>(null)

  function emptyRows(): Record<Season, SeasonalRow> {
    return {
      spring: { id: null, season: 'spring', imagery: '', phrases: [] },
      summer: { id: null, season: 'summer', imagery: '', phrases: [] },
      fall:   { id: null, season: 'fall',   imagery: '', phrases: [] },
      winter: { id: null, season: 'winter', imagery: '', phrases: [] },
    }
  }

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const { data, error: err } = await supabase
      .from('venue_seasonal_content')
      .select('id, season, imagery, phrases')
      .eq('venue_id', venueId)
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }
    const next = emptyRows()
    for (const r of (data ?? []) as Array<{ id: string; season: string; imagery: string | null; phrases: string[] | null }>) {
      const s = r.season as Season
      if (s in next) {
        next[s] = {
          id: r.id,
          season: s,
          imagery: r.imagery ?? '',
          phrases: r.phrases ?? [],
        }
      }
    }
    setRows(next)
    setLoading(false)
  }, [venueId])

  useEffect(() => { load() }, [load])

  async function saveSeason(season: Season) {
    if (!venueId) return
    const row = rows[season]
    setSaving(season)
    setError(null)
    const supabase = createClient()

    // Trim and drop empty phrases before writing.
    const cleanPhrases = row.phrases
      .map((p) => p.trim())
      .filter((p) => p.length > 0)

    const payload = {
      venue_id: venueId,
      season,
      imagery: row.imagery.trim() || null,
      phrases: cleanPhrases,
    }

    const { data, error: upErr } = await supabase
      .from('venue_seasonal_content')
      .upsert(payload, { onConflict: 'venue_id,season' })
      .select('id')
      .maybeSingle()

    if (upErr) {
      setError(upErr.message)
    } else if (data) {
      setRows((prev) => ({
        ...prev,
        [season]: { ...prev[season], id: data.id as string, phrases: cleanPhrases },
      }))
    }
    setSaving(null)
  }

  function updateImagery(season: Season, value: string) {
    setRows((prev) => ({ ...prev, [season]: { ...prev[season], imagery: value } }))
  }

  function addPhrase(season: Season) {
    setRows((prev) => ({
      ...prev,
      [season]: { ...prev[season], phrases: [...prev[season].phrases, ''] },
    }))
  }

  function updatePhrase(season: Season, idx: number, value: string) {
    setRows((prev) => ({
      ...prev,
      [season]: {
        ...prev[season],
        phrases: prev[season].phrases.map((p, i) => (i === idx ? value : p)),
      },
    }))
  }

  function removePhrase(season: Season, idx: number) {
    setRows((prev) => ({
      ...prev,
      [season]: {
        ...prev[season],
        phrases: prev[season].phrases.filter((_, i) => i !== idx),
      },
    }))
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-sage-600">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading seasonal content…
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-sage-600 hover:text-sage-800 mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Settings
        </Link>
        <h1 className="font-heading text-2xl font-bold text-sage-900 flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-sage-600" />
          Seasonal Content
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Imagery and phrases your AI uses to colour replies and tour invites
          with seasonal context. Sage and inquiry drafts pull from these rows
          when an inquiry references a season or a wedding date falls in one.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {SEASONS.map(({ key, label, emoji, hint }) => {
          const row = rows[key]
          const isSaving = saving === key
          return (
            <div key={key} className="bg-surface border border-border rounded-xl p-5 space-y-3">
              <div>
                <h2 className="font-medium text-sage-900 flex items-center gap-2">
                  <span className="text-lg" aria-hidden>{emoji}</span>
                  {label}
                </h2>
                <p className="text-xs text-sage-500 mt-0.5">{hint}</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-sage-700">Imagery</label>
                <input
                  value={row.imagery}
                  onChange={(e) => updateImagery(key, e.target.value)}
                  placeholder="e.g. dogwood blooms on the hilltop"
                  className="w-full border border-border rounded px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-sage-700">
                  Phrases
                  <span className="text-sage-400 font-normal ml-1">({row.phrases.length})</span>
                </label>
                <div className="space-y-1.5">
                  {row.phrases.map((p, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        value={p}
                        onChange={(e) => updatePhrase(key, i, e.target.value)}
                        placeholder={`Phrase ${i + 1}`}
                        className="flex-1 border border-border rounded px-3 py-1.5 text-sm"
                      />
                      <button
                        onClick={() => removePhrase(key, i)}
                        className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                        title="Remove phrase"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => addPhrase(key)}
                    className="text-xs text-sage-600 hover:text-sage-900 inline-flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add phrase
                  </button>
                </div>
              </div>

              <button
                onClick={() => saveSeason(key)}
                disabled={isSaving}
                className="px-4 py-2 bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1.5"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save {label}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
