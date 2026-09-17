'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'

/**
 * Notes from the venue, live. Whatever the venue writes here is what the
 * couple sees, always the current version, with when it last changed.
 * The venue edits these on the wedding page; the couple only reads.
 */

interface Note {
  id: string
  title: string
  body: string
  updated_at: string
  created_at: string
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export default function CoupleNotesPage() {
  const { weddingId, venueName, loading } = useCoupleContext()
  const [notes, setNotes] = useState<Note[] | null>(null)

  useEffect(() => {
    if (!weddingId) return
    let cancelled = false
    createClient()
      .from('venue_notes_to_couple')
      .select('id, title, body, updated_at, created_at')
      .eq('wedding_id', weddingId)
      .eq('published', true)
      .order('updated_at', { ascending: false })
      .then(({ data }) => {
        if (!cancelled) setNotes((data as Note[] | null) ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [weddingId])

  const venue = venueName ?? 'your venue'

  return (
    <div className="max-w-3xl">
      <h1
        className="text-3xl font-bold mb-2"
        style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
      >
        From {venue}
      </h1>
      <p className="text-gray-600 mb-8">
        Notes {venue} has written for you. This page is always the current version, so there&apos;s never an old copy to worry about.
      </p>

      {loading || notes === null ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : notes.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white px-6 py-8 text-gray-600">
          Nothing here yet. When {venue} writes something for you, it appears on this page.
        </div>
      ) : (
        <div className="space-y-4">
          {notes.map((n) => (
            <article key={n.id} id={n.id} className="rounded-2xl border border-gray-200 bg-white px-6 py-5">
              <h2 className="text-xl font-semibold text-gray-900" style={{ fontFamily: 'var(--couple-font-heading)' }}>
                {n.title}
              </h2>
              <p className="text-xs text-gray-500 mt-1">
                {n.updated_at !== n.created_at ? `Updated ${when(n.updated_at)}` : `Written ${when(n.created_at)}`}
              </p>
              <div className="mt-3 text-gray-800 leading-relaxed whitespace-pre-wrap">{n.body}</div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
