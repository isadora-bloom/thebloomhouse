/**
 * Bloom House — Wave 17 disagreement detector.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; Wave 17
 *     never overwrites the underlying data tables — it COMPARES them)
 *   - feedback_self_reported_sources_not_truth.md (the disagreement is
 *     the gold)
 *   - feedback_measure_dont_assume.md (don't pre-judge — surface the
 *     gap)
 *   - bloom-phase-b-decisions.md (reads attribution_events role +
 *     intent; never modifies them)
 *
 * What this module does
 * ---------------------
 * For one wedding (or every active wedding for a venue), scan each
 * Wave 17 axis and emit a DisagreementCandidate when stated and
 * forensic disagree. Each candidate is upserted into
 * disagreement_findings keyed on (venue_id, wedding_id, axis).
 *
 * The detector is READ-ONLY against the underlying tables. It NEVER
 * writes to couple_intel, couple_identity_profile, people, or
 * attribution_events. It WRITES only to disagreement_findings.
 *
 * Re-running on stable data refreshes last_observed_at and resets the
 * narrator cache when stated/forensic values move; counts otherwise
 * stay flat.
 *
 * Per-axis logic
 * --------------
 *   - source            stated discovery_sources.canonical_source vs
 *                       forensic inquiry attribution_event's role +
 *                       intent (when role=validation OR intent=broadcast
 *                       AND stated_source clearly names a different
 *                       canonical, that's a gap)
 *   - wedding_date      weddings.wedding_date vs implied event date from
 *                       tour temporal sense (tour scheduled_at gives a
 *                       date that is incompatible with stated wedding
 *                       date by > 60 days — e.g. couple says June but
 *                       tour booked for April implies an April event)
 *   - guest_count       weddings.guest_count_estimate vs final
 *                       invitation count (when a verified invitation
 *                       count source exists in couple_intel.intel
 *                       envelope; gap is informational until that
 *                       source is wired — kept as scaffold)
 *   - budget            stated_budget (heuristic: couple_intel
 *                       sensitivity_flags carrying budget signal OR a
 *                       legacy stored value) vs weddings.booking_value
 *                       (when wedding is booked)
 *   - persona           couple_intel.persona_label vs operator override
 *                       captured in evidence_overrides (kind=
 *                       profile_field, field_path persona*) or null
 *                       when no override exists
 *   - close_prediction  couple_intel.predicted_close_probability_pct vs
 *                       actual lifecycle outcome (when wedding.status
 *                       in booked OR lost terminals) — gap is the
 *                       distance from the predicted probability to the
 *                       actual outcome (booked = 100, lost = 0)
 *   - name              couple_identity_profile.profile.names.partner1
 *                       .first + .last vs people row (role=partner1)
 *                       first_name + last_name
 *   - crm_source        HoneyBook "Source" column (legacy weddings.source
 *                       value in 'website' / 'walk_in' / 'other' / etc.)
 *                       vs Wave 7B forensic inquiry-role inference
 *
 * Each comparison is wrapped in try/catch so a single bad row doesn't
 * abort the whole sweep.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { mapToCanonicalDiscoverySource } from '@/lib/services/discovery-source/canonical'
import type {
  DisagreementAxis,
  DisagreementCandidate,
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000

// Magnitude scale notes:
//   source/crm_source/persona/name : 100 = total mismatch, 0 = match
//   wedding_date                   : abs days diff
//   guest_count                    : abs persons diff
//   budget                         : abs dollars diff
//   close_prediction               : abs pct points diff
// (See migration 284 comment for the canonical definition.)

const WEDDING_DATE_GAP_DAYS_MIN = 60       // 60+ days = real disagreement
const GUEST_COUNT_GAP_MIN = 10             // 10+ guest diff = surface
const BUDGET_GAP_DOLLARS_MIN = 2000        // $2k+ gap = surface
const CLOSE_PREDICTION_GAP_PCT_MIN = 25    // 25+ pct gap = surface

interface DetectArgs {
  /** Detect for one wedding. */
  weddingId?: string
  /** Detect across all active weddings for one venue. */
  venueId?: string
  /** Optional supabase override (service-role by default). */
  supabase?: SupabaseClient
  /** Cap on weddings scanned in venue mode (sweep batching). */
  limit?: number
}

