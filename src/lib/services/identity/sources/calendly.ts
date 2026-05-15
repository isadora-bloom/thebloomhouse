/**
 * Phase B Calendly source adapter.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §1 (Calendly is full-identity:
 * email is mandatory in Calendly invitee payload) + §4 step 2.
 *
 * Where Calendly signals live in the legacy schema
 * ------------------------------------------------
 * 1. weddings.tour_date — set when a Calendly tour was booked
 *    against a known wedding. Plain timestamp.
 * 2. interactions with type='email' and subject like 'New Event:'
 *    or sender like 'no-reply@calendly.com' — Calendly's
 *    notification emails, which Phil's agent ingested as
 *    interactions because they arrived via Gmail OAuth.
 *
 * For the Tracer's purposes, the wedding-anchored tour_date is the
 * cleaner signal. It carries the date directly and is already
 * linked to the wedding. We emit one signal per (wedding,
 * tour_date) tuple. The Gmail adapter handles the underlying
 * Calendly-via-email notifications.
 *
 * The action_type 'tour_booked' is a progression event per §3 (the
 * couple actually showed engagement); the Tracer's progression
 * writer reads action_type to decide.
 */

import type { NormalizedSignal, SourceAdapter, SourceAdapterArgs } from './types'

interface WeddingTourRow {
  id: string
  tour_date: string | null
  status: string | null
  wedding_date: string | null
  created_at: string
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
      .select('id, tour_date, status, wedding_date, created_at')
      .eq('venue_id', venueId)
      .not('tour_date', 'is', null)
      .is('merged_into_id', null)
      .order('tour_date', { ascending: true })
      .range(offset, offset + batchSize - 1)
    if (since) q = q.gte('tour_date', since)
    const { data, error } = await q
    if (error) throw new Error(`calendly: ${error.message}`)
    const rows = (data ?? []) as WeddingTourRow[]
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
      if (!w.tour_date) continue
      const people = peopleByWedding.get(w.id) ?? []
      const p1 = people.find((p) => p.role === 'partner1') ?? null
      const p2 = people.find((p) => p.role === 'partner2') ?? null
      const fullP1 =
        [p1?.first_name, p1?.last_name].filter(Boolean).join(' ') || null
      // tour_completed → 'tour_attended' (progression); future
      // tour_date but no status flip → 'tour_booked'.
      const isPast = Date.parse(w.tour_date) < Date.now()
      const action =
        w.status === 'tour_completed' || w.status === 'booked' || w.status === 'completed'
          ? 'tour_attended'
          : isPast
            ? 'tour_completed_inferred'
            : 'tour_booked'
      yield {
        external_id: `${w.id}:tour:${w.tour_date}`,
        channel: 'calendly',
        action_type: action,
        occurred_at: w.tour_date,
        signal_tier: 'highest',
        identity_hint: fullP1,
        primary_name: fullP1,
        primary_email: p1?.email ?? null,
        primary_phone: p1?.phone ?? null,
        partner_name:
          [p2?.first_name, p2?.last_name].filter(Boolean).join(' ') || null,
        partner_email: p2?.email ?? null,
        partner_phone: p2?.phone ?? null,
        wedding_date: w.wedding_date,
        raw_payload: {
          legacy_wedding_id: w.id,
          tour_date: w.tour_date,
          wedding_status: w.status,
        },
        legacy_wedding_id: w.id,
      }
    }

    if (rows.length < batchSize) break
    offset += batchSize
  }
}

const adapter: SourceAdapter = { name: 'calendly', channel: 'calendly', walk }
export default adapter
