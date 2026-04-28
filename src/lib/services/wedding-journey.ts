/**
 * Wedding journey aggregator — turn every per-couple event into a
 * single chronological feed.
 *
 * One coordinator question, one answer: "what happened with this
 * couple, when, and through which channel?". Bloom records the same
 * conceptual event across multiple tables for different reasons —
 * interactions for the raw email, wedding_touchpoints for the funnel
 * step it represents, engagement_events for the heat-scoring signal it
 * fired. The journey timeline merges those without double-displaying
 * the same moment.
 *
 * Sources merged:
 *   - wedding_touchpoints — funnel-step truth (Inquiry / Tour Booked /
 *     Tour Held / Proposal / Booked). Always shown.
 *   - interactions — every email + call + voicemail (inbound/outbound).
 *   - drafts — AI-written replies. Generated, approved, sent, rejected.
 *   - engagement_events — heat-scoring signals NOT already covered by
 *     touchpoints (high_specificity, sustained_engagement, etc.).
 *   - activity_log — generic audit-log entries (status changes,
 *     proposal_sent, contract_signed, portal actions).
 *   - person_merges — when this couple's records were deduped.
 *   - tangential_signals — cross-source identity signals matched to
 *     this couple's people.
 *   - weddings milestones — first_response_at, tour_date, lost_at
 *     (inquiry_date and booked_at already covered by touchpoints).
 *
 * Why server-side: all per-source filters use venue_id checks for
 * scope safety, and aggregation in one place means the API returns a
 * stable typed shape the UI doesn't need to reassemble.
 */

import { createServiceClient } from '@/lib/supabase/service'

export type JourneyCategory =
  | 'funnel_step'
  | 'communication'
  | 'ai_draft'
  | 'engagement_signal'
  | 'status_change'
  | 'identity_merge'
  | 'tangential_signal'
  | 'milestone'

export type JourneyActor = 'couple' | 'venue' | 'ai' | 'system' | 'coordinator' | 'unknown'

export interface JourneyEvent {
  id: string
  timestamp: string
  category: JourneyCategory
  /** Short headline shown as the row title. */
  title: string
  /** One-line context shown under the title. Optional. */
  description?: string
  /** Source label: 'the_knot', 'calendly', 'website', 'gmail', etc. */
  source?: string | null
  /** Who initiated. Helps coordinator scan author at a glance. */
  actor: JourneyActor
  /** Optional structured payload for click-through detail. The UI
   *  doesn't render this directly — it's the raw evidence. */
  evidence?: Record<string, unknown>
}

interface BuildOptions {
  /** Hard cap on returned events. Default 500 — enough for the heaviest
   *  Rixey couple (which has ~200 events) without unbounded growth. */
  maxEvents?: number
}

interface TouchpointRow {
  id: string
  occurred_at: string
  touch_type: string
  source: string | null
  medium: string | null
  metadata: Record<string, unknown> | null
}

interface InteractionRow {
  id: string
  type: string
  direction: string
  subject: string | null
  body_preview: string | null
  from_email: string | null
  from_name: string | null
  timestamp: string
}

interface DraftRow {
  id: string
  status: string
  context_type: string | null
  brain_used: string | null
  model_used: string | null
  confidence_score: number | null
  auto_sent: boolean | null
  auto_send_source: string | null
  subject: string | null
  approved_at: string | null
  approved_by: string | null
  created_at: string
}

interface EngagementEventRow {
  id: string
  event_type: string
  points: number | null
  metadata: Record<string, unknown> | null
  created_at: string
}

interface ActivityLogRow {
  id: string
  activity_type: string
  entity_type: string | null
  details: Record<string, unknown> | null
  created_at: string
}

interface PersonMergeRow {
  id: string
  kept_person_id: string | null
  merged_person_id: string | null
  tier: string
  confidence_score: number | null
  merged_at: string
  undone_at: string | null
  signals: unknown
}

interface TangentialSignalRow {
  id: string
  signal_type: string
  signal_date: string | null
  source_context: string | null
  match_status: string
  confidence_score: number | null
  created_at: string
  extracted_identity: Record<string, unknown> | null
}

interface PersonIdRow {
  id: string
}

interface WeddingMilestoneRow {
  inquiry_date: string | null
  first_response_at: string | null
  tour_date: string | null
  booked_at: string | null
  lost_at: string | null
  lost_reason: string | null
  source: string | null
}

