/**
 * The inbox thread list, read off the identity spine (W63, wave 9).
 *
 * /agent/inbox was the last big surface reading `interactions` straight,
 * with a nested join into `people` and `weddings` to work out whose
 * message it was. Those three tables are the legacy stack. The spine
 * carries the same conversation: `touchpoints` is the message, `couples`
 * is who it belongs to, and `drafts` is the reply waiting to go out.
 *
 * Shape of the read
 * -----------------
 *   1. `touchpoints` for the venues in scope, message channels only,
 *      newest first. `raw_payload` carries the subject, the thread id,
 *      the full body and the raw From header — all written by
 *      `emailToNormalizedSignal`, so nothing is reconstructed here.
 *   2. `couples` for the couple ids those touchpoints point at, so a row
 *      can print a name instead of an address.
 *   3. `drafts` with `status='pending'`, attached to the message they
 *      answer (by the legacy interaction id the signal carried, else by
 *      the couple's wedding).
 *   4. `venues` for the venue chip, and `client_codes` for the Bloom
 *      number. Neither is a legacy table.
 *
 * What the spine cannot answer yet, and what this does about it
 * ------------------------------------------------------------
 *   - `interactions.lifecycle_folder` (migration 242) has no spine
 *     column, and neither does `interactions.intent_class` (migration
 *     327), which is what decides the folder when the classifier has
 *     run. So the folder is recomputed here through the SAME pure
 *     function the pipeline uses, `decideLifecycleFolder`, with
 *     `intentClass: null` — the structural fallback. Vendor and
 *     advertiser rows the LLM had judged may therefore land in a
 *     different tab than they did on the legacy read. That is a real
 *     difference, not a rounding error, and it is the first thing to fix
 *     when the spine carries an intent column.
 *   - `interactions.confidence_flag` (the imported / manual provenance
 *     chip) has no spine column. Rows carry null and the chip does not
 *     render.
 *   - `weddings.code_extension` has no spine column, so a Bloom number
 *     renders without its extension.
 *
 * Direction is read, never inferred. Migration 381 stamps
 * `touchpoints.direction` at write time and bans read-time inference; a
 * row written before it, or one that never landed on a couple, carries
 * null and is reported as null.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { LifecycleState } from '@/lib/intel/canonical'
import { decideLifecycleFolder, type LifecycleFolder, type WeddingStatusInput } from '@/lib/services/inbox/lifecycle'
import { htmlToText } from '@/lib/utils/html-text'
import { MESSAGE_CHANNELS } from './venue-spine-counts'

/** How many messages the list holds. Matches the legacy read's cap, so
 *  the tab counts mean the same thing they meant yesterday. */
export const INBOX_ROW_LIMIT = 200

/** Ceiling on the supporting fetches (couples, drafts, codes). */
const SUPPORT_FETCH_LIMIT = 20000

/** How far back a search or a thread lookup scans. Wider than the
 *  display cap because the matched fields live inside `raw_payload` and
 *  PostgREST cannot filter a JSON body cheaply, but bounded — this read
 *  runs in the coordinator's browser. */
const SEARCH_SCAN_LIMIT = 2000

/** Preview length. `interactions.body_preview` was the first 300 chars
 *  of the body; the spine keeps the whole body, so the slice happens
 *  here instead of at write time. */
const PREVIEW_CHARS = 300

/** Action types that mean a tour exists on this couple. Feeds the
 *  `hasTourEvent` input of the folder decider. */
const TOUR_ACTIONS: ReadonlySet<string> = new Set([
  'tour_booked',
  'tour_attended',
  'tour_rescheduled',
])

export interface InboxPendingDraft {
  id: string
  draftBody: string
  subject: string | null
  toEmail: string | null
  brainUsed: string | null
  confidenceScore: number | null
  autoSent: boolean
  createdAt: string
}

export interface InboxThreadRow {
  /** The touchpoint id. Stable, and the key the list renders on. */
  id: string
  venueId: string
  venueName: string | null
  coupleId: string | null
  /** `couples.source_wedding_id`. The per-row chips (risk flags, solo
   *  pill, auto-context) are still keyed by wedding, so the reader hands
   *  the id across rather than making the page look it up. */
  weddingId: string | null
  channel: string
  /** As stamped by migration 381. Null means never stamped. */
  direction: 'inbound' | 'outbound' | null
  subject: string | null
  bodyPreview: string | null
  fullBody: string | null
  occurredAt: string
  threadId: string | null
  fromEmail: string | null
  fromName: string | null
  /** The couple's name, or the raw From name when no couple resolved. */
  personName: string | null
  personEmail: string | null
  lifecycle: LifecycleState | null
  folder: LifecycleFolder
  clientCode: string | null
  pendingDraft: InboxPendingDraft | null
}

