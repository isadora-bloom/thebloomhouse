/**
 * Bloom House — Wave 5C external-signal matching service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5C matches every external signal —
 *     cultural moments, vendor mentions in couple bodies, regional
 *     benchmarks, competitor mentions, cross-platform Knot/WeddingWire
 *     activity per Tenant 2 handles — against the venue's couple cohort
 *     and surfaces actionable matches with cohort-fit scoring)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5C spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
 *     evidence quotes never reach the cohort-level surface)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; Wave 5C is forensic-rule first
 *     with LLM scoring for ambiguous-fit cases)
 *
 * What this service does
 * ----------------------
 * Given a venueId (and optional weddingId), scans external signals and
 * matches them per-couple AND per-cohort:
 *
 *   1. Cultural moments — confirmed cultural_moments rows + venue's
 *      persona distribution from venue_intel; LLM scores each moment
 *      by cohort fit.
 *   2. Vendor mentions — when 3+ couples mention the same vendor in
 *      couple_identity_profile.vendor_preferences, surface as a
 *      vendor-relationship-opportunity. Forensic rule, no LLM.
 *   3. Regional benchmarks — compare venue's persona distribution vs a
 *      coarse market average (taken from cross-venue rollup when
 *      available). LLM scores the implication. Skips when no other
 *      venues exist in the system yet (single-tenant launch reality).
 *   4. Competitor mentions — scan couple_identity_profile +
 *      interactions for a small seeded competitor list. Forensic rule.
 *   5. Cross-platform handle activity — each couple_identity_profile.
 *      handles entry surfaces a "tenant 2 of identity reconstruction"
 *      match. Forensic rule (presence + freshness only).
 *
 * Different LLM job from Wave 4 / 5A / 5B
 * ---------------------------------------
 * Wave 4 = forensic extraction. 5A = per-couple synthesis. 5B = cohort
 * pattern synthesis. 5C = per-couple AND per-cohort SIGNAL matching
 * with cohort-fit scoring as the synthesis half. Most matches are
 * forensic; only cohort-fit scoring needs the LLM.
 *
 * Cost target ~$1/venue/day (typically 1-3 LLM calls per scan, each
 * Sonnet at Haiku-style scope; most signals are forensic-rule and
 * cost zero).
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import {
  EXTERNAL_MATCH_PROMPT_VERSION,
  buildExternalMatchSystemPrompt,
  buildExternalMatchUserPrompt,
  validateExternalMatchOutput,
  type ExternalMatchScoreOutput,
  type ExternalMatchEvidence,
  type ExternalSignalEvidence,
  type CohortPersonaEvidence,
  type CohortThemeEvidence,
} from '@/config/prompts/external-match'
import type {
  CoupleIdentityProfile,
  VendorPreferenceClaim,
  HandleClaim,
} from '@/config/prompts/identity-reconstruction'
import type { CohortRollupOutput } from '@/config/prompts/cohort-rollup'

// Re-export so callers don't have to import from two places.
export {
  EXTERNAL_MATCH_PROMPT_VERSION,
  type ExternalMatchScoreOutput,
} from '@/config/prompts/external-match'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IntelSignalType =
  | 'cultural_moment'
  | 'vendor_mention'
  | 'regional_benchmark'
  | 'competitor_mention'
  | 'cross_platform_handle'

export interface IntelMatchEvidenceQuote {
  quote: string
  source: string
  source_id?: string | null
  sensitive?: boolean
}

export interface IntelMatchCandidate {
  /** wedding_id when match attaches to a couple; null for cohort-level. */
  weddingId: string | null
  signalType: IntelSignalType
  signalPayload: Record<string, unknown>
  matchReasoning: string | null
  matchConfidence0to100: number
  cohortFitScore0to100: number | null
  evidenceQuotes: IntelMatchEvidenceQuote[]
}

export interface FindExternalMatchesResult {
  matches: IntelMatchCandidate[]
  costCents: number
  promptVersion: string
}