/**
 * Engagement-event types that are ALREADY represented by
 * wedding_touchpoints. Including these in the journey would
 * double-display the same conceptual moment. The touchpoint mirror in
 * email-pipeline.ts writes a touchpoint for each of these on its way
 * into the DB.
 */
const TOUCHPOINT_MIRRORED_EVENT_TYPES = new Set([
  'initial_inquiry',
  'email_reply_received',
  'tour_scheduled',
  'tour_completed',
  'tour_rescheduled',
  'tour_cancelled',
  'contract_sent',
  'contract_signed',
  'final_walkthrough',
  'pre_wedding_event',
  'planning_meeting',
])

/**
 * Friendly labels for touchpoint touch_types. Falls through to a
 * snake_case → Title Case conversion for unknown types.
 */
function touchpointLabel(touchType: string): string {
  const map: Record<string, string> = {
    inquiry: 'Inquiry received',
    email_reply: 'Email reply',
    tour_booked: 'Tour booked',
    calendly_booked: 'Tour booked via scheduling tool',
    tour_conducted: 'Tour held',
    proposal_sent: 'Proposal sent',
    contract_signed: 'Contract signed · booked',
    website_visit: 'Website visit',
    ad_click: 'Ad click',
    referral: 'Referral',
    other: 'Other touchpoint',
  }
  return map[touchType] ?? touchType.replace(/_/g, ' ')
}

function engagementLabel(eventType: string): string {
  const map: Record<string, string> = {
    high_specificity: 'High specificity signal',
    high_commitment_signal: 'High commitment signal',
    family_mentioned: 'Family mention',
    sustained_engagement: 'Sustained engagement',
    marketing_metric: 'Marketing metric',
    tour_requested: 'Tour requested',
  }
  return map[eventType] ?? `Signal: ${eventType.replace(/_/g, ' ')}`
}

/**
 * Build a chronologically-sorted journey for one wedding. All queries
 * are scoped by both venue_id and wedding_id so a service-role read
 * can't leak cross-venue rows even if a stale weddingId is passed.
 */
