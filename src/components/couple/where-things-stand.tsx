'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

/**
 * The calm strip at the top of the couple's dashboard. Three things and
 * no more: what the venue is waiting on (usually nothing), the next
 * dated moment, and any note the venue has written recently. No counts
 * of what's incomplete, no percentages, no red. "Nothing needed from
 * you right now" is the normal state and is said out loud.
 */

interface Ask {
  id: string
  title: string
  detail: string | null
  section_key: string | null
  due_date: string | null
}

interface Note {
  id: string
  title: string
  updated_at: string
}

const SECTION_HREF: Record<string, string> = {
  guests: 'guests', budget: 'budget', timeline: 'timeline', worksheets: 'worksheets', vendors: 'vendors',
  seating: 'seating', 'wedding-details': 'wedding-details', checklist: 'checklist', rooms: 'rooms',
  bar: 'bar', beauty: 'beauty', decor: 'decor', transportation: 'transportation', staffing: 'staffing',
  allergies: 'allergies', party: 'party', ceremony: 'ceremony', rehearsal: 'rehearsal', photos: 'photos',
  website: 'website', 'final-review': 'final-review', messages: 'messages', booking: 'booking',
}

function friendlyDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

export function WhereThingsStand({
  base,
  weddingId,
  venueName,
  weddingDate,
}: {
  base: string
  weddingId: string
  venueName: string
  weddingDate: string | null
}) {
  const [asks, setAsks] = useState<Ask[] | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [done, setDone] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    Promise.all([
      supabase
        .from('couple_asks')
        .select('id, title, detail, section_key, due_date')
        .eq('wedding_id', weddingId)
        .is('done_at', null)
        .order('due_date', { ascending: true, nullsFirst: false }),
      supabase
        .from('venue_notes_to_couple')
        .select('id, title, updated_at')
        .eq('wedding_id', weddingId)
        .eq('published', true)
        .order('updated_at', { ascending: false })
        .limit(2),
    ]).then(([a, n]) => {
      if (cancelled) return
      setAsks((a.data as Ask[] | null) ?? [])
      setNotes((n.data as Note[] | null) ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [weddingId])

  async function markDone(id: string) {
    setDone((s) => new Set(s).add(id))
    await createClient().from('couple_asks').update({ done_at: new Date().toISOString() }).eq('id', id)
  }

  if (asks === null) return null
  const openAsks = asks.filter((a) => !done.has(a.id))

  return (
    <section
      className="rounded-2xl border bg-white px-5 py-4 sm:px-6 sm:py-5 space-y-4"
      style={{ borderColor: 'var(--couple-secondary, #C1C7BB)' }}
      aria-label="Where things stand"
    >
      <div>
        <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Where things stand</p>
        {openAsks.length === 0 ? (
          <p className="text-gray-800" style={{ fontFamily: 'var(--couple-font-heading)' }}>
            Nothing needed from you right now.
          </p>
        ) : (
          <ul className="space-y-2">
            {openAsks.map((a) => {
              const href = a.section_key && SECTION_HREF[a.section_key] ? `${base}/${SECTION_HREF[a.section_key]}` : null
              return (
                <li key={a.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-gray-800">
                      {venueName} would like: <span className="font-medium">{a.title}</span>
                      {a.due_date ? <span className="text-gray-500"> by {friendlyDate(a.due_date)}</span> : null}
                    </p>
                    {a.detail ? <p className="text-sm text-gray-600 mt-0.5">{a.detail}</p> : null}
                    {href ? (
                      <Link href={href} className="text-sm underline text-gray-700">Open the section</Link>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => markDone(a.id)}
                    className="shrink-0 text-xs text-gray-600 border border-gray-200 rounded-full px-3 py-1 hover:bg-gray-50"
                  >
                    Done
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {weddingDate ? (
        <p className="text-sm text-gray-600">
          Your wedding is on {friendlyDate(weddingDate)}.
        </p>
      ) : null}

      {notes.length > 0 ? (
        <p className="text-sm text-gray-700">
          From {venueName}:{' '}
          {notes.map((n, i) => (
            <span key={n.id}>
              <Link href={`${base}/notes#${n.id}`} className="underline">{n.title}</Link>
              <span className="text-gray-500"> ({friendlyDate(n.updated_at)})</span>
              {i < notes.length - 1 ? ', ' : ''}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  )
}
