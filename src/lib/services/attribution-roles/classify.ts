/**
 * Wave 7B — Channel-Role Classifier (forensic acquisition vs validation).
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; same evidence-chain rigor applied to attribution)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B spec — channel-role
 *     reclassification reveals "30% of Knot leads are validation")
 *   - bloom-phase-b-decisions.md (attribution_events architecture; we
 *     extend with role columns in mig 264, never modify persona_overlay
 *     which Wave 6A owns)
 *
 * What this service does
 * ----------------------
 * For one attribution_events row, decide whether the role is:
 *   - acquisition: this touchpoint sourced the couple. Pre-inquiry
 *     engagement evidence on the SAME platform exists.
 *   - validation: the couple discovered the venue elsewhere and used
 *     this touchpoint as a confirmation/intake form. NO same-platform
 *     pre-inquiry engagement; pre-inquiry signals exist on OTHER
 *     platforms.
 *   - conversion: the touchpoint is itself a closing-step event
 *     (inquiry submission, tour booking, contract signature). Always
 *     this when touch_type matches a conversion event.
 *   - mixed: signals contradict; coordinator review queue.
 *
 * Algorithm
 * ---------
 * 1. Conversion fast-path: if the touchpoint's touch_type or signal
 *    type matches a closing-step (inquiry / tour_booked / contract_
 *    signed / etc.), return conversion immediately.
 *
 * 2. Forensic check: gather pre-inquiry signals (within the 30-day
 *    window before inquiry_date) for the SAME candidate cluster. Split
 *    into same-platform vs other-platform. Apply the rules:
 *
 *    - same-platform pre-inquiry signal present → acquisition (high
 *      confidence)
 *    - same-platform absent + other-platform present → validation
 *      (high confidence; the strong story for "Knot is intake form")
 *    - same-platform absent + other-platform absent + clearly direct
 *      (no platform signal of any kind) → acquisition (default for
 *      direct/organic; couple found us themselves)
 *    - same-platform absent + other-platform absent + the platform IS
 *      a known intake/scheduling tool (Knot / WeddingWire / HoneyBook /
 *      Calendly) → mixed (defer to LLM judge — the platform is on the
 *      validation-suspicious list but no acquisition trail of any kind)
 *
 * 3. LLM judge (Sonnet) for mixed cases. ~$0.005 per classification.
 *
 * Cost: every classification is forensic-rule-only except mixed cases.
 * Mixed-case rate at 5,000 events ≈ 10-20% → ~500-1000 LLM calls @
 * $0.005 = $2.50-$5/venue lifetime classification.
 *
 * Idempotent — re-running on unchanged data produces the same role.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  buildSystemPrompt,
  buildUserPrompt,
  validateChannelRoleOutput,
  CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
  type ChannelRole,
  type ChannelRoleClassifierOutput,
  type EngagementSignal,
  type TouchpointEventEvidence,
} from '@/config/prompts/channel-role-classifier'

// Re-export for ergonomic imports.
export {
  CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
  type ChannelRole,
  type ChannelRoleClassifierOutput,
} from '@/config/prompts/channel-role-classifier'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Window we look back for pre-inquiry engagement signals. */
const PRE_INQUIRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * Touchpoint types that ALWAYS classify as conversion regardless of
 * source_platform. These are closing-step events; they cannot acquire
 * or validate.
 */
const CONVERSION_TOUCH_TYPES = new Set([
  'inquiry',
  'tour_booked',
  'tour_conducted',
  'tour_scheduled',
  'calendly_booked',
  'contract_signed',
  'proposal_sent',
  'booking',
])

/**
 * Platforms known to be heavy validation/intake suspects when no pre-
 * inquiry engagement is recorded. These are the "Request Info" buttons
 * couples click after discovering the venue elsewhere. Not a denylist —
 * forensic evidence still wins; this is the deferral hint when evidence
 * is absent.
 */
const VALIDATION_SUSPICIOUS_PLATFORMS = new Set([
  'the_knot',
  'theknot',
  'theknot.com',
  'weddingwire',
  'wedding_wire',
  'weddingwire.com',
  'honeybook',
  'honeybook.com',
  'calendly',
  'calendly.com',
  'zola',
])

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Possible outcomes of the forensic check before LLM judge. */
type ForensicPath =
  | 'conversion_touch_type'
  | 'acquisition_same_platform_signal'
  | 'validation_no_same_platform'
  | 'acquisition_direct_default'
  | 'mixed_deferred_to_llm'

