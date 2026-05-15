'use client'

/**
 * Unmerge modal — "Split this couple".
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §9. Operator picks the
 * touchpoints that belong to a different couple, chooses where they
 * go (new couple / existing couple / demote to fragment), and gives
 * a required reason. POSTs to /api/admin/identity/unmerge.
 */

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, Scissors, X } from 'lucide-react'

export interface UnmergeTouchpoint {
  id: string
  channel: string
  action_type: string
  occurred_at: string
}

interface Props {
  coupleId: string
  venueId: string
  touchpoints: UnmergeTouchpoint[]
  onClose: () => void
  onDone: () => void
}

type Destination = 'new_couple' | 'existing_couple' | 'fragment'

interface CoupleSearchRow {
  id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
}

export function UnmergeModal({
  coupleId,
  venueId,
  touchpoints,
  onClose,
  onDone,
}: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [destination, setDestination] = useState<Destination>('new_couple')
  const [reason, setReason] = useState('')
  const [targetCoupleId, setTargetCoupleId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<CoupleSearchRow[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Debounced couple search for the existing-couple destination.
  useEffect(() => {
    if (destination !== 'existing_couple' || search.trim().length < 2) {
      setSearchResults([])
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      const { data } = await supabase
        .from('couples')
        .select('id, primary_contact_name, primary_contact_email')
        .eq('venue_id', venueId)
        .neq('id', coupleId)
        .ilike('primary_contact_name', `%${search.trim()}%`)
        .limit(8)
      if (!cancelled) setSearchResults((data ?? []) as CoupleSearchRow[])
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [search, destination, supabase, venueId, coupleId])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const canSubmit =
    selected.size > 0 &&
    reason.trim().length > 0 &&
    (destination !== 'existing_couple' || !!targetCoupleId) &&
    !submitting

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/identity/unmerge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          couple_id: coupleId,
          touchpoint_ids: Array.from(selected),
          destination,
          target_couple_id:
            destination === 'existing_couple' ? targetCoupleId : undefined,
          reason: reason.trim(),
        }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
        return
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-stone-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-stone-600" />
            <h2 className="font-medium text-stone-900">Split this couple</h2>
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-stone-600">
            Select the touchpoints that belong to a different couple. They will
            be moved off this record. This is reversible only by another manual
            edit, so pick carefully.
          </p>

          <div className="rounded-md border border-stone-200">
            <div className="border-b border-stone-100 bg-stone-50 px-3 py-2 text-xs uppercase tracking-wide text-stone-500">
              Touchpoints ({selected.size} selected)
            </div>
            <div className="max-h-56 overflow-y-auto">
              {touchpoints.length === 0 && (
                <div className="px-3 py-4 text-sm text-stone-500">
                  No touchpoints on this couple.
                </div>
              )}
              {touchpoints.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-stone-50 px-3 py-2 text-sm last:border-0 hover:bg-stone-50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => toggle(t.id)}
                  />
                  <span className="font-medium text-stone-800">
                    {t.action_type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-stone-500">{t.channel}</span>
                  <span className="ml-auto text-xs text-stone-400">
                    {new Date(t.occurred_at).toLocaleDateString()}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-stone-500">
              Move them to
            </div>
            <div className="flex flex-col gap-1 text-sm">
              {(
                [
                  ['new_couple', 'A new couple'],
                  ['existing_couple', 'An existing couple'],
                  ['fragment', 'Demote to fragments (unanchored)'],
                ] as Array<[Destination, string]>
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="destination"
                    checked={destination === key}
                    onChange={() => setDestination(key)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {destination === 'existing_couple' && (
            <div>
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setTargetCoupleId(null)
                }}
                placeholder="Search couples by name"
                className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm outline-none"
              />
              {searchResults.length > 0 && !targetCoupleId && (
                <div className="mt-1 rounded-md border border-stone-200">
                  {searchResults.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setTargetCoupleId(r.id)
                        setSearch(r.primary_contact_name ?? r.id)
                        setSearchResults([])
                      }}
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-stone-50"
                    >
                      {r.primary_contact_name ?? '(unnamed)'}
                      {r.primary_contact_email && (
                        <span className="text-stone-400"> · {r.primary_contact_email}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {targetCoupleId && (
                <div className="mt-1 text-xs text-emerald-700">
                  Target selected.
                </div>
              )}
            </div>
          )}

          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-stone-500">
              Reason (required)
            </div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why don't these touchpoints belong to this couple?"
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none"
            />
          </div>

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm hover:bg-stone-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex items-center gap-2 rounded-md bg-stone-900 px-4 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-40"
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
            Split {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
