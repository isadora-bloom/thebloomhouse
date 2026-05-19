/**
 * Phase B Calendly source adapter.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §1 (Calendly is full-identity)
 * + §4 step 2.
 *
 * Where tour signals actually live (verified 2026-05-18)
 * ------------------------------------------------------
 * The pre-2026-05-18 adapter read `weddings.tour_date` — a column that
 * is NULL for ~every venue. Tour data lands in two other places, and
 * this adapter reads both:
 *
 *   1. `tours` — the operator-facing tour record. The live Calendly
 *      webhook (api/webhooks/calendly) writes one row per booking:
 *      scheduled_at, outcome, wedding_id, couple_display_name.
 *   2. `interactions` WHERE type='meeting' — the CSV-import path. The
 *      crm-import tour-scheduler adapter normalises Calendly CSV rows
 *      to interactions with type='meeting'. (The Gmail adapter takes
 *      type='email'; meetings were previously read by nobody.)
 *
 * A venue typically has tours from one path or the other; a venue with
 * both gets a (wedding_id, calendar-day) cross-table de-dup so the same
 * physical tour is not emitted twice.
 *
 * action_type — 'tour_booked' / 'tour_attended' / 'tour_cancelled' etc.
 * 'tour_attended' is a progression event per §3; the Tracer's
 * progression writer reads action_type to decide.
 */

import type { NormalizedSignal, SourceAdapter, SourceAdapterArgs } from './types'

const PAGE = 500

interface TourRow {
  id: string
  wedding_id: string | null
  scheduled_at: string | null
  outcome: string | null
  couple_display_name: string | null
  tour_type: string | null
  source: string | null
  created_at: string | null
}

interface MeetingRow {
  id: string
  wedding_id: string | null
  subject: string | null
  body_preview: string | null
  timestamp: string | null
  gmail_message_id: string | null
  from_name: string | null
}

/** Map a tours.outcome to a touchpoint action_type. */
function actionFromOutcome(outcome: string | null): string {
  const o = (outcome ?? '').toLowerCase()
  if (o.includes('attend') || o.includes('complet')) return 'tour_attended'
  if (o.includes('cancel')) return 'tour_cancelled'
  if (o.includes('no_show') || o.includes('no-show') || o.includes('noshow'))
    return 'tour_no_show'
  return 'tour_booked'
}

/** Map a meeting interaction's subject to a touchpoint action_type. */
function actionFromSubject(subject: string | null): string {
  const s = (subject ?? '').toLowerCase()
  if (s.includes('cancel')) return 'tour_cancelled'
  if (s.includes('reschedul')) return 'tour_rescheduled'
  return 'tour_booked'
}

async function* walk(
  args: SourceAdapterArgs,
): AsyncIterable<NormalizedSignal> {
  const { supabase, venueId, since } = args

  // (wedding_id|YYYY-MM-DD) of every tour emitted from the `tours`
  // table, so a CSV meeting for the same tour is not double-emitted.
  const seen = new Set<string>()

  // --- Pass 1: the `tours` table (live Calendly webhook + any source
  //     that writes operator tour records). ---
  let offset = 0
  while (true) {
    let q = supabase
      .from('tours')
      .select(
        'id, wedding_id, scheduled_at, outcome, couple_display_name, tour_type, source, created_at',
      )
      .eq('venue_id', venueId)
      .order('scheduled_at', { ascending: true, nullsFirst: true })
      .range(offset, offset + PAGE - 1)
    if (since) q = q.gte('scheduled_at', since)
    const { data, error } = await q
    if (error) throw new Error(`calendly(tours): ${error.message}`)
    const rows = (data ?? []) as TourRow[]
    if (rows.length === 0) break

    for (const t of rows) {
      const occurred = t.scheduled_at ?? t.created_at
      if (!occurred) continue
      if (t.wedding_id) seen.add(`${t.wedding_id}|${occurred.slice(0, 10)}`)
      yield {
        external_id: `tour:${t.id}`,
        channel: 'calendly',
        action_type: actionFromOutcome(t.outcome),
        occurred_at: occurred,
        signal_tier: 'highest',
        identity_hint: t.couple_display_name ?? null,
        primary_name: t.couple_display_name ?? null,
        primary_email: null,
        primary_phone: null,
        raw_payload: {
          tour_id: t.id,
          outcome: t.outcome,
          tour_type: t.tour_type,
          source: t.source,
          legacy_wedding_id: t.wedding_id,
        },
        legacy_wedding_id: t.wedding_id,
      }
    }
    if (rows.length < PAGE) break
    offset += PAGE
  }

  // --- Pass 2: CSV-imported tour meetings (interactions, type='meeting'). ---
  offset = 0
  while (true) {
    let q = supabase
      .from('interactions')
      .select(
        'id, wedding_id, subject, body_preview, timestamp, gmail_message_id, from_name',
      )
      .eq('venue_id', venueId)
      .eq('type', 'meeting')
      .order('timestamp', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (since) q = q.gte('timestamp', since)
    const { data, error } = await q
    if (error) throw new Error(`calendly(meetings): ${error.message}`)
    const rows = (data ?? []) as MeetingRow[]
    if (rows.length === 0) break

    for (const m of rows) {
      const occurred = m.timestamp
      if (!occurred) continue
      // Cross-table de-dup: skip if `tours` already covered this
      // wedding on this day.
      if (
        m.wedding_id &&
        seen.has(`${m.wedding_id}|${occurred.slice(0, 10)}`)
      ) {
        continue
      }
      yield {
        external_id: `meeting:${m.gmail_message_id ?? m.id}`,
        channel: 'calendly',
        action_type: actionFromSubject(m.subject),
        occurred_at: occurred,
        signal_tier: 'highest',
        identity_hint: m.from_name ?? null,
        primary_name: m.from_name ?? null,
        primary_email: null,
        primary_phone: null,
        raw_payload: {
          interaction_id: m.id,
          subject: m.subject,
          body_preview: m.body_preview,
          legacy_wedding_id: m.wedding_id,
        },
        legacy_wedding_id: m.wedding_id,
      }
    }
    if (rows.length < PAGE) break
    offset += PAGE
  }
}

const adapter: SourceAdapter = { name: 'calendly', channel: 'calendly', walk }
export default adapter
