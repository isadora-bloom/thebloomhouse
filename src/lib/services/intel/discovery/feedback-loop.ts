/**
 * Bloom House — Wave 7D feedback-loop service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7D closes the discovery → validation →
 *     action loop. Wave 7A produces hypotheses, Wave 7C validates them,
 *     Wave 7D writes validated discoveries BACK into the consuming
 *     Wave 5/6 systems so they incorporate the insight automatically.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7D spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Feedback
 *     writes never name couples. Payloads are channel labels, persona
 *     labels, lift_pct numbers — never per-couple identifiers.)
 *   - feedback_audit_agents_overclaim.md (every mapping function is
 *     verified end-to-end before reporting; we test the full validated-
 *     path for each known category.)
 *
 * What this service does
 * ----------------------
 * For one validated intel_discovery, route the insight back into Wave 5/6
 * consuming systems via a configurable mapping table (in code, not DB).
 * Each mapping function:
 *   1. Performs the system-specific write (enqueue / upsert / tag / flag).
 *   2. Logs a discovery_feedback_actions row recording the write
 *      (target_system + action_type + payload + error).
 * Errors per mapping are caught individually so one failure doesn't
 * block the rest. The discovery's feedback_applied_at is set when the
 * loop completes (success or partial failure both count — the audit
 * log captures granularity).
 *
 * Doctrine
 * --------
 * - Only acts when validation_status='validated'. Returns
 *   { actionsApplied: 0, errors: ['discovery not validated'] } otherwise.
 * - LLM-invented categories (anything outside the known set) route to
 *   tag_only — record-only, no system write. The category is then
 *   surfaced in the next Wave 7A discovery prompt's "previously-validated
 *   categories" hint, so the engine stops re-discovering the same novel
 *   pattern type.
 * - Idempotent at the row level: re-firing applyDiscoveryFeedback for an
 *   already-applied discovery writes a fresh audit row but the upsert /
 *   enqueue paths use natural keys + 24h dedupes so the underlying
 *   systems remain stable. Audit row count grows by one per re-fire,
 *   which is the intended audit signal.
 *
 * Mapping table
 * -------------
 *   'channel_role_distortion'        → enqueue attribution_role_jobs for the affected channel
 *   'vendor_referral_unobserved'     → upsert venue_intel.rollup.service_demand_map (vendor partner section)
 *   'persona_channel_pattern'        → tag persona_channel_rollups + create marketing_recommendation seed
 *   'cross_platform_drift'           → enqueue handle merge decision for review (tag-only audit row)
 *   'competitor_positioning'         → upsert intel_matches with signal_type='competitor_mention' (subtype payload)
 *   'stale_warm_lead'                → enqueue couple_intel refresh for affected couples
 *   'booking_blocker_question'       → flag in venue_intel.rollup.timing_patterns
 *   'time_of_day_pattern'            → tag in venue_intel.rollup.timing_patterns
 *   'demographic_clustering'         → upsert venue_intel.rollup.over_indexed_personas
 *   '*' (any LLM-invented category)  → tag_only (recorded, surfaced to Wave 7A)
 *
 * NOTE: intel_matches.signal_type is constrained by a DB CHECK to a
 * fixed set; 'competitor_positioning' is NOT a valid value. We map
 * 'competitor_positioning' onto 'competitor_mention' and preserve the
 * specificity in signal_payload.subtype='competitor_positioning'.
 *
 * NOTE: 'cross_platform_drift' would ideally enqueue into a dedicated
 * handle-merge review queue. handle_merge_decisions is an audit table
 * (decision NOT NULL) and there is no review-queue table. We surface
 * the signal as a tag-only action with target_system='handle_merge_review_flag'
 * so the dashboard can highlight it; the operator drives the actual
 * review via /admin/identity/handle-merge-proposals.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { enqueueRoleClassification } from '@/lib/services/attribution-roles/enqueue'
import { enqueueCoupleIntel } from '@/lib/services/intel/enqueue-couple-intel'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApplyDiscoveryFeedbackInput {
  discoveryId: string
  /** Optional client override (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** When true, force apply even if feedback_applied_at is already set
   *  (operator override path). Default false. */
  force?: boolean
}

