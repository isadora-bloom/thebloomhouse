'use client'

/**
 * Bulk review paste + import surface.
 *
 * Coordinator pastes a long blob from Knot / WeddingWire / etc.,
 * Claude extracts structured reviews, coordinator confirms a preview
 * table, batch inserts via the existing importReviews helper.
 *
 * The single-review screenshot path on /intel/reviews still works;
 * this page handles the "I have 30 reviews to dump in" case.
 */

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, Sparkles, Check, Trash2, Upload } from 'lucide-react'

interface ExtractedReview {
  reviewer_name: string
  rating: number
  body: string
  review_date: string | null
  source: string
  title: string | null
}

const SOURCE_OPTIONS = ['the_knot', 'wedding_wire', 'google', 'zola', 'yelp', 'facebook', 'other']

export default function ReviewsPastePage() {
  const [text, setText] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState<string | null>(null)
  const [reviews, setReviews] = useState<ExtractedReview[]>([])
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null)

  async function extract() {
    if (text.trim().length < 50) {
      setExtractError('Paste at least 50 characters of review text.')
      return
    }
    setExtracting(true)
    setExtractError(null)
    setImported(null)
    try {
      const res = await fetch('/api/intel/reviews/extract-from-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      setReviews(json.reviews ?? [])
      if ((json.reviews ?? []).length === 0) {
        setExtractError('Could not extract any reviews from the paste. Try a smaller chunk or check formatting.')
      }
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : String(e))
    } finally {
      setExtracting(false)
    }
  }

  function updateReview(idx: number, patch: Partial<ExtractedReview>) {
    setReviews((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  function removeReview(idx: number) {
    setReviews((prev) => prev.filter((_, i) => i !== idx))
  }

  async function commit() {
    if (reviews.length === 0) return
    setImporting(true)
    try {
      const res = await fetch('/api/intel/reviews/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      setImported(json.summary)
      setReviews([])
      setText('')
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/intel/reviews" className="p-2 rounded-lg hover:bg-sage-50 text-sage-500 hover:text-sage-800">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-2">
            <Upload className="w-6 h-6 text-teal-600" />
            Bulk paste reviews
          </h1>
          <p className="text-sm text-sage-500 mt-0.5">
            Paste a chunk of reviews from Knot, WeddingWire, Google, or anywhere else. Claude extracts the structured reviews; you confirm before they save.
          </p>
        </div>
      </div>

      {imported && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm text-emerald-800">
          <p className="font-medium">Imported {imported.inserted} review{imported.inserted === 1 ? '' : 's'}.</p>
          {imported.skipped > 0 && <p className="mt-1">Skipped {imported.skipped} duplicate{imported.skipped === 1 ? '' : 's'}.</p>}
          {imported.errors.length > 0 && (
            <p className="mt-1 text-amber-700">{imported.errors.length} error{imported.errors.length === 1 ? '' : 's'} logged.</p>
          )}
        </div>
      )}

      {reviews.length === 0 && (
        <div className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste reviews here. Multiple reviews concatenated together is fine - Claude will split them. Up to 200 KB."
            rows={20}
            className="w-full border border-border rounded-xl px-4 py-3 text-sm bg-white font-mono"
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-sage-500">
              {text.length.toLocaleString()} / 200,000 chars
            </p>
            <button
              type="button"
              onClick={extract}
              disabled={extracting || text.trim().length < 50}
              className="inline-flex items-center gap-2 px-5 py-2 bg-sage-600 text-white text-sm font-medium rounded-lg hover:bg-sage-700 disabled:opacity-50"
            >
              {extracting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Extracting (can take 30-60s)...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Extract reviews
                </>
              )}
            </button>
          </div>
          {extractError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-700">
              {extractError}
            </div>
          )}
        </div>
      )}

      {reviews.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-sage-700">
              <span className="font-semibold">{reviews.length}</span> review{reviews.length === 1 ? '' : 's'} extracted. Review + edit below, then save.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setReviews([]); setText(''); setExtractError(null) }}
                className="px-3 py-2 text-sm text-sage-600 hover:text-sage-900"
              >
                Discard + start over
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={importing}
                className="inline-flex items-center gap-2 px-5 py-2 bg-sage-600 text-white text-sm font-medium rounded-lg hover:bg-sage-700 disabled:opacity-50"
              >
                {importing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Save {reviews.length} review{reviews.length === 1 ? '' : 's'}
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {reviews.map((r, idx) => (
              <div key={idx} className="bg-surface border border-border rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">Reviewer</label>
                    <input
                      type="text"
                      value={r.reviewer_name}
                      onChange={(e) => updateReview(idx, { reviewer_name: e.target.value })}
                      className="w-full border border-border rounded-lg px-2 py-1.5 text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">Rating</label>
                    <select
                      value={r.rating}
                      onChange={(e) => updateReview(idx, { rating: Number(e.target.value) })}
                      className="w-full border border-border rounded-lg px-2 py-1.5 text-sm bg-white"
                    >
                      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} star{n === 1 ? '' : 's'}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">Source</label>
                    <select
                      value={r.source}
                      onChange={(e) => updateReview(idx, { source: e.target.value })}
                      className="w-full border border-border rounded-lg px-2 py-1.5 text-sm bg-white"
                    >
                      {SOURCE_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">Date (YYYY-MM-DD, optional)</label>
                    <input
                      type="text"
                      value={r.review_date ?? ''}
                      onChange={(e) => updateReview(idx, { review_date: e.target.value || null })}
                      placeholder="2024-10-15"
                      className="w-full border border-border rounded-lg px-2 py-1.5 text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">Title (optional)</label>
                    <input
                      type="text"
                      value={r.title ?? ''}
                      onChange={(e) => updateReview(idx, { title: e.target.value || null })}
                      className="w-full border border-border rounded-lg px-2 py-1.5 text-sm bg-white"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">Review body</label>
                  <textarea
                    value={r.body}
                    onChange={(e) => updateReview(idx, { body: e.target.value })}
                    rows={4}
                    className="w-full border border-border rounded-lg px-2 py-1.5 text-sm bg-white"
                  />
                </div>
                <div className="flex items-center justify-end pt-2 border-t border-border">
                  <button
                    type="button"
                    onClick={() => removeReview(idx)}
                    className="text-xs text-rose-600 hover:text-rose-800 inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove this review
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