export interface RoleEvidence {
  /** ISO timestamps of same-platform pre-inquiry signals. */
  platform_engagement_dates: string[]
  /** What signals were missing relative to the platform. */
  missing_signals: string[]
  /** Which path through the rule the classifier took. */
  forensic_path: ForensicPath
  /** Same-platform signal details (richer than dates alone). */
  same_platform_signals: EngagementSignal[]
  /** Other-platform signal details (helps coordinators inspect). */
  other_platform_signals: EngagementSignal[]
  /** LLM judge details when forensic_path = 'mixed_deferred_to_llm'. */
  llm_judge: {
    key_evidence_signals: string[]
    refusal: string | null
    prompt_version: string
  } | null
}

export interface ClassifyResult {
  role: 'acquisition' | 'validation' | 'conversion' | 'mixed' | 'unknown'
  role_confidence_0_100: number
  reasoning: string
  evidence: RoleEvidence
  /** Cost in cents (sub-cent precision); 0 when no LLM call was made. */
  cost_cents: number
  prompt_version: string | null
}

// ---------------------------------------------------------------------------
// Internal data fetchers
// ---------------------------------------------------------------------------

interface AttributionEventRow {
  id: string
  venue_id: string
  candidate_identity_id: string | null
  wedding_id: string
  source_platform: string | null
  signal_id: string | null
  decided_at: string
  signal_class: string | null
  bucket: string | null
  is_first_touch: boolean | null
  reverted_at: string | null
}

interface SignalRow {
  id: string
  source_platform: string | null
  signal_date: string | null
  source_context: string | null
  action_class: string | null
  signal_class: string | null
  candidate_identity_id: string | null
}

interface WeddingRow {
  id: string
  inquiry_date: string | null
  source: string | null
  utm_source: string | null
  status: string | null
}

interface TouchpointRow {
  id: string
  source: string | null
  occurred_at: string | null
  touch_type: string | null
  signal_class: string | null
}

async function loadAttributionEvent(
  sb: SupabaseClient,
  attributionEventId: string,
): Promise<AttributionEventRow | null> {
  const { data, error } = await sb
    .from('attribution_events')
    .select(
      'id, venue_id, candidate_identity_id, wedding_id, source_platform, signal_id, decided_at, signal_class, bucket, is_first_touch, reverted_at',
    )
    .eq('id', attributionEventId)
    .maybeSingle()
  if (error) throw new Error(`classify.loadAttributionEvent failed: ${error.message}`)
  return (data as AttributionEventRow | null) ?? null
}

async function loadWedding(sb: SupabaseClient, weddingId: string): Promise<WeddingRow | null> {
  const { data, error } = await sb
    .from('weddings')
    .select('id, inquiry_date, source, utm_source, status')
    .eq('id', weddingId)
    .maybeSingle()
  if (error) throw new Error(`classify.loadWedding failed: ${error.message}`)
  return (data as WeddingRow | null) ?? null
}

/**
 * Pull every tangential_signal in this candidate cluster. The cluster
 * is the multi-platform identity bag we're forensically reasoning over.
 */
async function loadCandidateSignals(
  sb: SupabaseClient,
  candidateIdentityId: string,
): Promise<SignalRow[]> {
  const { data, error } = await sb
    .from('tangential_signals')
    .select(
      'id, source_platform, signal_date, source_context, action_class, signal_class, candidate_identity_id',
    )
    .eq('candidate_identity_id', candidateIdentityId)
    .order('signal_date', { ascending: true })
  if (error) {
    console.warn('[classify] loadCandidateSignals failed:', error.message)
    return []
  }
  return (data ?? []) as SignalRow[]
}

/**
 * Pull pre-inquiry source-class touchpoints for THIS wedding so we can
 * see other-platform signals attached via wedding_touchpoints (some
 * funnel events arrive there directly without a tangential_signals row).
 */
