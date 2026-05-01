'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import { ShieldAlert, Plus, Trash2, AlertTriangle } from 'lucide-react'

// ---------------------------------------------------------------------------
// Per-venue forbidden topics admin (T1-J / B-21)
//
// Migration 125 introduced venue_forbidden_topics. checkEscalationForVenue
// in src/config/escalation-keywords.ts merges these rows with the global
// ESCALATION_KEYWORDS list. This page lets coordinators add and remove
// venue-specific triggers without a code deploy.
//
// The table also feeds B-20 (Sage portal pre-classification): when the
// inbound message hits any of these keywords, Sage skips generation and
// hands off to the coordinator queue with reason='forbidden_topic'.
// ---------------------------------------------------------------------------

interface ForbiddenTopic {
  id: string
  venue_id: string
  keyword: string
  category: string | null
  reason: string | null
  created_at: string
}

const CATEGORY_OPTIONS = [
  { value: '', label: 'Uncategorised' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'legal', label: 'Legal' },
  { value: 'family', label: 'Family' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'medical', label: 'Medical' },
  { value: 'force_majeure', label: 'Force majeure' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'other', label: 'Other' },
]

export default function ForbiddenTopicsPage() {
  const venueId = useVenueId()
  const supabase = createClient()
  const [topics, setTopics] = useState<ForbiddenTopic[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newKeyword, setNewKeyword] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newReason, setNewReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchTopics = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    try {
      const { data, error: fetchErr } = await supabase
        .from('venue_forbidden_topics')
        .select('id, venue_id, keyword, category, reason, created_at')
        .eq('venue_id', venueId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
      if (fetchErr) throw fetchErr
      setTopics((data ?? []) as ForbiddenTopic[])
      setError(null)
    } catch (err) {
      console.error('Failed to load forbidden topics:', err)
      setError('Failed to load forbidden topics')
    } finally {
      setLoading(false)
    }
  }, [venueId, supabase])

  useEffect(() => {
    fetchTopics()
  }, [fetchTopics])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!venueId || !newKeyword.trim() || submitting) return
    setSubmitting(true)
    try {
      const { error: insertErr } = await supabase
        .from('venue_forbidden_topics')
        .insert({
          venue_id: venueId,
          keyword: newKeyword.trim(),
          category: newCategory || null,
          reason: newReason.trim() || null,
        })
      if (insertErr) throw insertErr
      setNewKeyword('')
      setNewCategory('')
      setNewReason('')
      await fetchTopics()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add'
      // Likely-cause hint for the most common error: duplicate keyword.
      setError(/duplicate|unique/i.test(msg) ? 'That keyword already exists for this venue.' : msg)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!venueId) return
    try {
      const { error: delErr } = await supabase
        .from('venue_forbidden_topics')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (delErr) throw delErr
      await fetchTopics()
    } catch (err) {
      console.error('Failed to delete forbidden topic:', err)
      setError('Failed to delete')
    }
  }

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-sage-500 text-sm">Loading…</p>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Forbidden topics</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Keywords listed here are checked on every inbound couple message and
          Sage chat. A match skips automation and routes the message to the
          coordinator queue. The platform also enforces a global default list
          (legal/refund/lawsuit/etc.) that applies to every venue — these are
          venue-specific additions.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleAdd} className="rounded-lg border border-sage-200 bg-white p-4 space-y-3">
        <h2 className="font-medium text-sage-900">Add a topic</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="text"
            required
            placeholder="Keyword (e.g. 'kosher catering')"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            className="rounded border border-sage-200 px-3 py-2 text-sm focus:outline-none focus:border-sage-400"
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            className="rounded border border-sage-200 px-3 py-2 text-sm focus:outline-none focus:border-sage-400"
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <textarea
          placeholder="Why is this forbidden? (optional, shown in escalation alert)"
          value={newReason}
          onChange={(e) => setNewReason(e.target.value)}
          rows={2}
          className="w-full rounded border border-sage-200 px-3 py-2 text-sm focus:outline-none focus:border-sage-400 resize-none"
        />
        <button
          type="submit"
          disabled={submitting || !newKeyword.trim()}
          className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
        >
          <Plus className="w-4 h-4" />
          {submitting ? 'Adding…' : 'Add topic'}
        </button>
      </form>

      <section className="space-y-2">
        <h2 className="font-medium text-sage-900">Current topics ({topics.length})</h2>
        {topics.length === 0 ? (
          <p className="text-sm text-sage-500 italic">No venue-specific topics yet — only the global defaults apply.</p>
        ) : (
          <ul className="rounded-lg border border-sage-200 bg-white divide-y divide-sage-100">
            {topics.map((t) => (
              <li key={t.id} className="px-4 py-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-sage-900">{t.keyword}</span>
                    {t.category && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage-50 text-[10px] font-medium text-sage-600 uppercase">
                        {t.category}
                      </span>
                    )}
                  </div>
                  {t.reason && (
                    <p className="text-xs text-sage-500 mt-1">{t.reason}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(t.id)}
                  className="text-sage-400 hover:text-red-600 p-1 rounded transition-colors"
                  title="Remove"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