export interface ApplyDiscoveryFeedbackResult {
  actionsApplied: number
  errors: string[]
}

interface DiscoveryRow {
  id: string
  venue_id: string
  hypothesis_title: string
  hypothesis_text: string
  hypothesis_category: string
  evidence_summary: Record<string, unknown> | null
  validation_status: string
  validation_metric: Record<string, unknown> | null
  feedback_applied_at: string | null
  recommended_action_if_validated: string | null
  confidence_0_100: number
}

interface ActionLogInput {
  discoveryId: string
  venueId: string
  targetSystem: string
  actionType: 'enqueue' | 'upsert' | 'tag' | 'flag'
  payload: Record<string, unknown> | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Audit log writer
// ---------------------------------------------------------------------------

async function logAction(
  supabase: SupabaseClient,
  input: ActionLogInput,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('discovery_feedback_actions')
      .insert({
        discovery_id: input.discoveryId,
        venue_id: input.venueId,
        target_system: input.targetSystem,
        action_type: input.actionType,
        payload: input.payload,
        error: input.error,
      })
    if (error) {
      console.warn('[feedback-loop] action log insert failed:', error.message)
    }
  } catch (err) {
    console.warn(
      '[feedback-loop] action log threw:',
      err instanceof Error ? err.message : err,
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers — extract evidence shape from validation/discovery payloads
// ---------------------------------------------------------------------------

interface EvidenceFragment {
  signal_type?: string
  affected_channel?: string
  vendor_name?: string
  persona_label?: string
  competitor_name?: string
  pattern?: string
  cohort_segment?: string
  affected_wedding_ids?: string[]
}

function extractEvidence(
  evidenceSummary: Record<string, unknown> | null,
): EvidenceFragment {
  if (!evidenceSummary || typeof evidenceSummary !== 'object') return {}
  const e = evidenceSummary as Record<string, unknown>
  const aggStats =
    e.aggregate_stats && typeof e.aggregate_stats === 'object'
      ? (e.aggregate_stats as Record<string, unknown>)
      : {}

  const out: EvidenceFragment = {}
  if (typeof e.signal_type === 'string') out.signal_type = e.signal_type

  const channelCandidates = [
    e.affected_channel,
    e.channel,
    aggStats.affected_channel,
    aggStats.channel,
    aggStats.source_platform,
  ]
  for (const c of channelCandidates) {
    if (typeof c === 'string' && c.length > 0) {
      out.affected_channel = c
      break
    }
  }

  const vendorCandidates = [
    e.vendor_name,
    aggStats.vendor_name,
    aggStats.partner_name,
  ]
  for (const c of vendorCandidates) {
    if (typeof c === 'string' && c.length > 0) {
      out.vendor_name = c
      break
    }
  }

  const personaCandidates = [
    e.persona_label,
    aggStats.persona_label,
    aggStats.persona,
  ]
  for (const c of personaCandidates) {
    if (typeof c === 'string' && c.length > 0) {
      out.persona_label = c
      break
    }
  }

  const competitorCandidates = [
    e.competitor_name,
    aggStats.competitor_name,
    aggStats.competitor,
  ]
  for (const c of competitorCandidates) {
    if (typeof c === 'string' && c.length > 0) {
      out.competitor_name = c
      break
    }
  }

  const patternCandidates = [
    e.pattern,
    aggStats.pattern,
    aggStats.timing_pattern,
    aggStats.bucket,
  ]
  for (const c of patternCandidates) {
    if (typeof c === 'string' && c.length > 0) {
      out.pattern = c
      break
    }
  }

  const cohortCandidates = [
    e.cohort_segment,
    aggStats.cohort_segment,
    aggStats.demographic_cluster,
  ]
  for (const c of cohortCandidates) {
    if (typeof c === 'string' && c.length > 0) {
      out.cohort_segment = c
      break
    }
  }

  if (Array.isArray(e.affected_wedding_ids)) {
    const ids: string[] = []
    for (const w of e.affected_wedding_ids) {
      if (typeof w === 'string' && w.length > 0) ids.push(w)
    }
    if (ids.length > 0) out.affected_wedding_ids = ids
  } else if (Array.isArray(aggStats.affected_wedding_ids)) {
    const ids: string[] = []
    for (const w of aggStats.affected_wedding_ids as unknown[]) {
      if (typeof w === 'string' && w.length > 0) ids.push(w)
    }
    if (ids.length > 0) out.affected_wedding_ids = ids
  }

  return out
}

// ---------------------------------------------------------------------------
// Mapping functions (one per known hypothesis_category)
// ---------------------------------------------------------------------------

/**
 * channel_role_distortion → enqueue attribution_role_jobs for the affected
 * channel. Pulls up to 50 recent attribution_events on the channel and
 * enqueues each for re-classification. The role classifier uses the
 * latest forensic evidence so the affected channel's role split flips
 * once the queue drains.
 */
async function applyChannelRoleDistortion(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  const channel = evidence.affected_channel
  if (!channel) {
    return {
      actions: 0,
      error: 'channel_role_distortion: affected_channel missing from evidence',
    }
  }

  const { data: events, error: queryErr } = await supabase
    .from('attribution_events')
    .select('id')
    .eq('venue_id', discovery.venue_id)
    .eq('source_platform', channel)
    .is('reverted_at', null)
    .order('decided_at', { ascending: false })
    .limit(50)

  if (queryErr) {
    return {
      actions: 0,
      error: `channel_role_distortion: attribution_events query failed: ${queryErr.message}`,
    }
  }

  const eventRows = (events ?? []) as Array<{ id: string }>
  if (eventRows.length === 0) {
    // No work to do, but still log the attempt so the audit + digest
    // can show the loop fired against the right target system.
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: 'attribution_role_jobs',
      actionType: 'enqueue',
      payload: {
        channel,
        events_considered: 0,
        jobs_enqueued: 0,
        skipped_reason: 'no_attribution_events_for_channel',
      },
      error: null,
    })
    return {
      actions: 0,
      error: `channel_role_distortion: no attribution_events for channel ${channel}`,
    }
  }

  let enqueuedCount = 0
  for (const ev of eventRows) {
    const r = await enqueueRoleClassification({
      attributionEventId: ev.id,
      venueId: discovery.venue_id,
      triggerSignal: 'wave_7d_feedback',
      supabase,
    })
    if (!r.skipped) enqueuedCount += 1
  }

  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'attribution_role_jobs',
    actionType: 'enqueue',
    payload: {
      channel,
      events_considered: eventRows.length,
      jobs_enqueued: enqueuedCount,
    },
    error: null,
  })
  return { actions: 1, error: null }
}