async function loadWeddingTouchpoints(
  sb: SupabaseClient,
  weddingId: string,
): Promise<TouchpointRow[]> {
  const { data, error } = await sb
    .from('wedding_touchpoints')
    .select('id, source, occurred_at, touch_type, signal_class')
    .eq('wedding_id', weddingId)
    .order('occurred_at', { ascending: true })
  if (error) {
    console.warn('[classify] loadWeddingTouchpoints failed:', error.message)
    return []
  }
  return (data ?? []) as TouchpointRow[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Loose-equality compare for platform strings (handles "theknot" vs
 *  "the_knot" vs "theknot.com"). */
function platformsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/\.com$/, '')
      .replace(/[._-]/g, '')
  return norm(a) === norm(b)
}

function isValidationSuspiciousPlatform(p: string | null): boolean {
  if (!p) return false
  const norm = p.toLowerCase()
  if (VALIDATION_SUSPICIOUS_PLATFORMS.has(norm)) return true
  // Also catch domain variants by trimming .com.
  const trimmed = norm.replace(/\.com$/, '')
  return VALIDATION_SUSPICIOUS_PLATFORMS.has(trimmed)
}

interface SplitSignals {
  same_platform_signals: EngagementSignal[]
  other_platform_signals: EngagementSignal[]
}

function splitPreInquirySignals(
  signals: SignalRow[],
  touchpoints: TouchpointRow[],
  inquiryAt: number,
  windowStart: number,
  attributionPlatform: string | null,
  attributionEventSignalId: string | null,
): SplitSignals {
  const same: EngagementSignal[] = []
  const other: EngagementSignal[] = []

  for (const s of signals) {
    if (!s.signal_date) continue
    const t = Date.parse(s.signal_date)
    if (!Number.isFinite(t)) continue
    if (t >= inquiryAt) continue // only pre-inquiry
    if (t < windowStart) continue // only within window
    // Skip the SIGNAL that the attribution_event itself points at — we
    // don't want to count "this very touchpoint is engagement on its
    // own platform" as evidence FOR itself.
    if (attributionEventSignalId && s.id === attributionEventSignalId) continue

    const sig: EngagementSignal = {
      occurred_at: s.signal_date,
      platform: s.source_platform ?? 'unknown',
      description: [s.action_class, s.source_context].filter(Boolean).join(' · ') || 'tangential signal',
    }
    if (platformsMatch(s.source_platform, attributionPlatform)) {
      same.push(sig)
    } else {
      other.push(sig)
    }
  }

  // Wedding touchpoints (signal_class='source' only — exclude
  // scheduling/conversion noise here; the conversion fast-path handles
  // those touch_types separately).
  for (const tp of touchpoints) {
    if (!tp.occurred_at) continue
    const t = Date.parse(tp.occurred_at)
    if (!Number.isFinite(t)) continue
    if (t >= inquiryAt) continue
    if (t < windowStart) continue
    if (tp.signal_class !== 'source') continue
    if (CONVERSION_TOUCH_TYPES.has(tp.touch_type ?? '')) continue

    const sig: EngagementSignal = {
      occurred_at: tp.occurred_at,
      platform: tp.source ?? 'unknown',
      description: [tp.touch_type, tp.signal_class].filter(Boolean).join(' · ') || 'wedding touchpoint',
    }
    if (platformsMatch(tp.source, attributionPlatform)) {
      same.push(sig)
    } else {
      other.push(sig)
    }
  }

  return { same_platform_signals: same, other_platform_signals: other }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  /** Override Supabase client (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
  /** Disable LLM judge for ambiguous cases — return mixed instead.
   *  Useful when running mass backfill in cost-contained mode. */
  noLLM?: boolean
}

export interface ClassifyInput {
  attributionEventId: string
}

/**
 * Classify a single attribution event. One row in → one role decision
 * out. Idempotent on unchanged data.
 *
 * Throws on:
 *   - attribution event not found
 *   - LLM call required by mixed-path AND callAI fails (tier=sonnet)
 *
 * Does NOT write to the DB. The caller (sweep / single-classify
 * endpoint / bulk-reclass service) handles the UPDATE so this function
 * stays pure.
 */