export interface InboxThreadsResult {
  rows: InboxThreadRow[]
  /** True when the message fetch hit its cap, so older mail is not in
   *  the list. The page says so rather than implying the venue has only
   *  this much mail. */
  truncated: boolean
  /** Rows in the list whose direction was never stamped. */
  unknownDirection: number
  generatedAt: string
}

export interface InboxThreadsOpts {
  /** Sanitised search term. Matched against subject, body, sender name
   *  and sender address, the same four fields the legacy read searched. */
  search?: string | null
  /** Restrict to one thread. Used by the thread pane. */
  threadId?: string | null
  limit?: number
  /**
   * Per-venue vendor-domain allow-list (migration 258), keyed by venue
   * id. Supply it to skip the read; omit it and the reader loads the
   * list from the same injected client.
   */
  vendorDomainsByVenue?: Map<string, Set<string>> | null
}

interface RawTouchpoint {
  id: string
  venue_id: string
  couple_id: string | null
  channel: string
  action_type: string
  direction: string | null
  occurred_at: string
  raw_payload: Record<string, unknown> | null
}

interface RawCouple {
  id: string
  venue_id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  primary_contact_email: string | null
  lifecycle_state: string
  source_wedding_id: string | null
}

function str(payload: Record<string, unknown> | null, key: string): string | null {
  if (!payload) return null
  const v = payload[key]
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

/** "Sarah & Tom Whitfield" when both halves are known, one name when
 *  only one is, null when neither. Never a raw id. */
export function coupleDisplayName(couple: RawCouple | undefined): string | null {
  if (!couple) return null
  const primary = couple.primary_contact_name?.trim() || null
  const partner = couple.partner_contact_name?.trim() || null
  if (primary && partner) return `${primary} & ${partner}`
  return primary || partner
}

/** `couples.lifecycle_state` in the vocabulary the folder decider was
 *  written against. The decider takes a wedding status because it
 *  predates the spine; this is the one place the two vocabularies meet. */
export function lifecycleToWeddingStatus(state: string | null): WeddingStatusInput {
  switch (state) {
    case 'booked':
      return 'booked'
    case 'completed':
      return 'completed'
    case 'ghost':
      return 'lost'
    case 'resolved':
    case 'channel_scoped':
      return 'inquiry'
    default:
      // 'agent' and "no couple at all" both mean there is no couple-side
      // CRM state to lean on, which is exactly what null tells the
      // decider.
      return null
  }
}

function domainOf(email: string | null): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email.slice(at + 1).toLowerCase().trim() || null
}

function matchesSearch(row: InboxThreadRow, needle: string): boolean {
  const q = needle.toLowerCase()
  return (
    (row.subject?.toLowerCase().includes(q) ?? false) ||
    (row.bodyPreview?.toLowerCase().includes(q) ?? false) ||
    (row.personName?.toLowerCase().includes(q) ?? false) ||
    (row.personEmail?.toLowerCase().includes(q) ?? false) ||
    (row.fromName?.toLowerCase().includes(q) ?? false) ||
    (row.fromEmail?.toLowerCase().includes(q) ?? false)
  )
}

/**
 * SPINE-ONLY reader for the inbox list. Venue-scoped; merged-away
 * couples are excluded from the name join, so a tombstoned couple never
 * lends its name to a live thread. Honest-empty when no venue is in
 * scope.
 */