/**
 * vendor_referral_unobserved → upsert venue_intel.rollup.service_demand_map
 * with a "vendor_partner" entry. Preserves the existing rollup; appends or
 * updates the entry whose service_or_offering matches the vendor name.
 */
async function applyVendorReferralUnobserved(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  const vendorName = evidence.vendor_name
  if (!vendorName) {
    return {
      actions: 0,
      error: 'vendor_referral_unobserved: vendor_name missing from evidence',
    }
  }

  const { data: row, error: readErr } = await supabase
    .from('venue_intel')
    .select('rollup')
    .eq('venue_id', discovery.venue_id)
    .maybeSingle()

  if (readErr) {
    return {
      actions: 0,
      error: `vendor_referral_unobserved: venue_intel read failed: ${readErr.message}`,
    }
  }

  const rollup =
    row && typeof (row as { rollup?: unknown }).rollup === 'object' && (row as { rollup?: unknown }).rollup !== null
      ? ({ ...(row as { rollup: Record<string, unknown> }).rollup } as Record<string, unknown>)
      : ({} as Record<string, unknown>)

  const existingMap = Array.isArray(rollup.service_demand_map)
    ? (rollup.service_demand_map as Array<Record<string, unknown>>)
    : []

  const existingIdx = existingMap.findIndex(
    (e) =>
      typeof e?.service_or_offering === 'string' &&
      (e.service_or_offering as string).toLowerCase() === vendorName.toLowerCase(),
  )

  const entry = {
    service_or_offering: vendorName,
    demand_signal: 'vendor_partner',
    source: 'wave_7d_discovery',
    discovery_id: discovery.id,
    discovery_title: discovery.hypothesis_title,
  }

  const newMap = [...existingMap]
  if (existingIdx >= 0) {
    newMap[existingIdx] = { ...newMap[existingIdx], ...entry }
  } else {
    newMap.push(entry)
  }

  rollup.service_demand_map = newMap

  if (!row) {
    // No venue_intel row yet — skip the write but record the intent.
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: 'venue_intel.service_demand_map',
      actionType: 'upsert',
      payload: { skipped_reason: 'no_venue_intel_row', vendor_name: vendorName },
      error: 'venue_intel row not present; cannot upsert',
    })
    return {
      actions: 0,
      error: 'venue_intel row not present',
    }
  }

  const { error: updErr } = await supabase
    .from('venue_intel')
    .update({ rollup, updated_at: new Date().toISOString() })
    .eq('venue_id', discovery.venue_id)

  if (updErr) {
    return {
      actions: 0,
      error: `vendor_referral_unobserved: venue_intel update failed: ${updErr.message}`,
    }
  }

  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'venue_intel.service_demand_map',
    actionType: 'upsert',
    payload: { vendor_name: vendorName, entry },
    error: null,
  })
  return { actions: 1, error: null }
}

