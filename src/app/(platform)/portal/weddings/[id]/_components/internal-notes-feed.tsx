'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Lock, Trash2, Loader2, Save, Pencil, X, Check } from 'lucide-react'

interface NoteRow {
  id: string
  content: string
  created_by: string | null
  created_at: string
  updated_at: string
  author_name?: string | null
}

interface AuthorRow {
  id: string
  first_name: string | null
  last_name: string | null
}

interface Props {
  weddingId: string
  venueId: string
  /** Legacy single-blob from `weddings.notes` shown above the feed if non-empty.
   *  Coordinator can promote it into the multi-entry feed in one click. */
  legacyNote: string | null
  onLegacyDismiss: () => void
}

function fmt(dt: string) {
  return new Date(dt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function InternalNotesFeed({ weddingId, venueId, legacyNote, onLegacyDismiss }: Props) {
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data: rows } = await supabase
      .from('wedding_internal_notes')
      .select('id, content, created_by, created_at, updated_at')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: false })

    const list = (rows ?? []) as NoteRow[]
    // Resolve author display names without dragging in joined SQL — the
    // notes feed is small, the lookup hits cache, and it keeps the schema
    // contract simple.
    const authorIds = Array.from(new Set(list.map((n) => n.created_by).filter(Boolean) as string[]))
    if (authorIds.length > 0) {
      const { data: authors } = await supabase
        .from('user_profiles')
        .select('id, first_name, last_name')
        .in('id', authorIds)
      const byId = new Map<string, AuthorRow>()
      for (const a of (authors ?? []) as AuthorRow[]) byId.set(a.id, a)
      for (const n of list) {
        if (n.created_by) {
          const a = byId.get(n.created_by)
          if (a) {
            const name = [a.first_name, a.last_name].filter(Boolean).join(' ').trim()
            n.author_name = name || null
          }
        }
      }
    }
    setNotes(list)
    setLoading(false)
  }, [weddingId])

  useEffect(() => {
    load()
  }, [load])

  async function addNote(content: string) {
    if (!content.trim()) return
    setBusy(true)
    const supabase = createClient()
    const { data: userResult } = await supabase.auth.getUser()
    const userId = userResult.user?.id ?? null
    const { data, error } = await supabase
      .from('wedding_internal_notes')
      .insert({
        venue_id: venueId,
        wedding_id: weddingId,
        content: content.trim(),
        created_by: userId,
      })
      .select('id, content, created_by, created_at, updated_at')
      .single()

    if (!error && data) {
      // Prepend optimistically, then refetch in background to pick up the
      // resolved author name.
      setNotes((prev) => [data as NoteRow, ...prev])
      setDraft('')
      void load()
    }
    setBusy(false)
  }

  async function saveEdit(id: string) {
    if (!editDraft.trim()) return
    const supabase = createClient()
    const { error } = await supabase
      .from('wedding_internal_notes')
      .update({ content: editDraft.trim() })
      .eq('id', id)
    if (!error) {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, content: editDraft.trim(), updated_at: new Date().toISOString() } : n
        )
      )
      setEditingId(null)
      setEditDraft('')
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this note?')) return
    const supabase = createClient()
    const { error } = await supabase.from('wedding_internal_notes').delete().eq('id', id)
    if (!error) setNotes((prev) => prev.filter((n) => n.id !== id))
  }

  async function promoteLegacy() {
    if (!legacyNote?.trim()) return
    await addNote(legacyNote)
    // Clear legacy column on the wedding so it doesn't keep showing up.
    const supabase = createClient()
    await supabase.from('weddings').update({ notes: null }).eq('id', weddingId)
    onLegacyDismiss()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-sage-500">
        <Lock className="w-3.5 h-3.5" />
        Staff-only notes. Not visible to the couple. Each entry is timestamped and attributed.
      </div>

      {/* New-entry form */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          addNote(draft)
        }}
        className="space-y-2"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note — coordination details, special requests, concerns, anything the team should know…"
          rows={3}
          className="w-full p-3 rounded-xl border border-sage-200 bg-warm-white text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-y"
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className={cn(
              'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              draft.trim() && !busy
                ? 'bg-sage-700 text-white hover:bg-sage-800'
                : 'bg-sage-100 text-sage-400 cursor-not-allowed'
            )}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Add note
          </button>
        </div>
      </form>

      {/* Legacy single-blob (only shown if present) */}
      {legacyNote?.trim() && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-amber-800">
            <span className="font-medium">Legacy note from `weddings.notes`</span>
            <span className="text-amber-600">— add it as an entry below to keep it in the feed.</span>
          </div>
          <p className="text-sm text-amber-900 whitespace-pre-wrap">{legacyNote}</p>
          <div className="flex gap-2">
            <button
              onClick={promoteLegacy}
              className="text-xs text-amber-900 underline hover:text-amber-950"
            >
              Move into the feed
            </button>
            <button onClick={onLegacyDismiss} className="text-xs text-amber-700 hover:text-amber-900">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Feed */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-sage-400 py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading notes…
        </div>
      ) : notes.length === 0 && !legacyNote?.trim() ? (
        <div className="text-center py-8 text-sm text-sage-400">
          No internal notes yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => {
            const edited = note.updated_at && note.updated_at !== note.created_at
            const isEditing = editingId === note.id
            return (
              <li key={note.id} className="rounded-xl border border-sage-100 bg-warm-white p-3">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="text-[11px] text-sage-500 flex items-center gap-2 flex-wrap">
                    <span>{note.author_name ?? 'Unknown'}</span>
                    <span>·</span>
                    <span>{fmt(note.created_at)}</span>
                    {edited && <span className="italic">edited</span>}
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => {
                          setEditingId(note.id)
                          setEditDraft(note.content)
                        }}
                        className="text-sage-400 hover:text-sage-700"
                        aria-label="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => remove(note.id)}
                        className="text-sage-400 hover:text-rose-500"
                        aria-label="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                {isEditing ? (
                  <div className="space-y-2">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      className="w-full p-2 rounded-lg border border-sage-200 bg-white text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 resize-y"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => {
                          setEditingId(null)
                          setEditDraft('')
                        }}
                        className="inline-flex items-center gap-1 text-xs text-sage-500 hover:text-sage-700"
                      >
                        <X className="w-3 h-3" /> Cancel
                      </button>
                      <button
                        onClick={() => saveEdit(note.id)}
                        className="inline-flex items-center gap-1 text-xs text-sage-700 hover:text-sage-900"
                      >
                        <Check className="w-3 h-3" /> Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-sage-800 whitespace-pre-wrap">{note.content}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
