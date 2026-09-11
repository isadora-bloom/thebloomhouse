/**
 * Bloom House — Instagram DM ingestion.
 *
 * Wave 3, W28. Spec: HANDLE-IDENTITY-SPEC.md §4, the row that reads
 * "Instagram DMs via Meta Messaging API | same pipeline as SMS: one
 * inbound signal per message, `handles.instagram` set, text goes to the
 * classifier. Env-gated; dry until credentials exist."
 *
 * WHY A DM MATTERS
 * ================
 * A DM is usually the first thing a couple says in their own words, and
 * until now it landed nowhere. It arrives as a handle, and since
 * migration 398 a handle is a first-class identifier on the spine, so a
 * DM can attach to a couple deterministically rather than by a name
 * guess. That is the whole point of the wave.
 *
 * THE SHAPE, COPIED FROM SMS
 * ==========================
 * `smsToNormalizedSignal` is the model. One inbound message becomes one
 * NormalizedSignal:
 *
 *   channel      'instagram'
 *   action_type  'dm'
 *   external_id  `instagram:dm:{mid}` — Meta's message id, stable across
 *                redeliveries, which is what makes the whole path
 *                idempotent through the UNIQUE(venue_id, channel,
 *                external_id) on touchpoints and fragments
 *   occurred_at  the message timestamp, not ingest time
 *   handles      { instagram: <username> }, normalised by normalizeHandle
 *   primary_name the profile name, when Meta returns one
 *   raw_payload  the text, the IGSID, the conversation id
 *
 * THE HANDLE RULE IS ABSOLUTE
 * ===========================
 * Meta gives us an IGSID (a page-scoped opaque id), not a username. We
 * resolve it through the Graph API with the page token. If that lookup
 * fails for any reason, the IGSID stays in raw_payload and `handles` is
 * null. We never guess, never derive a handle from the display name,
 * never fall back to the IGSID as if it were a handle. A handle feeds a
 * deterministic match stage; a wrong one fuses two couples.
 *
 * THE ONE WRITER
 * ==============
 * `linkSignal` is the only writer of couples / touchpoints / fragments,
 * so this file builds a signal and hands it over. It writes nothing to
 * the spine itself.
 *
 * THE INTERACTION ROW — READ THIS
 * ===============================
 * The SMS path also writes an `interactions` row, which is what puts a
 * message in the agent inbox and gives the inbound-intent classifier
 * something to stamp. This file does NOT write that row, and the reason
 * is a deliberate constraint rather than an oversight:
 *
 *   `scripts/check-cascade-only-writer.mjs` guards `interactions`. The
 *   four existing channel ingesters (twilio route, openphone, zoom,
 *   email pipeline) each sit in that guard's GRANDFATHERED list, which
 *   `scripts/cleanup-budget.json` pins at a count that may only fall.
 *   Adding a fifth is exactly the move the anti-bandaid ratchet exists
 *   to stop, and the guard's own header says the right answer is
 *   "route through linkSignal".
 *
 * So Instagram is spine-native from day one: a DM lands as a touchpoint
 * on the couple, or as a fragment carrying the handle until a later
 * signal claims it. What it does NOT do yet is appear in /agent/inbox.
 *
 * `buildInstagramInteractionRow` below is the finished payload for that
 * row, exported and unit-tested, so wiring it is one call the day the
 * Phase-3 cascade interactions writer lands (CONSOLIDATION-PLAN-PHASED
 * §3) or the day an operator decides a grandfather entry is worth it.
 * See the WIRING note beside that function.
 *
 * OUTBOUND
 * ========
 * Out of scope. See the note at the foot of this file for where a reply
 * would plug in.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeHandle } from '@/lib/services/identity/handles'
import { deriveIdentityHint } from '@/lib/services/identity/signal-helpers/identity-hint'
import { mergeRawPayload } from '@/lib/services/identity/signal-helpers/raw-payload'
import type { NormalizedSignal } from '@/lib/services/identity/sources/types'
import {
  lookupInstagramSender,
  markInstagramError,
  markInstagramEvent,
} from '@/lib/services/integrations/instagram-meta'

export const INSTAGRAM_CHANNEL = 'instagram'
export const INSTAGRAM_DM_ACTION = 'dm'

/** `instagram:dm:{mid}`. One place, so the webhook's dedup probe and the
 *  signal builder can never drift apart. */
