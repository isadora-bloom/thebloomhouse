/**
 * Bloom House: SMS Auto-Reply Rules
 *
 * Pattern 9 W1: voice-channel parity. Mirrors auto_send_rules eligibility
 * but for the SMS path. Reads channel='sms' rules from auto_send_rules
 * (mig 318 added the channel column) and decides whether to generate a
 * Haiku-drafted reply.
 *
 * SMS-specific differences from the email auto-send path:
 *   - No Gmail thread cap (SMS threads cap via thread_cap_24h on the SMS
 *     phone identity instead. sms_thread_key = from_email phone).
 *   - No injection-suspected gate (SMS bodies rarely carry prompt injection;
 *     a future revision can add one).
 *   - No real send today: the draft lands in pending_sms_drafts (mig 318)
 *     for coordinator review. P6 routability + actual send wiring is
 *     deferred (see BLOOM-PATTERNS-ZOOM-OUT.md).
 *
 * Returns false when no rule matches or eligibility fails. the caller
 * (openphone.ts persist path) treats false as "skip drafting, no SMS goes
 * out". The single source of truth lives in auto_send_rules.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { generateSmsDraft, SMS_BRAIN_PROMPT_VERSION } from './draft-brain'
import type { SmsInteractionRow } from './draft-brain'
import { createNotification } from '@/lib/services/admin-notifications'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmsAutoReplyInput {
  venueId: string
  weddingId: string | null
  personId: string | null
  /** The newly-inserted inbound SMS interaction id (trigger). */
  triggerInteractionId: string
  /** External party phone (from_email on SMS rows). */
  externalPhone: string
  correlationId?: string
}

export interface SmsAutoReplyOutcome {
  drafted: boolean
  draftId: string | null
  reason: string
}

interface SmsAutoSendRule {
  id: string
  venue_id: string
  context: 'inquiry' | 'client' | string
  enabled: boolean
  confidence_threshold: number
  daily_limit: number
  thread_cap_24h: number
}

// ---------------------------------------------------------------------------
// Rule lookup
// ---------------------------------------------------------------------------

/**
 * Find the most relevant SMS auto-reply rule for this venue + context.
 * Prefers context-specific over generic. Returns null when no rule exists.
 */
async function findSmsRule(
  venueId: string,
  context: 'inquiry' | 'client',
): Promise<SmsAutoSendRule | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('auto_send_rules')
    .select('id, venue_id, context, enabled, confidence_threshold, daily_limit, thread_cap_24h')
    .eq('venue_id', venueId)
    .eq('channel', 'sms')
    .eq('context', context)
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return data as SmsAutoSendRule
}

// ---------------------------------------------------------------------------
// Eligibility checks
// ---------------------------------------------------------------------------

/**
 * Per-thread 24h cap. Counts pending_sms_drafts (auto-drafted, any status
 * except rejected/expired) on the (venue_id, to_phone) pair in the last
 * 24h. Mirrors the email-side thread_cap_24h semantics.
 */
async function threadCapExceeded(
  venueId: string,
  phone: string,
  cap: number,
): Promise<boolean> {
  if (cap <= 0) return true
  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count } = await supabase
    .from('pending_sms_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('to_phone', phone)
    .gte('created_at', cutoff)
    .neq('status', 'rejected')
    .neq('status', 'expired')
  return (count ?? 0) >= cap
}

/**
 * Venue-wide per-day cap. Mirrors auto_send_rules.daily_limit applied to
 * pending_sms_drafts. Same dedup posture: drafts that were rejected /
 * expired don't count against the cap.
 */
async function dailyCapExceeded(
  venueId: string,
  cap: number,
): Promise<boolean> {
  if (cap <= 0) return true
  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count } = await supabase
    .from('pending_sms_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('created_at', cutoff)
    .neq('status', 'rejected')
    .neq('status', 'expired')
  return (count ?? 0) >= cap
}

// ---------------------------------------------------------------------------
// Conversation loader
// ---------------------------------------------------------------------------