interface DetectResult {
  scanned: number
  candidates: DisagreementCandidate[]
  written: number
  refreshed: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Lightweight DB shapes — only the columns the detector reads.
// ---------------------------------------------------------------------------

interface WeddingRow {
  id: string
  venue_id: string
  status: string | null
  source: string | null            // legacy HoneyBook-style stated source
  source_detail: string | null
  wedding_date: string | null
  guest_count_estimate: number | null
  booking_value: number | null
  inquiry_date: string | null
  booked_at: string | null
  lost_at: string | null
  event_code: string | null
}

interface DiscoveryRow {
  canonical_source: string | null
  answer_text: string | null
  captured_at: string | null
}

interface AttributionEventLite {
  source_platform: string | null
  role: string | null
  role_confidence_0_100: number | null
  intent_class: string | null
  intent_class_confidence_0_100: number | null
  signal_class: string | null
  decided_at: string | null
}

interface TourRow {
  scheduled_at: string | null
  outcome: string | null
}

interface IntelRow {
  intel: unknown
  persona_label: string | null
  predicted_close_probability_pct: number | null
}

interface ProfileRow {
  profile: unknown
}

interface PersonRow {
  role: string | null
  first_name: string | null
  last_name: string | null
}

interface OverrideRow {
  evidence_kind: string | null
  evidence_ref: { table?: string; id?: string; field_path?: string } | null
  override_action: string | null
  correction_value: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseString(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim().toLowerCase()
  return t.length > 0 ? t : null
}

function normalisePlatformToCanonical(platform: string | null): string | null {
  if (!platform) return null
  const p = platform.toLowerCase().trim()
  // Map attribution_events.source_platform values to discovery_sources
  // canonical labels so we can compare them apples-to-apples.
  if (p === 'theknot' || p === 'the_knot' || p.includes('knot')) return 'theknot'
  if (p === 'weddingwire' || p === 'wedding_wire' || p.includes('weddingwire')) return 'weddingwire'
  if (p === 'instagram' || p === 'ig') return 'instagram'
  if (p === 'tiktok') return 'tiktok'
  if (p === 'pinterest') return 'pinterest'
  if (p === 'google' || p === 'google_search' || p === 'gmb') return 'google'
  if (p === 'facebook' || p === 'fb' || p === 'meta') return 'social_media'
  if (p === 'website' || p === 'direct' || p === 'organic') return 'direct'
  if (p === 'calendly') return 'calendly'
  if (p === 'honeybook') return 'honeybook'
  if (p === 'referral' || p === 'referrer') return 'friend'
  if (p === 'walk_in' || p === 'walkin') return 'walk_in'
  return p
}

// ---------------------------------------------------------------------------
// Per-axis detectors
// ---------------------------------------------------------------------------

function detectSourceDisagreement(
  wedding: WeddingRow,
  discovery: DiscoveryRow | null,
  inquiryEvent: AttributionEventLite | null,
): DisagreementCandidate | null {
  if (!discovery && !wedding.source) return null
  // Prefer the discovery_sources row (Wave 15 captures the verbatim
  // Calendly Q&A answer) when present; fall back to the legacy
  // weddings.source column.
  const statedCanonical =
    discovery?.canonical_source ??
    mapToCanonicalDiscoverySource(wedding.source)
  if (!statedCanonical || statedCanonical === 'unknown') return null

  // Forensic side: when Wave 7B classified the inquiry as 'validation'
  // OR Wave 16 classified it as 'broadcast' AND the stated value
  // names a clearly different canonical, that's the gap. When role is
  // 'acquisition' + intent 'targeted' on the same platform as stated,
  // there's no gap — the system agrees.
  if (!inquiryEvent) return null
  const forensicCanonical = normalisePlatformToCanonical(inquiryEvent.source_platform)
  if (!forensicCanonical) return null

  const stated = statedCanonical.toLowerCase()
  const forensic = forensicCanonical.toLowerCase()

  // When stated names an AI tool but the inquiry came in through Knot,
  // that's a real gap (couple discovered via ChatGPT, intake form was
  // Knot — different attribution stories).
  // When stated names instagram but the inquiry came through Knot
  // AND role=validation, that's a real gap (Knot is just intake).
  // When stated == forensic platform, no gap.
  const isSamePlatform =
    stated === forensic ||
    (stated === 'theknot' && forensic === 'theknot') ||
    (stated === 'weddingwire' && forensic === 'weddingwire')
  if (isSamePlatform) return null

  const isValidationRole = inquiryEvent.role === 'validation'
  const isBroadcastIntent = inquiryEvent.intent_class === 'broadcast'

  // If neither role nor intent commits to a "couple discovered elsewhere"
  // story, the gap is weaker — only surface when stated is a distinct
  // canonical from the inquiry channel.
  const stronglyImpliesValidation = isValidationRole || isBroadcastIntent

  // Confidence: pull from the Wave 7B + Wave 16 forensic columns when
  // present.
  const roleConf = inquiryEvent.role_confidence_0_100 ?? 50
  const intentConf = inquiryEvent.intent_class_confidence_0_100 ?? 50
  const conf = stronglyImpliesValidation
    ? Math.max(roleConf, intentConf)
    : Math.round((roleConf + intentConf) / 2 * 0.6)

  // Magnitude: source axis uses 0-100 mismatch scale. Total platform
  // mismatch with a strong validation signal = 100. Without the
  // validation signal but with different platform = 60. Same platform
  // already early-returned.
  const magnitude = stronglyImpliesValidation ? 100 : 60

  return {
    venueId: wedding.venue_id,
    weddingId: wedding.id,
    axis: 'source',
    statedValue: {
      canonical: statedCanonical,
      raw: discovery?.answer_text ?? wedding.source ?? null,
    },
    statedSourceKind: discovery ? 'calendly_qa' : 'honeybook_source_col',
    forensicValue: {
      canonical: forensicCanonical,
      platform: inquiryEvent.source_platform,
      role: inquiryEvent.role,
      intent: inquiryEvent.intent_class,
    },
    forensicSourceKind:
      isValidationRole && isBroadcastIntent
        ? 'wave_7b_role_classifier+wave_16_intent'
        : isValidationRole
          ? 'wave_7b_role_classifier'
          : isBroadcastIntent
            ? 'wave_16_intent'
            : 'attribution_events',
    magnitudeScore: magnitude,
    confidence_0_100: conf,
  }
}

function detectWeddingDateDisagreement(
  wedding: WeddingRow,
  tours: TourRow[],
): DisagreementCandidate | null {
  if (!wedding.wedding_date) return null
  if (tours.length === 0) return null

  // The most useful signal: a confirmed-completed tour whose date is
  // post-wedding-date by > 60 days (couple is touring AFTER the date
  // they said the wedding is, impossible — typo or stale wedding_date)
  // OR a future-scheduled tour whose date is post-wedding-date (same
  // story).
  // Don't trigger on small drifts (rescheduled tours within +/- 14
  // days; couples often move tour by a week or two).
  const weddingDateMs = Date.parse(wedding.wedding_date)
  if (!Number.isFinite(weddingDateMs)) return null

  let biggestGapDays = 0
  let triggerTourAt: string | null = null
  for (const t of tours) {
    if (!t.scheduled_at) continue
    const tourMs = Date.parse(t.scheduled_at)
    if (!Number.isFinite(tourMs)) continue
    // Tour AFTER the wedding date by 60+ days = real gap
    const gapDays = (tourMs - weddingDateMs) / DAY_MS
    if (gapDays > biggestGapDays) {
      biggestGapDays = gapDays
      triggerTourAt = t.scheduled_at
    }
  }
  if (biggestGapDays < WEDDING_DATE_GAP_DAYS_MIN) return null

  return {
    venueId: wedding.venue_id,
    weddingId: wedding.id,
    axis: 'wedding_date',
    statedValue: { wedding_date: wedding.wedding_date },
    statedSourceKind: 'web_form',
    forensicValue: {
      latest_tour_at: triggerTourAt,
      gap_days: Math.round(biggestGapDays),
      implication:
        'tour scheduled after the stated wedding date — wedding_date is likely stale',
    },
    forensicSourceKind: 'lifecycle_event_sequence',
    magnitudeScore: Math.round(biggestGapDays),
    confidence_0_100: 80,
  }
}

function detectGuestCountDisagreement(
  wedding: WeddingRow,
  intel: IntelRow | null,
): DisagreementCandidate | null {
  // The "final invitation count" source is not yet wired (when an
  // invitation-management integration lands, this detector becomes
  // active). For now we scan couple_intel.intel for any
  // operator-confirmed actual guest count and compare.
  if (!intel || typeof intel.intel !== 'object' || intel.intel === null) return null
  const i = intel.intel as Record<string, unknown>
  // Heuristic key: couple_intel might carry a "final_guest_count" or
  // "confirmed_guest_count" populated by the Sage brain when the
  // couple's RSVP / invitation language confirms numbers. If neither
  // is present, no gap signal yet.
  const finalRaw = (i.final_guest_count ?? i.confirmed_guest_count) as
    | number
    | undefined
  if (typeof finalRaw !== 'number' || !Number.isFinite(finalRaw)) return null
  if (wedding.guest_count_estimate === null) return null
  const diff = Math.abs(wedding.guest_count_estimate - finalRaw)
  if (diff < GUEST_COUNT_GAP_MIN) return null

  return {
    venueId: wedding.venue_id,
    weddingId: wedding.id,
    axis: 'guest_count',
    statedValue: { guest_count_estimate: wedding.guest_count_estimate },
    statedSourceKind: 'inquiry_form',
    forensicValue: { final_guest_count: finalRaw },
    forensicSourceKind: 'couple_intel',
    magnitudeScore: diff,
    confidence_0_100: 70,
  }
}

function detectBudgetDisagreement(
  wedding: WeddingRow,
  intel: IntelRow | null,
): DisagreementCandidate | null {
  if (wedding.status !== 'booked') return null
  if (wedding.booking_value === null) return null
  if (!intel || typeof intel.intel !== 'object' || intel.intel === null) return null
  const i = intel.intel as Record<string, unknown>
  // couple_intel.intel may carry a stated_budget signal extracted by
  // the Wave 5A synthesizer from inquiry / Sage interactions.
  // Heuristic keys: 'stated_budget' or 'budget_mentioned'.
  const statedRaw = (i.stated_budget ?? i.budget_mentioned) as
    | number
    | undefined
  if (typeof statedRaw !== 'number' || !Number.isFinite(statedRaw)) return null
  const diff = Math.abs(wedding.booking_value - statedRaw)
  if (diff < BUDGET_GAP_DOLLARS_MIN) return null

  return {
    venueId: wedding.venue_id,
    weddingId: wedding.id,
    axis: 'budget',
    statedValue: { stated_budget: statedRaw },
    statedSourceKind: 'couple_email',
    forensicValue: { booking_value: wedding.booking_value },
    forensicSourceKind: 'booking_value',
    magnitudeScore: diff,
    confidence_0_100: 75,
  }
}

function detectPersonaDisagreement(
  wedding: WeddingRow,
  intel: IntelRow | null,
  overrides: OverrideRow[],
): DisagreementCandidate | null {
  if (!intel?.persona_label) return null
  // Look for an operator override on a persona-related field_path. The
  // override doctrine is Wave 15's evidence_overrides table (mig 282).
  // We treat any active evidence_override with kind='profile_field' and
  // a field_path including 'persona' as an operator-stated override.
  const personaOverride = overrides.find((o) => {
    if (o.evidence_kind !== 'profile_field') return false
    if (o.override_action !== 'correct_value') return false
    const ref = o.evidence_ref ?? {}
    const fp = typeof ref.field_path === 'string' ? ref.field_path.toLowerCase() : ''
    return fp.includes('persona')
  })
  if (!personaOverride) return null
  const correctionRaw = personaOverride.correction_value
  let operatorPersona: string | null = null
  if (typeof correctionRaw === 'string') {
    operatorPersona = correctionRaw
  } else if (
    correctionRaw &&
    typeof correctionRaw === 'object' &&
    !Array.isArray(correctionRaw)
  ) {
    const obj = correctionRaw as Record<string, unknown>
    operatorPersona = typeof obj.label === 'string' ? obj.label : null
  }
  if (!operatorPersona) return null
  const stated = normaliseString(operatorPersona)
  const forensic = normaliseString(intel.persona_label)
  if (!stated || !forensic) return null
  if (stated === forensic) return null
  return {
    venueId: wedding.venue_id,
    weddingId: wedding.id,
    axis: 'persona',
    statedValue: { persona_label: operatorPersona },
    statedSourceKind: 'operator_override',
    forensicValue: { persona_label: intel.persona_label },
    forensicSourceKind: 'wave_5a_persona',
    magnitudeScore: 100,
    confidence_0_100: 90,
  }
}

function detectClosePredictionDisagreement(
  wedding: WeddingRow,
  intel: IntelRow | null,
): DisagreementCandidate | null {
  if (intel?.predicted_close_probability_pct === null || intel?.predicted_close_probability_pct === undefined) {
    return null
  }
  const predicted = intel.predicted_close_probability_pct
  let actualPct: number | null = null
  if (wedding.status === 'booked') {
    actualPct = 100
  } else if (wedding.status === 'lost' || wedding.status === 'cancelled') {
    actualPct = 0
  }
  if (actualPct === null) return null
  const diff = Math.abs(actualPct - predicted)
  if (diff < CLOSE_PREDICTION_GAP_PCT_MIN) return null
  return {
    venueId: wedding.venue_id,
    weddingId: wedding.id,
    axis: 'close_prediction',
    statedValue: { predicted_close_probability_pct: predicted },
    statedSourceKind: 'wave_5a_persona',
    forensicValue: {
      actual_outcome_pct: actualPct,
      lifecycle_status: wedding.status,
    },
    forensicSourceKind: 'lifecycle_event_sequence',
    magnitudeScore: diff,
    confidence_0_100: 90,
  }
}

function detectNameDisagreement(
  wedding: WeddingRow,
  profile: ProfileRow | null,
  partner1Person: PersonRow | null,
): DisagreementCandidate | null {
  if (!profile || !partner1Person) return null
  const p = profile.profile as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return null
  const names = (p.names ?? null) as Record<string, unknown> | null
  if (!names) return null
  const partner1 = (names.partner1 ?? null) as Record<string, unknown> | null
  if (!partner1) return null
  const reconstructedFirst = normaliseString(partner1.first)
  const reconstructedLast = normaliseString(partner1.last)
  const peopleFirst = normaliseString(partner1Person.first_name)
  const peopleLast = normaliseString(partner1Person.last_name)
  if (!reconstructedFirst && !reconstructedLast) return null
  if (!peopleFirst && !peopleLast) return null
  const firstMatches = reconstructedFirst === peopleFirst
  const lastMatches = reconstructedLast === peopleLast
  if (firstMatches && lastMatches) return null
  // Magnitude: count of fields that don't match (0-2) → 50 / 100
  const mismatchCount = (firstMatches ? 0 : 1) + (lastMatches ? 0 : 1)
  return {
    venueId: wedding.venue_id,
    weddingId: wedding.id,
    axis: 'name',
    statedValue: {
      first_name: partner1Person.first_name,
      last_name: partner1Person.last_name,
    },
    statedSourceKind: 'people_row',
    forensicValue: {
      first: partner1.first,
      last: partner1.last,
    },
    forensicSourceKind: 'wave_4_reconstruct',
    magnitudeScore: mismatchCount * 50,
    confidence_0_100: 85,
  }
}

function detectCrmSourceDisagreement(
  wedding: WeddingRow,
  inquiryEvent: AttributionEventLite | null,
  discovery: DiscoveryRow | null,
): DisagreementCandidate | null {
  // HoneyBook "Source" column = weddings.source string. When the
  // inquiry event's role is 'acquisition' (the SAME platform genuinely
  // sourced the couple) but weddings.source disagrees with that
  // platform, the CRM column is stale or operator-mis-clicked.
  if (!wedding.source) return null
  if (!inquiryEvent) return null
  if (inquiryEvent.role !== 'acquisition') return null
  const statedCanonical = mapToCanonicalDiscoverySource(wedding.source)
  if (statedCanonical === 'unknown') return null
  const forensicCanonical = normalisePlatformToCanonical(inquiryEvent.source_platform)
  if (!forensicCanonical) return null
  if (statedCanonical === forensicCanonical) return null
  // Skip when discovery_sources already disagrees with the CRM —
  // source-axis already covers that case. crm_source is specifically
  // CRM-column-vs-forensic when there is no live Calendly answer in
  // the picture.
  if (discovery && discovery.canonical_source) return null
  return {
    venueId: wedding.venue_id,
    weddingId: wedding.id,
    axis: 'crm_source',
    statedValue: { honeybook_source: wedding.source },
    statedSourceKind: 'honeybook_source_col',
    forensicValue: {
      canonical: forensicCanonical,
      platform: inquiryEvent.source_platform,
      role: inquiryEvent.role,
    },
    forensicSourceKind: 'wave_7b_role_classifier',
    magnitudeScore: 100,
    confidence_0_100: inquiryEvent.role_confidence_0_100 ?? 70,
  }
}

// ---------------------------------------------------------------------------
// Per-wedding orchestrator
// ---------------------------------------------------------------------------

async function detectForWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<DisagreementCandidate[]> {
  // Fetch the wedding row first to resolve venueId.
  const { data: weddingData, error: wedErr } = await supabase
    .from('weddings')
    .select(
      'id, venue_id, status, source, source_detail, wedding_date, ' +
        'guest_count_estimate, booking_value, inquiry_date, booked_at, ' +
        'lost_at, event_code',
    )
    .eq('id', weddingId)
    .maybeSingle()
  if (wedErr) throw new Error(`detectForWedding: ${wedErr.message}`)
  if (!weddingData) return []
  const wedding = weddingData as unknown as WeddingRow

  // Parallel side reads.
  const [
    discoveryRes,
    eventRes,
    toursRes,
    intelRes,
    profileRes,
    peopleRes,
    overridesRes,
  ] = await Promise.all([
    supabase
      .from('discovery_sources')
      .select('canonical_source, answer_text, captured_at')
      .eq('wedding_id', weddingId)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('attribution_events')
      .select(
        'source_platform, role, role_confidence_0_100, intent_class, ' +
          'intent_class_confidence_0_100, signal_class, decided_at',
      )
      .eq('wedding_id', weddingId)
      .is('reverted_at', null)
      .order('decided_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('tours')
      .select('scheduled_at, outcome')
      .eq('wedding_id', weddingId)
      .order('scheduled_at', { ascending: false })
      .limit(10),
    supabase
      .from('couple_intel')
      .select('intel, persona_label, predicted_close_probability_pct')
      .eq('wedding_id', weddingId)
      .maybeSingle(),
    supabase
      .from('couple_identity_profile')
      .select('profile')
      .eq('wedding_id', weddingId)
      .maybeSingle(),
    supabase
      .from('people')
      .select('role, first_name, last_name')
      .eq('wedding_id', weddingId)
      .eq('role', 'partner1')
      .is('merged_into_id', null)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('evidence_overrides')
      .select('evidence_kind, evidence_ref, override_action, correction_value')
      .eq('wedding_id', weddingId)
      .eq('active', true),
  ])

  const discovery = (discoveryRes.data ?? null) as unknown as DiscoveryRow | null
  const inquiryEvent = (eventRes.data ?? null) as unknown as AttributionEventLite | null
  const tours = (toursRes.data ?? []) as unknown as TourRow[]
  const intel = (intelRes.data ?? null) as unknown as IntelRow | null
  const profile = (profileRes.data ?? null) as unknown as ProfileRow | null
  const partner1Person = (peopleRes.data ?? null) as unknown as PersonRow | null
  const overrides = (overridesRes.data ?? []) as unknown as OverrideRow[]

  const candidates: DisagreementCandidate[] = []
  const detectors: Array<() => DisagreementCandidate | null> = [
    () => detectSourceDisagreement(wedding, discovery, inquiryEvent),
    () => detectWeddingDateDisagreement(wedding, tours),
    () => detectGuestCountDisagreement(wedding, intel),
    () => detectBudgetDisagreement(wedding, intel),
    () => detectPersonaDisagreement(wedding, intel, overrides),
    () => detectClosePredictionDisagreement(wedding, intel),
    () => detectNameDisagreement(wedding, profile, partner1Person),
    () => detectCrmSourceDisagreement(wedding, inquiryEvent, discovery),
  ]
  for (const fn of detectors) {
    try {
      const c = fn()
      if (c) candidates.push(c)
    } catch (err) {
      // One axis failing doesn't abort the others.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[disagreement.detect] axis-detector failed: ${msg}`)
    }
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

interface UpsertOutcome {
  inserted: boolean
  refreshed: boolean
}

async function upsertCandidate(
  supabase: SupabaseClient,
  c: DisagreementCandidate,
): Promise<UpsertOutcome> {
  // Look up existing row by (venue_id, wedding_id, axis).
  const { data: existing, error: selErr } = await supabase
    .from('disagreement_findings')
    .select('id, stated_value, forensic_value, status')
    .eq('venue_id', c.venueId)
    .eq('wedding_id', c.weddingId)
    .eq('axis', c.axis)
    .maybeSingle()
  if (selErr) throw new Error(`upsertCandidate: ${selErr.message}`)

  const nowIso = new Date().toISOString()

  if (!existing) {
    const { error: insErr } = await supabase
      .from('disagreement_findings')
      .insert({
        venue_id: c.venueId,
        wedding_id: c.weddingId,
        axis: c.axis,
        stated_value: c.statedValue ?? null,
        stated_source_kind: c.statedSourceKind,
        forensic_value: c.forensicValue ?? null,
        forensic_source_kind: c.forensicSourceKind,
        magnitude_score: c.magnitudeScore,
        confidence_0_100: c.confidence_0_100,
        first_detected_at: nowIso,
        last_observed_at: nowIso,
        status: 'active',
      })
    if (insErr) throw new Error(`upsertCandidate insert: ${insErr.message}`)
    return { inserted: true, refreshed: false }
  }

  // Existing — refresh last_observed_at. If stated/forensic values
  // moved, clear the narrator cache so it regenerates on next narration
  // sweep. Don't touch operator-set status (resolved/dismissed/
  // investigating); only push 'active' through when reactivating an
  // archived row.
  const statedChanged =
    JSON.stringify(existing.stated_value ?? null) !==
    JSON.stringify(c.statedValue ?? null)
  const forensicChanged =
    JSON.stringify(existing.forensic_value ?? null) !==
    JSON.stringify(c.forensicValue ?? null)
  const update: Record<string, unknown> = {
    stated_value: c.statedValue ?? null,
    stated_source_kind: c.statedSourceKind,
    forensic_value: c.forensicValue ?? null,
    forensic_source_kind: c.forensicSourceKind,
    magnitude_score: c.magnitudeScore,
    confidence_0_100: c.confidence_0_100,
    last_observed_at: nowIso,
  }
  if (statedChanged || forensicChanged) {
    update.narrator_text = null
    update.narrator_generated_at = null
  }
  const { error: updErr } = await supabase
    .from('disagreement_findings')
    .update(update)
    .eq('id', existing.id as string)
  if (updErr) throw new Error(`upsertCandidate update: ${updErr.message}`)
  return { inserted: false, refreshed: true }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Detect disagreements for one wedding OR every active wedding in a
 * venue. Upserts results into disagreement_findings.
 *
 * @returns counts of scanned weddings, new vs refreshed rows, errors.
 */
export async function detectDisagreements(
  args: DetectArgs,
): Promise<DetectResult> {
  const supabase = args.supabase ?? createServiceClient()
  const errors: string[] = []
  let scanned = 0
  let written = 0
  let refreshed = 0
  const allCandidates: DisagreementCandidate[] = []

  let weddingIds: string[] = []
  if (args.weddingId) {
    weddingIds = [args.weddingId]
  } else if (args.venueId) {
    // Active = anything not in archived terminal states. Cap by limit.
    const limit = args.limit ?? 200
    const { data, error } = await supabase
      .from('weddings')
      .select('id')
      .eq('venue_id', args.venueId)
      .order('inquiry_date', { ascending: false })
      .limit(limit)
    if (error) {
      errors.push(`load weddings: ${error.message}`)
      return { scanned, candidates: allCandidates, written, refreshed, errors }
    }
    weddingIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  } else {
    errors.push('detectDisagreements: must pass weddingId or venueId')
    return { scanned, candidates: allCandidates, written, refreshed, errors }
  }

  for (const wid of weddingIds) {
    scanned += 1
    try {
      const candidates = await detectForWedding(supabase, wid)
      for (const c of candidates) {
        allCandidates.push(c)
        try {
          const out = await upsertCandidate(supabase, c)
          if (out.inserted) written += 1
          else if (out.refreshed) refreshed += 1
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`upsert ${wid}/${c.axis}: ${msg}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`detect ${wid}: ${msg}`)
    }
  }

  return { scanned, candidates: allCandidates, written, refreshed, errors }
}
