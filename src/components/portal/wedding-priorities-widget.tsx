'use client'

/**
 * Coordinator-side widget for flagging a couple's section priorities.
 *
 * 2026-05-26. Pairs with the sidebar "Now" star added in the same
 * sweep. Coordinator picks 0-8 sidebar sections; on save, the API
 * replaces the priority set. Couples see filled-amber stars on these
 * items (overriding the time-aware default).
 *
 * Drop into any coordinator page that has a weddingId. Self-contained
 * fetch + save; no parent-state plumbing.
 */

import { useEffect, useState } from 'react'
import { Loader2, Check, Star, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PriorityRow {
  id: string
  section_slug: string
  sort_order: number
  note: string | null
  created_at?: string
  updated_at?: string
}

// Curated picker — only the actionable sections the couple can act
// on. Mirrors the SECTIONS registry in section-status.ts. Kept here
// by hand to avoid pulling the whole client-side registry into the
// admin bundle. Update both when sidebar slugs change.
const PRIORITY_OPTIONS: { slug: string; label: string; group: string }[] = [
  // General
  { slug: 'wedding-details', label: 'Wedding Details', group: 'General' },
  { slug: 'budget', label: 'Budget', group: 'General' },
  { slug: 'booking', label: 'Booking', group: 'General' },
  { slug: 'timeline', label: 'Timeline', group: 'General' },
  { slug: 'ceremony', label: 'Ceremony', group: 'General' },
  { slug: 'ceremony-chairs', label: 'Ceremony Chairs', group: 'General' },
  { slug: 'rehearsal', label: 'Rehearsal Dinner', group: 'General' },
  { slug: 'final-review', label: 'Final Review', group: 'General' },
  // Vendors
  { slug: 'vendors', label: 'Vendors', group: 'Vendors' },
  { slug: 'contracts', label: 'Contracts', group: 'Vendors' },
  { slug: 'bar', label: 'Bar', group: 'Vendors' },
  { slug: 'beauty', label: 'Beauty', group: 'Vendors' },
  { slug: 'decor', label: 'Decor', group: 'Vendors' },
  { slug: 'photos', label: 'Photos', group: 'Vendors' },
  { slug: 'transportation', label: 'Transportation', group: 'Vendors' },
  { slug: 'staffing', label: 'Staffing', group: 'Vendors' },
  // Guests
  { slug: 'guests', label: 'Guest List', group: 'Guests' },
  { slug: 'rsvp-settings', label: 'RSVP Settings', group: 'Guests' },
  { slug: 'party', label: 'Wedding Party', group: 'Guests' },
  { slug: 'allergies', label: 'Allergies', group: 'Guests' },
  { slug: 'guest-care', label: 'Guest Care', group: 'Guests' },
  { slug: 'rooms', label: 'Rooms', group: 'Guests' },
  { slug: 'seating', label: 'Seating', group: 'Guests' },
  { slug: 'table-map', label: 'Floor Plan', group: 'Guests' },
  { slug: 'tables', label: 'Table Sizes', group: 'Guests' },
  // Resources
  { slug: 'worksheets', label: 'Worksheets', group: 'Resources' },
  { slug: 'venue-inventory', label: 'Venue Inclusions', group: 'Resources' },
  { slug: 'website', label: 'Wedding Website', group: 'Resources' },
]

const OPTION_BY_SLUG = new Map(PRIORITY_OPTIONS.map((o) => [o.slug, o]))

const MAX_PRIORITIES = 8

export function WeddingPrioritiesWidget({ weddingId }: { weddingId: string }) {
  const [items, setItems] = useState<PriorityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draftNoteId, setDraftNoteId] = useState<string | null>(null)
  const [draftNote, setDraftNote] = useState('')

  // ----- fetch -----
  useEffect(() => {
    if (!weddingId) return
    let cancelled = false
    fetch(`/api/portal/weddings/${weddingId}/priorities`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        if (data?.priorities) setItems(data.priorities as PriorityRow[])
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[WeddingPrioritiesWidget] load failed:', err)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [weddingId])

  // ----- save (replace set) -----
  async function persist(next: PriorityRow[]) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/weddings/${weddingId}/priorities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: next.map((i, idx) => ({
            section_slug: i.section_slug,
            sort_order: idx,
            note: i.note,
          })),
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setItems((data.priorities ?? []) as PriorityRow[])
    } catch (err) {
      console.error('[WeddingPrioritiesWidget] save failed:', err)
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function addPriority(slug: string) {
    if (items.some((i) => i.section_slug === slug)) return
    if (items.length >= MAX_PRIORITIES) {
      setError(`Maximum ${MAX_PRIORITIES} priorities at a time. Remove one to add another.`)
      return
    }
    const next: PriorityRow[] = [
      ...items,
      { id: 'pending', section_slug: slug, sort_order: items.length, note: null },
    ]
    setItems(next)
    setPickerOpen(false)
    persist(next)
  }

  function removePriority(slug: string) {
    const next = items.filter((i) => i.section_slug !== slug)
    setItems(next)
    persist(next)
  }

  function saveNote(slug: string) {
    const next = items.map((i) =>
      i.section_slug === slug ? { ...i, note: draftNote.trim() || null } : i
    )
    setItems(next)
    setDraftNoteId(null)
    setDraftNote('')
    persist(next)
  }

  function startNote(item: PriorityRow) {
    setDraftNoteId(item.section_slug)
    setDraftNote(item.note || '')
  }

  // ----- render -----

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
            <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
            Coordinator priorities
          </h3>
          <p className="text-xs text-gray-500">
            Pin 1-{MAX_PRIORITIES} sections the couple should focus on. Overrides the time-aware suggestion.
          </p>
        </div>
        {!loading && items.length < MAX_PRIORITIES && (
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className={cn(
              'text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors',
              pickerOpen ? 'bg-gray-100 border-gray-300' : 'border-gray-200 hover:bg-gray-50'
            )}
          >
            {pickerOpen ? 'Cancel' : 'Add priority'}
          </button>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-start gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 shrink-0">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-xs text-gray-400 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading priorities…
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-400 italic">
          No priorities set. The couple sees time-aware suggestions based on their wedding date.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => {
            const opt = OPTION_BY_SLUG.get(item.section_slug)
            const label = opt?.label || item.section_slug
            const isEditingNote = draftNoteId === item.section_slug
            return (
              <li key={item.section_slug} className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2">
                <div className="flex items-start gap-2">
                  <Star className="w-3.5 h-3.5 fill-amber-500 text-amber-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800">{label}</div>
                    {isEditingNote ? (
                      <div className="mt-1.5 flex gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={draftNote}
                          onChange={(e) => setDraftNote(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveNote(item.section_slug) }}
                          placeholder="Optional note for the couple…"
                          maxLength={500}
                          className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                        <button
                          onClick={() => saveNote(item.section_slug)}
                          className="text-xs px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                        >
                          <Check className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => { setDraftNoteId(null); setDraftNote('') }}
                          className="text-xs px-2 py-1 rounded text-gray-500 hover:bg-gray-100 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ) : item.note ? (
                      <button
                        onClick={() => startNote(item)}
                        className="mt-0.5 text-xs text-gray-500 italic hover:text-gray-700 text-left"
                      >
                        “{item.note}”
                      </button>
                    ) : (
                      <button
                        onClick={() => startNote(item)}
                        className="mt-0.5 text-xs text-gray-400 hover:text-gray-600"
                      >
                        + add note
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => removePriority(item.section_slug)}
                    className="text-gray-400 hover:text-red-600 shrink-0"
                    title="Remove priority"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {pickerOpen && (
        <div className="border border-gray-200 rounded-lg bg-gray-50/50 p-3 space-y-2">
          {Object.entries(
            PRIORITY_OPTIONS.reduce<Record<string, typeof PRIORITY_OPTIONS>>((acc, opt) => {
              acc[opt.group] = acc[opt.group] || []
              acc[opt.group].push(opt)
              return acc
            }, {})
          ).map(([group, opts]) => (
            <div key={group}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">{group}</p>
              <div className="flex flex-wrap gap-1.5">
                {opts.map((opt) => {
                  const already = items.some((i) => i.section_slug === opt.slug)
                  return (
                    <button
                      key={opt.slug}
                      disabled={already}
                      onClick={() => addPriority(opt.slug)}
                      className={cn(
                        'text-xs px-2 py-1 rounded-full border transition-colors',
                        already
                          ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                          : 'bg-white border-gray-200 text-gray-700 hover:bg-amber-50 hover:border-amber-300'
                      )}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {saving && (
        <div className="text-[10px] text-gray-400 flex items-center gap-1">
          <Loader2 className="w-2.5 h-2.5 animate-spin" /> Saving…
        </div>
      )}
    </div>
  )
}
