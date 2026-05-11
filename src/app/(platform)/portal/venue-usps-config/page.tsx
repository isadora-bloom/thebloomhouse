'use client'

/**
 * Portal → Venue USPs
 *
 * Coordinator editor for venue_usps — the short "what makes us different"
 * statements Sage blends into inquiry and client replies. Every venue ships
 * with an empty table until a coordinator enters these; without them the
 * personality-builder USP block is blank and Sage's drafts read generic.
 *
 * Multi-venue: rows are scoped by venue_id from useVenueId(). Two venues
 * in the same org never see each other's USPs. White-label: header uses
 * the venue's business_name from venue_config.
 */

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useAiName } from '@/lib/hooks/use-ai-name'
import { Sparkles, Save, Plus, Trash2, Loader2, Wand2, X, Check, Pencil } from 'lucide-react'

interface USP {
  id: string | null
  usp_text: string
  sort_order: number
  is_active: boolean
}

interface USPSuggestion {
  usp_text: string
  evidence_excerpt: string
  confidence: number
}

export default function VenueUSPsConfigPage() {
  const aiName = useAiName()
  const venueId = useVenueId()
  const [venueName, setVenueName] = useState('')
  const [usps, setUsps] = useState<USP[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Content-suggester state. The operator clicks "Pull suggestions from
  // your website" → POST to /api/admin/content-suggest/usps → the LLM
  // returns proposed USPs. Each one renders with Accept / Edit / Skip.
  // Suggestions are NEVER auto-saved; they become draft rows that the
  // operator then commits with the regular Save button.
  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState<USPSuggestion[] | null>(null)
  const [suggestError, setSuggestError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const [{ data: rows }, { data: cfg }] = await Promise.all([
      supabase
        .from('venue_usps')
        .select('id, usp_text, sort_order, is_active')
        .eq('venue_id', venueId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('venue_config')
        .select('business_name')
        .eq('venue_id', venueId)
        .maybeSingle(),
    ])
    setVenueName((cfg?.business_name as string) || '')
    setUsps(
      (rows ?? []).map((r) => ({
        id: r.id as string,
        usp_text: (r.usp_text as string) ?? '',
        sort_order: (r.sort_order as number) ?? 0,
        is_active: (r.is_active as boolean) ?? true,
      }))
    )
    setLoading(false)
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  function addRow() {
    setUsps((prev) => [
      ...prev,
      {
        id: null,
        usp_text: '',
        sort_order: prev.length,
        is_active: true,
      },
    ])
  }

  function removeRow(index: number) {
    setUsps((prev) => prev.filter((_, i) => i !== index))
  }

  function updateRow(index: number, patch: Partial<USP>) {
    setUsps((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  async function handleSuggest() {
    if (!venueId) return
    setSuggesting(true)
    setSuggestError(null)
    setSuggestions(null)
    try {
      const res = await fetch('/api/admin/content-suggest/usps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSuggestError(data?.error ?? 'Could not pull suggestions.')
        return
      }
      const list = (data?.suggestions ?? []) as USPSuggestion[]
      setSuggestions(list)
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setSuggesting(false)
    }
  }

  function acceptSuggestion(suggestion: USPSuggestion) {
    setUsps((prev) => [
      ...prev,
      {
        id: null,
        usp_text: suggestion.usp_text,
        sort_order: prev.length,
        is_active: true,
      },
    ])
    setSuggestions((prev) => prev?.filter((s) => s !== suggestion) ?? null)
  }

  function editSuggestion(suggestion: USPSuggestion) {
    // Drop the suggestion into the editable rows so the operator can
    // tweak the wording before saving. The focus stays on the new row.
    acceptSuggestion(suggestion)
  }

  function skipSuggestion(suggestion: USPSuggestion) {
    setSuggestions((prev) => prev?.filter((s) => s !== suggestion) ?? null)
  }

  function acceptAllSuggestions() {
    if (!suggestions) return
    setUsps((prev) => {
      const additions = suggestions.map((s, i) => ({
        id: null as string | null,
        usp_text: s.usp_text,
        sort_order: prev.length + i,
        is_active: true,
      }))
      return [...prev, ...additions]
    })
    setSuggestions(null)
  }

  async function handleSave() {
    if (!venueId) return
    setSaving(true)
    setSaved(false)
    setError(null)
    const supabase = createClient()

    // Delete rows removed since load (those in DB but not in current state).
    const { data: existing } = await supabase
      .from('venue_usps')
      .select('id')
      .eq('venue_id', venueId)
    const currentIds = new Set(usps.filter((u) => u.id).map((u) => u.id as string))
    const toDelete = (existing ?? [])
      .map((r) => r.id as string)
      .filter((id) => !currentIds.has(id))
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from('venue_usps')
        .delete()
        .in('id', toDelete)
      if (delErr) {
        setError(delErr.message)
        setSaving(false)
        return
      }
    }

    // Upsert the remaining rows with normalised sort_order.
    const payload = usps
      .filter((u) => u.usp_text.trim() !== '')
      .map((u, i) => ({
        ...(u.id ? { id: u.id } : {}),
        venue_id: venueId,
        usp_text: u.usp_text.trim(),
        sort_order: i,
        is_active: u.is_active,
      }))
    if (payload.length > 0) {
      const { error: upErr } = await supabase.from('venue_usps').upsert(payload)
      if (upErr) {
        setError(upErr.message)
        setSaving(false)
        return
      }
    }
    setSaved(true)
    setSaving(false)
    setTimeout(() => setSaved(false), 2500)
    await load()
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900 flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-sage-600" />
          {venueName ? `${venueName} · What makes us different` : 'Venue USPs'}
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Short statements {aiName} weaves into inquiry and client replies. Keep
          each one punchy — 8–15 words. Reorder by dragging or editing in
          place; the order here is the order {aiName} cycles through.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleSuggest}
          disabled={suggesting || loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-sage-800 bg-warm-white border border-sage-300 rounded-lg hover:bg-sage-50 disabled:opacity-50"
          title="Read your venue website and propose USPs"
        >
          {suggesting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Wand2 className="w-4 h-4 text-sage-700" />
          )}
          {suggesting ? 'Reading your website…' : 'Pull suggestions from your website'}
        </button>
        {suggestError && (
          <span className="text-sm text-rose-600">{suggestError}</span>
        )}
      </div>

      {suggestions && (
        <div className="bg-sage-50/60 border border-sage-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-medium text-sage-900 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-sage-600" /> Suggestions from your website
              </h2>
              <p className="text-xs text-sage-600 mt-0.5">
                Each suggestion shows the line on your site it came from.
                Accept adds it as a draft row below; Save USPs to commit.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {suggestions.length > 0 && (
                <button
                  type="button"
                  onClick={acceptAllSuggestions}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-sage-800 bg-white border border-sage-300 rounded hover:bg-sage-100"
                >
                  <Check className="w-3.5 h-3.5" /> Accept all
                </button>
              )}
              <button
                type="button"
                onClick={() => setSuggestions(null)}
                className="p-1.5 text-sage-500 hover:text-sage-800 hover:bg-white rounded"
                title="Dismiss suggestions"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          {suggestions.length === 0 ? (
            <p className="text-sm text-sage-600 italic">
              No new venue-specific USPs found. Your site may be generic, or
              everything specific is already in your list.
            </p>
          ) : (
            <ul className="space-y-2">
              {suggestions.map((s, i) => (
                <li
                  key={i}
                  className="bg-white border border-sage-200 rounded-lg p-3 space-y-1.5"
                >
                  <p className="text-sm text-sage-900">{s.usp_text}</p>
                  {s.evidence_excerpt && (
                    <p className="text-xs italic text-sage-500">
                      From the site: &ldquo;{s.evidence_excerpt}&rdquo;
                    </p>
                  )}
                  <div className="flex items-center gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => acceptSuggestion(s)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-sage-800 bg-sage-100 hover:bg-sage-200 rounded"
                    >
                      <Check className="w-3.5 h-3.5" /> Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => editSuggestion(s)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-sage-700 bg-white border border-sage-200 hover:bg-sage-50 rounded"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => skipSuggestion(s)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-sage-500 hover:text-sage-800 hover:bg-sage-50 rounded"
                    >
                      <X className="w-3.5 h-3.5" /> Skip
                    </button>
                    {typeof s.confidence === 'number' && (
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-sage-400">
                        confidence {Math.round(s.confidence * 100)}%
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-sage-500 italic">Loading…</p>
      ) : (
        <div className="space-y-3">
          {usps.length === 0 && (
            <p className="text-sm text-sage-500 italic">
              No USPs yet. Add one to start shaping {aiName}&apos;s voice.
            </p>
          )}
          {usps.map((u, i) => (
            <div
              key={u.id ?? `new-${i}`}
              className="flex items-start gap-2 bg-white border border-sage-200 rounded-lg p-3"
            >
              <span className="text-xs font-mono text-sage-400 pt-2 w-6 text-right shrink-0">
                {i + 1}
              </span>
              <textarea
                value={u.usp_text}
                onChange={(e) => updateRow(i, { usp_text: e.target.value })}
                rows={2}
                placeholder="e.g. Historic 1906 estate on 200 acres of Virginia hills — every couple gets the whole property."
                className="flex-1 px-3 py-2 border border-sage-200 rounded text-sm"
              />
              <label className="flex items-center gap-1 text-xs text-sage-700 pt-2 shrink-0">
                <input
                  type="checkbox"
                  checked={u.is_active}
                  onChange={(e) => updateRow(i, { is_active: e.target.checked })}
                />
                Active
              </label>
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="p-2 text-rose-600 hover:bg-rose-50 rounded"
                title="Remove this USP"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-sage-700 border border-sage-200 rounded-lg hover:bg-sage-50"
          >
            <Plus className="w-4 h-4" /> Add USP
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving…' : 'Save USPs'}
        </button>
        {saved && <span className="text-sm text-sage-600">Saved.</span>}
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>
    </div>
  )
}
