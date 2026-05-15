/**
 * Phase B anchors adapter — booked clients as ground truth.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 step 1 ("Anchor discovery:
 * pull booked clients from CRM (HoneyBook, Aisle Planner, etc.) →
 * create Person records for each, lifecycle_state='booked'").
 *
 * Phase A already mirrors every wedding into `couples` via the
 * dual-write hook in mintWedding + the backfill in migration 346.
 * Anchors are therefore already present as couples rows with
 * lifecycle_state='booked' (or 'resolved'/'ghost' depending on
 * weddings.status). This adapter does NOT create anything; it
 * emits one NormalizedSignal per booked anchor so the Tracer can
 * tag the anchor in tracer_run_events and use it as a seed for
 * the touchpoint sweep that follows.
 *
 * What "anchor" means
 * -------------------
 * Doctrine §4 anchors on "booked clients, completed events,
 * confirmed tour attendees". This adapter reads from the legacy
 * `weddings` table (the actual source of truth pre-Phase-D) and
 * filters by status:
 *
 *   booked     → confirmed-paid client. Strongest anchor.
 *   completed  → past wedding (the venue's own history). Strong.
 *   tour_completed → attended tour. Medium anchor — the venue met
 *                    them in person.
 *
 * Inquiry / tour_scheduled rows are NOT anchors. Those are the
 * touchpoints the Tracer walks BACKWARD from anchors.
 */

import type { NormalizedSignal, SourceAdapter, SourceAdapterArgs } from './types'

const ANCHOR_STATUSES = ['booked', 'completed', 'tour_completed'] as const

interface WeddingRow {
  id: string
  status: string | null
  wedding_date: string | null
  inquiry_date: string | null
  tour_date: string | null
  created_at: string
  updated_at: string | null
}

interface PersonRow {
  wedding_id: string
  role: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
}

async function* walk(
  args: SourceAdapterArgs,
): AsyncIterable<NormalizedSignal> {
  const { supabase, venueId, since, batchSize = 500 } = args

  let offset = 0
  while (true) {
    let q = supabase
      .from('weddings')
      .select('id, status, wedding_date, inquiry_date, tour_date, created_at, updated_at')
      .eq('venue_id', venueId)
      .in('status', ANCHOR_STATUSES as unknown as string[])
      .is('merged_into_id', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + batchSize - 1)
    if (since) q = q.gte('updated_at', since)
    const { data: weddings, error } = await q
    if (error) throw new Error(`anchors: ${error.message}`)
    const rows = (weddings ?? []) as WeddingRow[]
    if (rows.length === 0) break

    const ids = rows.map((r) => r.id)
    const { data: peopleData } = await supabase
      .from('people')
      .select('wedding_id, role, first_name, last_name, email, phone')
      .in('wedding_id', ids)
    const peopleByWedding = new Map<string, PersonRow[]>()
    for (const p of ((peopleData ?? []) as PersonRow[])) {
      const arr = peopleByWedding.get(p.wedding_id) ?? []
      arr.push(p)
      peopleByWedding.set(p.wedding_id, arr)
    }

    for (const w of rows) {
      const people = peopleByWedding.get(w.id) ?? []
      const p1 = people.find((p) => p.role === 'partner1') ?? null
      const p2 = people.find((p) => p.role === 'partner2') ?? null
      const occurred =
        w.tour_date ??
        w.inquiry_date ??
        w.created_at ??
        new Date().toISOString()
      const tier =
        w.status === 'booked' || w.status === 'completed' ? 'highest' : 'high'
      yield {
        external_id: w.id,
        channel: 'honeybook',
        action_type: w.status === 'tour_completed' ? 'tour_attended' : 'booked',
        occurred_at: occurred,
        signal_tier: tier,
        identity_hint:
          [p1?.first_name, p1?.last_name].filter(Boolean).join(' ') || null,
        primary_name:
          [p1?.first_name, p1?.last_name].filter(Boolean).join(' ') || null,
        primary_email: p1?.email ?? null,
        primary_phone: p1?.phone ?? null,
        partner_name:
          [p2?.first_name, p2?.last_name].filter(Boolean).join(' ') || null,
        partner_email: p2?.email ?? null,
        partner_phone: p2?.phone ?? null,
        wedding_date: w.wedding_date,
        raw_payload: {
          legacy_wedding_id: w.id,
          status: w.status,
          inquiry_date: w.inquiry_date,
          tour_date: w.tour_date,
        },
        legacy_wedding_id: w.id,
      }
    }

    if (rows.length < batchSize) break
    offset += batchSize
  }
}

const adapter: SourceAdapter = {
  name: 'anchors',
  channel: 'honeybook',
  walk,
}

export default adapter