/**
 * persona_channel_pattern → tag persona_channel_rollups (pin the discovery
 * onto the matching cell via discovery_feedback_actions audit) AND create
 * a marketing_recommendation seed (status='pending').
 *
 * No-auto-execute doctrine: we never write attribution_events; we never
 * change spend; we just create a recommendation row the operator can
 * accept.
 */
async function applyPersonaChannelPattern(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  const persona = evidence.persona_label
  const channel = evidence.affected_channel
  let actionCount = 0

  // 1. Tag the matching persona_channel_rollups cell via audit log.
  if (persona && channel) {
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: 'persona_channel_rollups',
      actionType: 'tag',
      payload: { persona_label: persona, channel, discovery_title: discovery.hypothesis_title },
      error: null,
    })
    actionCount += 1
  }

  // 2. Create a marketing_recommendation seed.
  const recPayload = {
    venue_id: discovery.venue_id,
    recommendation_title: `[Discovery seed] ${discovery.hypothesis_title.slice(0, 100)}`,
    recommendation_text:
      discovery.recommended_action_if_validated ||
      `Wave 7D feedback: validated discovery "${discovery.hypothesis_title}". Coordinator should review the persona × channel evidence and decide on action.`,
    action_type: 'investigate' as const,
    source_channel: channel ?? null,
    target_persona: persona ?? null,
    confidence_0_100: discovery.confidence_0_100,
    reasoning_chain: {
      evidence_signals: [
        `discovery_id: ${discovery.id}`,
        `hypothesis_category: ${discovery.hypothesis_category}`,
      ],
      assumed_baseline: 'See discovery evidence_summary',
      projected_outcome: 'See discovery recommended_action_if_validated',
      counterfactual:
        'If we ignore this signal the persona × channel pattern will continue undisclosed.',
      payback_months: 0,
      key_risks: ['Pattern may shift as cohort grows; revalidate quarterly.'],
      source: 'wave_7d_discovery_feedback',
    },
    input_data_hash: `wave_7d_discovery:${discovery.id}`,
    n_too_small_warning: false,
    status: 'pending',
    prompt_version: 'wave_7d_feedback_seed.v1',
  }

  const { error: insertErr } = await supabase
    .from('marketing_recommendations')
    .insert(recPayload)

  if (insertErr) {
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: 'marketing_recommendations',
      actionType: 'upsert',
      payload: recPayload as unknown as Record<string, unknown>,
      error: insertErr.message,
    })
    return {
      actions: actionCount,
      error: `persona_channel_pattern: marketing_recommendations insert failed: ${insertErr.message}`,
    }
  }

  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'marketing_recommendations',
    actionType: 'upsert',
    payload: { title: recPayload.recommendation_title, action_type: 'investigate' },
    error: null,
  })
  return { actions: actionCount + 1, error: null }
}