export async function getWeddingJourney(
  venueId: string,
  weddingId: string,
  options: BuildOptions = {}
): Promise<JourneyEvent[]> {
  const sb = createServiceClient()
  const limit = options.maxEvents ?? 500

  // Verify the wedding exists in this venue before fetching anything
  // else. Cheap guard against cross-venue probing.
  const { data: weddingRow } = await sb
    .from('weddings')
    .select('id, venue_id, inquiry_date, first_response_at, tour_date, booked_at, lost_at, lost_reason, source')
    .eq('id', weddingId)
    .maybeSingle()
  if (!weddingRow || (weddingRow as { venue_id: string }).venue_id !== venueId) {
    return []
  }
  const wedding = weddingRow as WeddingMilestoneRow & { id: string; venue_id: string }

  // Look up linked people first so we can join tangential_signals and
  // person_merges (both reference people, not weddings directly).
  const { data: people } = await sb
    .from('people')
    .select('id')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
  const personIds = ((people ?? []) as PersonIdRow[]).map((p) => p.id)

  // Fetch every per-source table in parallel. Each query venue-scoped.
  const [
    touchpointRes,
    interactionRes,
    draftRes,
    engagementRes,
    activityRes,
    mergeRes,
    tangentialRes,
  ] = await Promise.all([
    sb
      .from('wedding_touchpoints')
      .select('id, occurred_at, touch_type, source, medium, metadata')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .order('occurred_at', { ascending: true }),
    sb
      .from('interactions')
      .select('id, type, direction, subject, body_preview, from_email, from_name, timestamp')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .order('timestamp', { ascending: true }),
    sb
      .from('drafts')
      .select('id, status, context_type, brain_used, model_used, confidence_score, auto_sent, auto_send_source, subject, approved_at, approved_by, created_at')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: true }),
    sb
      .from('engagement_events')
      .select('id, event_type, points, metadata, created_at')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: true }),
    sb
      .from('activity_log')
      .select('id, activity_type, entity_type, details, created_at')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: true }),
    personIds.length > 0
      ? sb
          .from('person_merges')
          .select('id, kept_person_id, merged_person_id, tier, confidence_score, merged_at, undone_at, signals')
          .eq('venue_id', venueId)
          .or(`kept_person_id.in.(${personIds.join(',')}),merged_person_id.in.(${personIds.join(',')})`)
          .order('merged_at', { ascending: true })
      : Promise.resolve({ data: [] as PersonMergeRow[] }),
    personIds.length > 0
      ? sb
          .from('tangential_signals')
          .select('id, signal_type, signal_date, source_context, match_status, confidence_score, created_at, extracted_identity')
          .eq('venue_id', venueId)
          .in('matched_person_id', personIds)
          .eq('match_status', 'confirmed_match')
          .order('signal_date', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] as TangentialSignalRow[] }),
  ])

  const events: JourneyEvent[] = []

  // ---- Touchpoints (funnel-step truth) ----
  for (const tp of (touchpointRes.data ?? []) as TouchpointRow[]) {
    const meta = tp.metadata ?? {}
    const backtraced = meta.backtraced_from && meta.backtraced_to
      ? ` (re-attributed from ${String(meta.backtraced_from)} to ${String(meta.backtraced_to)})`
      : ''
    events.push({
      id: `tp-${tp.id}`,
      timestamp: tp.occurred_at,
      category: 'funnel_step',
      title: touchpointLabel(tp.touch_type),
      description:
        backtraced ||
        (tp.medium ? `via ${tp.medium}` : undefined),
      source: tp.source,
      actor: tp.touch_type === 'inquiry' ? 'couple' : 'system',
      evidence: { ...meta, touch_type: tp.touch_type, medium: tp.medium },
    })
  }

  // ---- Interactions (raw emails / calls) ----
  for (const ix of (interactionRes.data ?? []) as InteractionRow[]) {
    const isInbound = ix.direction === 'inbound'
    const typeLabel = ix.type === 'email' ? 'Email' : ix.type === 'call' ? 'Call' : ix.type === 'voicemail' ? 'Voicemail' : 'SMS'
    events.push({
      id: `ix-${ix.id}`,
      timestamp: ix.timestamp,
      category: 'communication',
      title: `${typeLabel} ${isInbound ? 'received' : 'sent'}${ix.subject ? `: ${ix.subject}` : ''}`,
      description: ix.body_preview ?? undefined,
      actor: isInbound ? 'couple' : 'venue',
      evidence: { from_email: ix.from_email, from_name: ix.from_name, direction: ix.direction, type: ix.type },
    })
  }

  // ---- Drafts (AI generation + lifecycle) ----
  for (const d of (draftRes.data ?? []) as DraftRow[]) {
    const conf = d.confidence_score !== null ? ` · ${d.confidence_score}% confident` : ''
    events.push({
      id: `draft-gen-${d.id}`,
      timestamp: d.created_at,
      category: 'ai_draft',
      title: `AI draft generated${conf}`,
      description: d.subject ?? undefined,
      actor: 'ai',
      evidence: { brain: d.brain_used, model: d.model_used, status: d.status },
    })
    if (d.status === 'sent') {
      events.push({
        id: `draft-sent-${d.id}`,
        timestamp: d.approved_at ?? d.created_at,
        category: 'communication',
        title: d.auto_sent ? 'AI auto-sent reply' : 'Coordinator approved + sent',
        description: d.subject ?? undefined,
        actor: d.auto_sent ? 'ai' : 'coordinator',
        evidence: { auto_sent: d.auto_sent, auto_send_source: d.auto_send_source },
      })
    } else if (d.status === 'approved' && d.approved_at) {
      events.push({
        id: `draft-approve-${d.id}`,
        timestamp: d.approved_at,
        category: 'ai_draft',
        title: 'Draft approved',
        description: d.subject ?? undefined,
        actor: 'coordinator',
      })
    } else if (d.status === 'rejected' && d.approved_at) {
      events.push({
        id: `draft-reject-${d.id}`,
        timestamp: d.approved_at,
        category: 'ai_draft',
        title: 'Draft rejected',
        description: d.subject ?? undefined,
        actor: 'coordinator',
      })
    }
  }

  // ---- Engagement events (only the ones NOT already mirrored as
  //      touchpoints — heat-internal signals like sustained_engagement) ----
  for (const e of (engagementRes.data ?? []) as EngagementEventRow[]) {
    if (TOUCHPOINT_MIRRORED_EVENT_TYPES.has(e.event_type)) continue
    events.push({
      id: `eng-${e.id}`,
      timestamp: e.created_at,
      category: 'engagement_signal',
      title: engagementLabel(e.event_type),
      description: e.points ? `+${e.points} heat points` : undefined,
      actor: 'system',
      evidence: { event_type: e.event_type, points: e.points, ...(e.metadata ?? {}) },
    })
  }

  // ---- Activity log (status changes, etc.) ----
  for (const a of (activityRes.data ?? []) as ActivityLogRow[]) {
    const details = a.details ?? {}
    if (a.activity_type === 'status_change') {
      events.push({
        id: `act-status-${a.id}`,
        timestamp: a.created_at,
        category: 'status_change',
        title: `Status: ${(details.new_status as string) ?? 'changed'}`,
        description: details.old_status ? `from ${String(details.old_status)}` : undefined,
        actor: ((details.changed_by as string) === 'system' ? 'system' : 'coordinator'),
        evidence: details,
      })
    } else if (a.activity_type === 'proposal_sent') {
      events.push({
        id: `act-proposal-${a.id}`,
        timestamp: a.created_at,
        category: 'status_change',
        title: 'Proposal sent',
        actor: 'coordinator',
        evidence: details,
      })
    } else if (a.activity_type === 'contract_signed') {
      events.push({
        id: `act-contract-${a.id}`,
        timestamp: a.created_at,
        category: 'status_change',
        title: 'Contract signed',
        description: details.method ? `detected via ${String(details.method)}` : undefined,
        actor: 'couple',
        evidence: details,
      })
    }
  }

  // ---- Person merges (identity dedup audit) ----
  for (const m of (mergeRes.data ?? []) as PersonMergeRow[]) {
    if (m.undone_at) continue // skip undone merges
    const conf = m.confidence_score !== null ? ` · ${(m.confidence_score * 100).toFixed(0)}%` : ''
    events.push({
      id: `merge-${m.id}`,
      timestamp: m.merged_at,
      category: 'identity_merge',
      title: `People merged · ${m.tier} confidence${conf}`,
      description: 'Two contact records identified as the same person were combined.',
      actor: 'system',
      evidence: { tier: m.tier, kept: m.kept_person_id, merged: m.merged_person_id, signals: m.signals },
    })
  }

  // ---- Tangential signals (cross-source identity matches) ----
  for (const s of (tangentialRes.data ?? []) as TangentialSignalRow[]) {
    events.push({
      id: `tng-${s.id}`,
      timestamp: s.signal_date ?? s.created_at,
      category: 'tangential_signal',
      title: `${s.signal_type.replace(/_/g, ' ')} matched to this couple`,
      description: s.source_context ?? undefined,
      source: s.signal_type.startsWith('instagram_') ? 'instagram' : null,
      actor: 'system',
      evidence: { extracted_identity: s.extracted_identity, match_status: s.match_status },
    })
  }

  // ---- Wedding milestones not covered by touchpoints ----
  // inquiry_date and booked_at are already in touchpoints. Add the
  // ones that aren't: first_response_at, tour_date (the originally
  // scheduled tour datetime, distinct from when the booking touchpoint
  // happened), lost_at.
  if (wedding.first_response_at) {
    const responseMs = wedding.inquiry_date
      ? new Date(wedding.first_response_at).getTime() - new Date(wedding.inquiry_date).getTime()
      : 0
    const responseLabel = responseMs > 0 ? formatDuration(responseMs) : null
    events.push({
      id: 'milestone-first-response',
      timestamp: wedding.first_response_at,
      category: 'milestone',
      title: `First response sent${responseLabel ? ` · ${responseLabel} response time` : ''}`,
      actor: 'venue',
    })
  }
  if (wedding.lost_at) {
    events.push({
      id: 'milestone-lost',
      timestamp: wedding.lost_at,
      category: 'status_change',
      title: 'Marked lost',
      description: wedding.lost_reason ?? undefined,
      actor: 'system',
    })
  }

  // Sort chronologically (oldest first — natural reading order for a
  // journey) and dedup near-identical events fired within a 60s
  // window. Two writers can stamp the same logical moment with
  // slightly different timestamps (touchpoint mirror vs engagement
  // event) — keep the touchpoint as the canonical row when they
  // collide.
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  const deduped: JourneyEvent[] = []
  for (const e of events) {
    const last = deduped[deduped.length - 1]
    if (
      last &&
      last.title === e.title &&
      last.actor === e.actor &&
      Math.abs(new Date(last.timestamp).getTime() - new Date(e.timestamp).getTime()) < 60000
    ) {
      continue
    }
    deduped.push(e)
  }

  return deduped.slice(0, limit)
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}