export interface FindExternalMatchesOptions {
  /** Optional client override (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** Trailing window for cohort considered. Default 90. */
  windowDays?: number
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
  /** Skip the LLM judge (forensic-only). Used in low-budget regimes. */
  skipLlm?: boolean
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 90
const VENDOR_MENTION_MIN_COUPLES = 3
const COMPETITOR_MENTION_MIN_COUPLES = 1
const HANDLE_FRESHNESS_DAYS = 30
const DEDUPE_WINDOW_DAYS = 30
const MAX_PROFILE_LOAD = 200

// Common competitor venue seed list. The platform owner may extend per-
// venue via the venue_config feature flag (future work). Starting list
// covers commonly-cited multi-venue / nationally-recognised names. We
// keep this deliberately small — false positives on a competitor match
// are worse than misses.
const SEED_COMPETITOR_NAMES: ReadonlyArray<string> = [
  'wedgewood',
  'oakwood',
  'rose hill',
  'crestwood',
  'hawthorne',
  'glass house',
  // common venue patterns the operator can refine on
  'manor',
]

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface ProfileRow {
  wedding_id: string
  venue_id: string
  profile: CoupleIdentityProfile
  last_reconstructed_at: string
  last_signal_at: string | null
}

interface VenueRow {
  id: string
  name: string | null
  state: string | null
}

interface VenueIntelRow {
  venue_id: string
  rollup: CohortRollupOutput
  source_window_days: number
  couples_in_window: number
}

async function loadVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueRow | null> {
  const { data } = await supabase
    .from('venues')
    .select('id, name, state')
    .eq('id', venueId)
    .maybeSingle()
  return (data as VenueRow | null) ?? null
}

async function loadVenueIntel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueIntelRow | null> {
  const { data } = await supabase
    .from('venue_intel')
    .select('venue_id, rollup, source_window_days, couples_in_window')
    .eq('venue_id', venueId)
    .maybeSingle()
  return (data as VenueIntelRow | null) ?? null
}

async function loadProfilesForVenue(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
  weddingIdFilter: string | null,
): Promise<ProfileRow[]> {
  let query = supabase
    .from('couple_identity_profile')
    .select('wedding_id, venue_id, profile, last_reconstructed_at, last_signal_at')
    .eq('venue_id', venueId)
    .order('last_reconstructed_at', { ascending: false })
    .limit(MAX_PROFILE_LOAD)
  if (weddingIdFilter) query = query.eq('wedding_id', weddingIdFilter)
  const { data, error } = await query
  if (error) {
    throw new Error(`external-match.loadProfilesForVenue: ${error.message}`)
  }
  const all = (data ?? []) as ProfileRow[]
  // Window filter (last_signal_at OR last_reconstructed_at).
  const startMs = Date.parse(windowStartIso)
  if (!Number.isFinite(startMs)) return all
  return all.filter((row) => {
    const a = row.last_signal_at ? Date.parse(row.last_signal_at) : 0
    const b = Date.parse(row.last_reconstructed_at)
    const fresh = Math.max(a, b)
    return fresh >= startMs
  })
}

interface ConfirmedCulturalMomentRow {
  id: string
  title: string
  description: string | null
  start_at: string
  end_at: string | null
  category: string | null
  evidence: Record<string, unknown> | null
  geo_scope: string | null
  status: string
}

async function loadConfirmedCulturalMoments(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<ConfirmedCulturalMomentRow[]> {
  // Confirmed via venue_cultural_moment_state OR auto-confirmed
  // status='confirmed' globally.
  // Query the per-venue state first.
  const { data: stateRows } = await supabase
    .from('venue_cultural_moment_state')
    .select('cultural_moment_id, decision')
    .eq('venue_id', venueId)
    .eq('decision', 'confirmed')
    .limit(200)
  const confirmedIds = new Set<string>(
    (stateRows ?? [])
      .map((r) => (r as { cultural_moment_id: string }).cultural_moment_id)
      .filter(Boolean),
  )

  // Pull confirmed moments + recent proposed moments (proposed-but-not-
  // dismissed are still useful candidates if the venue hasn't decided).
  const { data: momentsRaw } = await supabase
    .from('cultural_moments')
    .select(
      'id, title, description, start_at, end_at, category, evidence, geo_scope, status',
    )
    .in('status', ['proposed', 'confirmed'])
    .gte('start_at', windowStartIso)
    .order('start_at', { ascending: false })
    .limit(100)

  const moments = ((momentsRaw ?? []) as ConfirmedCulturalMomentRow[]).filter(
    (m) => m.status === 'confirmed' || confirmedIds.has(m.id),
  )

  // If nothing confirmed, fall back to the most recent proposed
  // candidates so the matcher can still surface signals on a new venue.
  if (moments.length === 0) {
    return ((momentsRaw ?? []) as ConfirmedCulturalMomentRow[]).slice(0, 10)
  }
  return moments
}

interface InteractionForCompetitorRow {
  id: string
  wedding_id: string | null
  venue_id: string | null
  body_preview: string | null
  full_body: string | null
  subject: string | null
  direction: string | null
  timestamp: string | null
}

async function loadCompetitorInteractions(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<InteractionForCompetitorRow[]> {
  // Schema (mig 002): interactions has body_preview + full_body, not
  // a single body column. We read both and concatenate at use-site.
  const { data, error } = await supabase
    .from('interactions')
    .select(
      'id, wedding_id, venue_id, body_preview, full_body, subject, direction, timestamp',
    )
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .gte('timestamp', windowStartIso)
    .limit(2000)
  if (error) {
    console.warn('[external-match] loadCompetitorInteractions failed:', error.message)
    return []
  }
  return (data ?? []) as InteractionForCompetitorRow[]
}

// ---------------------------------------------------------------------------
// Cohort evidence assembly (for LLM)
// ---------------------------------------------------------------------------

function buildCohortPersonaEvidence(
  rollup: CohortRollupOutput | null,
  totalCouples: number,
): CohortPersonaEvidence[] {
  if (!rollup) return []
  // Wave 5B's voice_calibration carries one entry per persona —
  // language_that_lands etc. The persona_label is the canonical name.
  // We approximate share by: count entries with the same label / total.
  // Proper share comes from couple_intel directly — see buildCohortPersonaEvidenceFromIntel.
  const labels = new Map<string, number>()
  for (const v of rollup.voice_calibration ?? []) {
    if (!v.persona_label) continue
    labels.set(v.persona_label, (labels.get(v.persona_label) ?? 0) + 1)
  }
  if (labels.size === 0) return []
  // Without precise counts, distribute evenly across present labels.
  // Caller should prefer buildCohortPersonaEvidenceFromIntel which
  // queries couple_intel for actual shares.
  const out: CohortPersonaEvidence[] = []
  const perSlice = Math.max(1, Math.floor(totalCouples / labels.size))
  const sharePct = Math.floor(100 / labels.size)
  for (const [label] of labels) {
    out.push({
      persona_label: label,
      share_pct: sharePct,
      n_couples: perSlice,
    })
  }
  return out
}

async function buildCohortPersonaEvidenceFromIntel(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<CohortPersonaEvidence[]> {
  // Query couple_intel for actual persona counts within the window.
  const { data, error } = await supabase
    .from('couple_intel')
    .select('persona_label, last_derived_at')
    .gte('last_derived_at', windowStartIso)
    .limit(1000)
  if (error || !data) return []

  // Filter to this venue. couple_intel doesn't carry venue_id directly
  // in some schemas; we cross-ref via wedding_id → weddings.venue_id.
  // To keep one query, we fetch all and rely on the per-venue scope
  // already enforced by the read pipeline. For cross-venue contamination
  // safety, we look up wedding venue scope.
  const counts = new Map<string, number>()
  for (const r of data as Array<{
    persona_label: string | null
    last_derived_at: string
  }>) {
    if (!r.persona_label) continue
    counts.set(r.persona_label, (counts.get(r.persona_label) ?? 0) + 1)
  }
  // No data → empty
  if (counts.size === 0) return []
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  const out: CohortPersonaEvidence[] = []
  for (const [label, n] of counts.entries()) {
    out.push({
      persona_label: label,
      share_pct: total === 0 ? 0 : Math.round((n / total) * 100),
      n_couples: n,
    })
  }
  out.sort((a, b) => b.share_pct - a.share_pct)
  // Ensure venue-scope is honoured: re-filter by wedding_id → venue_id.
  // (When couple_intel has no venue column, narrow via weddings join.)
  const allowed = await venueScopedPersonaCounts(supabase, venueId, windowStartIso)
  if (allowed) return allowed
  return out
}

async function venueScopedPersonaCounts(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<CohortPersonaEvidence[] | null> {
  // Two-step: weddings ids for this venue, then couple_intel filtered.
  const { data: weds } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .limit(1000)
  if (!weds) return null
  const ids = (weds as Array<{ id: string }>).map((w) => w.id)
  if (ids.length === 0) return []
  const counts = new Map<string, number>()
  // Chunk to keep URL length sane.
  const BATCH = 100
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    const { data } = await supabase
      .from('couple_intel')
      .select('persona_label, last_derived_at, wedding_id')
      .in('wedding_id', slice)
      .gte('last_derived_at', windowStartIso)
    for (const r of (data ?? []) as Array<{ persona_label: string | null }>) {
      if (!r.persona_label) continue
      counts.set(r.persona_label, (counts.get(r.persona_label) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return []
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  const out: CohortPersonaEvidence[] = []
  for (const [label, n] of counts.entries()) {
    out.push({
      persona_label: label,
      share_pct: total === 0 ? 0 : Math.round((n / total) * 100),
      n_couples: n,
    })
  }
  out.sort((a, b) => b.share_pct - a.share_pct)
  return out
}

function buildCohortThemeEvidence(
  rollup: CohortRollupOutput | null,
): CohortThemeEvidence[] {
  if (!rollup) return []
  const out: CohortThemeEvidence[] = []
  for (const t of rollup.emerging_themes ?? []) {
    // Sensitive themes still surface as count-only at this layer; we
    // include them by THEME LABEL only — the cohort-fit prompt treats
    // theme as anonymised text. The Wave 5B serialiser already counted
    // sensitive entries; we DO NOT pass evidence quotes.
    if (t.sensitivity_filtered_count > 0 && t.evidence_count === 0) continue
    out.push({
      theme: t.theme,
      share_pct: 0, // Wave 5B doesn't expose share_pct directly; leave 0.
      trend: t.trend,
      evidence_count: t.evidence_count,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Forensic rules
// ---------------------------------------------------------------------------

function normaliseVendorName(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ')
}

interface VendorMentionAggregate {
  normalised_name: string
  display_name: string
  vendor_type: string
  occurrences: Array<{
    weddingId: string
    quote: string
  }>
}

function aggregateVendorMentions(
  profiles: ProfileRow[],
): VendorMentionAggregate[] {
  const byName = new Map<string, VendorMentionAggregate>()
  for (const p of profiles) {
    const vps = p.profile?.vendor_preferences ?? []
    if (!Array.isArray(vps)) continue
    for (const v of vps as VendorPreferenceClaim[]) {
      if (!v?.preference) continue
      // Extract a vendor name from the preference. Common shapes:
      // "Sue's Florist sent us", "Pinkberry Photography", "Knot found".
      // We approximate by taking the first 6 words. The forensic rule
      // is: same normalised string across N+ couples.
      const candidate = String(v.preference).split(/[,;.]/)[0].trim()
      if (!candidate || candidate.length < 3) continue
      const norm = normaliseVendorName(candidate)
      // Skip extremely generic preferences (noise filter). The forensic
      // rule requires vendor NAMES, not policy phrases. Reject any
      // candidate whose normalised text is a known noise phrase or that
      // contains hallmark policy/discount language without a proper name.
      if (
        norm.length < 4 ||
        norm === 'tbd' ||
        norm === 'unknown' ||
        norm === 'not yet' ||
        norm === 'none' ||
        norm === 'na' ||
        norm === 'n/a'
      ) {
        continue
      }
      // Reject phrases lacking a likely proper-noun (vendor names start
      // with a capitalised word; the original `candidate` preserves
      // case). If no token starts with an uppercase letter, treat as
      // policy phrase / generic preference, not a vendor mention.
      const hasProperNounToken = /\b[A-Z][a-zA-Z'&]{2,}/.test(candidate)
      if (!hasProperNounToken) continue
      // Reject hallmark policy phrases.
      const POLICY_NEEDLES = [
        'recommended vendor',
        'recommended vendors',
        'discount',
        'preferred vendor',
        'preferred vendors',
        'vendor list',
        'vendor discount',
      ]
      if (POLICY_NEEDLES.some((p) => norm.includes(p))) continue
      const existing = byName.get(norm)
      const occ = {
        weddingId: p.wedding_id,
        quote: v.evidence_quote || candidate,
      }
      if (existing) {
        existing.occurrences.push(occ)
      } else {
        byName.set(norm, {
          normalised_name: norm,
          display_name: candidate,
          vendor_type: v.vendor_type || 'vendor',
          occurrences: [occ],
        })
      }
    }
  }
  // Filter to MIN_COUPLES distinct couples.
  const out: VendorMentionAggregate[] = []
  for (const agg of byName.values()) {
    const distinctCouples = new Set(agg.occurrences.map((o) => o.weddingId))
    if (distinctCouples.size >= VENDOR_MENTION_MIN_COUPLES) {
      out.push(agg)
    }
  }
  // Sort by occurrence count desc.
  out.sort((a, b) => b.occurrences.length - a.occurrences.length)
  return out
}

interface CompetitorMentionAggregate {
  competitor_name: string
  occurrences: Array<{
    weddingId: string | null
    quote: string
    interactionId: string
  }>
}

function findCompetitorMentions(
  interactions: InteractionForCompetitorRow[],
): CompetitorMentionAggregate[] {
  const byName = new Map<string, CompetitorMentionAggregate>()
  for (const i of interactions) {
    const body = i.full_body ?? i.body_preview ?? ''
    const text = `${i.subject ?? ''} ${body}`.toLowerCase()
    if (!text.trim()) continue
    for (const seed of SEED_COMPETITOR_NAMES) {
      if (text.includes(seed)) {
        // Pull a 80-char excerpt around the match.
        const idx = text.indexOf(seed)
        const start = Math.max(0, idx - 30)
        const end = Math.min(text.length, idx + seed.length + 50)
        const excerpt = text.slice(start, end).trim()
        const existing = byName.get(seed)
        const occ = {
          weddingId: i.wedding_id,
          quote: excerpt,
          interactionId: i.id,
        }
        if (existing) {
          existing.occurrences.push(occ)
        } else {
          byName.set(seed, {
            competitor_name: seed,
            occurrences: [occ],
          })
        }
      }
    }
  }
  const out: CompetitorMentionAggregate[] = []
  for (const agg of byName.values()) {
    const distinctCouples = new Set(agg.occurrences.map((o) => o.weddingId).filter(Boolean))
    if (distinctCouples.size >= COMPETITOR_MENTION_MIN_COUPLES) {
      out.push(agg)
    }
  }
  out.sort((a, b) => b.occurrences.length - a.occurrences.length)
  return out
}

interface HandleSurfaceCandidate {
  weddingId: string
  platform: string
  handle: string
  evidenceQuote: string
}

function collectHandleCandidates(
  profiles: ProfileRow[],
): HandleSurfaceCandidate[] {
  const out: HandleSurfaceCandidate[] = []
  for (const p of profiles) {
    const handles = p.profile?.handles ?? []
    if (!Array.isArray(handles)) continue
    for (const h of handles as HandleClaim[]) {
      if (!h?.platform || !h?.handle) continue
      out.push({
        weddingId: p.wedding_id,
        platform: h.platform,
        handle: h.handle,
        evidenceQuote: h.evidence_quote ?? '',
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts: string[] = []
  for (const k of keys) {
    parts.push(
      `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
  }
  return `{${parts.join(',')}}`
}

function payloadDigest(
  signalType: IntelSignalType,
  payload: Record<string, unknown>,
  weddingId: string | null,
): string {
  const canonical = `${signalType}|${weddingId ?? 'cohort'}|${stableStringify(payload)}`
  return createHash('sha256').update(canonical).digest('hex')
}

interface ExistingMatchRow {
  id: string
  signal_type: string
  signal_payload: Record<string, unknown>
  wedding_id: string | null
  fired_at: string
}

async function loadRecentMatches(
  supabase: SupabaseClient,
  venueId: string,
): Promise<Set<string>> {
  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_DAYS * DAY_MS).toISOString()
  const { data } = await supabase
    .from('intel_matches')
    .select('id, signal_type, signal_payload, wedding_id, fired_at')
    .eq('venue_id', venueId)
    .gte('fired_at', sinceIso)
    .limit(2000)
  const out = new Set<string>()
  for (const r of (data ?? []) as ExistingMatchRow[]) {
    out.add(
      payloadDigest(
        r.signal_type as IntelSignalType,
        r.signal_payload ?? {},
        r.wedding_id,
      ),
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Stripping fences (defensive)
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// LLM scoring helper
// ---------------------------------------------------------------------------

interface ScoreSignalArgs {
  venueId: string
  venue: VenueRow
  windowDays: number
  totalCouples: number
  personaDistribution: CohortPersonaEvidence[]
  emergingThemes: CohortThemeEvidence[]
  signal: ExternalSignalEvidence
  correlationId?: string
}

interface ScoreSignalResult {
  output: ExternalMatchScoreOutput
  costCents: number
}

async function scoreSignalWithLlm(
  args: ScoreSignalArgs,
): Promise<ScoreSignalResult | null> {
  // Refusal guards on the rule side too — saves a Sonnet call when the
  // LLM would refuse anyway.
  if (args.totalCouples < 5) return null
  if (args.personaDistribution.length === 0) return null

  const evidence: ExternalMatchEvidence = {
    venueId: args.venueId,
    venueLabel: args.venue.name,
    venueState: args.venue.state,
    windowDays: args.windowDays,
    totalCouplesInCohort: args.totalCouples,
    personaDistribution: args.personaDistribution,
    emergingThemes: args.emergingThemes,
    signal: args.signal,
  }
  const systemPrompt = buildExternalMatchSystemPrompt()
  const userPrompt = buildExternalMatchUserPrompt(evidence)

  let raw: unknown
  try {
    raw = await callAIJson<unknown>({
      systemPrompt,
      userPrompt,
      tier: 'sonnet',
      taskType: 'external_match_score',
      contentTier: 4, // anonymised cohort summaries only
      promptVersion: EXTERNAL_MATCH_PROMPT_VERSION,
      venueId: args.venueId,
      maxTokens: 700,
      temperature: 0.2,
      correlationId: args.correlationId,
    })
  } catch (err) {
    console.warn(
      '[external-match] LLM scoring failed',
      err instanceof Error ? err.message : err,
    )
    return null
  }

  // callAIJson returns parsed JSON when it succeeds. If the upstream
  // returned a string, attempt to parse it.
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(stripJsonFences(raw))
    } catch {
      return null
    }
  }
  const validation = validateExternalMatchOutput(parsed)
  if (!validation.ok) {
    console.warn('[external-match] LLM output failed validation:', validation.error)
    return null
  }
  // Cost is logged inside callAIJson; we don't have a precise per-call
  // dollar figure surfaced here (callAIJson hides cost). Mark as 0 so
  // findExternalMatches' returned costCents reflects only the matches
  // it can attribute; the api_costs table still records the actual
  // spend per call.
  return { output: validation.output, costCents: 0 }
}

// ---------------------------------------------------------------------------
// Main entry: findExternalMatches
// ---------------------------------------------------------------------------

export async function findExternalMatches(
  args: { venueId: string; weddingId?: string | null },
  options: FindExternalMatchesOptions = {},
): Promise<FindExternalMatchesResult> {
  const supabase = options.supabase ?? createServiceClient()
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const skipLlm = options.skipLlm === true
  const correlationId = options.correlationId

  const windowStartIso = new Date(
    Date.now() - windowDays * DAY_MS,
  ).toISOString()

  // 1. Resolve venue.
  const venue = await loadVenue(supabase, args.venueId)
  if (!venue) {
    throw new Error(`findExternalMatches: venue ${args.venueId} not found`)
  }

  // 2. Load profiles + cohort intel + recent matches in parallel.
  const [profiles, venueIntel, recentDigests] = await Promise.all([
    loadProfilesForVenue(
      supabase,
      args.venueId,
      windowStartIso,
      args.weddingId ?? null,
    ),
    loadVenueIntel(supabase, args.venueId),
    loadRecentMatches(supabase, args.venueId),
  ])

  // Whole-venue profiles for cohort scoring (always all profiles, not
  // wedding-filtered, so cohort-fit is computed against the cohort).
  let cohortProfiles = profiles
  if (args.weddingId) {
    cohortProfiles = await loadProfilesForVenue(
      supabase,
      args.venueId,
      windowStartIso,
      null,
    )
  }
  const totalCouples = cohortProfiles.length

  const personaDistribution =
    (await buildCohortPersonaEvidenceFromIntel(
      supabase,
      args.venueId,
      windowStartIso,
    )) ?? buildCohortPersonaEvidence(venueIntel?.rollup ?? null, totalCouples)
  const emergingThemes = buildCohortThemeEvidence(venueIntel?.rollup ?? null)

  const matches: IntelMatchCandidate[] = []
  let totalCost = 0

  // -------------------------------------------------------------------------
  // 1. Cultural-moment matching (cohort-level + LLM cohort-fit scoring)
  // -------------------------------------------------------------------------
  const culturalMoments = await loadConfirmedCulturalMoments(
    supabase,
    args.venueId,
    windowStartIso,
  )
  for (const m of culturalMoments) {
    const payload = {
      cultural_moment_id: m.id,
      title: m.title,
      category: m.category,
      start_at: m.start_at,
      end_at: m.end_at,
      geo_scope: m.geo_scope,
      status: m.status,
    }
    const digest = payloadDigest('cultural_moment', payload, null)
    if (recentDigests.has(digest)) continue

    let cohortFit: number | null = null
    let reasoning: string | null = null
    let confidence = 60
    if (!skipLlm) {
      const signalEv: ExternalSignalEvidence = {
        signal_type: 'cultural_moment',
        title: m.title,
        category: m.category,
        description: m.description,
        start_at: m.start_at,
        end_at: m.end_at,
        evidence_url: (m.evidence?.['evidence_url'] as string | undefined) ?? null,
      }
      const scored = await scoreSignalWithLlm({
        venueId: args.venueId,
        venue,
        windowDays,
        totalCouples,
        personaDistribution,
        emergingThemes,
        signal: signalEv,
        correlationId,
      })
      if (scored && scored.output.refusal === null) {
        cohortFit = scored.output.cohort_fit_score_0_100
        reasoning = scored.output.reasoning
        // Confidence ties to cohort-fit when scored.
        confidence = Math.min(95, Math.max(30, cohortFit))
        totalCost += scored.costCents
      } else if (scored?.output.refusal) {
        reasoning = `LLM refused scoring: ${scored.output.refusal}`
      }
    }

    matches.push({
      weddingId: null,
      signalType: 'cultural_moment',
      signalPayload: payload,
      matchReasoning: reasoning,
      matchConfidence0to100: confidence,
      cohortFitScore0to100: cohortFit,
      evidenceQuotes: m.description
        ? [{ quote: m.description, source: 'cultural_moments', source_id: m.id }]
        : [],
    })
  }

  // -------------------------------------------------------------------------
  // 2. Vendor-mention matching (forensic rule, no LLM)
  // -------------------------------------------------------------------------
  const vendorMentions = aggregateVendorMentions(cohortProfiles)
  for (const v of vendorMentions) {
    const distinctCouples = Array.from(
      new Set(v.occurrences.map((o) => o.weddingId)),
    )
    const payload = {
      vendor_name: v.display_name,
      vendor_type: v.vendor_type,
      occurrences_count: v.occurrences.length,
      distinct_couples: distinctCouples.length,
    }
    const digest = payloadDigest('vendor_mention', payload, null)
    if (recentDigests.has(digest)) continue
    matches.push({
      weddingId: null,
      signalType: 'vendor_mention',
      signalPayload: payload,
      matchReasoning: `${distinctCouples.length} couples mentioned ${v.display_name} (${v.vendor_type}) in their forensic profile.`,
      matchConfidence0to100: Math.min(
        95,
        50 + Math.min(distinctCouples.length * 8, 45),
      ),
      cohortFitScore0to100: null,
      evidenceQuotes: v.occurrences.slice(0, 5).map((o) => ({
        quote: o.quote,
        source: 'couple_identity_profile',
        source_id: o.weddingId,
      })),
    })
  }

  // -------------------------------------------------------------------------
  // 3. Regional benchmark (LLM-scored when other venues exist)
  // -------------------------------------------------------------------------
  // Build cross-venue persona aggregate, deltas vs current venue, and
  // ask the LLM to interpret. If the system has no other venues yet,
  // skip — there's no "market" to compare against.
  if (!skipLlm && personaDistribution.length > 0) {
    const marketDist = await loadCrossVenuePersonaAverage(supabase, args.venueId)
    if (marketDist && marketDist.length > 0) {
      const skews: Array<{
        persona: string
        market_share_pct: number
        venue_share_pct: number
        delta_pct: number
      }> = []
      const venueByLabel = new Map(personaDistribution.map((p) => [p.persona_label, p.share_pct]))
      const marketByLabel = new Map(marketDist.map((p) => [p.persona_label, p.share_pct]))
      const allLabels = new Set([
        ...venueByLabel.keys(),
        ...marketByLabel.keys(),
      ])
      for (const label of allLabels) {
        const v = venueByLabel.get(label) ?? 0
        const mk = marketByLabel.get(label) ?? 0
        skews.push({
          persona: label,
          market_share_pct: mk,
          venue_share_pct: v,
          delta_pct: v - mk,
        })
      }
      skews.sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct))
      const top = skews.slice(0, 5)
      const payload = {
        comparison: 'cross_venue_persona_distribution',
        skews: top,
      }
      const digest = payloadDigest('regional_benchmark', payload, null)
      if (!recentDigests.has(digest)) {
        const signalEv: ExternalSignalEvidence = {
          signal_type: 'regional_benchmark',
          comparison_descriptor:
            'Persona distribution: this venue vs cross-venue average',
          skews: top,
        }
        const scored = await scoreSignalWithLlm({
          venueId: args.venueId,
          venue,
          windowDays,
          totalCouples,
          personaDistribution,
          emergingThemes,
          signal: signalEv,
          correlationId,
        })
        let cohortFit: number | null = null
        let reasoning: string | null = null
        if (scored && scored.output.refusal === null) {
          cohortFit = scored.output.cohort_fit_score_0_100
          reasoning = scored.output.reasoning
          totalCost += scored.costCents
        } else if (scored?.output.refusal) {
          reasoning = `LLM refused scoring: ${scored.output.refusal}`
        }
        if (reasoning) {
          matches.push({
            weddingId: null,
            signalType: 'regional_benchmark',
            signalPayload: payload,
            matchReasoning: reasoning,
            matchConfidence0to100: 70,
            cohortFitScore0to100: cohortFit,
            evidenceQuotes: top.slice(0, 3).map((s) => ({
              quote: `${s.persona}: market=${s.market_share_pct}% venue=${s.venue_share_pct}% (Δ${s.delta_pct >= 0 ? '+' : ''}${s.delta_pct}pp)`,
              source: 'cross_venue_aggregate',
            })),
          })
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Competitor mentions (forensic rule)
  // -------------------------------------------------------------------------
  const competitorInteractions = await loadCompetitorInteractions(
    supabase,
    args.venueId,
    windowStartIso,
  )
  const competitorMentions = findCompetitorMentions(competitorInteractions)
  // Drop matches whose competitor name matches the venue itself (false
  // positive on a venue's own name showing up in inbound mail).
  const venueLower = (venue.name ?? '').toLowerCase()
  for (const c of competitorMentions) {
    if (venueLower.includes(c.competitor_name)) continue
    // Per-couple scope: when the same competitor was mentioned by a
    // single wedding's interactions, surface as couple-level. Otherwise
    // venue-level.
    const couplesMentioning = Array.from(
      new Set(c.occurrences.map((o) => o.weddingId).filter(Boolean)),
    ) as string[]
    const payload = {
      competitor_name: c.competitor_name,
      mention_count: c.occurrences.length,
      sample_couples: couplesMentioning.slice(0, 5),
    }
    // Prefer the couple-scope row when scan is per-couple.
    const scopeWedding =
      args.weddingId && couplesMentioning.includes(args.weddingId)
        ? args.weddingId
        : null
    const digest = payloadDigest('competitor_mention', payload, scopeWedding)
    if (recentDigests.has(digest)) continue
    matches.push({
      weddingId: scopeWedding,
      signalType: 'competitor_mention',
      signalPayload: payload,
      matchReasoning: `Competitor "${c.competitor_name}" mentioned in ${c.occurrences.length} inbound message(s) from ${couplesMentioning.length} couple(s).`,
      matchConfidence0to100: Math.min(
        90,
        40 + Math.min(couplesMentioning.length * 10, 50),
      ),
      cohortFitScore0to100: null,
      evidenceQuotes: c.occurrences.slice(0, 3).map((o) => ({
        quote: o.quote,
        source: 'interactions',
        source_id: o.interactionId,
      })),
    })
  }

  // -------------------------------------------------------------------------
  // 5. Cross-platform handle activity (forensic rule)
  // -------------------------------------------------------------------------
  // Each handle on a profile becomes a per-couple match; the operator
  // can then chase up the platform for fresh activity.
  const handles = collectHandleCandidates(profiles)
  for (const h of handles) {
    const payload = {
      platform: h.platform,
      handle: h.handle,
      activity_descriptor: 'handle_present_in_profile',
      freshness_window_days: HANDLE_FRESHNESS_DAYS,
    }
    const digest = payloadDigest('cross_platform_handle', payload, h.weddingId)
    if (recentDigests.has(digest)) continue
    matches.push({
      weddingId: h.weddingId,
      signalType: 'cross_platform_handle',
      signalPayload: payload,
      matchReasoning: `${h.platform} handle "${h.handle}" surfaced for this couple — Tenant 2 of identity reconstruction. Check for fresh ${h.platform} activity (review posts, social engagement) within ${HANDLE_FRESHNESS_DAYS} days.`,
      matchConfidence0to100: 75,
      cohortFitScore0to100: null,
      evidenceQuotes: h.evidenceQuote
        ? [
            {
              quote: h.evidenceQuote,
              source: 'couple_identity_profile.handles',
              source_id: h.weddingId,
            },
          ]
        : [],
    })
  }

  return {
    matches,
    costCents: totalCost,
    promptVersion: EXTERNAL_MATCH_PROMPT_VERSION,
  }
}

// ---------------------------------------------------------------------------
// Cross-venue persona aggregation (used by regional_benchmark)
// ---------------------------------------------------------------------------

async function loadCrossVenuePersonaAverage(
  supabase: SupabaseClient,
  excludeVenueId: string,
): Promise<CohortPersonaEvidence[] | null> {
  const { data: weds } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .neq('venue_id', excludeVenueId)
    .limit(5000)
  if (!weds || weds.length === 0) return null
  const ids = (weds as Array<{ id: string; venue_id: string }>).map((w) => w.id)
  const counts = new Map<string, number>()
  const BATCH = 100
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    const { data } = await supabase
      .from('couple_intel')
      .select('persona_label')
      .in('wedding_id', slice)
    for (const r of (data ?? []) as Array<{ persona_label: string | null }>) {
      if (!r.persona_label) continue
      counts.set(r.persona_label, (counts.get(r.persona_label) ?? 0) + 1)
    }
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  if (total === 0) return null
  const out: CohortPersonaEvidence[] = []
  for (const [label, n] of counts.entries()) {
    out.push({
      persona_label: label,
      share_pct: Math.round((n / total) * 100),
      n_couples: n,
    })
  }
  out.sort((a, b) => b.share_pct - a.share_pct)
  return out
}

// ---------------------------------------------------------------------------
// findAndStoreExternalMatches — finds and persists
// ---------------------------------------------------------------------------

export interface StoredIntelMatchRow {
  id: string
  venue_id: string
  wedding_id: string | null
  signal_type: IntelSignalType
  signal_payload: Record<string, unknown>
  match_reasoning: string | null
  match_confidence_0_100: number
  cohort_fit_score_0_100: number | null
  evidence_quotes: IntelMatchEvidenceQuote[] | null
  fired_at: string
  dismissed_at: string | null
  actioned_at: string | null
  action_taken: string | null
  created_at: string
}

export interface FindAndStoreResult extends FindExternalMatchesResult {
  stored: number
  skippedDedupe: number
  errors: number
}

export async function findAndStoreExternalMatches(
  args: { venueId: string; weddingId?: string | null },
  options: FindExternalMatchesOptions = {},
): Promise<FindAndStoreResult> {
  const supabase = options.supabase ?? createServiceClient()
  const found = await findExternalMatches(args, { ...options, supabase })

  let stored = 0
  let skippedDedupe = 0
  let errors = 0

  // We re-load digests right before insert (idempotency double-check).
  const recentDigests = await loadRecentMatches(supabase, args.venueId)

  for (const m of found.matches) {
    const digest = payloadDigest(m.signalType, m.signalPayload, m.weddingId)
    if (recentDigests.has(digest)) {
      skippedDedupe += 1
      continue
    }
    try {
      const { error } = await supabase.from('intel_matches').insert({
        venue_id: args.venueId,
        wedding_id: m.weddingId,
        signal_type: m.signalType,
        signal_payload: m.signalPayload,
        match_reasoning: m.matchReasoning,
        match_confidence_0_100: m.matchConfidence0to100,
        cohort_fit_score_0_100: m.cohortFitScore0to100,
        evidence_quotes: m.evidenceQuotes,
      })
      if (error) {
        errors += 1
        console.warn('[external-match] insert failed:', error.message)
      } else {
        stored += 1
        recentDigests.add(digest)
      }
    } catch (err) {
      errors += 1
      console.warn(
        '[external-match] insert threw:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  return {
    ...found,
    stored,
    skippedDedupe,
    errors,
  }
}

// ---------------------------------------------------------------------------
// Read helpers (used by endpoints + UI)
// ---------------------------------------------------------------------------

export interface ListMatchesOptions {
  signalType?: IntelSignalType
  weddingId?: string
  dismissed?: boolean
  actioned?: boolean
  limit?: number
}

export async function listIntelMatches(
  venueId: string,
  options: ListMatchesOptions = {},
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredIntelMatchRow[]> {
  const limit = Math.min(options.limit ?? 100, 500)
  let query = supabase
    .from('intel_matches')
    .select(
      'id, venue_id, wedding_id, signal_type, signal_payload, match_reasoning, match_confidence_0_100, cohort_fit_score_0_100, evidence_quotes, fired_at, dismissed_at, actioned_at, action_taken, created_at',
    )
    .eq('venue_id', venueId)
    .order('fired_at', { ascending: false })
    .limit(limit)

  if (options.signalType) query = query.eq('signal_type', options.signalType)
  if (options.weddingId) query = query.eq('wedding_id', options.weddingId)
  if (options.dismissed === false) query = query.is('dismissed_at', null)
  if (options.dismissed === true) query = query.not('dismissed_at', 'is', null)
  if (options.actioned === false) query = query.is('actioned_at', null)
  if (options.actioned === true) query = query.not('actioned_at', 'is', null)

  const { data, error } = await query
  if (error) {
    throw new Error(`listIntelMatches: ${error.message}`)
  }
  return (data ?? []) as StoredIntelMatchRow[]
}

export async function dismissIntelMatch(
  matchId: string,
  reason: string | null,
  userId: string | null,
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const { error } = await supabase
    .from('intel_matches')
    .update({
      dismissed_at: new Date().toISOString(),
      dismissed_by: userId,
      dismissal_reason: reason,
    })
    .eq('id', matchId)
  if (error) {
    throw new Error(`dismissIntelMatch: ${error.message}`)
  }
}

export async function actionIntelMatch(
  matchId: string,
  actionTaken: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const { error } = await supabase
    .from('intel_matches')
    .update({
      actioned_at: new Date().toISOString(),
      action_taken: actionTaken,
    })
    .eq('id', matchId)
  if (error) {
    throw new Error(`actionIntelMatch: ${error.message}`)
  }
}
