'use client'
/**
 * Coordinator-side: notes to the couple, live. Whatever is written here
 * is what they see at /notes, always the current version, with when it
 * last changed. Edit in place; there is no "send". Unpublish to hide a
 * note without deleting it.
 */
import { useEffect, useState } from 'react'
import { Loader2, Plus, Eye, EyeOff, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface Note {
  id: string
  title: string
  body: string
  published: boolean
  updated_at: string
}

export function VenueNotesWidget({ weddingId }: { weddingId: string }) {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    createClient()
      .from('venue_notes_to_couple')
      .select('id, title, body, published, updated_at')
      .eq('wedding_id', weddingId)
      .order('updated_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setError(error.message)
        setNotes((data as Note[] | null) ?? [])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [weddingId])

  function startNew() {
    setEditing('new')
    setTitle('')
    setBody('')
  }

  function startEdit(n: Note) {
    setEditing(n.id)
    setTitle(n.title)
    setBody(n.body)
  }

  async function save() {
    if (!title.trim() || !body.trim()) return
    setSaving(true)
    setError(null)
    const supabase = createClient()
    if (editing === 'new') {
      const { data: wedding } = await supabase.from('weddings').select('venue_id').eq('id', weddingId).maybeSingle()
      const { data: { user } } = await supabase.auth.getUser()
      const { data, error } = await supabase
        .from('venue_notes_to_couple')
        .insert({ venue_id: wedding?.venue_id, wedding_id: weddingId, title: title.trim(), body: body.trim(), created_by: user?.id ?? null })
        .select('id, title, body, published, updated_at')
        .single()
      setSaving(false)
      if (error) {
        setError(error.message)
        return
      }
      setNotes((n) => [data as Note, ...n])
    } else if (editing) {
      const { data, error } = await supabase
        .from('venue_notes_to_couple')
        .update({ title: title.trim(), body: body.trim() })
        .eq('id', editing)
        .select('id, title, body, published, updated_at')
        .single()
      setSaving(false)
      if (error) {
        setError(error.message)
        return
      }
      setNotes((n) => n.map((x) => (x.id === editing ? (data as Note) : x)))
    }
    setEditing(null)
  }

  async function togglePublished(n: Note) {
    const { error } = await createClient().from('venue_notes_to_couple').update({ published: !n.published }).eq('id', n.id)
    if (error) {
      setError(error.message)
      return
    }
    setNotes((all) => all.map((x) => (x.id === n.id ? { ...x, published: !n.published } : x)))
  }

  async function remove(id: string) {
    const { error } = await createClient().from('venue_notes_to_couple').delete().eq('id', id)
    if (error) {
      setError(error.message)
      return
    }
    setNotes((all) => all.filter((x) => x.id !== id))
    if (editing === id) setEditing(null)
  }

  return (
    <div className="bg-white border border-sage-100 rounded-xl p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-heading text-lg text-sage-900">Notes to the couple</h3>
        {loading ? <Loader2 className="w-4 h-4 animate-spin text-sage-400" /> : null}
      </div>
      <p className="text-xs text-sage-600 mb-4">
        Live on their &ldquo;From {'{venue}'}&rdquo; page. Edit here and they see the current version; nothing is sent, nothing goes stale.
      </p>

      {error ? <p className="text-xs text-red-700 mb-3">{error}</p> : null}

      {editing ? (
        <div className="rounded-lg bg-sage-50 border border-sage-100 p-3 space-y-2 mb-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title, e.g. What we agreed on the walkthrough"
            className="w-full rounded-md border border-sage-200 bg-white px-3 py-1.5 text-sm"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder="Write it the way you'd say it to them."
            className="w-full rounded-md border border-sage-200 bg-white px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={saving || !title.trim() || !body.trim()} className="rounded-md bg-sage-700 text-white px-3 py-1.5 text-sm disabled:opacity-50">
              {saving ? 'Saving…' : editing === 'new' ? 'Publish' : 'Save changes'}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-sage-200 px-3 py-1.5 text-sm text-sage-700">Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={startNew} className="inline-flex items-center gap-1 rounded-md border border-sage-200 px-3 py-1.5 text-sm text-sage-800 hover:bg-sage-50 mb-4">
          <Plus className="w-3.5 h-3.5" /> New note
        </button>
      )}

      {notes.length === 0 && !loading ? (
        <p className="text-sm text-sage-600">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-sage-100 px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <button type="button" onClick={() => startEdit(n)} className="text-left flex-1 min-w-0">
                  <p className="text-sm text-sage-900">{n.title}{!n.published ? <span className="ml-2 text-xs text-sage-500">(hidden)</span> : null}</p>
                  <p className="text-xs text-sage-600 line-clamp-2">{n.body}</p>
                  <p className="text-[11px] text-sage-500 mt-0.5">Updated {new Date(n.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => togglePublished(n)} className="text-sage-500 hover:text-sage-800" aria-label={n.published ? 'Hide from couple' : 'Show to couple'} title={n.published ? 'Hide from couple' : 'Show to couple'}>
                    {n.published ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                  <button type="button" onClick={() => remove(n.id)} className="text-sage-400 hover:text-red-700" aria-label="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