async function loadConversation(
  venueId: string,
  phone: string,
): Promise<SmsInteractionRow[]> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('interactions')
    .select('id, direction, body_preview, full_body, timestamp, from_name')
    .eq('venue_id', venueId)
    .eq('type', 'sms')
    .eq('from_email', phone)
    .order('timestamp', { ascending: true })
    .limit(20)

  const rows = (data ?? []) as Array<{
    id: string
    direction: string | null
    body_preview: string | null
    full_body: string | null
    timestamp: string | null
    from_name: string | null
  }>

  return rows.map((r) => ({
    id: r.id,
    direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
    body_preview: r.body_preview,
    full_body: r.full_body,
    timestamp: r.timestamp,
    from_name: r.from_name,
  })) as SmsInteractionRow[]
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the SMS auto-reply rule pipeline for a newly-persisted inbound SMS.
 * Best-effort: any failure logs + returns drafted=false but never throws
 * (the SMS persist path must not block on this).
 *
 * The caller is openphone.ts after a successful interactions insert. We
 * skip out early when:
 *   - no rule exists for the venue + context
 *   - rule is disabled
 *   - thread cap exceeded
 *   - daily cap exceeded
 *   - wedding is in a terminal state (booked/lost/completed/cancelled)
 *   - escalation flag was just set (don't draft while a human is paged)
 */
export async function tryGenerateSmsAutoReply(
  input: SmsAutoReplyInput,
): Promise<SmsAutoReplyOutcome> {
  const { venueId, weddingId, personId, triggerInteractionId, externalPhone, correlationId } = input
  if (!externalPhone) {
    return { drafted: false, draftId: null, reason: 'missing phone' }
  }

  const supabase = createServiceClient()

  // Resolve the context.
  //   inquiry: pre-booked weddings or unmatched signals
  //   client: booked weddings
  // Mirrors the email-side detectContextType but slimmer.
  let context: 'inquiry' | 'client' = 'inquiry'
  let weddingStatus: string | null = null
  let weddingTerminal = false
  if (weddingId) {
    const { data: w } = await supabase
      .from('weddings')
      .select('status, booked_at, lost_at, ai_opted_out')
      .eq('id', weddingId)
      .maybeSingle()
    weddingStatus = (w?.status as string | null) ?? null
    const bookedAt = (w?.booked_at as string | null) ?? null
    const lostAt = (w?.lost_at as string | null) ?? null
    const aiOptedOut = (w?.ai_opted_out as boolean | null) ?? false

    if (aiOptedOut) {
      return { drafted: false, draftId: null, reason: 'wedding ai_opted_out' }
    }
    if (
      weddingStatus === 'lost' ||
      weddingStatus === 'cancelled' ||
      weddingStatus === 'completed' ||
      !!lostAt
    ) {
      weddingTerminal = true
    }
    if (weddingStatus === 'booked' || !!bookedAt) {
      context = 'client'
    }
  }
  if (weddingTerminal) {
    return { drafted: false, draftId: null, reason: 'wedding terminal state' }
  }

  // Escalation freshly set? If the trigger interaction was just flagged
  // for human escalation (W5), do not draft. The coordinator owns the
  // response.
  const { data: trigger } = await supabase
    .from('interactions')
    .select('sms_escalation_requested_at')
    .eq('id', triggerInteractionId)
    .maybeSingle()
  if (trigger?.sms_escalation_requested_at) {
    return { drafted: false, draftId: null, reason: 'escalation requested' }
  }

  // Rule lookup.
  const rule = await findSmsRule(venueId, context)
  if (!rule) {
    return { drafted: false, draftId: null, reason: `no sms rule for context=${context}` }
  }
  if (!rule.enabled) {
    return { drafted: false, draftId: null, reason: 'rule disabled' }
  }

  // Caps.
  if (await threadCapExceeded(venueId, externalPhone, rule.thread_cap_24h)) {
    return { drafted: false, draftId: null, reason: 'thread cap 24h exceeded' }
  }
  if (await dailyCapExceeded(venueId, rule.daily_limit)) {
    return { drafted: false, draftId: null, reason: 'daily cap exceeded' }
  }

  // Build conversation context + generate.
  let draft
  try {
    const conversation = await loadConversation(venueId, externalPhone)
    draft = await generateSmsDraft({
      venueId,
      weddingId,
      conversation,
      reason: 'auto_reply',
      correlationId,
    })
  } catch (err) {
    console.warn(
      '[sms-auto-reply] draft generation failed:',
      err instanceof Error ? err.message : String(err),
    )
    return { drafted: false, draftId: null, reason: 'draft generation failed' }
  }

  // Threshold check. confidence_threshold on the rule is stored as the
  // 0-100 integer post-mig-121 (auto_send_confidence_threshold_int);
  // SMS draft brain emits the same shape.
  if (draft.confidence < rule.confidence_threshold) {
    return {
      drafted: false,
      draftId: null,
      reason: `confidence ${draft.confidence} below threshold ${rule.confidence_threshold}`,
    }
  }

  // Persist into pending_sms_drafts. P6 routability hasn't shipped, so
  // status='pending' for coordinator review. When the routable send path
  // lands, this is the point where status='auto_send_pending' + the
  // 5-min cancellation window would engage.
  const { data: inserted, error: insertErr } = await supabase
    .from('pending_sms_drafts')
    .insert({
      venue_id: venueId,
      wedding_id: weddingId,
      person_id: personId,
      trigger_interaction_id: triggerInteractionId,
      to_phone: externalPhone,
      draft_body: draft.draft,
      status: 'pending',
      reason: 'auto_reply',
      confidence_0_100: draft.confidence,
      prompt_version: SMS_BRAIN_PROMPT_VERSION,
      cost: draft.cost,
      tokens_used: draft.tokensUsed,
      correlation_id: correlationId ?? null,
    })
    .select('id')
    .maybeSingle()

  if (insertErr || !inserted) {
    console.error(
      '[sms-auto-reply] insert pending_sms_drafts failed:',
      insertErr?.message,
    )
    return { drafted: false, draftId: null, reason: 'persist failed' }
  }

  const draftId = inserted.id as string

  // Fire an admin notification so the coordinator sees a new draft
  // waiting. Priority 'normal'. this is not an emergency, just a queue
  // entry. Escalation cases hit a 'high'-priority notif via the W5 path.
  try {
    await createNotification({
      venueId,
      weddingId: weddingId ?? undefined,
      type: 'sms_draft_pending',
      title: `Sage drafted an SMS reply for ${externalPhone}`,
      body: JSON.stringify({
        draftId,
        toPhone: externalPhone,
        confidence_0_100: draft.confidence,
        excerpt: draft.draft.slice(0, 200),
      }),
      priority: 'normal',
      correlationId: correlationId ?? null,
    })
  } catch {
    // Non-fatal.
  }

  return { drafted: true, draftId, reason: 'ok' }
}