export async function loadInboxThreads(
  supabase: SupabaseClient,
  venueIds: string[],
  opts: InboxThreadsOpts = {},
): Promise<InboxThreadsResult> {
  const generatedAt = new Date().toISOString()
  const empty: InboxThreadsResult = {
    rows: [],
    truncated: false,
    unknownDirection: 0,
    generatedAt,
  }
  if (venueIds.length === 0) return empty

  const limit = opts.limit ?? INBOX_ROW_LIMIT

  // 1. The messages. Fetched wider than the display cap when a search is
  //    on, because the match happens over fields that live inside
  //    `raw_payload` and PostgREST cannot filter a JSON body cheaply.
  const fetchLimit = opts.search || opts.threadId ? SEARCH_SCAN_LIMIT : limit
  const { data: tpData, error: tpErr } = await supabase
    .from('touchpoints')
    .select('id, venue_id, couple_id, channel, action_type, direction, occurred_at, raw_payload')
    .in('venue_id', venueIds)
    .in('channel', [...MESSAGE_CHANNELS])
    .order('occurred_at', { ascending: false })
    .limit(fetchLimit)
  if (tpErr) throw new Error(`loadInboxThreads: touchpoints ${tpErr.message}`)
  const touchpoints = (tpData ?? []) as RawTouchpoint[]

  // 2. The couples behind them.
  const coupleIds = [...new Set(touchpoints.map((t) => t.couple_id).filter((v): v is string => !!v))]
  const couplesById = new Map<string, RawCouple>()
  if (coupleIds.length > 0) {
    const { data: coupleData, error: coupleErr } = await supabase
      .from('couples')
      .select(
        'id, venue_id, primary_contact_name, partner_contact_name, primary_contact_email, lifecycle_state, source_wedding_id',
      )
      .in('id', coupleIds)
      .is('merged_into_id', null)
      .limit(SUPPORT_FETCH_LIMIT)
    if (coupleErr) throw new Error(`loadInboxThreads: couples ${coupleErr.message}`)
    for (const c of (coupleData ?? []) as RawCouple[]) couplesById.set(c.id, c)
  }

  // 3. Venue names for the chip.
  const venueNames = new Map<string, string>()
  {
    const { data: venueData, error: venueErr } = await supabase
      .from('venues')
      .select('id, name')
      .in('id', venueIds)
    if (venueErr) throw new Error(`loadInboxThreads: venues ${venueErr.message}`)
    for (const v of (venueData ?? []) as Array<{ id: string; name: string | null }>) {
      if (v.name) venueNames.set(v.id, v.name)
    }
  }

  // 4. Bloom numbers, keyed by the couple's wedding.
  const weddingIds = [
    ...new Set(
      [...couplesById.values()]
        .map((c) => c.source_wedding_id)
        .filter((v): v is string => !!v),
    ),
  ]
  const codeByWedding = new Map<string, string>()
  if (weddingIds.length > 0) {
    const { data: codeData } = await supabase
      .from('client_codes')
      .select('wedding_id, code')
      .in('wedding_id', weddingIds)
      .limit(SUPPORT_FETCH_LIMIT)
    for (const row of (codeData ?? []) as Array<{ wedding_id: string; code: string | null }>) {
      if (row.code && !codeByWedding.has(row.wedding_id)) codeByWedding.set(row.wedding_id, row.code)
    }
  }

  // 5. Pending drafts, attached the same two ways the legacy read
  //    attached them: directly by the message they answer, then by the
  //    couple's wedding for drafts that never pointed at a message.
  const { data: draftData, error: draftErr } = await supabase
    .from('drafts')
    .select(
      'id, interaction_id, wedding_id, draft_body, subject, to_email, brain_used, confidence_score, auto_sent, created_at',
    )
    .in('venue_id', venueIds)
    .eq('status', 'pending')
    .limit(SUPPORT_FETCH_LIMIT)
  if (draftErr) throw new Error(`loadInboxThreads: drafts ${draftErr.message}`)
  const drafts = (draftData ?? []) as Array<{
    id: string
    interaction_id: string | null
    wedding_id: string | null
    draft_body: string
    subject: string | null
    to_email: string | null
    brain_used: string | null
    confidence_score: number | null
    auto_sent: boolean | null
    created_at: string
  }>

  const buildDraft = (d: (typeof drafts)[number]): InboxPendingDraft => ({
    id: d.id,
    draftBody: d.draft_body,
    subject: d.subject,
    toEmail: d.to_email,
    brainUsed: d.brain_used,
    confidenceScore: d.confidence_score,
    autoSent: d.auto_sent ?? false,
    createdAt: d.created_at,
  })

  const draftByInteraction = new Map<string, (typeof drafts)[number]>()
  const orphanDraftsByWedding = new Map<string, Array<(typeof drafts)[number]>>()
  for (const d of drafts) {
    if (d.interaction_id) {
      draftByInteraction.set(d.interaction_id, d)
    } else if (d.wedding_id) {
      const held = orphanDraftsByWedding.get(d.wedding_id)
      if (held) held.push(d)
      else orphanDraftsByWedding.set(d.wedding_id, [d])
    }
  }

  // 6. The venue's curated vendor-domain allow-list (migration 258).
  //    Read through the injected client so the same call works from a
  //    server route and from the coordinator's browser; supply it in
  //    `opts` to skip the read entirely.
  let vendorDomainsByVenue = opts.vendorDomainsByVenue ?? null
  if (!vendorDomainsByVenue) {
    vendorDomainsByVenue = new Map<string, Set<string>>()
    const { data: domainData } = await supabase
      .from('venue_vendor_domains')
      .select('venue_id, domain')
      .in('venue_id', venueIds)
      .limit(SUPPORT_FETCH_LIMIT)
    for (const row of (domainData ?? []) as Array<{ venue_id: string; domain: string | null }>) {
      if (!row.domain) continue
      const held = vendorDomainsByVenue.get(row.venue_id) ?? new Set<string>()
      held.add(row.domain.toLowerCase().trim())
      vendorDomainsByVenue.set(row.venue_id, held)
    }
  }

  // 7. Per-couple context the folder decider needs: how many inbound and
  //    outbound messages that couple has, and whether a tour exists.
  //    Counted off the same fetch, so no extra round trip.
  const perCouple = new Map<string, { inbound: number; outbound: number; tour: boolean }>()
  for (const t of touchpoints) {
    if (!t.couple_id) continue
    let entry = perCouple.get(t.couple_id)
    if (!entry) {
      entry = { inbound: 0, outbound: 0, tour: false }
      perCouple.set(t.couple_id, entry)
    }
    if (t.direction === 'inbound') entry.inbound += 1
    else if (t.direction === 'outbound') entry.outbound += 1
    if (TOUR_ACTIONS.has(t.action_type)) entry.tour = true
  }

  // 8. Build the rows.
  let unknownDirection = 0
  const rows: InboxThreadRow[] = touchpoints.map((t) => {
    const couple = t.couple_id ? couplesById.get(t.couple_id) : undefined
    const payload = t.raw_payload ?? null
    const fromEmail = str(payload, 'raw_from_email')
    const fromName = str(payload, 'raw_from_name')
    const fullBody = str(payload, 'full_body')
    const direction =
      t.direction === 'inbound' || t.direction === 'outbound' ? t.direction : null
    if (direction === null) unknownDirection += 1

    const counts = t.couple_id ? perCouple.get(t.couple_id) : undefined
    const vendorDomains = vendorDomainsByVenue?.get(t.venue_id) ?? null
    const folder = decideLifecycleFolder({
      // The spine carries no intent column (migration 327 put it on
      // `interactions`), so the decider runs its structural fallback.
      intentClass: null,
      weddingStatus: lifecycleToWeddingStatus(couple?.lifecycle_state ?? null),
      bookedAt: null,
      inboundCount: counts?.inbound ?? 0,
      outboundCount: counts?.outbound ?? 0,
      hasTourEvent: counts?.tour ?? false,
      senderDomain: domainOf(fromEmail ?? couple?.primary_contact_email ?? null),
      // `people.role` is legacy and has no spine equivalent, so the
      // role-driven vendor branch never fires here. The per-venue
      // allow-list below does the same job from curated data.
      senderRole: null,
      venueVendorDomains: vendorDomains,
    })

    const weddingId = couple?.source_wedding_id ?? null
    const interactionId = str(payload, 'interaction_id')
    let pending = interactionId ? draftByInteraction.get(interactionId) : undefined
    if (!pending && weddingId && direction === 'inbound') {
      const queue = orphanDraftsByWedding.get(weddingId)
      if (queue && queue.length > 0) pending = queue.shift()
    }

    return {
      id: t.id,
      venueId: t.venue_id,
      venueName: venueNames.get(t.venue_id) ?? null,
      coupleId: t.couple_id,
      weddingId,
      channel: t.channel,
      direction,
      subject: str(payload, 'subject'),
      bodyPreview: fullBody ? htmlToText(fullBody).slice(0, PREVIEW_CHARS) : null,
      fullBody,
      occurredAt: t.occurred_at,
      threadId: str(payload, 'thread_id'),
      fromEmail,
      fromName,
      personName: coupleDisplayName(couple) ?? fromName,
      personEmail: couple?.primary_contact_email ?? fromEmail,
      lifecycle: (couple?.lifecycle_state as LifecycleState | undefined) ?? null,
      folder,
      clientCode: weddingId ? codeByWedding.get(weddingId) ?? null : null,
      pendingDraft: pending ? buildDraft(pending) : null,
    }
  })

  let filtered = rows
  if (opts.threadId) {
    filtered = filtered.filter((r) => r.threadId === opts.threadId)
  }
  if (opts.search) {
    const needle = opts.search.trim()
    if (needle.length > 0) filtered = filtered.filter((r) => matchesSearch(r, needle))
  }
  const capped = filtered.slice(0, limit)

  return {
    rows: capped,
    truncated: touchpoints.length >= fetchLimit || filtered.length > capped.length,
    unknownDirection,
    generatedAt,
  }
}

/**
 * Service-client wrapper, for server callers. The browser calls
 * `loadInboxThreads` with its own client — every table this reader
 * touches is venue-scoped under RLS, so an operator sees their own mail
 * and nobody else's.
 */
export async function getInboxThreads(
  venueIds: string[],
  opts: InboxThreadsOpts = {},
): Promise<InboxThreadsResult> {
  if (venueIds.length === 0) {
    return { rows: [], truncated: false, unknownDirection: 0, generatedAt: new Date().toISOString() }
  }
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadInboxThreads(createServiceClient(), venueIds, opts)
}
