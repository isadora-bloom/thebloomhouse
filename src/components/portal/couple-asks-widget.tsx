'use client'
/**
 * Coordinator-side: the few things the venue is actually waiting on from
 * this couple. Each one shows on the couple's dashboard under "Where
 * things stand" until they, or you, mark it done. Keep it to what you
 * genuinely need; an empty list reads "Nothing needed from you right now"
 * on their side, which is the point.
 *
 * Writes go straight through RLS (couple_asks_staff), same as the
 * priorities widget beside it.
 */
import { useEffect, useState } from 'react'
import { Loader2, Check, Plus, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface Ask {
  id: string
  title: string
  detail: string | null
  section_key: string | null
  due_date: string | null
  done_at: string | null
  created_at: string
}

const SECTIONS: { key: string; label: string }[] = [
  { key: '', label: 'No section' },
  { key: 'guests', label: 'Guest list' },
  { key: 'worksheets', label: 'Worksheets' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'seating', label: 'Seating' },
  { key: 'wedding-details', label: 'Wedding details' },
  { key: 'budget', label: 'Budget' },
  { key: 'rooms', label: 'Rooms' },
  { key: 'bar', label: 'Bar' },
  { key: 'allergies', label: 'Allergies' },
  { key: 'final-review', label: 'Final review' },
  { key: 'messages', label: 'Messages' },
]

export function CoupleAsksWidget({ weddingId }: { weddingId: string }) {
  const [asks, setAsks] = useState<Ask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [section, setSection] = useState('')
  const [due, setDue] = useState('')
  const [showDone, setShowDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    createClient()
      .from('couple_asks')
      .select('id, title, detail, section_key, due_date, done_at, created_at')
      .eq('wedding_id', weddingId)
      .order('done_at', { ascending: true, nullsFirst: true })
      .order('due_date', { ascending: true, nullsFirst: false })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setError(error.message)
        setAsks((data as Ask[] | null) ?? [])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [weddingId])

  async function add() {
    if (!title.trim()) return
    setAdding(true)
    setError(null)
    const supabase = createClient()
    const { data: wedding } = await supabase.from('weddings').select('venue_id').eq('id', weddingId).maybeSingle()
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('couple_asks')
      .insert({
        venue_id: wedding?.venue_id,
        wedding_id: weddingId,
        title: title.trim(),
        detail: detail.trim() || null,
        section_key: section || null,
        due_date: due || null,
        created_by: user?.id ?? null,
      })
      .select('id, title, detail, section_key, due_date, done_at, created_at')
      .single()
    setAdding(false)
    if (error) {
      setError(error.message)
      return
    }
    setAsks((a) => [data as Ask, ...a])
    setTitle('')
    setDetail('')
    setSection('')
    setDue('')
  }

  async function toggleDone(ask: Ask) {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const done_at = ask.done_at ? null : new Date().toISOString()
    const { error } = await supabase
      .from('couple_asks')
      .update({ done_at, done_by: done_at ? user?.id ?? null : null })
      .eq('id', ask.id)
    if (error) {
      setError(error.message)
      return
    }
    setAsks((a) => a.map((x) => (x.id === ask.id ? { ...x, done_at } : x)))
  }

  async function remove(id: string) {
    const { error } = await createClient().from('couple_asks').delete().eq('id', id)
    if (error) {
      setError(error.message)
      return
    }
    setAsks((a) => a.filter((x) => x.id !== id))
  }

  const open = asks.filter((a) => !a.done_at)
  const done = asks.filter((a) => a.done_at)

  return (
    <div className="bg-white border border-sage-100 rounded-xl p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-heading text-lg text-sage-900">Waiting on the couple</h3>
        {loading ? <Loader2 className="w-4 h-4 animate-spin text-sage-400" /> : null}
      </div>
      <p className="text-xs text-sage-600 mb-4">
        Shows at the top of their dashboard as &ldquo;Where things stand&rdquo;. Keep it to what you actually need; when this is empty they see &ldquo;Nothing needed from you right now&rdquo;.
      </p>

      {error ? <p className="text-xs text-red-700 mb-3">{error}</p> : null}

      {open.length === 0 && !loading ? (
        <p className="text-sm text-sage-600 mb-4">Nothing outstanding.</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {open.map((a) => (
            <li key={a.id} className="flex items-start gap-3 rounded-lg border border-sage-100 px-3 py-2">
              <button
                type="button"
                onClick={() => toggleDone(a)}
                className="mt-0.5 w-5 h-5 rounded-full border border-sage-300 flex items-center justify-center hover:bg-sage-50"
                aria-label="Mark done"
              >
                <Check className="w-3 h-3 text-transparent" />
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-sage-900">{a.title}</p>
                <p className="text-xs text-sage-600">
                  {a.due_date ? `by ${new Date(a.due_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'no date'}
                  {a.section_key ? ` · ${SECTIONS.find((s) => s.key === a.section_key)?.label ?? a.section_key}` : ''}
                </p>
                {a.detail ? <p className="text-xs text-sage-700 mt-0.5">{a.detail}</p> : null}
              </div>
              <button type="button" onClick={() => remove(a.id)} className="text-sage-400 hover:text-sage-700" aria-label="Remove">
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg bg-sage-50 border border-sage-100 p-3 space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What you need, e.g. Final guest count"
          className="w-full rounded-md border border-sage-200 bg-white px-3 py-1.5 text-sm"
        />
        <input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="One line of why, optional"
          className="w-full rounded-md border border-sage-200 bg-white px-3 py-1.5 text-sm"
        />
        <div className="flex gap-2">
          <select value={section} onChange={(e) => setSection(e.target.value)} className="flex-1 rounded-md border border-sage-200 bg-white px-2 py-1.5 text-sm">
            {SECTIONS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="rounded-md border border-sage-200 bg-white px-2 py-1.5 text-sm" />
          <button
            type="button"
            onClick={add}
            disabled={adding || !title.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-sage-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>

      {done.length > 0 ? (
        <div className="mt-3">
          <button type="button" onClick={() => setShowDone((v) => !v)} className="text-xs text-sage-600 underline">
            {showDone ? 'Hide' : 'Show'} {done.length} done
          </button>
          {showDone ? (
            <ul className="mt-2 space-y-1">
              {done.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-xs text-sage-600">
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span className="line-through">{a.title}</span>
                  <button type="button" onClick={() => toggleDone(a)} className="underline">reopen</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
