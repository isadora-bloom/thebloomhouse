'use client'

/**
 * Portal → Venue Resources
 *
 * Coordinator editor for `venue_resources` — the link tiles couples
 * see on /resources in the couple portal (vendor preferred lists,
 * planning guides, recommended reads, parking instructions, etc.).
 *
 * The audit on 2026-04-28 flagged this table as orphan: the couple
 * page reads it but no UI ever wrote to it, so any non-demo venue's
 * /resources page rendered hardcoded fallbacks. Migration 095 added
 * authenticated venue-isolation RLS so this UI can write.
 *
 * Field mapping:
 *   - title (required, e.g. "Preferred Vendors")
 *   - subtitle (optional one-line description)
 *   - url (required — external or internal link)
 *   - icon (free-text lucide icon name; defaults to 'link')
 *   - is_external (true = open in new tab; false = same-tab nav)
 *   - sort_order (display order on the couple page)
 *   - is_active (toggle visibility without deleting)
 */

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { Link2, Plus, Trash2, Loader2, Save, Eye, EyeOff } from 'lucide-react'

interface Resource {
  id: string
  venue_id: string
  title: string
  subtitle: string | null
  url: string
  icon: string | null
  is_external: boolean
  sort_order: number
  is_active: boolean
  created_at: string
}

const ICON_HINTS = ['link', 'book', 'star', 'map', 'phone', 'mail', 'file-text', 'image', 'users', 'home']

