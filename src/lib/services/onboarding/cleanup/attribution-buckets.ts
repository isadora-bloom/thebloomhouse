/**
 * Step 5 of the onboarding cleanup pipeline — recompute attribution
 * buckets.
 *
 * Extracted from scripts/recompute-attribution-buckets.ts (kept as a
 * thin CLI wrapper). After step 3 corrects inquiry_date, the bucket /
 * is_first_touch on existing attribution_events rows may be stale — a
 * signal that's now post-inquiry may still be labelled 'attribution'.
 * Re-derives against the current inquiry dates.
 *
 * Bucket rule (matches src/lib/services/candidate-resolver.ts):
 *   bucket = signal_date >= inquiry_date ? 'nurture' : 'attribution'
 * First-touch rule: exactly one row per wedding gets is_first_touch =
 * true — the bucket='attribution' row with the earliest signal_date.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CleanupStepResult } from './types'
import { emptyResult } from './types'

interface Event {
  id: string
  wedding_id: string
  signal_id: string | null
  bucket: string
  is_first_touch: boolean
}
interface Signal { id: string; signal_date: string | null }

export async function recomputeAttributionBuckets(
  sb: SupabaseClient,
  venueId: string,
  apply: boolean,
): Promise<CleanupStepResult> {
  const result = emptyResult('attribution_buckets', '5. Recompute attribution buckets')
  const errors: string[] = []

  const { data: eventsRaw, error: evErr } = await sb
    .from('attribution_events')
    .select('id, wedding_id, signal_id, bucket, is_first_touch')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
  if (evErr) {
    result.ok = false
    result.errors.push(evErr.message)
    return result
  }
  const events = (eventsRaw ?? []) as Event[]
  if (events.length === 0) {
    result.counts = { attribution_events: 0, bucket_flips: 0, first_touch_changes: 0, rows_written: 0 }
    return result
  }

  const sigIds = events.map((e) => e.signal_id).filter((v): v is string => Boolean(v))
  const sigDateById = new Map<string, string>()
  const CHUNK = 100
  for (let i = 0; i < sigIds.length; i += CHUNK) {
    const chunk = sigIds.slice(i, i + CHUNK)
    const { data: sigs } = await sb.from('tangential_signals').select('id, signal_date').in('id', chunk)
    for (const s of (sigs ?? []) as Signal[]) {
      if (s.signal_date) sigDateById.set(s.id, s.signal_date)
    }
  }

  const weddingIds = Array.from(new Set(events.map((e) => e.wedding_id)))
  const inquiryDateById = new Map<string, string | null>()
  for (let i = 0; i < weddingIds.length; i += CHUNK) {
    const chunk = weddingIds.slice(i, i + CHUNK)
    const { data: weds } = await sb.from('weddings').select('id, inquiry_date').in('id', chunk)
    for (const w of (weds ?? []) as Array<{ id: string; inquiry_date: string | null }>) {
      inquiryDateById.set(w.id, w.inquiry_date)
    }
  }

  let bucketsFlipped = 0
  let firstTouchesChanged = 0
  const updates: Array<{ id: string; patch: Partial<Event> }> = []
  const eventsByWedding = new Map<string, Event[]>()
  for (const e of events) {
    const arr = eventsByWedding.get(e.wedding_id) ?? []
    arr.push(e)
    eventsByWedding.set(e.wedding_id, arr)
  }

  for (const [wid, evs] of eventsByWedding.entries()) {
    const inquiryDate = inquiryDateById.get(wid) ?? null
    const inquiryTs = inquiryDate ? new Date(inquiryDate).getTime() : null

    type Decided = { event: Event; desiredBucket: string; signalTs: number | null }
    const decided: Decided[] = evs.map((e) => {
      const sigDate = e.signal_id ? sigDateById.get(e.signal_id) : undefined
      const signalTs = sigDate ? new Date(sigDate).getTime() : null
      let desiredBucket = e.bucket
      if (signalTs !== null && inquiryTs !== null) {
        desiredBucket = signalTs >= inquiryTs ? 'nurture' : 'attribution'
      }
      return { event: e, desiredBucket, signalTs }
    })

    let earliest: { id: string; ts: number } | null = null
    for (const d of decided) {
      if (d.desiredBucket !== 'attribution' || d.signalTs === null) continue
      if (!earliest || d.signalTs < earliest.ts) earliest = { id: d.event.id, ts: d.signalTs }
    }

    for (const d of decided) {
      const desiredFirstTouch = earliest?.id === d.event.id
      const patch: Partial<Event> = {}
      if (d.desiredBucket !== d.event.bucket) {
        patch.bucket = d.desiredBucket
        bucketsFlipped++
      }
      if (desiredFirstTouch !== d.event.is_first_touch) {
        patch.is_first_touch = desiredFirstTouch
        firstTouchesChanged++
      }
      if (Object.keys(patch).length > 0) updates.push({ id: d.event.id, patch })
    }
  }

  let written = 0
  if (apply && updates.length > 0) {
    for (const u of updates) {
      const { error } = await sb.from('attribution_events').update(u.patch).eq('id', u.id)
      if (error) errors.push(`${u.id}: ${error.message}`)
      else written++
    }
  }

  result.counts = {
    weddings_scanned: weddingIds.length,
    attribution_events: events.length,
    bucket_flips: bucketsFlipped,
    first_touch_changes: firstTouchesChanged,
    rows_written: apply ? written : updates.length,
  }
  result.errors = errors
  return result
}
