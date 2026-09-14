/**
 * One reader for the day-of timeline.
 *
 * The `timeline` table is dual-mode and has been since migration 076,
 * which consolidated `wedding_timeline` into it but did not unify the two
 * shapes that were already using the name:
 *
 *   config-blob mode  One row per wedding. `config_json` holds
 *                     { config, events, customEvents } — the couple's
 *                     timeline builder writes this and upserts on
 *                     wedding_id. Migration 188 notes that it deliberately
 *                     DEFERRED the unique index, so the fork is known and
 *                     still open.
 *
 *   per-event mode    One row per event, with time / title / description /
 *                     category / location / sort_order. The coordinator
 *                     wedding page and the print view read this.
 *
 * A reconciler that only understood one mode would report every
 * commitment as unmatched for half the weddings in the database. So this
 * module reads both and returns the same thing either way: the list of
 * things that are on the day.
 *
 * It is the single reader. The queue component and the nightly sweep both
 * import it rather than each growing their own copy of the fork.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** One thing that is on the day, flattened out of whichever mode. */
export interface TimelineEntry {
  /** What a coordinator would call it. */
  title: string
  /** Wall-clock time when the row carries one. */
  time: string | null
  /** Free text attached to the entry, if any. Judged alongside the title. */
  notes: string | null
  /** Which shape this came out of. Useful when writing back. */
  mode: 'config' | 'rows'
}

/** The config-blob shape, narrowed to the fields this module touches. */
interface ConfigBlobEvent {
  name?: unknown
  time?: unknown
  notes?: unknown
  included?: unknown
}

interface ConfigBlob {
  events?: unknown
  customEvents?: unknown
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function entriesFromConfigBlob(blob: unknown): TimelineEntry[] {
  if (!blob || typeof blob !== 'object') return []
  const typed = blob as ConfigBlob
  const out: TimelineEntry[] = []

  // Built-in events carry `included`. An event the couple switched off is
  // not on the day, so it must not count as covering a commitment.
  // Custom events have no such flag; every one of them is on the day.
  const collect = (raw: unknown, honourIncluded: boolean) => {
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const ev = item as ConfigBlobEvent
      if (honourIncluded && ev.included === false) continue
      const title = readString(ev.name)
      if (!title) continue
      out.push({
        title,
        time: readString(ev.time),
        notes: readString(ev.notes),
        mode: 'config',
      })
    }
  }

  collect(typed.events, true)
  collect(typed.customEvents, false)
  return out
}

/**
 * Every entry on a wedding's day-of timeline, from whichever mode that
 * wedding's rows are in. Returns an empty list when the wedding has no
 * timeline at all, which is a real answer and not an error: a couple who
 * has built nothing yet has nothing covering anything.
 *
 * Never throws. A read failure returns `{ entries: [], readable: false }`
 * so the caller can tell "no timeline" from "could not look", and the
 * sweep can decline to mark things unmatched on the strength of a failed
 * query.
 */
export async function readTimelineEntries(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<{ entries: TimelineEntry[]; readable: boolean }> {
  // `select('*')` rather than a column list on purpose. `config_json` is
  // written by the couple's timeline builder but was never declared in a
  // migration before 406, so on any database where 406 has not run yet a
  // named select would fail with 42703 and this reader would report every
  // wedding as having no timeline. The print view at
  // portal/weddings/[id]/print reads it the same way for the same reason.
  const { data, error } = await supabase
    .from('timeline')
    .select('*')
    .eq('wedding_id', weddingId)
    .order('sort_order', { ascending: true })

  if (error) {
    return { entries: [], readable: false }
  }

  const rows = data ?? []
  const entries: TimelineEntry[] = []

  for (const row of rows as Array<Record<string, unknown>>) {
    // Config-blob row. One of these carries the whole day.
    if (row.config_json) {
      entries.push(...entriesFromConfigBlob(row.config_json))
      continue
    }
    // Per-event row.
    const title = readString(row.title)
    if (!title) continue
    entries.push({
      title,
      time: readString(row.time),
      notes: readString(row.description),
      mode: 'rows',
    })
  }

  return { entries, readable: true }
}

/** Just the titles, which is what the judge is shown. */
export function timelineTitles(entries: TimelineEntry[]): string[] {
  return entries.map((e) => (e.notes ? `${e.title} — ${e.notes}` : e.title))
}