export default function VenueResourcesConfigPage() {
  const venueId = useVenueId()
  const [resources, setResources] = useState<Resource[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Add-form state
  const [titleDraft, setTitleDraft] = useState('')
  const [subtitleDraft, setSubtitleDraft] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [iconDraft, setIconDraft] = useState('link')
  const [isExternalDraft, setIsExternalDraft] = useState(true)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const { data, error: err } = await supabase
      .from('venue_resources')
      .select('*')
      .eq('venue_id', venueId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
    if (err) setError(err.message)
    else setResources((data ?? []) as Resource[])
    setLoading(false)
  }, [venueId])

  useEffect(() => { load() }, [load])

  async function addResource() {
    if (!venueId || !titleDraft.trim() || !urlDraft.trim()) {
      setError('Title and URL are required.')
      return
    }
    setSaving(true)
    setError(null)
    const supabase = createClient()
    const nextSort = resources.length === 0 ? 0 : Math.max(...resources.map((r) => r.sort_order)) + 1
    const { error: insErr } = await supabase.from('venue_resources').insert({
      venue_id: venueId,
      title: titleDraft.trim(),
      subtitle: subtitleDraft.trim() || null,
      url: urlDraft.trim(),
      icon: iconDraft.trim() || 'link',
      is_external: isExternalDraft,
      sort_order: nextSort,
      is_active: true,
    })
    if (insErr) {
      setError(insErr.message)
    } else {
      setTitleDraft('')
      setSubtitleDraft('')
      setUrlDraft('')
      setIconDraft('link')
      setIsExternalDraft(true)
      await load()
    }
    setSaving(false)
  }

  async function updateField(id: string, patch: Partial<Resource>) {
    const supabase = createClient()
    const { error: updErr } = await supabase
      .from('venue_resources')
      .update(patch)
      .eq('id', id)
    if (updErr) {
      setError(updErr.message)
      return
    }
    setResources((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  async function deleteResource(id: string) {
    if (!confirm('Delete this resource? It will disappear from the couple portal immediately.')) return
    const supabase = createClient()
    const { error: delErr } = await supabase.from('venue_resources').delete().eq('id', id)
    if (delErr) setError(delErr.message)
    else setResources((prev) => prev.filter((r) => r.id !== id))
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-sage-600">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading resources…
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-sage-900 flex items-center gap-2">
          <Link2 className="w-6 h-6 text-sage-600" />
          Couple Portal Resources
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Curate the link tiles your couples see on their{' '}
          <code className="text-xs bg-sage-50 px-1.5 py-0.5 rounded">/resources</code>{' '}
          page — vendor lists, planning guides, parking instructions.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Add form */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="font-medium text-sage-900 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add a resource
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            placeholder="Title (e.g. Preferred Vendors)"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm"
          />
          <input
            placeholder="URL (https://…)"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm"
          />
          <input
            placeholder="Subtitle (optional)"
            value={subtitleDraft}
            onChange={(e) => setSubtitleDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm sm:col-span-2"
          />
          <div className="flex items-center gap-2">
            <select
              value={iconDraft}
              onChange={(e) => setIconDraft(e.target.value)}
              className="border border-border rounded px-3 py-2 text-sm flex-1"
            >
              {ICON_HINTS.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-sage-700">
            <input
              type="checkbox"
              checked={isExternalDraft}
              onChange={(e) => setIsExternalDraft(e.target.checked)}
            />
            Open in new tab (external)
          </label>
        </div>
        <button
          onClick={addResource}
          disabled={saving || !titleDraft.trim() || !urlDraft.trim()}
          className="px-4 py-2 bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Add
        </button>
      </div>

      {/* List */}
      <div className="space-y-2">
        {resources.length === 0 ? (
          <div className="bg-sage-50 border border-border rounded-lg p-6 text-center text-sm text-sage-500">
            No resources yet. Add the first one above — it will show up immediately on the couple{' '}
            <code className="text-xs bg-white px-1 py-0.5 rounded">/resources</code> page.
          </div>
        ) : (
          resources.map((r) => (
            <div
              key={r.id}
              className={`bg-surface border border-border rounded-lg p-4 flex items-start gap-3 ${
                !r.is_active ? 'opacity-60' : ''
              }`}
            >
              <div className="flex-1 min-w-0 space-y-2">
                <input
                  value={r.title}
                  onChange={(e) => setResources((prev) => prev.map((x) => (x.id === r.id ? { ...x, title: e.target.value } : x)))}
                  onBlur={(e) => updateField(r.id, { title: e.target.value.trim() })}
                  className="font-medium text-sage-900 bg-transparent border-b border-transparent hover:border-sage-200 focus:border-sage-500 focus:outline-none w-full"
                />
                <input
                  value={r.subtitle ?? ''}
                  placeholder="(no subtitle)"
                  onChange={(e) => setResources((prev) => prev.map((x) => (x.id === r.id ? { ...x, subtitle: e.target.value } : x)))}
                  onBlur={(e) => updateField(r.id, { subtitle: e.target.value.trim() || null })}
                  className="text-sm text-sage-600 bg-transparent border-b border-transparent hover:border-sage-200 focus:border-sage-500 focus:outline-none w-full"
                />
                <input
                  value={r.url}
                  onChange={(e) => setResources((prev) => prev.map((x) => (x.id === r.id ? { ...x, url: e.target.value } : x)))}
                  onBlur={(e) => updateField(r.id, { url: e.target.value.trim() })}
                  className="text-xs text-sage-500 font-mono bg-transparent border-b border-transparent hover:border-sage-200 focus:border-sage-500 focus:outline-none w-full"
                />
                <div className="flex items-center gap-3 text-xs text-sage-500">
                  <select
                    value={r.icon ?? 'link'}
                    onChange={(e) => updateField(r.id, { icon: e.target.value })}
                    className="border border-border rounded px-2 py-0.5 text-xs"
                  >
                    {ICON_HINTS.map((i) => <option key={i} value={i}>{i}</option>)}
                  </select>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={r.is_external}
                      onChange={(e) => updateField(r.id, { is_external: e.target.checked })}
                    />
                    External
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-sage-500">Order</span>
                    <input
                      type="number"
                      value={r.sort_order}
                      onChange={(e) => setResources((prev) => prev.map((x) => (x.id === r.id ? { ...x, sort_order: Number(e.target.value) } : x)))}
                      onBlur={(e) => updateField(r.id, { sort_order: Number(e.target.value) || 0 })}
                      className="w-14 border border-border rounded px-2 py-0.5"
                    />
                  </label>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button
                  onClick={() => updateField(r.id, { is_active: !r.is_active })}
                  title={r.is_active ? 'Hide from couples' : 'Show to couples'}
                  className="p-1.5 text-sage-500 hover:text-sage-900 hover:bg-sage-50 rounded"
                >
                  {r.is_active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => deleteResource(r.id)}
                  title="Delete"
                  className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="text-xs text-sage-500 italic flex items-center gap-1">
        <Save className="w-3 h-3" />
        Changes save automatically when you click off a field.
      </div>
    </div>
  )
}