/**
 * cross_platform_drift → flag the venue's handle-merge review surface.
 * handle_merge_decisions is an audit table (decision NOT NULL); there's
 * no review-queue table. We surface this as a tag-only action so the
 * dashboard can highlight that handle-merge needs attention. The operator
 * acts via /admin/identity/handle-merge-proposals.
 */
async function applyCrossPlatformDrift(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'handle_merge_review_flag',
    actionType: 'flag',
    payload: {
      hint: 'cross_platform_drift detected — operator should review /admin/identity/handle-merge-proposals',
      discovery_title: discovery.hypothesis_title,
      evidence_signal: evidence.signal_type ?? null,
    },
    error: null,
  })
  return { actions: 1, error: null }
}

/**
 * competitor_positioning → upsert intel_matches with signal_type=
 * 'competitor_mention' (the closest valid signal_type given the CHECK
 * constraint on the column) and a payload subtype='competitor_positioning'
 * to preserve the discovery's specificity.
 */
async function applyCompetitorPositioning(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  const competitor = evidence.competitor_name ?? 'unspecified_competitor'

  const payload = {
    venue_id: discovery.venue_id,
    wedding_id: null,
    signal_type: 'competitor_mention' as const,
    signal_payload: {
      subtype: 'competitor_positioning',
      competitor_name: competitor,
      mention_count: 0,
      source: 'wave_7d_discovery',
      discovery_id: discovery.id,
      discovery_title: discovery.hypothesis_title,
    },
    match_reasoning: `Wave 7D feedback from validated discovery: ${discovery.hypothesis_title.slice(0, 200)}`,
    match_confidence_0_100: discovery.confidence_0_100,
    cohort_fit_score_0_100: null,
    evidence_quotes: null,
  }

  const { error: insertErr } = await supabase
    .from('intel_matches')
    .insert(payload)

  if (insertErr) {
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: 'intel_matches',
      actionType: 'upsert',
      payload: { competitor_name: competitor },
      error: insertErr.message,
    })
    return {
      actions: 0,
      error: `competitor_positioning: intel_matches insert failed: ${insertErr.message}`,
    }
  }

  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'intel_matches',
    actionType: 'upsert',
    payload: { competitor_name: competitor, subtype: 'competitor_positioning' },
    error: null,
  })
  return { actions: 1, error: null }
}

/**
 * stale_warm_lead → enqueue couple_intel refresh for affected couples.
 * Pulls the wedding_ids out of evidence (if present) or falls back to
 * the venue's stale-warm cohort (lost_at is null AND last_inbound > 30d
 * AND status not in ('booked', 'lost')) up to a small batch.
 */
