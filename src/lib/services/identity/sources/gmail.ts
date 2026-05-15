/**
 * Phase B Gmail source adapter — walks interactions (type=email).
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 step 2 (touchpoint sweep).
 *
 * The legacy interactions table is the historical email log. Each
 * row already has wedding_id when the email landed during an active
 * lead flow (Forwards Linker attached it) or NULL when the email
 * arrived against an unknown sender (orphan — Tracer's job to
 * re-evaluate).
 *
 * Signal tier mapping
 * -------------------
 * Doctrine §1 places Gmail in the 'high' tier (full identity:
 * email + often a signature with name + phone). Inbound replies
 * are progression events; outbound venue-sent emails are NOT
 * (per §3 Don't skip #1: 'venue sent them a marketing email' is
 * not progression). The Tracer's progression-event writer reads
 * `action_type` to enforce this — only 'reply' / 'inbound_*'
 * action types become couple_progression_events rows.
 */

import type { NormalizedSignal, SourceAdapter, SourceAdapterArgs } from './types'

interface InteractionRow {
  id: string
  wedding_id: string | null
  type: string
  direction: string
  subject: string | null
  body_preview: string | null
  full_body: string | null
  gmail_message_id: string | null
  gmail_thread_id: string | null
  timestamp: string
}

interface PersonForInteraction {
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
      .from('interactions')
      .select(
        'id, wedding_id, type, direction, subject, body_preview, full_body, gmail_message_id, gmail_thread_id, timestamp',
      )
      .eq('venue_id', venueId)
      .eq('type', 'email')
      .order('timestamp', { ascending: true })
      .range(offset, offset + batchSize - 1)
    if (since) q = q.gte('timestamp', since)
    const { data, error } = await q
    if (error) throw new Error(`gmail: ${error.message}`)
    const rows = (data ?? []) as InteractionRow[]
    if (rows.length === 0) break

    // Resolve names/emails/phones from people for rows that have a
    // wedding_id (the cheap path). Orphan rows yield identity_hint
    // null and rely on body extraction downstream (Tracer's
    // matcher reads body via raw_payload.subject + body_preview).
    const wedIds = Array.from(
      new Set(rows.map((r) => r.wedding_id).filter((id): id is string => Boolean(id))),
    )
    const peopleByWedding = new Map<string, PersonForInteraction[]>()
    if (wedIds.length > 0) {
      const { data: peopleData } = await supabase
        .from('people')
        .select('wedding_id, role, first_name, last_name, email, phone')
        .in('wedding_id', wedIds)
      for (const p of ((peopleData ?? []) as PersonForInteraction[])) {
        const arr = peopleByWedding.get(p.wedding_id) ?? []
        arr.push(p)
        peopleByWedding.set(p.wedding_id, arr)
      }
    }

    for (const r of rows) {
      const people = r.wedding_id ? peopleByWedding.get(r.wedding_id) ?? [] : []
      const p1 = people.find((p) => p.role === 'partner1') ?? null
      const p2 = people.find((p) => p.role === 'partner2') ?? null
      const isInbound = r.direction === 'inbound'
      yield {
        external_id: r.gmail_message_id ?? r.id,
        channel: 'gmail',
        action_type: isInbound ? 'reply' : 'venue_sent',
        occurred_at: r.timestamp,
        signal_tier: isInbound ? 'high' : 'medium',
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
        raw_payload: {
          interaction_id: r.id,
          subject: r.subject,
          body_preview: r.body_preview,
          gmail_thread_id: r.gmail_thread_id,
          direction: r.direction,
        },
        legacy_wedding_id: r.wedding_id,
      }
    }

    if (rows.length < batchSize) break
    offset += batchSize
  }
}

const adapter: SourceAdapter = {
  name: 'gmail',
  channel: 'gmail',
  walk,
}

export default adapter