export function instagramDmExternalId(mid: string): string {
  return `${INSTAGRAM_CHANNEL}:${INSTAGRAM_DM_ACTION}:${mid}`
}

// ---------------------------------------------------------------------------
// Webhook payload parsing
// ---------------------------------------------------------------------------

/** One inbound message, lifted out of Meta's nested envelope. */
export interface InstagramInboundMessage {
  /** Meta's message id. The idempotency key. */
  mid: string
  /** Page-scoped sender id. Opaque; not a handle. */
  senderIgsid: string
  /** Recipient, which for an inbound message is the venue's Instagram
   *  business account id. Also present as entry[].id. */
  recipientId: string | null
  /** Instagram business account id from entry[].id. The venue routing key. */
  igBusinessId: string
  /** Message text. Empty string when the DM was only an attachment. */
  text: string
  /** Epoch milliseconds from Meta. */
  timestampMs: number | null
  /** Attachment types present, when any. Kept for forensics. */
  attachmentTypes: string[]
  /** True when Meta flagged the message as an echo of our own send. */
  isEcho: boolean
}

interface MetaMessagingEntry {
  id?: unknown
  time?: unknown
  messaging?: unknown
}

/**
 * Pull every inbound DM out of a Meta webhook body.
 *
 * Meta's envelope is `{ object: 'instagram', entry: [{ id, time,
 * messaging: [{ sender, recipient, timestamp, message }] }] }`. We
 * accept only `object === 'instagram'`, skip echoes (our own outbound
 * coming back), skip read receipts and reactions (no `message.mid`), and
 * tolerate any field being absent, because a webhook body is untrusted
 * input even after the signature passes.
 */