async function applyStaleWarmLead(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  let weddingIds = evidence.affected_wedding_ids ?? []

  if (weddingIds.length === 0) {
    // Fallback: query stale-warm leads for the venue.
    const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data, error: queryErr } = await supabase
      .from('weddings')
      .select('id')
      .eq('venue_id', discovery.venue_id)
      .is('lost_at', null)
      .neq('status', 'booked')
      .neq('status', 'lost')
      .lte('updated_at', cutoffIso)
      .limit(20)
    if (queryErr) {
      return {
        actions: 0,
        error: `stale_warm_lead: weddings query failed: ${queryErr.message}`,
      }
    }
    weddingIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  }

  if (weddingIds.length === 0) {
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: 'couple_intel',
      actionType: 'enqueue',
      payload: { skipped_reason: 'no_stale_warm_couples', candidates_considered: 0 },
      error: null,
    })
    return { actions: 0, error: null }
  }

  let enqueuedCount = 0
  for (const wid of weddingIds.slice(0, 20)) {
    const r = await enqueueCoupleIntel({
      weddingId: wid,
      venueId: discovery.venue_id,
      triggerSignal: 'wave_7d_feedback',
      supabase,
    })
    if (!r.skipped) enqueuedCount += 1
  }

  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'couple_intel',
    actionType: 'enqueue',
    payload: {
      candidates_considered: weddingIds.length,
      jobs_enqueued: enqueuedCount,
    },
    error: null,
  })
  return { actions: 1, error: null }
}

/**
 * booking_blocker_question → add a flag-shaped entry into
 * venue_intel.rollup.timing_patterns. Indicates the operator should treat
 * the discovery as a friction-source the venue copy/brand can address.
 */
async function applyBookingBlockerQuestion(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  return upsertTimingPattern(supabase, discovery, evidence, 'flag', {
    pattern: evidence.pattern ?? `booking_blocker: ${discovery.hypothesis_title.slice(0, 100)}`,
    actionable_recommendation:
      discovery.recommended_action_if_validated ||
      'Address this blocker in venue copy / FAQ / sales follow-up.',
    source: 'wave_7d_discovery',
    discovery_id: discovery.id,
    sub_kind: 'booking_blocker',
  })
}

/**
 * time_of_day_pattern → tag-shaped entry into venue_intel.rollup.timing_patterns.
 * Lighter-weight than booking_blocker — the operator may want to schedule
 * outbound around the cohort's peak inbound hours.
 */
async function applyTimeOfDayPattern(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  return upsertTimingPattern(supabase, discovery, evidence, 'tag', {
    pattern: evidence.pattern ?? `time_of_day: ${discovery.hypothesis_title.slice(0, 100)}`,
    actionable_recommendation:
      discovery.recommended_action_if_validated ||
      'Align outbound + Sage send schedule to this peak window.',
    source: 'wave_7d_discovery',
    discovery_id: discovery.id,
    sub_kind: 'time_of_day',
  })
}

async function upsertTimingPattern(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  _evidence: EvidenceFragment,
  actionType: 'flag' | 'tag',
  entry: Record<string, unknown>,
): Promise<{ actions: number; error: string | null }> {
  const { data: row, error: readErr } = await supabase
    .from('venue_intel')
    .select('rollup')
    .eq('venue_id', discovery.venue_id)
    .maybeSingle()

  if (readErr) {
    return {
      actions: 0,
      error: `timing_patterns: venue_intel read failed: ${readErr.message}`,
    }
  }

  if (!row) {
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: 'venue_intel.timing_patterns',
      actionType,
      payload: { skipped_reason: 'no_venue_intel_row', entry },
      error: 'venue_intel row not present; cannot upsert',
    })
    return { actions: 0, error: 'venue_intel row not present' }
  }

  const rollup =
    typeof (row as { rollup?: unknown }).rollup === 'object' && (row as { rollup?: unknown }).rollup !== null
      ? ({ ...(row as { rollup: Record<string, unknown> }).rollup } as Record<string, unknown>)
      : ({} as Record<string, unknown>)

  const existing = Array.isArray(rollup.timing_patterns)
    ? (rollup.timing_patterns as Array<Record<string, unknown>>)
    : []

  // Dedupe: replace any existing entry whose discovery_id matches this one.
  const filtered = existing.filter((e) => e?.discovery_id !== discovery.id)
  filtered.push(entry)
  rollup.timing_patterns = filtered

  const { error: updErr } = await supabase
    .from('venue_intel')
    .update({ rollup, updated_at: new Date().toISOString() })
    .eq('venue_id', discovery.venue_id)

  if (updErr) {
    return {
      actions: 0,
      error: `timing_patterns: venue_intel update failed: ${updErr.message}`,
    }
  }

  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'venue_intel.timing_patterns',
    actionType,
    payload: { entry, total_patterns: filtered.length },
    error: null,
  })
  return { actions: 1, error: null }
}