export async function classifyAttributionEvent(
  input: ClassifyInput,
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const sb = options.supabase ?? createServiceClient()
  const event = await loadAttributionEvent(sb, input.attributionEventId)
  if (!event) {
    throw new Error(`classify: attribution_event ${input.attributionEventId} not found`)
  }

  // Conversion fast-path on signal_class. signal_class='outcome' rows
  // are conversions by definition (the schema reserves outcome for
  // contract_signed / etc.). Note: signal_class='source' rows can still
  // be conversions when their underlying touch_type is a closing event.
  if (event.signal_class === 'outcome') {
    return {
      role: 'conversion',
      role_confidence_0_100: 100,
      reasoning: 'attribution_event signal_class=outcome — closing-step event by definition',
      evidence: {
        platform_engagement_dates: [],
        missing_signals: [],
        forensic_path: 'conversion_touch_type',
        same_platform_signals: [],
        other_platform_signals: [],
        llm_judge: null,
      },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  const wedding = await loadWedding(sb, event.wedding_id)
  // Without an inquiry_date we can't anchor the pre/post window. Fall
  // back to attribution_event.decided_at (the moment we attributed it)
  // as a pragmatic substitute — if the touchpoint was created post-
  // wedding-creation we still have a 30-day window before that decision
  // to inspect.
  const inquiryIsoSrc =
    wedding?.inquiry_date ??
    event.decided_at // pragmatic fallback
  const inquiryAt = Date.parse(inquiryIsoSrc)
  if (!Number.isFinite(inquiryAt)) {
    return {
      role: 'unknown',
      role_confidence_0_100: 0,
      reasoning: 'wedding inquiry_date missing or unparseable; cannot anchor pre/post window',
      evidence: {
        platform_engagement_dates: [],
        missing_signals: ['wedding_inquiry_date'],
        forensic_path: 'mixed_deferred_to_llm',
        same_platform_signals: [],
        other_platform_signals: [],
        llm_judge: null,
      },
      cost_cents: 0,
      prompt_version: null,
    }
  }
  const windowStart = inquiryAt - PRE_INQUIRY_WINDOW_MS

  // Find the underlying signal — when the attribution_event points at
  // a tangential_signal whose action_class indicates a closing event,
  // we treat it as conversion. Otherwise we pull the candidate cluster.
  let candidateSignals: SignalRow[] = []
  if (event.candidate_identity_id) {
    candidateSignals = await loadCandidateSignals(sb, event.candidate_identity_id)
  }
  const touchpoints = await loadWeddingTouchpoints(sb, event.wedding_id)

  // Conversion fast-path on the underlying signal's action_class. Inquiry
  // submissions / contract events show up as action_class='inquiry' or
  // 'contract' or similar. Be defensive: many real signals don't carry
  // a structured action_class at all (Rixey's the_knot signals are
  // action_class='message'/'view'/etc.).
  const sourceSignal = event.signal_id
    ? candidateSignals.find((s) => s.id === event.signal_id)
    : null
  const sourceAction = (sourceSignal?.action_class ?? '').toLowerCase()
  if (
    sourceAction === 'inquiry' ||
    sourceAction === 'contract' ||
    sourceAction === 'tour_booked' ||
    sourceAction === 'contract_signed'
  ) {
    return {
      role: 'conversion',
      role_confidence_0_100: 95,
      reasoning: `underlying signal action_class='${sourceAction}' — closing-step event`,
      evidence: {
        platform_engagement_dates: [],
        missing_signals: [],
        forensic_path: 'conversion_touch_type',
        same_platform_signals: [],
        other_platform_signals: [],
        llm_judge: null,
      },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // Find an inquiry touchpoint matching this attribution platform
  // within ±1 day of inquiry — that's a strong "this attribution
  // event IS the inquiry" hint → conversion.
  const inquiryTouchpoint = touchpoints.find(
    (tp) =>
      tp.touch_type === 'inquiry' &&
      tp.occurred_at &&
      Math.abs(Date.parse(tp.occurred_at) - inquiryAt) < 24 * 60 * 60 * 1000 &&
      platformsMatch(tp.source, event.source_platform),
  )
  if (inquiryTouchpoint) {
    // It's a conversion only if THIS attribution_event corresponds to the
    // inquiry submission moment itself (decided_at within 1 day of
    // inquiry AND the underlying signal is the form-fill).
    const decidedAt = Date.parse(event.decided_at)
    if (
      Number.isFinite(decidedAt) &&
      Math.abs(decidedAt - inquiryAt) < 24 * 60 * 60 * 1000 &&
      Math.abs(Date.parse(sourceSignal?.signal_date ?? '0') - inquiryAt) < 24 * 60 * 60 * 1000
    ) {
      return {
        role: 'conversion',
        role_confidence_0_100: 90,
        reasoning: 'attribution_event is the inquiry submission moment itself',
        evidence: {
          platform_engagement_dates: [],
          missing_signals: [],
          forensic_path: 'conversion_touch_type',
          same_platform_signals: [],
          other_platform_signals: [],
          llm_judge: null,
        },
        cost_cents: 0,
        prompt_version: null,
      }
    }
  }

  // Forensic check: split pre-inquiry signals into same vs other platform.
  const split = splitPreInquirySignals(
    candidateSignals,
    touchpoints,
    inquiryAt,
    windowStart,
    event.source_platform,
    event.signal_id,
  )

  const platformDates = split.same_platform_signals.map((s) => s.occurred_at)

  // RULE 1: same-platform pre-inquiry signal → acquisition (high confidence).
  if (split.same_platform_signals.length > 0) {
    return {
      role: 'acquisition',
      role_confidence_0_100: 95,
      reasoning:
        `${split.same_platform_signals.length} pre-inquiry engagement signal(s) on ` +
        `${event.source_platform ?? 'this platform'} within the 30-day window — ` +
        `the channel actually sourced the couple.`,
      evidence: {
        platform_engagement_dates: platformDates,
        missing_signals: [],
        forensic_path: 'acquisition_same_platform_signal',
        same_platform_signals: split.same_platform_signals,
        other_platform_signals: split.other_platform_signals,
        llm_judge: null,
      },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // RULE 2: same-platform absent + other-platform present → validation.
  if (split.other_platform_signals.length > 0) {
    return {
      role: 'validation',
      role_confidence_0_100: 90,
      reasoning:
        `No pre-inquiry engagement on ${event.source_platform ?? 'this platform'} ` +
        `but ${split.other_platform_signals.length} signal(s) on other platform(s) — ` +
        `couple discovered the venue elsewhere and used this channel as intake/validation.`,
      evidence: {
        platform_engagement_dates: [],
        missing_signals: [`pre_inquiry_${event.source_platform}_engagement`],
        forensic_path: 'validation_no_same_platform',
        same_platform_signals: [],
        other_platform_signals: split.other_platform_signals,
        llm_judge: null,
      },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // No signals on any platform pre-inquiry. Two paths:
  //   - validation-suspicious platform → defer to LLM (or mixed if noLLM)
  //   - everything else → acquisition by default (direct/organic)
  if (!isValidationSuspiciousPlatform(event.source_platform)) {
    return {
      role: 'acquisition',
      role_confidence_0_100: 70,
      reasoning:
        `No pre-inquiry engagement on any tracked platform; ` +
        `${event.source_platform ?? 'unknown'} is not a known intake/scheduling tool — ` +
        `treating as direct/organic acquisition by default.`,
      evidence: {
        platform_engagement_dates: [],
        missing_signals: [
          `pre_inquiry_${event.source_platform}_engagement`,
          'pre_inquiry_other_platform_engagement',
        ],
        forensic_path: 'acquisition_direct_default',
        same_platform_signals: [],
        other_platform_signals: [],
        llm_judge: null,
      },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // Validation-suspicious platform (Knot/WW/HoneyBook/Calendly) with
  // NO same-platform AND NO other-platform pre-inquiry trail. The forensic
  // rule is ambiguous: it might be a real Knot acquisition with no
  // engagement event captured, OR a validation channel where the real
  // acquisition signal was simply not tracked. Defer to LLM judge.
  if (options.noLLM) {
    return {
      role: 'mixed',
      role_confidence_0_100: 40,
      reasoning:
        'No pre-inquiry engagement on this platform OR any other platform; ' +
        'this is a validation-suspicious platform — coordinator review.',
      evidence: {
        platform_engagement_dates: [],
        missing_signals: ['pre_inquiry_any_platform_engagement'],
        forensic_path: 'mixed_deferred_to_llm',
        same_platform_signals: [],
        other_platform_signals: [],
        llm_judge: null,
      },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // ---- LLM judge ----
  const evidence: TouchpointEventEvidence = {
    attribution_event_id: event.id,
    source_platform: event.source_platform ?? 'unknown',
    decided_at: event.decided_at,
    inquiry_date: wedding?.inquiry_date ?? null,
    same_platform_pre_inquiry_signals: [],
    other_platform_pre_inquiry_signals: [],
    touch_type: sourceSignal?.action_class ?? null,
    signal_class: event.signal_class,
    wedding_source_legacy: wedding?.source ?? null,
  }
  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(evidence)

  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'channel_role_classifier',
    contentTier: 2,
    promptVersion: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
    venueId: event.venue_id,
    maxTokens: 800,
    temperature: 0.2,
    correlationId: options.correlationId,
  })

  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    // LLM returned non-JSON. Fall back to mixed rather than throw —
    // the caller's drift sweep can retry; classification quality
    // matters less than pipeline stability here.
    return {
      role: 'mixed',
      role_confidence_0_100: 0,
      reasoning: `LLM judge returned non-JSON; deferred to coordinator review. parseError=${message}`,
      evidence: {
        platform_engagement_dates: [],
        missing_signals: ['llm_judge_non_json'],
        forensic_path: 'mixed_deferred_to_llm',
        same_platform_signals: [],
        other_platform_signals: [],
        llm_judge: {
          key_evidence_signals: [],
          refusal: `non_json_response: ${cleaned.slice(0, 200)}`,
          prompt_version: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
        },
      },
      cost_cents: aiResult.cost * 100,
      prompt_version: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
    }
  }
  const validation = validateChannelRoleOutput(parsed)
  if (!validation.ok) {
    return {
      role: 'mixed',
      role_confidence_0_100: 0,
      reasoning: `LLM judge schema invalid; deferred to coordinator review. error=${validation.error}`,
      evidence: {
        platform_engagement_dates: [],
        missing_signals: ['llm_judge_schema_invalid'],
        forensic_path: 'mixed_deferred_to_llm',
        same_platform_signals: [],
        other_platform_signals: [],
        llm_judge: {
          key_evidence_signals: [],
          refusal: `schema_invalid: ${validation.error}`,
          prompt_version: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
        },
      },
      cost_cents: aiResult.cost * 100,
      prompt_version: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
    }
  }

  const out: ChannelRoleClassifierOutput = validation.output
  const finalRole: ClassifyResult['role'] =
    out.role === null ? 'mixed' : (out.role as ClassifyResult['role'])

  return {
    role: finalRole,
    role_confidence_0_100: out.confidence_0_100,
    reasoning: out.reasoning,
    evidence: {
      platform_engagement_dates: [],
      missing_signals:
        finalRole === 'validation' ? [`pre_inquiry_${event.source_platform}_engagement`] : [],
      forensic_path: 'mixed_deferred_to_llm',
      same_platform_signals: [],
      other_platform_signals: [],
      llm_judge: {
        key_evidence_signals: out.key_evidence_signals,
        refusal: out.refusal,
        prompt_version: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
      },
    },
    cost_cents: aiResult.cost * 100,
    prompt_version: CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION,
  }
}

// ---------------------------------------------------------------------------
// Persistence — writes the classification result onto the
// attribution_events row. Pure-classify is exposed separately for
// callers that just want the decision (e.g., dry-run / preview).
// ---------------------------------------------------------------------------

export async function classifyAndPersistAttributionEvent(
  input: ClassifyInput,
  options: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const sb = options.supabase ?? createServiceClient()
  const result = await classifyAttributionEvent(input, { ...options, supabase: sb })

  // Wave 22: stamp prompt_version_classified_under so the reclassify
  // sweep can find rows that ran under bias-suspect v1 prompts. Only
  // set when an LLM judge actually fired; forensic-rule-only paths
  // leave the column NULL.
  const updatePayload: Record<string, unknown> = {
    role: result.role,
    role_confidence_0_100: result.role_confidence_0_100,
    role_classified_at: new Date().toISOString(),
    role_reasoning: result.reasoning.slice(0, 4000),
    role_evidence: result.evidence,
  }
  if (result.prompt_version) {
    updatePayload.prompt_version_classified_under = result.prompt_version
  }

  const { error } = await sb
    .from('attribution_events')
    .update(updatePayload)
    .eq('id', input.attributionEventId)
  if (error) {
    throw new Error(
      `classifyAndPersistAttributionEvent: update failed for ${input.attributionEventId}: ${error.message}`,
    )
  }

  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}
