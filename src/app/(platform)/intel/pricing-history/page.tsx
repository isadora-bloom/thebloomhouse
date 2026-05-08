'use client'

/**
 * /intel/pricing-history — Tier-D #173.
 *
 * Surfaces the venue's pricing changelog. pricing_history is written by
 * the calculator-config edit path + the manual onboarding form, but
 * until this page nothing read it. Coordinators couldn't see the
 * trajectory of their pricing decisions and the elasticity insight
 * couldn't tie the dots back to a coordinator-visible audit trail.
 *
 * Renders newest-first, filterable by field_name, with the
 * old→new diff inline. Each row exposes an "add note" affordance so
 * the coordinator can attach the why ("matched competitor" /
 * "renovation increased capacity") that drives the demand-vs-supply
 * weighting downstream.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { ArrowLeft, Loader2, DollarSign, Pencil, Check, X } from 'lucide-react'

interface PricingRow {
  id: string
  field_name: string
  old_value: unknown
  new_value: unknown
  changed_by: string | null
  context: string | null
  notes: string | null
  changed_at: string
}

function fmtValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'object' && v !== null && 'value' in v) {
    const inner = (v as { value: unknown }).value
    if (typeof inner === 'number') return `$${inner.toLocaleString()}`
    return String(inner)
  }
  if (typeof v === 'number') return `$${v.toLocaleString()}`
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

function fmtField(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

export default function PricingHistoryPage() {
  const venueId = useVenueId()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<PricingRow[]>([])
  const [fieldFilter, setFieldFilter] = useState<string>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftNote, setDraftNote] = useState('')

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const { data, error } = await supabase
          .from('pricing_history')
          .select('id, field_name, old_value, new_value, changed_by, context, notes, changed_at')
          .eq('venue_id', venueId)
          .order('changed_at', { ascending: false })
          .limit(500)
        if (error) throw error
        if (!cancelled) setRows((data ?? []) as PricingRow[])
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [venueId])

  async function saveNote(id: string) {
    const supabase = createClient()
    const { error } = await supabase
      .from('pricing_history')
      .update({ notes: draftNote || null })
      .eq('id', id)
    if (error) {
      setErr(error.message)
      return
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, notes: draftNote || null } : r)))
    setEditingId(null)
    setDraftNote('')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
      </div>
    )
  }

  if (err) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-700">
          Could not load pricing history: {err}
        </div>
      </div>
    )
  }

  const fields = Array.from(new Set(rows.map((r) => r.field_name))).sort()
  const filtered = fieldFilter === 'all' ? rows : rows.filter((r) => r.field_name === fieldFilter)

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/intel" className="p-2 rounded-lg hover:bg-sage-50 text-sage-500 hover:text-sage-800">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-teal-600" />
            Pricing history
          </h1>
          <p className="text-sm text-sage-500 mt-0.5">
            Every pricing change at this venue, newest first. Add notes to capture why a change happened, so the elasticity model knows what to weight.
          </p>
        </div>
      </div>

      {fields.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFieldFilter('all')}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              fieldFilter === 'all'
                ? 'bg-sage-600 text-white border-sage-600'
                : 'bg-warm-white text-sage-700 border-border hover:bg-sage-50'
            }`}
          >
            All ({rows.length})
          </button>
          {fields.map((f) => {
            const count = rows.filter((r) => r.field_name === f).length
            return (
              <button
                key={f}
                onClick={() => setFieldFilter(f)}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  fieldFilter === f
                    ? 'bg-sage-600 text-white border-sage-600'
                    : 'bg-warm-white text-sage-700 border-border hover:bg-sage-50'
                }`}
              >
                {fmtField(f)} ({count})
              </button>
            )
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="p-10 bg-surface border border-border rounded-xl text-center">
          <DollarSign className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <h3 className="text-sage-800 font-medium mb-1">No pricing changes yet</h3>
          <p className="text-sm text-sage-500">
            When you edit a price field in onboarding or the calculator config, it shows up here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => {
            const isEditing = editingId === r.id
            return (
              <div key={r.id} className="bg-surface border border-border rounded-xl p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="text-base font-semibold text-sage-800">{fmtField(r.field_name)}</h3>
                      <span className="text-xs text-sage-400">{new Date(r.changed_at).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-sage-500 line-through">{fmtValue(r.old_value)}</span>
                      <span className="text-sage-400">→</span>
                      <span className="text-sage-900 font-medium">{fmtValue(r.new_value)}</span>
                    </div>
                    {r.context && (
                      <p className="text-xs text-sage-500 mt-1">via {r.context}</p>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <div className="flex items-center gap-2 pt-2 border-t border-border">
                    <input
                      type="text"
                      value={draftNote}
                      onChange={(e) => setDraftNote(e.target.value)}
                      placeholder="Why did this change happen?"
                      className="flex-1 border border-border rounded-lg px-3 py-1.5 text-sm bg-warm-white"
                      autoFocus
                    />
                    <button
                      onClick={() => saveNote(r.id)}
                      className="p-1.5 text-sage-600 hover:text-sage-900 hover:bg-sage-50 rounded"
                      title="Save"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => { setEditingId(null); setDraftNote('') }}
                      className="p-1.5 text-sage-400 hover:text-sage-700 rounded"
                      title="Cancel"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    {r.notes ? (
                      <p className="text-sm text-sage-700">{r.notes}</p>
                    ) : (
                      <p className="text-xs text-sage-400 italic">No note attached</p>
                    )}
                    <button
                      onClick={() => { setEditingId(r.id); setDraftNote(r.notes ?? '') }}
                      className="p-1.5 text-sage-400 hover:text-sage-700 hover:bg-sage-50 rounded"
                      title={r.notes ? 'Edit note' : 'Add note'}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