/**
 * demographic_clustering → upsert venue_intel.rollup.over_indexed_personas.
 * Adds a "wave_7d_discovery" entry preserving the existing array.
 */
async function applyDemographicClustering(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
): Promise<{ actions: number; error: string | null }> {
  const cohortSegment = evidence.cohort_segment ?? evidence.persona_label
  if (!cohortSegment) {
    return {
      actions: 0,
      error: 'demographic_clustering: cohort_segment / persona_label missing from evidence',
    }
  }

  const { data: row, error: readErr } = await supabase
    .from('venue_intel')
    .select('rollup')
    .eq('venue_id', discovery.venue_id)
    .maybeSingle()

  if (readErr) {
    return {
      actions: 0,
      error: `demographic_clustering: venue_intel read failed: ${readErr.message}`,
    }
  }

  if (!row) {
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: 'venue_intel.over_indexed_personas',
      actionType: 'upsert',
      payload: { skipped_reason: 'no_venue_intel_row', cohort_segment: cohortSegment },
      error: 'venue_intel row not present; cannot upsert',
    })
    return { actions: 0, error: 'venue_intel row not present' }
  }

  const rollup =
    typeof (row as { rollup?: unknown }).rollup === 'object' && (row as { rollup?: unknown }).rollup !== null
      ? ({ ...(row as { rollup: Record<string, unknown> }).rollup } as Record<string, unknown>)
      : ({} as Record<string, unknown>)

  const existing = Array.isArray(rollup.over_indexed_personas)
    ? (rollup.over_indexed_personas as Array<Record<string, unknown>>)
    : []

  const filtered = existing.filter((e) => e?.discovery_id !== discovery.id)
  const entry = {
    cohort_segment: cohortSegment,
    over_index_signal: discovery.hypothesis_title,
    confidence_0_100: discovery.confidence_0_100,
    source: 'wave_7d_discovery',
    discovery_id: discovery.id,
  }
  filtered.push(entry)
  rollup.over_indexed_personas = filtered

  const { error: updErr } = await supabase
    .from('venue_intel')
    .update({ rollup, updated_at: new Date().toISOString() })
    .eq('venue_id', discovery.venue_id)

  if (updErr) {
    return {
      actions: 0,
      error: `demographic_clustering: venue_intel update failed: ${updErr.message}`,
    }
  }

  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'venue_intel.over_indexed_personas',
    actionType: 'upsert',
    payload: { entry },
    error: null,
  })
  return { actions: 1, error: null }
}

/**
 * tag_only — record the discovery's category in the audit log so a future
 * Wave 7A discovery prompt can surface "previously-validated categories"
 * to the engine. No system write happens.
 */
async function applyTagOnly(
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
): Promise<{ actions: number; error: string | null }> {
  await logAction(supabase, {
    discoveryId: discovery.id,
    venueId: discovery.venue_id,
    targetSystem: 'tag_only',
    actionType: 'tag',
    payload: {
      hypothesis_category: discovery.hypothesis_category,
      hypothesis_title: discovery.hypothesis_title,
      reason: 'LLM-invented category outside known mapping table; recorded for engine awareness only.',
    },
    error: null,
  })
  return { actions: 1, error: null }
}

// ---------------------------------------------------------------------------
// Mapping table
// ---------------------------------------------------------------------------

type MappingHandler = (
  supabase: SupabaseClient,
  discovery: DiscoveryRow,
  evidence: EvidenceFragment,
) => Promise<{ actions: number; error: string | null }>