export function parseInstagramWebhook(body: unknown): InstagramInboundMessage[] {
  const out: InstagramInboundMessage[] = []
  if (!body || typeof body !== 'object') return out
  const envelope = body as { object?: unknown; entry?: unknown }
  if (envelope.object !== 'instagram') return out
  const entries = Array.isArray(envelope.entry) ? envelope.entry : []

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== 'object') continue
    const entry = rawEntry as MetaMessagingEntry
    const igBusinessId = typeof entry.id === 'string' ? entry.id : null
    if (!igBusinessId) continue
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : []

    for (const rawEvent of messaging) {
      if (!rawEvent || typeof rawEvent !== 'object') continue
      const event = rawEvent as {
        sender?: { id?: unknown }
        recipient?: { id?: unknown }
        timestamp?: unknown
        message?: {
          mid?: unknown
          text?: unknown
          is_echo?: unknown
          attachments?: unknown
        }
      }
      const message = event.message
      if (!message || typeof message !== 'object') continue
      const mid = typeof message.mid === 'string' ? message.mid : null
      if (!mid) continue
      if (message.is_echo === true) continue

      const senderIgsid =
        typeof event.sender?.id === 'string' ? event.sender.id : null
      if (!senderIgsid) continue
      // An inbound message addressed to the venue has the venue as
      // recipient. When the sender IS the business account this is an
      // outbound echo Meta did not flag; skip it rather than mint a
      // couple from the venue's own handle.
      if (senderIgsid === igBusinessId) continue

      const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : []
      const attachmentTypes = attachments
        .map((a) =>
          a && typeof a === 'object' && typeof (a as { type?: unknown }).type === 'string'
            ? ((a as { type: string }).type)
            : null,
        )
        .filter((t): t is string => Boolean(t))

      out.push({
        mid,
        senderIgsid,
        recipientId:
          typeof event.recipient?.id === 'string' ? event.recipient.id : null,
        igBusinessId,
        text: typeof message.text === 'string' ? message.text : '',
        timestampMs:
          typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
            ? event.timestamp
            : null,
        attachmentTypes,
        isEcho: false,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Signal builder (pure)
// ---------------------------------------------------------------------------

export interface BuildInstagramDmSignalArgs {
  message: InstagramInboundMessage
  /** Raw username from the Graph lookup, or null when it failed. */
  username: string | null
  /** Display name from the Graph lookup, or null. */
  profileName: string | null
}

/**
 * One inbound DM to one NormalizedSignal. Pure: no database, no network.
 *
 * `handles` is set only when `normalizeHandle('instagram', username)`
 * returns a value. A username Meta returns in a shape our normaliser
 * rejects is treated the same as a failed lookup: the raw value is kept
 * in raw_payload for forensics and `handles` stays null.
 */
export function buildInstagramDmSignal(
  args: BuildInstagramDmSignalArgs,
): NormalizedSignal {
  const { message, username, profileName } = args
  const handle = normalizeHandle('instagram', username)
  const occurredAt =
    message.timestampMs !== null
      ? new Date(message.timestampMs).toISOString()
      : new Date().toISOString()
  const name = profileName?.trim() || null

  return {
    external_id: instagramDmExternalId(message.mid),
    channel: INSTAGRAM_CHANNEL,
    action_type: INSTAGRAM_DM_ACTION,
    occurred_at: occurredAt,
    // Same tier the inbound SMS carries. A person writing to the venue in
    // their own words is the strongest progression signal a channel has,
    // whatever the channel. Whether it is enough to MINT a couple is the
    // cascade's call, not ours, and a handle-only signal will not be:
    // a handle is not reachable, so Point-Zero cannot be established
    // from it (HANDLE-IDENTITY-SPEC.md §3).
    signal_tier: 'high',
    identity_hint: deriveIdentityHint({
      name,
      handle: handle ? `@${handle}` : null,
    }),
    primary_name: name,
    primary_email: null,
    primary_phone: null,
    partner_name: null,
    partner_email: null,
    partner_phone: null,
    wedding_date: null,
    session_ip: null,
    session_fingerprint: null,
    handles: handle ? { instagram: handle } : null,
    raw_payload: mergeRawPayload(
      {
        subject: null,
        body_preview: message.text ? message.text.slice(0, 300) : null,
        thread_id: message.senderIgsid,
        external_url: handle ? `https://instagram.com/${handle}` : null,
      },
      {
        full_body: message.text,
        direction: 'inbound',
        mid: message.mid,
        // Always kept, handle or no handle. When the Graph lookup fails
        // this is the only thread back to the human, and a later
        // successful lookup can re-anchor on it.
        sender_igsid: message.senderIgsid,
        recipient_id: message.recipientId,
        ig_business_id: message.igBusinessId,
        // The raw username as Meta returned it, even when our normaliser
        // rejected it. Lets an operator see WHY a handle is missing.
        raw_username: username,
        handle_lookup_ok: Boolean(handle),
        profile_name: profileName,
        attachment_types: message.attachmentTypes.length
          ? message.attachmentTypes
          : null,
      },
    ),
    legacy_wedding_id: null,
    author_class: 'couple',
  }
}

// ---------------------------------------------------------------------------
// Interaction row (built, tested, not yet wired — see the header)
// ---------------------------------------------------------------------------

/**
 * The `interactions` row an Instagram DM would take, shaped exactly as
 * the SMS path shapes its own.
 *
 * `type` is 'sms', not 'dm'. The vocabulary does not have 'dm': the CHECK
 * on interactions.type is ('email','call','voicemail','sms','meeting',
 * 'web_form','portal_chat') as of migration 230. 'sms' is the nearest
 * existing value and the right one, because every reader that treats a
 * row as a short inbound message from a person keyed off 'sms'. Adding
 * 'dm' to the CHECK would be worse than reusing 'sms': it would extend
 * the vocabulary and then be invisible to every `type IN (...)` filter
 * already in the codebase, so the row would exist and nobody would show
 * it. The channel is not lost: raw/`subject` says Instagram, and the
 * spine touchpoint carries channel='instagram' properly.
 *
 * WIRING, when the interactions limb gets a cascade writer: call this
 * from `ingestInstagramDm` after `linkSignal` returns, insert the row
 * through that writer, then pass its id back into the signal's
 * `raw_payload.interaction_id` slot (the base payload reserves it). The
 * inbound-intent classifier and the reply pipeline both key off the
 * interaction id, so they light up at the same moment.
 */
export function buildInstagramInteractionRow(args: {
  venueId: string
  message: InstagramInboundMessage
  username: string | null
  profileName: string | null
  personId?: string | null
  weddingId?: string | null
}): Record<string, unknown> {
  const { venueId, message, username, profileName } = args
  const handle = normalizeHandle('instagram', username)
  const who = handle ? `@${handle}` : (profileName ?? message.senderIgsid)
  const occurred =
    message.timestampMs !== null
      ? new Date(message.timestampMs).toISOString()
      : new Date().toISOString()
  return {
    venue_id: venueId,
    person_id: args.personId ?? null,
    wedding_id: args.weddingId ?? null,
    type: 'sms',
    direction: 'inbound',
    subject: `Instagram DM from ${who}`,
    body_preview: message.text.slice(0, 300),
    full_body: message.text,
    // interactions has no handle column. The SMS path puts the phone in
    // from_email because that is where the inbox looks for sender
    // identity; the handle goes in the same slot for the same reason.
    from_email: handle ? `@${handle}` : null,
    from_name: profileName ?? null,
    timestamp: occurred,
    // signal-class-justified: an inbound DM is a touchpoint
    signal_class: 'touchpoint',
    // Same surface the SMS path uses: the non-email conversation triage
    // inbox, alongside Twilio and the audio transcripts.
    surface: 'voice_capture',
    author_class: 'couple',
  }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface IngestInstagramDmArgs {
  supabase: SupabaseClient
  venueId: string
  /** Page access token, resolved by the caller from the connection row.
   *  Null means we cannot resolve the sender, which is survivable: the
   *  signal lands with handles null and the IGSID in raw_payload. */
  pageToken: string | null
  message: InstagramInboundMessage
  /** Injected in tests. Passed through to the Graph lookup. */
  fetchImpl?: typeof fetch
  /** Telemetry label on the linker row. */
  source?: string
}

export type IngestOutcome =
  | 'linked'
  | 'duplicate'
  | 'skipped_empty'
  | 'failed'

export interface IngestInstagramDmResult {
  outcome: IngestOutcome
  externalId: string
  /** Whether the Graph lookup produced a handle we could normalise. */
  handleResolved: boolean
  /** linkSignal's action, when it ran. */
  action: string | null
  matchedCoupleId: string | null
  reason: string
}

/**
 * Probe for an existing touchpoint or fragment with this external id.
 *
 * Read-only, and strictly an optimisation plus a courtesy: the UNIQUE
 * constraint inside the cascade is what actually makes replays safe.
 * This check exists so a Meta redelivery does not spend a Graph API call
 * and an LLM judge budget re-deciding a message we already have. Meta
 * retries aggressively on any non-2xx, so redelivery is the normal case,
 * not the edge case.
 */
async function alreadySeen(
  supabase: SupabaseClient,
  venueId: string,
  externalId: string,
): Promise<boolean> {
  const { data: tp } = await supabase
    .from('touchpoints')
    .select('id')
    .eq('venue_id', venueId)
    .eq('channel', INSTAGRAM_CHANNEL)
    .eq('external_id', externalId)
    .limit(1)
    .maybeSingle()
  if (tp) return true
  const { data: fr } = await supabase
    .from('fragments')
    .select('id')
    .eq('venue_id', venueId)
    .eq('channel', INSTAGRAM_CHANNEL)
    .eq('external_id', externalId)
    .limit(1)
    .maybeSingle()
  return Boolean(fr)
}

/**
 * One inbound DM, all the way through: dedup probe, sender lookup,
 * signal, linkSignal.
 *
 * Never throws. The webhook has already acknowledged Meta by the time
 * this runs, and a thrown error there would only produce a redelivery
 * storm, so every failure is caught, stamped on the connection row, and
 * returned as an outcome.
 */
export async function ingestInstagramDm(
  args: IngestInstagramDmArgs,
): Promise<IngestInstagramDmResult> {
  const { supabase, venueId, pageToken, message } = args
  const externalId = instagramDmExternalId(message.mid)
  const base: IngestInstagramDmResult = {
    outcome: 'failed',
    externalId,
    handleResolved: false,
    action: null,
    matchedCoupleId: null,
    reason: '',
  }

  // A message with neither text nor attachments carries nothing. Meta
  // sends these for reactions and delivery receipts on some tiers.
  if (!message.text && message.attachmentTypes.length === 0) {
    return { ...base, outcome: 'skipped_empty', reason: 'no text, no attachment' }
  }

  try {
    if (await alreadySeen(supabase, venueId, externalId)) {
      return { ...base, outcome: 'duplicate', reason: 'external_id already on the spine' }
    }
  } catch (err) {
    // A failed probe is not a reason to drop the message. Fall through
    // and let the UNIQUE constraint do its job.
    console.warn(
      '[instagram-dm] dedup probe failed (continuing):',
      err instanceof Error ? err.message : err,
    )
  }

  // Sender lookup. Never guesses, never throws.
  let username: string | null = null
  let profileName: string | null = null
  if (pageToken) {
    const profile = await lookupInstagramSender({
      igsid: message.senderIgsid,
      pageToken,
      fetchImpl: args.fetchImpl,
    })
    username = profile.username
    profileName = profile.name
  } else {
    console.warn(
      `[instagram-dm] no page token for venue ${venueId} — ` +
        'signal lands with handles null and the IGSID in raw_payload',
    )
  }

  const signal = buildInstagramDmSignal({ message, username, profileName })
  const handleResolved = Boolean(signal.handles?.instagram)

  try {
    const { linkSignal } = await import('@/lib/spine/cascade')
    const result = await linkSignal({
      supabase,
      venueId,
      signal,
      source: args.source ?? 'live:instagram_dm',
    })
    // Heartbeat for the settings page. Fire and forget.
    void markInstagramEvent(venueId).catch(() => {})
    return {
      outcome: result.duplicate ? 'duplicate' : 'linked',
      externalId,
      handleResolved,
      action: result.action,
      matchedCoupleId: result.matched_couple_id,
      reason: result.reason,
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err)
    console.error('[instagram-dm] linkSignal failed:', messageText)
    void markInstagramError(venueId, messageText).catch(() => {})
    return { ...base, handleResolved, reason: messageText }
  }
}

// ---------------------------------------------------------------------------
// Outbound, for whoever picks it up next
// ---------------------------------------------------------------------------
//
// Replying to a DM is out of scope for W28. When it lands, it goes here,
// and the shape is already decided by what is above:
//
//   1. POST {GRAPH_BASE}/{ig_business_id}/messages with
//      { recipient: { id: <sender_igsid> }, message: { text } } and the
//      page token. The IGSID to reply to is in raw_payload.sender_igsid
//      on the inbound touchpoint, which is why it is always kept.
//   2. Meta's messaging window is 24 hours from the couple's last
//      message. A reply outside it needs the human-agent tag and will
//      fail without it, so the send path must check occurred_at first.
//   3. The reply itself is another signal: same builder with
//      action_type 'dm_outbound', signal_tier 'medium', author_class
//      'sage' or 'operator', mirroring the inbound/outbound split in
//      sms-to-signal.ts.
//   4. Auto-send stays behind the same gates SMS is behind. Isadora's
//      standing instruction is that auto-send stays off until the
//      reimport is complete; a new channel does not get a private
//      exemption from that.
