// ---------------------------------------------------------------------------
// timeline/build-timeline.ts — Wave 12 unified couple-timeline aggregator.
// ---------------------------------------------------------------------------
//
// Anchor docs (~/.claude memory/):
//   - bloom-constitution.md (Bloom is forensic identity reconstruction —
//     every signal is a chronologically-ordered event in the couple's
//     story. This service merges every source into one chronological
//     stream. Aggregate ≠ disclose: sensitive emotional truths from
//     couple_identity_profile are NEVER surfaced through this stream
//     unless the venue feature flag is on.)
//   - bloom-wave4-identity-reconstruction.md (the forensic record is
//     the substrate; Wave 12 is a *read-only* view over the substrate
//     plus every other signal source. NEVER re-extracts from raw bodies
//     — only reads existing rows.)
//   - bloom-may8-deep-fixes.md (inbox lifecycle filters direction=
//     'inbound' for counting purposes; timeline shows BOTH directions
//     for full audit but the kind discriminator lets the UI filter.)
//   - feedback_audit_agents_overclaim.md (verify end-to-end with a
//     real wedding — see scripts/test-wave12-timeline.ts for the
//     spot-check.)
//
// What this is
// ------------
// One function: buildCoupleTimeline({ weddingId, supabase }). Reads from
// every signal source we already have rows in, merges them into a single
// chronologically-ordered array of TimelineEvent rows. Each event has a
// kind discriminator (interaction, tour, lifecycle_transition,
// reconstruction, intel_derive, payment, contract, review,
// attribution_event, intel_match, discovery, recommendation) so the UI
// can filter.
//
// Per-source bounds prevent runaway memory for couples with thousands of
// interactions (Rixey's busiest leads carry 200+ emails over 18 months).
// MAX_EVENTS caps the whole output; older events are dropped.
//
// SENSITIVITY GATE
// ----------------
// `couple_identity_profile.last_reconstructed_at` is included as a
// "reconstruction" event so the timeline shows the operational rhythm
// (when did the Sonnet judge run on this couple?). The event PAYLOAD
// never contains the forensic profile body. Same rule for couple_intel:
// the event shows "intel derived" but never quotes the brief or
// sensitivity_flags.
//
// IDEMPOTENT
// ----------
// Pure read. Calling twice produces the same array (modulo new rows
// that landed between calls). No writes. No LLM calls.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TimelineEventKind =
  | 'interaction'
  | 'tour'
  | 'lifecycle_transition'
  | 'reconstruction'
  | 'intel_derive'
  | 'payment'
  | 'contract'
  | 'review'
  | 'attribution_event'
  | 'intel_match'
  | 'discovery'
  | 'recommendation'

export type TimelineDirection = 'inbound' | 'outbound'

export interface TimelineEvent {
  /** Synthetic id, e.g. 'interaction:UUID' / 'lifecycle_transition:UUID'.
   *  Stable across calls so the UI can key on it for highlight/scroll. */
  id: string
  /** ISO. The chronological anchor. */
  timestamp: string
  kind: TimelineEventKind
  /** Only set when kind ∈ {interaction}. */
  direction?: TimelineDirection
  /** Computed from lifecycle_transitions — what stage the couple was IN
   *  when this event fired. NULL means we don't have a transition row
   *  predating the event (couple was never staged before this signal). */
  lifecycle_stage_at_time?: string | null
  title: string
  summary: string
  /** Who/what produced the event. Free-text:
   *   'Sage AI' / 'coordinator' / 'couple' / 'system' / 'cron sweep'. */
  actor?: string
  /** Click-through pointer into the source row. */
  payload_ref: { table: string; id: string }
  /** Lucide icon hint. Free-text. The UI maps these to icons. */
  icon_hint: string
}

export interface BuildCoupleTimelineArgs {
  weddingId: string
  supabase: SupabaseClient
  /** Cap total events. Default 500. */
  maxEvents?: number
  /** Optional ISO lower bound. */
  since?: string | null
  /** Optional ISO upper bound. */
  until?: string | null
  /** Optional kind filter. When set, only events of these kinds are
   *  returned. Filters are applied AFTER aggregation so the per-source
   *  caps still apply — i.e. requesting kinds=['review'] does NOT relax
   *  the interactions cap. */
  kinds?: ReadonlyArray<TimelineEventKind> | null
  /** Per-source caps. Tuned for Rixey's longest leads (200+ emails over
   *  18 months). UI gets a 'truncated' flag if any cap was hit. */
  perSourceCaps?: Partial<PerSourceCaps>
}

export interface PerSourceCaps {
  interactions: number
  tours: number
  lifecycle_transitions: number
  payments: number
  contracts: number
  reviews: number
  attribution_events: number
  intel_matches: number
  discoveries: number
  recommendations: number
}