const KNOWN_MAPPINGS: Record<string, MappingHandler> = {
  channel_role_distortion: applyChannelRoleDistortion,
  vendor_referral_unobserved: applyVendorReferralUnobserved,
  persona_channel_pattern: applyPersonaChannelPattern,
  cross_platform_drift: applyCrossPlatformDrift,
  competitor_positioning: applyCompetitorPositioning,
  stale_warm_lead: applyStaleWarmLead,
  booking_blocker_question: applyBookingBlockerQuestion,
  time_of_day_pattern: applyTimeOfDayPattern,
  demographic_clustering: applyDemographicClustering,
}

export function getKnownFeedbackCategories(): ReadonlyArray<string> {
  return Object.keys(KNOWN_MAPPINGS)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function applyDiscoveryFeedback(
  input: ApplyDiscoveryFeedbackInput,
): Promise<ApplyDiscoveryFeedbackResult> {
  const supabase = input.supabase ?? createServiceClient()
  const force = input.force === true

  if (!input.discoveryId) {
    return { actionsApplied: 0, errors: ['discoveryId required'] }
  }

  const { data: discoveryRow, error: readErr } = await supabase
    .from('intel_discoveries')
    .select(
      'id, venue_id, hypothesis_title, hypothesis_text, hypothesis_category, evidence_summary, validation_status, validation_metric, feedback_applied_at, recommended_action_if_validated, confidence_0_100',
    )
    .eq('id', input.discoveryId)
    .maybeSingle()

  if (readErr) {
    return {
      actionsApplied: 0,
      errors: [`discovery read failed: ${readErr.message}`],
    }
  }

  if (!discoveryRow) {
    return { actionsApplied: 0, errors: ['discovery not found'] }
  }

  const discovery = discoveryRow as DiscoveryRow

  if (discovery.validation_status !== 'validated') {
    return { actionsApplied: 0, errors: ['discovery not validated'] }
  }

  if (discovery.feedback_applied_at && !force) {
    return {
      actionsApplied: 0,
      errors: ['feedback already applied (pass force=true to override)'],
    }
  }

  const evidence = extractEvidence(discovery.evidence_summary)
  const handler = KNOWN_MAPPINGS[discovery.hypothesis_category]

  let actionsApplied = 0
  const errors: string[] = []

  try {
    if (handler) {
      const r = await handler(supabase, discovery, evidence)
      actionsApplied += r.actions
      if (r.error) errors.push(r.error)
    } else {
      const r = await applyTagOnly(supabase, discovery)
      actionsApplied += r.actions
      if (r.error) errors.push(r.error)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`mapping handler threw: ${msg}`)
    // Best-effort error audit row.
    await logAction(supabase, {
      discoveryId: discovery.id,
      venueId: discovery.venue_id,
      targetSystem: discovery.hypothesis_category,
      actionType: 'tag',
      payload: null,
      error: msg,
    })
  }

  const { error: stampErr } = await supabase
    .from('intel_discoveries')
    .update({ feedback_applied_at: new Date().toISOString() })
    .eq('id', discovery.id)
  if (stampErr) {
    errors.push(`feedback_applied_at stamp failed: ${stampErr.message}`)
  }

  return { actionsApplied, errors }
}

// ---------------------------------------------------------------------------
// Read helper — drives /feedback-actions endpoint + DiscoveryFeedbackPanel
// ---------------------------------------------------------------------------

export interface DiscoveryFeedbackActionRow {
  id: string
  discovery_id: string
  venue_id: string
  target_system: string
  action_type: string
  payload: Record<string, unknown> | null
  written_at: string
  error: string | null
}

export async function listDiscoveryFeedbackActions(
  discoveryId: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<DiscoveryFeedbackActionRow[]> {
  const { data, error } = await supabase
    .from('discovery_feedback_actions')
    .select(
      'id, discovery_id, venue_id, target_system, action_type, payload, written_at, error',
    )
    .eq('discovery_id', discoveryId)
    .order('written_at', { ascending: false })
    .limit(200)
  if (error) {
    throw new Error(`listDiscoveryFeedbackActions: ${error.message}`)
  }
  return (data ?? []) as DiscoveryFeedbackActionRow[]
}
