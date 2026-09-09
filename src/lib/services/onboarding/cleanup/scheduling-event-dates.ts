/**
 * Step 2 of the onboarding cleanup pipeline — recover scheduling-event
 * datetimes from metadata.
 *
 * Extracted from scripts/backfill-scheduling-event-dates.ts (kept as a
 * thin CLI wrapper). Rewrites occurred_at on engagement_events /
 * wedding_touchpoints, and weddings.tour_date, from
 * metadata.event_datetime (the actual tour time) when it differs from
 * the current occurred_at by more than 24h — the pipeline used to
 * stamp these with the notification's arrival time instead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCalendlyDatetime } from '@/lib/services/ingestion/scheduling-tool-parsers'
import type { CleanupStepResult } from './types'
import { emptyResult } from './types'

const MIN_DRIFT_HOURS = 24

function parseEventTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const direct = new Date(value)
  if (!isNaN(direct.getTime())) return direct.toISOString()
  const ts = parseCalendlyDatetime(value)
  if (ts !== null) return new Date(ts).toISOString()
  return null
}

function parseFromSubject(subject: unknown): string | null {
  if (typeof subject !== 'string' || !subject) return null
  const m = subject.match(/(\d{1,2}:\d{2}\s*(?:am|pm))\s+(?:[A-Za-z]+,?\s+)?([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i)
  if (!m) return null
  const time = m[1].replace(/(\d)(am|pm)/i, '$1 $2').toUpperCase()
  const date = m[2]
  const t = Date.parse(`${date} ${time}`)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

function pickEventTime(metadata: { event_datetime?: string | null; subject?: string | null } | null): string | null {
  if (!metadata) return null
  return parseEventTime(metadata.event_datetime) ?? parseFromSubject(metadata.subject)
}

interface SubStats {
  scanned: number
  updated: number
  skippedNoMetadata: number
  skippedAlreadyAccurate: number
  skippedUnparseable: number
}
function newSubStats(): SubStats {
  return { scanned: 0, updated: 0, skippedNoMetadata: 0, skippedAlreadyAccurate: 0, skippedUnparseable: 0 }
}

export async function backfillSchedulingEventDates(
  sb: SupabaseClient,
  venueId: string,
  apply: boolean,
): Promise<CleanupStepResult> {
  const result = emptyResult('scheduling_event_dates', '2. Recover scheduling-event datetimes from metadata')
  const errors: string[] = []

  async function backfillEngagementEvents(): Promise<SubStats> {
    const stats = newSubStats()
    const PAGE = 500
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('engagement_events')
        .select('id, occurred_at, metadata')
        .eq('venue_id', venueId)
        .in('event_type', ['tour_scheduled', 'tour_completed', 'tour_cancelled', 'contract_signed'])
        .range(from, from + PAGE - 1)
      if (error) { errors.push(`engagement_events @${from}: ${error.message}`); break }
      const rows = (data ?? []) as Array<{ id: string; occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null } | null }>
      if (rows.length === 0) break
      for (const r of rows) {
        stats.scanned++
        const correct = pickEventTime(r.metadata)
        if (!correct) {
          if (!r.metadata?.event_datetime && !r.metadata?.subject) stats.skippedNoMetadata++
          else stats.skippedUnparseable++
          continue
        }
        const currentTs = r.occurred_at ? new Date(r.occurred_at).getTime() : null
        if (currentTs !== null && Math.abs(new Date(correct).getTime() - currentTs) < MIN_DRIFT_HOURS * 3_600_000) {
          stats.skippedAlreadyAccurate++
          continue
        }
        if (apply) {
          const { error: updErr } = await sb.from('engagement_events').update({ occurred_at: correct }).eq('id', r.id)
          if (!updErr) stats.updated++
          else errors.push(`ee ${r.id}: ${updErr.message}`)
        } else {
          stats.updated++
        }
      }
      if (rows.length < PAGE) break
      from += PAGE
    }
    return stats
  }

  async function backfillEngagementEventsFromSiblings(): Promise<SubStats> {
    const stats = newSubStats()
    const { data } = await sb
      .from('engagement_events')
      .select('id, wedding_id, occurred_at, metadata, event_type')
      .eq('venue_id', venueId)
      .in('event_type', ['tour_scheduled', 'tour_completed', 'tour_cancelled', 'contract_signed'])
    const rows = (data ?? []) as Array<{ id: string; wedding_id: string; occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null; interaction_id?: string | null } | null }>
    for (const r of rows) {
      stats.scanned++
      if (pickEventTime(r.metadata)) continue
      const interactionId = r.metadata?.interaction_id ?? null
      if (!interactionId) { stats.skippedNoMetadata++; continue }
      const { data: sibling } = await sb
        .from('engagement_events')
        .select('id, occurred_at, metadata')
        .eq('wedding_id', r.wedding_id)
        .contains('metadata', { interaction_id: interactionId })
        .neq('id', r.id)
        .limit(10)
      const sibs = (sibling ?? []) as Array<{ occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null } | null }>
      let correct: string | null = null
      for (const sib of sibs) {
        const fromMeta = pickEventTime(sib.metadata)
        if (fromMeta) { correct = fromMeta; break }
      }
      if (!correct && sibs.length > 0) {
        const latest = sibs.map((s) => s.occurred_at).filter((v): v is string => Boolean(v)).sort().at(-1)
        correct = latest ?? null
      }
      if (!correct) { stats.skippedUnparseable++; continue }
      const currentTs = r.occurred_at ? new Date(r.occurred_at).getTime() : null
      if (currentTs !== null && Math.abs(new Date(correct).getTime() - currentTs) < MIN_DRIFT_HOURS * 3_600_000) {
        stats.skippedAlreadyAccurate++
        continue
      }
      if (apply) {
        const { error: updErr } = await sb.from('engagement_events').update({ occurred_at: correct }).eq('id', r.id)
        if (!updErr) stats.updated++
        else errors.push(`ee-sibling ${r.id}: ${updErr.message}`)
      } else {
        stats.updated++
      }
    }
    return stats
  }

  async function backfillTouchpointsFromSiblings(): Promise<SubStats> {
    const stats = newSubStats()
    const { data } = await sb
      .from('wedding_touchpoints')
      .select('id, wedding_id, occurred_at, metadata, touch_type')
      .eq('venue_id', venueId)
      .in('touch_type', ['tour_conducted', 'contract_signed', 'tour_booked', 'calendly_booked'])
    const rows = (data ?? []) as Array<{ id: string; wedding_id: string; occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null; interaction_id?: string | null } | null }>
    for (const r of rows) {
      stats.scanned++
      if (pickEventTime(r.metadata)) continue
      const interactionId = r.metadata?.interaction_id ?? null
      if (!interactionId) { stats.skippedNoMetadata++; continue }
      const { data: sibling } = await sb
        .from('engagement_events')
        .select('occurred_at, metadata')
        .eq('wedding_id', r.wedding_id)
        .contains('metadata', { interaction_id: interactionId })
        .limit(10)
      const sibs = (sibling ?? []) as Array<{ occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null } | null }>
      let correct: string | null = null
      for (const sib of sibs) {
        const fromMeta = pickEventTime(sib.metadata)
        if (fromMeta) { correct = fromMeta; break }
      }
      if (!correct && sibs.length > 0) {
        const latest = sibs.map((s) => s.occurred_at).filter((v): v is string => Boolean(v)).sort().at(-1)
        correct = latest ?? null
      }
      if (!correct) { stats.skippedUnparseable++; continue }
      const currentTs = r.occurred_at ? new Date(r.occurred_at).getTime() : null
      if (currentTs !== null && Math.abs(new Date(correct).getTime() - currentTs) < MIN_DRIFT_HOURS * 3_600_000) {
        stats.skippedAlreadyAccurate++
        continue
      }
      if (apply) {
        const { error: updErr } = await sb.from('wedding_touchpoints').update({ occurred_at: correct }).eq('id', r.id)
        if (!updErr) stats.updated++
        else errors.push(`tp-sibling ${r.id}: ${updErr.message}`)
      } else {
        stats.updated++
      }
    }
    return stats
  }

  async function backfillTouchpoints(): Promise<SubStats> {
    const stats = newSubStats()
    const PAGE = 500
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('wedding_touchpoints')
        .select('id, occurred_at, metadata')
        .eq('venue_id', venueId)
        .in('touch_type', ['tour_booked', 'calendly_booked', 'tour_conducted', 'contract_signed'])
        .range(from, from + PAGE - 1)
      if (error) { errors.push(`wedding_touchpoints @${from}: ${error.message}`); break }
      const rows = (data ?? []) as Array<{ id: string; occurred_at: string | null; metadata: { event_datetime?: string | null; subject?: string | null } | null }>
      if (rows.length === 0) break
      for (const r of rows) {
        stats.scanned++
        const correct = pickEventTime(r.metadata)
        if (!correct) {
          if (!r.metadata?.event_datetime && !r.metadata?.subject) stats.skippedNoMetadata++
          else stats.skippedUnparseable++
          continue
        }
        const currentTs = r.occurred_at ? new Date(r.occurred_at).getTime() : null
        if (currentTs !== null && Math.abs(new Date(correct).getTime() - currentTs) < MIN_DRIFT_HOURS * 3_600_000) {
          stats.skippedAlreadyAccurate++
          continue
        }
        if (apply) {
          const { error: updErr } = await sb.from('wedding_touchpoints').update({ occurred_at: correct }).eq('id', r.id)
          if (!updErr) stats.updated++
          else errors.push(`tp ${r.id}: ${updErr.message}`)
        } else {
          stats.updated++
        }
      }
      if (rows.length < PAGE) break
      from += PAGE
    }
    return stats
  }

  async function backfillWeddingTourDates(): Promise<SubStats> {
    const stats = newSubStats()
    const { data: weddings } = await sb
      .from('weddings')
      .select('id, tour_date')
      .eq('venue_id', venueId)
      .is('tour_date', null)
    for (const w of (weddings ?? []) as Array<{ id: string; tour_date: string | null }>) {
      stats.scanned++
      const { data: events } = await sb
        .from('engagement_events')
        .select('metadata, occurred_at')
        .eq('venue_id', venueId)
        .eq('wedding_id', w.id)
        .eq('event_type', 'tour_scheduled')
        .order('occurred_at', { ascending: true })
        .limit(1)
      const ev = (events ?? [])[0] as { metadata: { event_datetime?: string | null; subject?: string | null } | null } | undefined
      const correct = pickEventTime(ev?.metadata ?? null)
      if (!correct) {
        if (!ev?.metadata?.event_datetime && !ev?.metadata?.subject) stats.skippedNoMetadata++
        else stats.skippedUnparseable++
        continue
      }
      if (apply) {
        const { error: updErr } = await sb.from('weddings').update({ tour_date: correct }).eq('id', w.id)
        if (!updErr) stats.updated++
        else errors.push(`wedding ${w.id}: ${updErr.message}`)
      } else {
        stats.updated++
      }
    }
    return stats
  }

  const ee = await backfillEngagementEvents()
  const eesibs = await backfillEngagementEventsFromSiblings()
  const tp = await backfillTouchpoints()
  const tpsibs = await backfillTouchpointsFromSiblings()
  const wd = await backfillWeddingTourDates()

  result.counts = {
    engagement_events_scanned: ee.scanned,
    engagement_events_updated: ee.updated,
    engagement_events_siblings_updated: eesibs.updated,
    touchpoints_scanned: tp.scanned,
    touchpoints_updated: tp.updated,
    touchpoints_siblings_updated: tpsibs.updated,
    wedding_tour_dates_scanned: wd.scanned,
    wedding_tour_dates_updated: wd.updated,
  }
  result.errors = errors
  return result
}