export const DEFAULT_PER_SOURCE_CAPS: PerSourceCaps = {
  interactions: 500,
  tours: 100,
  lifecycle_transitions: 100,
  payments: 100,
  contracts: 50,
  reviews: 50,
  attribution_events: 100,
  intel_matches: 100,
  discoveries: 50,
  recommendations: 50,
}

export interface CoupleTimelineResult {
  events: TimelineEvent[]
  /** True if any per-source cap was reached and rows were dropped, OR
   *  the overall maxEvents cap was applied. */
  truncated: boolean
  /** Quick by-kind histogram. UI renders this as the header chip row. */
  countsByKind: Record<TimelineEventKind, number>
  /** Total events before maxEvents truncation. */
  totalEvents: number
  /** Snapshot of wedding scope info — convenient for the UI header. */
  scope: {
    weddingId: string
    venueId: string | null
    currentLifecycleStage: string | null
    currentLifecycleStageSetAt: string | null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Aggregate every signal source for a wedding into a unified
 * chronological timeline. Idempotent. Bounded. Never re-extracts from
 * raw bodies — every event references a row that already exists.
 *
 * The function never throws on per-source DB errors. A failing source
 * is logged + skipped; the rest of the timeline still renders. This
 * matches the Wave 4 ReconstructedIdentityPanel pattern — a failing
 * intel_matches read shouldn't dark out the whole timeline page.
 */
export async function buildCoupleTimeline(
  args: BuildCoupleTimelineArgs,
): Promise<CoupleTimelineResult> {
  const { weddingId, supabase } = args
  const maxEvents = args.maxEvents ?? 500
  const caps: PerSourceCaps = { ...DEFAULT_PER_SOURCE_CAPS, ...(args.perSourceCaps ?? {}) }
  const since = args.since ?? null
  const until = args.until ?? null

  // ------- Scope row (no per-source error tolerance — we need this) -------
  const scope = await readScope(supabase, weddingId)

  // ------- Aggregate every source in parallel -------
  const [
    interactionEvents,
    tourEvents,
    lifecycleTransitionEvents,
    reconstructionEvents,
    intelDeriveEvents,
    paymentEvents,
    contractEvents,
    reviewEvents,
    attributionEvents,
    intelMatchEvents,
    discoveryEvents,
    recommendationEvents,
    lifecycleStageHistory,
  ] = await Promise.all([
    safeRead('interactions', () => readInteractions(supabase, weddingId, caps.interactions, since, until)),
    safeRead('tours', () => readTours(supabase, weddingId, caps.tours, since, until)),
    safeRead('lifecycle_transitions', () =>
      readLifecycleTransitions(supabase, weddingId, caps.lifecycle_transitions, since, until),
    ),
    safeRead('couple_identity_profile', () =>
      readReconstructionEvents(supabase, weddingId, since, until),
    ),
    safeRead('couple_intel', () =>
      readIntelDeriveEvents(supabase, weddingId, since, until),
    ),
    safeRead('budget_payments', () =>
      readPaymentEvents(supabase, weddingId, caps.payments, since, until),
    ),
    safeRead('contracts', () =>
      readContractEvents(supabase, weddingId, caps.contracts, since, until),
    ),
    safeRead('reviews', () =>
      readReviewEvents(supabase, weddingId, scope.venueId, caps.reviews, since, until),
    ),
    safeRead('attribution_events', () =>
      readAttributionEvents(supabase, weddingId, caps.attribution_events, since, until),
    ),
    safeRead('intel_matches', () =>
      readIntelMatchEvents(supabase, weddingId, caps.intel_matches, since, until),
    ),
    safeRead('intel_discoveries', () =>
      readDiscoveryEvents(supabase, weddingId, scope.venueId, caps.discoveries, since, until),
    ),
    safeRead('marketing_recommendations', () =>
      readRecommendationEvents(
        supabase,
        weddingId,
        scope.venueId,
        caps.recommendations,
        since,
        until,
      ),
    ),
    // Separately load every lifecycle_transition (no until filter) so we
    // can compute "what stage was the couple in when event X happened".
    // Bounded — same cap as the transitions event source above.
    safeRead('lifecycle_transitions_history', () =>
      readLifecycleStageHistory(supabase, weddingId, caps.lifecycle_transitions),
    ),
  ])

  // ------- Merge + sort -------
  const all: TimelineEvent[] = [
    ...interactionEvents,
    ...tourEvents,
    ...lifecycleTransitionEvents,
    ...reconstructionEvents,
    ...intelDeriveEvents,
    ...paymentEvents,
    ...contractEvents,
    ...reviewEvents,
    ...attributionEvents,
    ...intelMatchEvents,
    ...discoveryEvents,
    ...recommendationEvents,
  ]

  // Sort ASC by timestamp. Defensive on parse failure (drop bad rows
  // at the end of the array rather than crash).
  all.sort((a, b) => {
    const ta = Date.parse(a.timestamp)
    const tb = Date.parse(b.timestamp)
    const aa = Number.isFinite(ta) ? ta : Number.MAX_SAFE_INTEGER
    const bb = Number.isFinite(tb) ? tb : Number.MAX_SAFE_INTEGER
    return aa - bb
  })

  // ------- Compute lifecycle_stage_at_time for every event -------
  // lifecycleStageHistory is ASC by transitioned_at. For each event we
  // find the last transition whose transitioned_at <= event.timestamp.
  // Linear two-pointer walk — O(N + M).
  attachLifecycleStageAtTime(all, lifecycleStageHistory)

  const totalBeforeKindFilter = all.length

  // ------- Apply kind filter (if any) -------
  let filtered = all
  if (args.kinds && args.kinds.length > 0) {
    const set = new Set<TimelineEventKind>(args.kinds)
    filtered = all.filter((e) => set.has(e.kind))
  }

  // ------- Apply max-events cap — keep MOST RECENT 500 -------
  let truncated = false
  // Per-source caps already truncated; mark truncated if any source
  // returned at-cap row count.
  if (interactionEvents.length >= caps.interactions) truncated = true
  if (tourEvents.length >= caps.tours) truncated = true
  if (lifecycleTransitionEvents.length >= caps.lifecycle_transitions) truncated = true

  let final = filtered
  if (filtered.length > maxEvents) {
    final = filtered.slice(filtered.length - maxEvents)
    truncated = true
  }

  // ------- Counts by kind (over the *returned* events) -------
  const countsByKind: Record<TimelineEventKind, number> = {
    interaction: 0,
    tour: 0,
    lifecycle_transition: 0,
    reconstruction: 0,
    intel_derive: 0,
    payment: 0,
    contract: 0,
    review: 0,
    attribution_event: 0,
    intel_match: 0,
    discovery: 0,
    recommendation: 0,
  }
  for (const e of final) countsByKind[e.kind]++

  return {
    events: final,
    truncated,
    countsByKind,
    totalEvents: totalBeforeKindFilter,
    scope: {
      weddingId,
      venueId: scope.venueId,
      currentLifecycleStage: scope.currentLifecycleStage,
      currentLifecycleStageSetAt: scope.currentLifecycleStageSetAt,
    },
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

interface ScopeSnapshot {
  venueId: string | null
  currentLifecycleStage: string | null
  currentLifecycleStageSetAt: string | null
}

async function readScope(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<ScopeSnapshot> {
  try {
    const { data } = await supabase
      .from('weddings')
      .select('venue_id, lifecycle_stage, lifecycle_stage_set_at')
      .eq('id', weddingId)
      .maybeSingle()
    if (!data) return { venueId: null, currentLifecycleStage: null, currentLifecycleStageSetAt: null }
    const r = data as {
      venue_id: string | null
      lifecycle_stage: string | null
      lifecycle_stage_set_at: string | null
    }
    return {
      venueId: r.venue_id,
      currentLifecycleStage: r.lifecycle_stage,
      currentLifecycleStageSetAt: r.lifecycle_stage_set_at,
    }
  } catch {
    return { venueId: null, currentLifecycleStage: null, currentLifecycleStageSetAt: null }
  }
}

// ---------------------------------------------------------------------------
// Per-source readers — each returns TimelineEvent[]
// ---------------------------------------------------------------------------

async function safeRead<T>(
  label: string,
  fn: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[timeline] source '${label}' failed: ${msg}`)
    return []
  }
}

async function readInteractions(
  supabase: SupabaseClient,
  weddingId: string,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  let q = supabase
    .from('interactions')
    .select('id, type, direction, subject, body_preview, from_name, from_email, timestamp')
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: false })
    .limit(cap)
  if (since) q = q.gte('timestamp', since)
  if (until) q = q.lte('timestamp', until)
  const { data, error } = await q
  if (error || !data) return []

  return (data as Array<{
    id: string
    type: string | null
    direction: string | null
    subject: string | null
    body_preview: string | null
    from_name: string | null
    from_email: string | null
    timestamp: string
  }>).map((r) => {
    const direction: TimelineDirection =
      r.direction === 'outbound' ? 'outbound' : 'inbound'
    const senderLabel =
      r.from_name?.trim() ||
      r.from_email?.trim() ||
      (direction === 'inbound' ? 'unknown sender' : 'venue')
    const subjectSnippet = r.subject?.trim() || '(no subject)'
    const summary = (r.body_preview ?? '').trim().slice(0, 200) || '(no preview)'
    const verb = direction === 'inbound' ? 'Inbound' : 'Outbound'
    const typeLabel = r.type === 'email' ? 'email' : (r.type ?? 'message')
    return {
      id: `interaction:${r.id}`,
      timestamp: r.timestamp,
      kind: 'interaction' as const,
      direction,
      title: `${verb} ${typeLabel} from ${senderLabel}: "${truncate(subjectSnippet, 80)}"`,
      summary,
      actor: direction === 'inbound' ? 'couple' : 'Sage AI / coordinator',
      payload_ref: { table: 'interactions', id: r.id },
      icon_hint: direction === 'inbound' ? 'arrow-down-right' : 'arrow-up-right',
    }
  })
}

async function readTours(
  supabase: SupabaseClient,
  weddingId: string,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  let q = supabase
    .from('tours')
    .select('id, scheduled_at, tour_type, outcome, notes, created_at, source')
    .eq('wedding_id', weddingId)
    .order('scheduled_at', { ascending: false, nullsFirst: false })
    .limit(cap)
  if (since) q = q.gte('scheduled_at', since)
  if (until) q = q.lte('scheduled_at', until)
  const { data, error } = await q
  if (error || !data) return []

  const events: TimelineEvent[] = []
  for (const r of data as Array<{
    id: string
    scheduled_at: string | null
    tour_type: string | null
    outcome: string | null
    notes: string | null
    created_at: string | null
    source: string | null
  }>) {
    // Two anchors: when the tour was scheduled AND (if outcome is set)
    // when the tour completed/no-showed. We emit ONE row anchored at
    // scheduled_at; outcome is described in the title/summary. (A more
    // granular split is possible but inflates the event count without
    // adding clarity — the operational story is "tour @ Apr 12 →
    // completed".)
    const anchor = r.scheduled_at ?? r.created_at
    if (!anchor) continue
    const outcomeLabel = r.outcome
      ? r.outcome.replace(/_/g, ' ')
      : 'pending'
    const typeLabel = r.tour_type ? r.tour_type.replace(/_/g, ' ') : 'tour'
    events.push({
      id: `tour:${r.id}`,
      timestamp: anchor,
      kind: 'tour',
      title: `Tour scheduled (${typeLabel}) — outcome: ${outcomeLabel}`,
      summary: r.notes?.trim() ?? (r.source ? `via ${r.source}` : 'No notes.'),
      actor: 'coordinator',
      payload_ref: { table: 'tours', id: r.id },
      icon_hint: 'calendar',
    })
  }
  return events
}

async function readLifecycleTransitions(
  supabase: SupabaseClient,
  weddingId: string,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  let q = supabase
    .from('lifecycle_transitions')
    .select(
      'id, from_stage, to_stage, transition_kind, reasoning, confidence, transitioned_at',
    )
    .eq('wedding_id', weddingId)
    .order('transitioned_at', { ascending: false })
    .limit(cap)
  if (since) q = q.gte('transitioned_at', since)
  if (until) q = q.lte('transitioned_at', until)
  const { data, error } = await q
  if (error || !data) return []

  return (data as Array<{
    id: string
    from_stage: string | null
    to_stage: string
    transition_kind: string
    reasoning: string | null
    confidence: number | null
    transitioned_at: string
  }>).map((r) => {
    const fromLabel = r.from_stage ?? '(unknown)'
    const titlePart =
      r.transition_kind === 'auto_stuck'
        ? `Stuck at ${r.to_stage} (re-affirmed)`
        : `Moved ${fromLabel} → ${r.to_stage}`
    return {
      id: `lifecycle_transition:${r.id}`,
      timestamp: r.transitioned_at,
      kind: 'lifecycle_transition' as const,
      title: `${titlePart} [${r.transition_kind}]`,
      summary: r.reasoning?.trim() || 'No reasoning recorded.',
      actor:
        r.transition_kind === 'llm_judged'
          ? 'Sage AI'
          : r.transition_kind === 'operator_override'
            ? 'coordinator'
            : 'system',
      payload_ref: { table: 'lifecycle_transitions', id: r.id },
      icon_hint: 'sparkles',
    }
  })
}

async function readReconstructionEvents(
  supabase: SupabaseClient,
  weddingId: string,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  // Just one event per wedding (couple_identity_profile is pk=wedding_id).
  // We emit it anchored at last_reconstructed_at. Never quotes the
  // forensic body — title says "Identity reconstructed (N runs)".
  try {
    const { data } = await supabase
      .from('couple_identity_profile')
      .select('wedding_id, last_reconstructed_at, reconstruction_count, prompt_version')
      .eq('wedding_id', weddingId)
      .maybeSingle()
    if (!data) return []
    const r = data as {
      wedding_id: string
      last_reconstructed_at: string
      reconstruction_count: number
      prompt_version: string
    }
    if (since && r.last_reconstructed_at < since) return []
    if (until && r.last_reconstructed_at > until) return []
    return [
      {
        id: `reconstruction:${r.wedding_id}`,
        timestamp: r.last_reconstructed_at,
        kind: 'reconstruction',
        title: `Identity reconstructed (${r.reconstruction_count} run${r.reconstruction_count === 1 ? '' : 's'})`,
        summary: `Sonnet forensic pass · prompt ${r.prompt_version}`,
        actor: 'Sage AI',
        payload_ref: { table: 'couple_identity_profile', id: r.wedding_id },
        icon_hint: 'sparkles',
      },
    ]
  } catch {
    return []
  }
}

async function readIntelDeriveEvents(
  supabase: SupabaseClient,
  weddingId: string,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  // couple_intel.last_derived_at — single event per wedding. NEVER
  // quotes coordinator_brief or sensitivity_flags (those live in the
  // CoupleIntelPanel, gated separately).
  try {
    const { data } = await supabase
      .from('couple_intel')
      .select('wedding_id, last_derived_at, predicted_close_probability_pct, persona_label')
      .eq('wedding_id', weddingId)
      .maybeSingle()
    if (!data) return []
    const r = data as {
      wedding_id: string
      last_derived_at: string
      predicted_close_probability_pct: number | null
      persona_label: string | null
    }
    if (since && r.last_derived_at < since) return []
    if (until && r.last_derived_at > until) return []
    const personaPart = r.persona_label ? ` · persona: ${r.persona_label}` : ''
    const probPart =
      typeof r.predicted_close_probability_pct === 'number'
        ? ` · close prob ${r.predicted_close_probability_pct}%`
        : ''
    return [
      {
        id: `intel_derive:${r.wedding_id}`,
        timestamp: r.last_derived_at,
        kind: 'intel_derive',
        title: 'Couple intel derived',
        summary: `Sonnet derivation pass${personaPart}${probPart}`,
        actor: 'Sage AI',
        payload_ref: { table: 'couple_intel', id: r.wedding_id },
        icon_hint: 'brain',
      },
    ]
  } catch {
    return []
  }
}

async function readPaymentEvents(
  supabase: SupabaseClient,
  weddingId: string,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  // budget_payments — anchor on payment_date when present, fall back to
  // created_at. Amount and method become the title.
  let q = supabase
    .from('budget_payments')
    .select('id, amount, payment_date, payment_method, notes, created_at')
    .eq('wedding_id', weddingId)
    .order('payment_date', { ascending: false, nullsFirst: false })
    .limit(cap)
  if (since) q = q.gte('payment_date', since.slice(0, 10))
  if (until) q = q.lte('payment_date', until.slice(0, 10))
  const { data, error } = await q
  if (error || !data) return []

  return (data as Array<{
    id: string
    amount: number | string | null
    payment_date: string | null
    payment_method: string | null
    notes: string | null
    created_at: string | null
  }>).map((r) => {
    const anchor = r.payment_date
      ? new Date(r.payment_date).toISOString()
      : (r.created_at ?? new Date().toISOString())
    const amt =
      typeof r.amount === 'number'
        ? r.amount
        : Number(r.amount ?? 0) || 0
    const methodPart = r.payment_method ? ` via ${r.payment_method}` : ''
    return {
      id: `payment:${r.id}`,
      timestamp: anchor,
      kind: 'payment' as const,
      title: `Payment $${amt.toLocaleString()}${methodPart}`,
      summary: r.notes?.trim() ?? 'No notes.',
      actor: 'couple',
      payload_ref: { table: 'budget_payments', id: r.id },
      icon_hint: 'dollar-sign',
    }
  })
}

async function readContractEvents(
  supabase: SupabaseClient,
  weddingId: string,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  let q = supabase
    .from('contracts')
    .select('id, filename, file_type, created_at')
    .eq('wedding_id', weddingId)
    .order('created_at', { ascending: false })
    .limit(cap)
  if (since) q = q.gte('created_at', since)
  if (until) q = q.lte('created_at', until)
  const { data, error } = await q
  if (error || !data) return []

  return (data as Array<{
    id: string
    filename: string | null
    file_type: string | null
    created_at: string
  }>).map((r) => ({
    id: `contract:${r.id}`,
    timestamp: r.created_at,
    kind: 'contract' as const,
    title: `Contract uploaded: ${r.filename ?? '(unnamed)'}`,
    summary: r.file_type ? `type: ${r.file_type}` : 'Document attached to wedding.',
    actor: 'coordinator',
    payload_ref: { table: 'contracts', id: r.id },
    icon_hint: 'file-signature',
  }))
}

async function readReviewEvents(
  supabase: SupabaseClient,
  weddingId: string,
  venueId: string | null,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  // reviews is venue-scoped (no wedding_id column on legacy schema).
  // Strategy: fetch the couple's display name via people, then match
  // reviews where reviewer_name LIKE either partner's first/last name.
  // Bounded — at most `cap` rows. If reviewer_name is null in a row, it
  // does not match.
  if (!venueId) return []

  let names: string[] = []
  try {
    const { data: peopleRows } = await supabase
      .from('people')
      .select('first_name, last_name')
      .eq('wedding_id', weddingId)
    const set = new Set<string>()
    for (const p of (peopleRows as Array<{
      first_name: string | null
      last_name: string | null
    }> | null) ?? []) {
      const fn = p.first_name?.trim()
      const ln = p.last_name?.trim()
      if (fn) set.add(fn)
      if (ln) set.add(ln)
      if (fn && ln) set.add(`${fn} ${ln}`)
    }
    names = Array.from(set).filter((n) => n.length >= 3)
  } catch {
    return []
  }
  if (names.length === 0) return []

  // Build an .or() expression matching reviewer_name with ilike on each
  // name token. Cap at first 10 distinct tokens to keep the OR sane.
  const orExpr = names
    .slice(0, 10)
    .map((n) => `reviewer_name.ilike.%${escapeIlike(n)}%`)
    .join(',')
  let q = supabase
    .from('reviews')
    .select('id, source, reviewer_name, rating, title, body, review_date, response_date')
    .eq('venue_id', venueId)
    .or(orExpr)
    .order('review_date', { ascending: false })
    .limit(cap)
  if (since) q = q.gte('review_date', since.slice(0, 10))
  if (until) q = q.lte('review_date', until.slice(0, 10))
  const { data, error } = await q
  if (error || !data) return []

  return (data as Array<{
    id: string
    source: string | null
    reviewer_name: string | null
    rating: number | null
    title: string | null
    body: string | null
    review_date: string | null
    response_date: string | null
  }>)
    .filter((r) => !!r.review_date)
    .map((r) => {
      const anchor = new Date(r.review_date as string).toISOString()
      const sourceLabel = r.source ?? 'unknown'
      const stars = typeof r.rating === 'number' ? `${r.rating}★` : '?★'
      return {
        id: `review:${r.id}`,
        timestamp: anchor,
        kind: 'review' as const,
        title: `${stars} review on ${sourceLabel} by ${r.reviewer_name ?? '(anonymous)'}`,
        summary: (r.title ?? r.body ?? '').slice(0, 220) || '(no body)',
        actor: 'couple',
        payload_ref: { table: 'reviews', id: r.id },
        icon_hint: 'star',
      }
    })
}

async function readAttributionEvents(
  supabase: SupabaseClient,
  weddingId: string,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  let q = supabase
    .from('attribution_events')
    .select(
      'id, source_platform, confidence, tier, bucket, decided_by, decided_at, reasoning, is_first_touch, role, reverted_at',
    )
    .eq('wedding_id', weddingId)
    .order('decided_at', { ascending: false })
    .limit(cap)
  if (since) q = q.gte('decided_at', since)
  if (until) q = q.lte('decided_at', until)
  const { data, error } = await q
  if (error || !data) return []

  return (data as Array<{
    id: string
    source_platform: string | null
    confidence: number | null
    tier: string | null
    bucket: string | null
    decided_by: string | null
    decided_at: string
    reasoning: string | null
    is_first_touch: boolean | null
    role: string | null
    reverted_at: string | null
  }>)
    // Keep reverted rows in the timeline (audit value) but label them.
    .map((r) => {
      const ftPart = r.is_first_touch ? ' [first-touch]' : ''
      const rolePart = r.role && r.role !== 'unknown' ? ` · role=${r.role}` : ''
      const bucketPart = r.bucket ? ` · ${r.bucket}` : ''
      const revertedPart = r.reverted_at ? ' (reverted)' : ''
      return {
        id: `attribution_event:${r.id}`,
        timestamp: r.decided_at,
        kind: 'attribution_event' as const,
        title: `Attribution: ${r.source_platform ?? 'unknown'}${ftPart}${revertedPart}`,
        summary:
          r.reasoning?.trim() ||
          `Tier ${r.tier ?? '?'} · ${r.confidence ?? '?'}%${rolePart}${bucketPart}`,
        actor:
          r.decided_by === 'ai'
            ? 'Sage AI'
            : r.decided_by === 'coordinator'
              ? 'coordinator'
              : 'system',
        payload_ref: { table: 'attribution_events', id: r.id },
        icon_hint: 'route',
      }
    })
}

async function readIntelMatchEvents(
  supabase: SupabaseClient,
  weddingId: string,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  let q = supabase
    .from('intel_matches')
    .select(
      'id, signal_type, signal_payload, match_reasoning, match_confidence_0_100, cohort_fit_score_0_100, fired_at, dismissed_at, actioned_at, action_taken',
    )
    .eq('wedding_id', weddingId)
    .order('fired_at', { ascending: false })
    .limit(cap)
  if (since) q = q.gte('fired_at', since)
  if (until) q = q.lte('fired_at', until)
  const { data, error } = await q
  if (error || !data) return []

  return (data as Array<{
    id: string
    signal_type: string
    signal_payload: Record<string, unknown> | null
    match_reasoning: string | null
    match_confidence_0_100: number
    cohort_fit_score_0_100: number | null
    fired_at: string
    dismissed_at: string | null
    actioned_at: string | null
    action_taken: string | null
  }>).map((r) => {
    const payloadHint = summarizeIntelMatchPayload(r.signal_type, r.signal_payload)
    const statusPart = r.dismissed_at
      ? ' (dismissed)'
      : r.actioned_at
        ? ` · actioned: ${r.action_taken ?? 'yes'}`
        : ''
    return {
      id: `intel_match:${r.id}`,
      timestamp: r.fired_at,
      kind: 'intel_match' as const,
      title: `Intel match: ${r.signal_type}${payloadHint}${statusPart}`,
      summary:
        r.match_reasoning?.trim() ||
        `confidence ${r.match_confidence_0_100}%${r.cohort_fit_score_0_100 != null ? ` · cohort fit ${r.cohort_fit_score_0_100}%` : ''}`,
      actor: 'Sage AI',
      payload_ref: { table: 'intel_matches', id: r.id },
      icon_hint: 'link',
    }
  })
}

async function readDiscoveryEvents(
  supabase: SupabaseClient,
  weddingId: string,
  venueId: string | null,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  // intel_discoveries is venue-scoped only — no wedding_id column.
  // Strategy: surface venue-wide discoveries whose evidence_summary
  // references this weddingId. evidence_summary is jsonb; we search via
  // a containment query on a 'sample_wedding_ids' array if present.
  // When the column shape is different / absent, we just return [].
  if (!venueId) return []

  let q = supabase
    .from('intel_discoveries')
    .select(
      'id, hypothesis_title, hypothesis_category, evidence_summary, confidence_0_100, validation_status, created_at',
    )
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(cap * 4) // overfetch — we filter by wedding membership client-side
  if (since) q = q.gte('created_at', since)
  if (until) q = q.lte('created_at', until)
  const { data, error } = await q
  if (error || !data) return []

  const kept: TimelineEvent[] = []
  for (const r of data as Array<{
    id: string
    hypothesis_title: string
    hypothesis_category: string
    evidence_summary: Record<string, unknown> | null
    confidence_0_100: number
    validation_status: string
    created_at: string
  }>) {
    // Match either { sample_wedding_ids: [uuid, ...] } or
    // { wedding_ids: [...] } shapes. Aggregate ≠ disclose, so the
    // discovery row never EXPOSES the wedding id back to the UI — but
    // we use it for membership detection here.
    const ev = (r.evidence_summary ?? {}) as Record<string, unknown>
    const arr =
      (ev.sample_wedding_ids as string[] | undefined) ||
      (ev.wedding_ids as string[] | undefined) ||
      undefined
    if (!Array.isArray(arr) || !arr.includes(weddingId)) continue

    kept.push({
      id: `discovery:${r.id}`,
      timestamp: r.created_at,
      kind: 'discovery',
      title: `Discovery: ${truncate(r.hypothesis_title, 100)}`,
      summary: `${r.hypothesis_category} · ${r.validation_status} · confidence ${r.confidence_0_100}%`,
      actor: 'Sage AI',
      payload_ref: { table: 'intel_discoveries', id: r.id },
      icon_hint: 'lightbulb',
    })
    if (kept.length >= cap) break
  }
  return kept
}

async function readRecommendationEvents(
  supabase: SupabaseClient,
  weddingId: string,
  venueId: string | null,
  cap: number,
  since: string | null,
  until: string | null,
): Promise<TimelineEvent[]> {
  // marketing_recommendations is venue-scoped + persona-scoped.
  // Strategy: match recs whose target_persona matches this couple's
  // persona_label from couple_intel. When persona_label is null,
  // returns [].
  if (!venueId) return []
  try {
    const { data: intelRow } = await supabase
      .from('couple_intel')
      .select('persona_label')
      .eq('wedding_id', weddingId)
      .maybeSingle()
    const persona = (intelRow as { persona_label: string | null } | null)?.persona_label
    if (!persona) return []

    let q = supabase
      .from('marketing_recommendations')
      .select(
        'id, recommendation_title, action_type, target_persona, source_channel, target_channel, confidence_0_100, status, generated_at',
      )
      .eq('venue_id', venueId)
      .eq('target_persona', persona)
      .order('generated_at', { ascending: false })
      .limit(cap)
    if (since) q = q.gte('generated_at', since)
    if (until) q = q.lte('generated_at', until)
    const { data, error } = await q
    if (error || !data) return []

    return (data as Array<{
      id: string
      recommendation_title: string
      action_type: string
      target_persona: string | null
      source_channel: string | null
      target_channel: string | null
      confidence_0_100: number
      status: string
      generated_at: string
    }>).map((r) => {
      const channelPart =
        r.source_channel && r.target_channel
          ? ` (${r.source_channel} → ${r.target_channel})`
          : ''
      return {
        id: `recommendation:${r.id}`,
        timestamp: r.generated_at,
        kind: 'recommendation' as const,
        title: `Recommendation: ${truncate(r.recommendation_title, 100)}`,
        summary: `${r.action_type}${channelPart} · ${r.status} · confidence ${r.confidence_0_100}%`,
        actor: 'Sage AI',
        payload_ref: { table: 'marketing_recommendations', id: r.id },
        icon_hint: 'trending-up',
      }
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// lifecycle_stage_at_time computation
// ---------------------------------------------------------------------------

interface LifecycleStageHistoryRow {
  to_stage: string
  transitioned_at: string
}

async function readLifecycleStageHistory(
  supabase: SupabaseClient,
  weddingId: string,
  cap: number,
): Promise<LifecycleStageHistoryRow[]> {
  const { data, error } = await supabase
    .from('lifecycle_transitions')
    .select('to_stage, transitioned_at')
    .eq('wedding_id', weddingId)
    .order('transitioned_at', { ascending: true })
    .limit(cap)
  if (error || !data) return []
  return (data as Array<{ to_stage: string; transitioned_at: string }>).map((r) => ({
    to_stage: r.to_stage,
    transitioned_at: r.transitioned_at,
  }))
}

function attachLifecycleStageAtTime(
  events: TimelineEvent[],
  history: LifecycleStageHistoryRow[],
): void {
  if (history.length === 0) return
  // events are sorted ASC by timestamp; history is ASC by transitioned_at.
  // Walk both forward: for each event, advance the history pointer to
  // the latest transition whose transitioned_at <= event.timestamp.
  let hi = 0
  let stageNow: string | null = null
  for (const e of events) {
    const t = Date.parse(e.timestamp)
    if (!Number.isFinite(t)) {
      e.lifecycle_stage_at_time = stageNow
      continue
    }
    while (hi < history.length) {
      const ht = Date.parse(history[hi].transitioned_at)
      if (Number.isFinite(ht) && ht <= t) {
        stageNow = history[hi].to_stage
        hi++
      } else {
        break
      }
    }
    e.lifecycle_stage_at_time = stageNow
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 3) + '...'
}

function escapeIlike(s: string): string {
  // Escape % and _ which are wildcards in PG ilike. Also escape commas
  // because the .or() postgrest dialect uses comma as the separator.
  return s.replace(/[%_]/g, '\\$&').replace(/,/g, ' ')
}

function summarizeIntelMatchPayload(
  signalType: string,
  payload: Record<string, unknown> | null,
): string {
  if (!payload) return ''
  const p = payload as Record<string, unknown>
  switch (signalType) {
    case 'cultural_moment': {
      const t = p.title
      return typeof t === 'string' ? `: ${truncate(t, 40)}` : ''
    }
    case 'vendor_mention': {
      const v = p.vendor_name
      return typeof v === 'string' ? `: ${truncate(v, 40)}` : ''
    }
    case 'competitor_mention': {
      const c = p.competitor_name
      return typeof c === 'string' ? `: ${truncate(c, 40)}` : ''
    }
    case 'cross_platform_handle': {
      const plat = p.platform
      const h = p.handle
      if (typeof plat === 'string' && typeof h === 'string') {
        return `: ${plat}/${truncate(h, 30)}`
      }
      return ''
    }
    default:
      return ''
  }
}
