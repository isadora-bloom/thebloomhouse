/**
 * Bloom House: Intelligence Brain Service
 *
 * The AI backbone for the intelligence dashboard. Handles:
 * - Natural language queries about venue data (NLQ)
 * - Marketing positioning suggestions from review language + trends
 * - Query feedback logging
 *
 * NLQ approach: rather than translating natural language to SQL (fragile,
 * injection risk), we pull a summary of recent venue data, feed it as context
 * alongside the question, and let the AI reason over it conversationally.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAI, callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'

/** Prompt revision identifier — see PROMPTS-CHANGELOG.md / OPS-21.5.1. */
export const BRAIN_PROMPT_VERSION = 'intel-brain.prompt.v1.1'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NLQResult {
  response: string
  queryId: string
  tokensUsed: number
  cost: number
}

interface PositioningSuggestion {
  title: string
  rationale: string
  copy_example: string
}

interface PositioningSuggestionsResult {
  suggestions: PositioningSuggestion[]
}

interface VenueDataContext {
  venueName: string
  recentWeddings: WeddingSummary[]
  pipelineCounts: Record<string, number>
  sourceAttribution: SourceAttributionRow[]
  trendDeviations: TrendDeviationRow[]
  recentRecommendations: RecommendationRow[]
  weatherForecast: WeatherRow[]
  economicIndicators: Record<string, number>
  consultantMetrics: ConsultantMetricRow[]
  topPhrases: PhraseRow[]

  // T5-θ.2 (2026-05-02): cross-limb grounding for NLQ + Sage. The
  // legacy fields above stayed read-only; new fields below append
  // attribution / candidates / FRED deltas / cultural / calendar /
  // Internal Context. Callers that destructure existing fields
  // continue to compile.
  attributionByPlatform: AttributionPlatformRow[]
  candidateIdentitySummary: CandidateIdentitySummary
  culturalMoments: CulturalMomentRow[]
  fredSeriesDeltas: FredSeriesDelta[]
  upcomingCalendarEvents: CalendarEventRow[]
  coordinatorAbsences: CoordinatorAbsenceRow[]
  venueOperationalState: OperationalStateRow[]
  pricingHistory: PricingHistoryRow[]
  marketingChannels: MarketingChannelRow[]
  recentInteractionSnippets: InteractionSnippet[]
  tourCancellationReasons: TourCancellationReasonRow[]
  lostDealReasons: LostDealReasonRow[]

  // T5-PP (2026-05-02): NLQ context-loader gaps surfaced by Stream MM.
  // (1) toursByMonth — bucket tours by scheduled_at month so questions
  //     like "what's my busiest tour month?" can be grounded.
  // (2) marketingSpendByMonth — pull marketing_spend rows directly so
  //     NLQ has fresh per-month spend without depending on the weekly
  //     source_attribution cron freshness. source_attribution still
  //     gets read above (cost-per-lead computed numbers) — these two
  //     fields are complementary lenses.
  toursByMonth: ToursByMonthRow[]
  marketingSpendByMonth: MarketingSpendByMonthRow[]
}

interface WeddingSummary {
  id: string
  status: string
  source: string | null
  wedding_date: string | null
  guest_count_estimate: number | null
  booking_value: number | null
  inquiry_date: string | null
  booked_at: string | null
  lost_at: string | null
  lost_reason: string | null
  heat_score: number
  temperature_tier: string
}

interface SourceAttributionRow {
  source: string
  period_start: string
  period_end: string
  spend: number | null
  inquiries: number | null
  tours: number | null
  bookings: number | null
  revenue: number | null
  cost_per_inquiry: number | null
  cost_per_booking: number | null
  conversion_rate: number | null
  roi: number | null
}

interface TrendDeviationRow {
  term: string
  week: string
  interest: number
}

interface RecommendationRow {
  recommendation_type: string
  title: string
  body: string
  priority: number
  status: string
  created_at: string
}

interface WeatherRow {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
}

interface ConsultantMetricRow {
  consultant_id: string
  period_start: string
  period_end: string
  inquiries_handled: number | null
  tours_booked: number | null
  bookings_closed: number | null
  conversion_rate: number | null
  avg_response_time_minutes: number | null
  avg_booking_value: number | null
}

interface PhraseRow {
  phrase: string
  theme: string
  sentiment_score: number
  frequency: number
}

// ---------------------------------------------------------------------------
// T5-θ.2 cross-limb grounding types (NLQ + Sage)
// ---------------------------------------------------------------------------

interface AttributionPlatformRow {
  platform: string
  count: number
  /** booked count / total attribution events on this platform (0..1) */
  conversion_rate: number
}

interface CandidateIdentitySummary {
  total: number
  resolved_count: number
  unresolved_count: number
  /** resolved_count / total (0..1). 0 when total is 0. */
  conversion_rate: number
}

interface CulturalMomentRow {
  name: string
  category: string | null
  start_date: string
  end_date: string | null
  influence_weight: number | null
  geography: string | null
}

interface FredSeriesDelta {
  series_id: string
  label: string
  latest_value: number
  latest_date: string | null
  delta_30d: number | null
  delta_90d: number | null
}

interface CalendarEventRow {
  name: string
  category: string
  date: string
  geo_scope: string
}

interface CoordinatorAbsenceRow {
  start_date: string
  end_date: string
  reason: string
  coordinator_name: string | null
}

interface OperationalStateRow {
  state_type: string
  start_date: string
  end_date: string | null
  description: string
}

interface PricingHistoryRow {
  effective_date: string
  package_name: string
  prior_price: number | null
  new_price: number | null
}

interface MarketingChannelRow {
  name: string
  source_key: string
  active: boolean
}

interface InteractionSnippet {
  date: string
  snippet: string
}

interface TourCancellationReasonRow {
  reason: string
  count: number
}

interface LostDealReasonRow {
  reason: string
  count: number
}

// T5-PP (2026-05-02) — NLQ context-loader gaps from Stream MM Q4 + bug surface.
interface ToursByMonthRow {
  /** ISO 'YYYY-MM' bucket (UTC) */
  month: string
  count: number
  completed: number
  cancelled: number
  no_show: number
  rescheduled: number
  pending: number
}

interface MarketingSpendByMonthRow {
  source: string
  /** ISO 'YYYY-MM' bucket */
  month: string
  /** raw dollar amount as stored in marketing_spend.amount (decimal) */
  amount: number
  /** populated when the writer set notes (confidence flags etc.) */
  notes: string | null
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildNLQSystemPrompt(venueName: string): string {
  return `You are the intelligence analyst for ${venueName}. You have access to the venue's recent data and your job is to answer questions about venue performance, bookings, marketing, trends, and operations.

Answer questions conversationally but precisely. Always cite specific numbers when available. If you don't have enough data to answer confidently, say so. Never make up statistics.

You understand the following data:

WEDDINGS (booking pipeline):
- Statuses: inquiry → tour_scheduled → tour_completed → proposal_sent → booked → completed. Can also be "lost" or "cancelled".
- Sources: the_knot, wedding_wire, here_comes_the_guide, zola, honeybook, google, google_ads, google_business, instagram, facebook, pinterest, tiktok, venue_calculator, website, direct, referral, walk_in, csv_import, vendor_referral, other
- Each wedding has: booking_value, guest_count_estimate, heat_score (lead temperature), temperature_tier
- Key dates: inquiry_date, wedding_date, booked_at, lost_at

SOURCE ATTRIBUTION (cost-per-lead rollup, refreshed weekly):
- Marketing spend vs results per source (inquiries, tours, bookings, revenue)
- Calculated metrics: cost_per_inquiry, cost_per_booking, conversion_rate, ROI
- IMPORTANT: this is computed by a weekly cron job. Recent spend changes
  may not yet be reflected here. For always-fresh per-month spend, prefer
  the MARKETING SPEND BY MONTH block below.

MARKETING SPEND BY MONTH (raw, always fresh):
- Per source × month spend pulled directly from marketing_spend (last 12
  months). Use this when the user asks about recent spend changes,
  channel comparisons, or month-over-month trends — these numbers reflect
  what's currently in the database, no cron lag.
- Notes column carries confidence flags (high / medium / low) when set
  by the loader, so you can call out estimated months explicitly.

TOURS BY MONTH (last 12 months):
- Tours bucketed by scheduled_at month (UTC) with outcome breakdown:
  total, completed, cancelled, no_show, rescheduled, pending.
- Use this to answer "what's my busiest tour month?" or to spot months
  with elevated cancellation / no-show rates. Tours grouped by the
  month they were scheduled for, not the month they were created.

SEARCH TRENDS:
- Google Trends interest scores for wedding-related terms in the venue's metro
- Recent data points show whether demand is rising or falling

TREND RECOMMENDATIONS:
- AI-generated actionable recommendations based on trend deviations
- Types: pricing, marketing, staffing, content, outreach

WEATHER:
- 14-day forecast for the venue location (high/low temps, precipitation, conditions)

ECONOMIC INDICATORS:
- Consumer sentiment, personal savings rate, disposable income, housing starts, consumer confidence
- These signal overall wedding spending appetite

CONSULTANT METRICS:
- Performance per coordinator: inquiries handled, tours booked, bookings closed, conversion rate, response time

REVIEW LANGUAGE:
- Notable phrases extracted from reviews, grouped by theme (coordinator, space, flexibility, value, etc.)
- Each phrase has a sentiment score and frequency count

ATTRIBUTION BY PLATFORM (cross-limb grounding for source ROI questions):
- Per-platform attribution events from the last 90 days, with platform-level conversion rates (booked / total events).
- Use this to compare platforms grounded in actual attribution numbers (e.g. "did Pinterest convert better than Knot last quarter?").

CANDIDATE IDENTITY RESOLUTION:
- Pre-zero anonymous platform signals (Knot views, Instagram follows, Pinterest saves) clustered into candidate identities.
- Summary: total, resolved (matched to a wedding), unresolved, conversion_rate. Indicates how much top-of-funnel actually surfaces.

CULTURAL MOMENTS (confirmed only, last 90 days):
- Coordinator-confirmed cultural / industry / macro moments with start_date, end_date, category, influence_weight (-100..100), and geography.
- Used to ground questions like "did the coastal grandmother trend bring us inquiries?" — only confirmed moments appear here.

FRED MACRO INDICATORS (latest + 30d / 90d delta):
- Series in the panel: CPIAUCSL (CPI), MORTGAGE30US (30y mortgage rate), SP500, UNRATE (unemployment), UMCSENT (consumer sentiment).
- Each carries a latest value plus delta_30d and delta_90d so you can answer "are we slowing down alongside mortgage rates?" with grounded numbers.

UPCOMING CALENDAR EVENTS (next 90 days, venue-region scoped):
- External calendar events (federal holidays, school breaks, university events, sporting events, conventions, elections, religious observances) hierarchically scoped to the venue's region (us / us_<state> / us_<state>_<metro>).

COORDINATOR ABSENCES (active or upcoming):
- Date windows when a coordinator is out (vacation, conference, illness, holiday closure). Anomaly questions about response time should check absences first.

VENUE OPERATIONAL STATE (active windows):
- Renovation / closure / capacity / vendor / policy / force-majeure windows currently active or recently active. Pulled when the user asks about why the funnel changed.

PRICING HISTORY (last 365 days):
- Append-only audit of base_price / capacity / tier changes with prior and new value plus effective date. Use to ground elasticity questions ("did the price change in May matter?").

MARKETING CHANNELS REGISTRY:
- The venue's per-channel registry (Knot, WW, Instagram, Google Business, referrals, paid, etc.) with active flag. Authoritative list of what the venue actually markets through.

RECENT INBOUND INTERACTION SNIPPETS (last 90 days, top 20 by recency):
- Truncated first 200 chars of recent inbound emails / messages. Useful when you're asked "are couples mentioning X recently?" — the snippets are direct evidence.

TOUR CANCELLATION REASONS (last 365 days, lost-deal reason aggregates):
- Aggregate count of cancellation / lost reasons across tours-stage and tour-stage lost deals. Grounds questions about WHY tours fall through.

When answering:
- Be direct and actionable — venue owners are busy
- Quote numbers from the data block; comparisons (this month vs last, one source vs another) are allowed when BOTH sides are present in the data
- If asked about trends, explain what the trend means for the business
- If asked "how are we doing", give a balanced overview covering pipeline health, conversion, and any notable signals
- Format currency as dollars; percentages must trace back to a ratio the data block supports (e.g. bookings/inquiries from the source attribution rows)
- Use markdown formatting for readability (bold key numbers, use bullet points for lists)

NUMBERS DISCIPLINE (ANTI-19.9-A / Playbook 19.9 #1):
- Every number you reference must come from the data block above OR be a comparison/ratio computed FROM two numbers in the data block.
- Do NOT invent statistics, projections, industry benchmarks, or "typical" numbers.
- Do NOT extrapolate ("at this pace we'll hit X") unless the data block carries a forecast you can quote.
- If the data block lacks a number you'd like to reference, write the observation without the number rather than inventing one.`
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

/**
 * Pull a summary of recent venue data for the AI to reason over.
 *
 * T5-θ.2 (2026-05-02): expanded for NLQ + Sage cross-limb grounding.
 * The legacy block (weddings / source attribution / trends / weather /
 * indicators / consultants / phrases) stayed structurally intact —
 * existing callers continue to destructure the same fields. New fields
 * are appended:
 *   - attributionByPlatform (90d, attribution_events)
 *   - candidateIdentitySummary (resolved vs unresolved)
 *   - culturalMoments (status='confirmed', last 90d)
 *   - fredSeriesDeltas (latest + 30d / 90d delta per series)
 *   - upcomingCalendarEvents (next 90d, venue-region scoped)
 *   - coordinatorAbsences (active or upcoming)
 *   - venueOperationalState (active windows)
 *   - pricingHistory (last 365d)
 *   - marketingChannels (active registry)
 *   - recentInteractionSnippets (last 90d inbound, top 20 by recency)
 *   - tourCancellationReasons (last 365d, tours.cancellation_reason —
 *     why a scheduled tour did not happen; lead may still book later)
 *   - lostDealReasons (last 365d, lost_deals.reason_category at tour
 *     stage — why the deal itself died; intentionally separate lens)
 *
 * Window bumps:
 *   - weddings 30d → 365d (Sage needs > 1mo to reason about cohorts).
 */
async function gatherVenueData(venueId: string): Promise<VenueDataContext> {
  const supabase = createServiceClient()

  const NOW_MS = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000

  const thirtyDaysAgo = new Date(NOW_MS - 30 * DAY_MS)
    .toISOString()
    .split('T')[0]
  const ninetyDaysAgoIso = new Date(NOW_MS - 90 * DAY_MS).toISOString()
  const ninetyDaysAgoDate = ninetyDaysAgoIso.split('T')[0]
  const ninetyDaysFromNowDate = new Date(NOW_MS + 90 * DAY_MS)
    .toISOString()
    .split('T')[0]
  const oneYearAgoIso = new Date(NOW_MS - 365 * DAY_MS).toISOString()
  const oneYearAgoDate = oneYearAgoIso.split('T')[0]

  const fourteenDaysFromNow = new Date(NOW_MS + 14 * DAY_MS)
    .toISOString()
    .split('T')[0]

  const today = new Date().toISOString().split('T')[0]

  // Run all queries in parallel
  const [
    venueResult,
    weddingsResult,
    allWeddingsResult,
    attributionResult,
    trendsResult,
    recommendationsResult,
    weatherResult,
    consultantResult,
    phrasesResult,
    indicatorsResult,
    // T5-θ.2 new domains:
    attributionEventsResult,
    candidateIdentitiesResult,
    culturalMomentsResult,
    calendarEventsResult,
    coordinatorAbsencesResult,
    operationalStateResult,
    pricingHistoryResult,
    marketingChannelsResult,
    interactionsResult,
    lostDealsResult,
    tourCancelResult,
    // T5-PP additions:
    toursByMonthResult,
    marketingSpendDirectResult,
  ] = await Promise.all([
    // Venue name + state (state used to scope external_calendar_events)
    supabase
      .from('venues')
      .select('name, state')
      .eq('id', venueId)
      .single(),

    // Recent weddings — bumped 30d → 365d per T5-θ.2 spec so Sage can
    // reason about cohorts and trends across a full season.
    supabase
      .from('weddings')
      .select('id, status, source, wedding_date, guest_count_estimate, booking_value, inquiry_date, booked_at, lost_at, lost_reason, heat_score, temperature_tier')
      .eq('venue_id', venueId)
      .gte('updated_at', oneYearAgoDate)
      .order('updated_at', { ascending: false })
      .limit(200),

    // All active weddings for pipeline counts
    supabase
      .from('weddings')
      .select('status')
      .eq('venue_id', venueId)
      .not('status', 'in', '("completed","lost","cancelled")'),

    // Latest source attribution
    supabase
      .from('source_attribution')
      .select('source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi')
      .eq('venue_id', venueId)
      .order('calculated_at', { ascending: false })
      .limit(20),

    // Recent trend data (last 8 weeks)
    supabase
      .from('search_trends')
      .select('term, week, interest')
      .eq('venue_id', venueId)
      .gte('week', new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('week', { ascending: false })
      .limit(100),

    // Recent recommendations
    supabase
      .from('trend_recommendations')
      .select('recommendation_type, title, body, priority, status, created_at')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(10),

    // Weather forecast (next 14 days)
    supabase
      .from('weather_data')
      .select('date, high_temp, low_temp, precipitation, conditions')
      .eq('venue_id', venueId)
      .gte('date', today)
      .lte('date', fourteenDaysFromNow)
      .order('date', { ascending: true }),

    // Consultant metrics (most recent period)
    supabase
      .from('consultant_metrics')
      .select('consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value')
      .eq('venue_id', venueId)
      .order('calculated_at', { ascending: false })
      .limit(10),

    // Top review phrases
    supabase
      .from('review_language')
      .select('phrase, theme, sentiment_score, frequency')
      .eq('venue_id', venueId)
      .order('frequency', { ascending: false })
      .limit(15),

    // Latest macro indicators (fred_indicators).
    //
    // T5-ε.1 (2026-05-01): migrated from legacy economic_indicators
    // (which the cron writer had silently abandoned post-launch) to
    // fred_indicators — the table the correlation engine reads. Pull
    // a generous window so the per-series dedup below catches the
    // latest observation regardless of FRED's update cadence (CPI is
    // monthly, SP500 is daily).
    supabase
      .from('fred_indicators')
      .select('series_id, value, observation_date')
      .order('observation_date', { ascending: false })
      .limit(50),

    // ---------------------------------------------------------------
    // T5-θ.2: cross-limb grounding queries
    // ---------------------------------------------------------------

    // Attribution events (last 90d, venue-scoped) — drives platform
    // breakdown + per-platform conversion. We pull both attribution
    // and nurture rows; the breakdown scopes to bucket='attribution'
    // (the discovery-credit rows). Joined to weddings for status so
    // we can compute conversion = booked / total.
    supabase
      .from('attribution_events')
      .select('source_platform, bucket, wedding_id, weddings!inner(status)')
      .eq('venue_id', venueId)
      .is('reverted_at', null)
      .gte('decided_at', ninetyDaysAgoIso)
      .limit(2000),

    // Candidate identities — total / resolved / unresolved (venue-scoped).
    // We grab a thin column set; counting is done in JS.
    supabase
      .from('candidate_identities')
      .select('id, resolved_wedding_id')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .limit(5000),

    // Cultural moments — venue-confirmed only, overlapping the last 90d.
    // Migration 167: cultural_moments stays global, but each venue has
    // its own confirmation/dismissal state in venue_cultural_moment_state.
    // We query through the per-venue state so Sage's brain only sees
    // moments THIS venue elevated (Hawthorne's confirmed list != Crestwood's).
    supabase
      .from('venue_cultural_moment_state')
      .select('cultural_moments!inner(title, category, start_at, end_at, influence_weight, geo_scope)')
      .eq('venue_id', venueId)
      .eq('state', 'confirmed')
      .gte('cultural_moments.end_at', ninetyDaysAgoIso)
      .order('cultural_moments(start_at)', { ascending: false })
      .limit(50),

    // External calendar events — next 90d, scoped via geo_scope to the
    // venue's region. The calendar.ts loader expands hierarchies; we
    // do the same expansion inline so the venue's federal + state +
    // metro events all appear.
    supabase
      .from('external_calendar_events')
      .select('title, category, start_date, end_date, geo_scope')
      .is('deleted_at', null)
      .lte('start_date', ninetyDaysFromNowDate)
      .gte('end_date', today)
      .order('start_date', { ascending: true })
      .limit(100),

    // Coordinator absences — active or upcoming.
    supabase
      .from('coordinator_absences')
      .select('start_at, end_at, reason, handoff_notes, assigned_consultant_id, user_profiles:assigned_consultant_id(full_name)')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .gte('end_at', new Date(NOW_MS).toISOString())
      .order('start_at', { ascending: true })
      .limit(20),

    // Operational state — active (end_at IS NULL OR end_at > now).
    supabase
      .from('venue_operational_state')
      .select('state_type, start_at, end_at, title, description')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .or(`end_at.is.null,end_at.gte.${new Date(NOW_MS).toISOString()}`)
      .order('start_at', { ascending: false })
      .limit(20),

    // Pricing history — last 365d.
    supabase
      .from('pricing_history')
      .select('changed_at, field_name, old_value, new_value')
      .eq('venue_id', venueId)
      .gte('changed_at', oneYearAgoIso)
      .order('changed_at', { ascending: false })
      .limit(50),

    // Marketing channels (active registry).
    supabase
      .from('marketing_channels')
      .select('key, label, is_active')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .order('is_active', { ascending: false })
      .order('label', { ascending: true })
      .limit(50),

    // Recent inbound interactions (last 90d, top 20 by recency).
    // Per T5-θ.2 spec: truncate-only, no LLM extractor pass.
    supabase
      .from('interactions')
      .select('timestamp, body_preview, full_body')
      .eq('venue_id', venueId)
      .eq('direction', 'inbound')
      .gte('timestamp', ninetyDaysAgoIso)
      .order('timestamp', { ascending: false })
      .limit(20),

    // Lost-deal reason aggregates at the tour stage — last 365d.
    // lost_deals.reason_category is the canonical "why the deal died"
    // signal (deal-level: even after a successful tour, the couple
    // chose another venue). DISTINCT from tours.cancellation_reason
    // below — that one is "why was the TOUR cancelled" (the tour
    // never happened, but the lead may still book later).
    // Both signals are passed to Sage so NLQ answers don't conflate
    // them. /intel/lost-deals reads from the same source.
    supabase
      .from('lost_deals')
      .select('reason_category, reason_detail')
      .eq('venue_id', venueId)
      .eq('lost_at_stage', 'tour')
      .not('reason_category', 'is', null)
      .gte('lost_at', oneYearAgoIso)
      .limit(500),

    // Tour cancellation reasons — last 365d, tours.cancellation_reason
    // (migration 166). The partial index idx_tours_cancellation_reason
    // (venue_id, cancellation_reason) supports this scan. JS aggregate
    // to avoid a SQL VIEW. Distinct from lost_deals above: a tour can
    // be cancelled (weather, family emergency) without the deal dying.
    supabase
      .from('tours')
      .select('cancellation_reason')
      .eq('venue_id', venueId)
      .not('cancellation_reason', 'is', null)
      .gte('scheduled_at', oneYearAgoIso)
      .limit(1000),

    // T5-PP: tours bucketed by month for "busiest tour month" questions.
    // Pull last 12 months of tours with scheduled_at + outcome; we GROUP
    // in JS to avoid a server-side SQL function. Stream MM Q4 surfaced
    // this gap: NLQ said "I see 178 active tours but no monthly breakdown."
    supabase
      .from('tours')
      .select('scheduled_at, outcome')
      .eq('venue_id', venueId)
      .not('scheduled_at', 'is', null)
      .gte('scheduled_at', oneYearAgoIso)
      .order('scheduled_at', { ascending: false })
      .limit(2000),

    // T5-PP: direct marketing_spend pull (last 12 months, source x month).
    // source_attribution above carries computed cost-per-lead numbers but
    // is refreshed by a weekly cron — recent spend changes are invisible
    // until the next refresh. Stream MM had to manually trigger a refresh
    // to get NLQ Q1 (Google Ads ROI) grounded. Pulling marketing_spend
    // directly closes that freshness gap.
    supabase
      .from('marketing_spend')
      .select('source, month, amount, notes')
      .eq('venue_id', venueId)
      .gte('month', oneYearAgoDate)
      .order('month', { ascending: false })
      .limit(500),
  ])

  // Build pipeline counts from active weddings
  const pipelineCounts: Record<string, number> = {}
  for (const row of allWeddingsResult.data ?? []) {
    const status = row.status as string
    pipelineCounts[status] = (pipelineCounts[status] ?? 0) + 1
  }

  // Deduplicate FRED series — keep latest observation per series_id.
  // The query already orders DESC so the first occurrence per series_id
  // is the latest. Map FRED ids to friendly labels so the AI prompt
  // stays human-readable ("CPI (headline): 305.2" beats "CPIAUCSL: 305.2").
  const FRED_LABELS: Record<string, string> = {
    CPIAUCSL:     'CPI (headline)',
    MORTGAGE30US: '30y fixed mortgage rate',
    SP500:        'S&P 500',
    UNRATE:       'US unemployment',
    UMCSENT:      'Consumer sentiment',
  }
  const indicators: Record<string, number> = {}
  for (const row of indicatorsResult.data ?? []) {
    const seriesId = row.series_id as string
    const label = FRED_LABELS[seriesId] ?? seriesId
    if (!(label in indicators) && row.value != null) {
      indicators[label] = Number(row.value)
    }
  }

  // ---------------------------------------------------------------------
  // T5-θ.2 post-processing
  // ---------------------------------------------------------------------

  // FRED series with 30d / 90d deltas. The legacy `indicators` field
  // returns latest-only as a flat record; this richer view groups all
  // observations per series and computes the latest-vs-30d-ago and
  // latest-vs-90d-ago delta for the panel series. Delta is null when
  // the series hasn't been observed back that far in the 50-row pull
  // (rare: SP500 + MORTGAGE30US update daily/weekly so 50 rows is a
  // few months; CPI is monthly so 50 rows is ~4 years of history).
  const PANEL_SERIES = ['CPIAUCSL', 'MORTGAGE30US', 'SP500', 'UNRATE', 'UMCSENT']
  const seriesObservations = new Map<
    string,
    { date: string; value: number }[]
  >()
  for (const row of indicatorsResult.data ?? []) {
    const seriesId = row.series_id as string
    if (row.value == null || !row.observation_date) continue
    const arr = seriesObservations.get(seriesId) ?? []
    arr.push({ date: row.observation_date as string, value: Number(row.value) })
    seriesObservations.set(seriesId, arr)
  }
  const fredSeriesDeltas: FredSeriesDelta[] = []
  const nowMs = NOW_MS
  for (const seriesId of PANEL_SERIES) {
    const obs = seriesObservations.get(seriesId)
    if (!obs || obs.length === 0) continue
    // Already sorted DESC by query — guard regardless.
    obs.sort((a, b) => b.date.localeCompare(a.date))
    const latest = obs[0]
    const findClosestBefore = (cutoffMs: number) => {
      for (const o of obs) {
        if (new Date(`${o.date}T00:00:00Z`).getTime() <= cutoffMs) return o
      }
      return null
    }
    const thirtyAgoObs = findClosestBefore(nowMs - 30 * DAY_MS)
    const ninetyAgoObs = findClosestBefore(nowMs - 90 * DAY_MS)
    fredSeriesDeltas.push({
      series_id: seriesId,
      label: FRED_LABELS[seriesId] ?? seriesId,
      latest_value: latest.value,
      latest_date: latest.date,
      delta_30d: thirtyAgoObs ? latest.value - thirtyAgoObs.value : null,
      delta_90d: ninetyAgoObs ? latest.value - ninetyAgoObs.value : null,
    })
  }

  // Attribution events: per-platform breakdown with conversion rate.
  // bucket='attribution' rows credit a platform for first-touch
  // discovery; we count those, then derive conversion as
  // (count where wedding.status='booked') / count.
  type AttribRow = {
    source_platform: string
    bucket: string
    weddings: { status: string } | { status: string }[] | null
  }
  const attribByPlatform = new Map<
    string,
    { count: number; booked: number }
  >()
  for (const r of (attributionEventsResult.data ?? []) as AttribRow[]) {
    if (r.bucket !== 'attribution') continue
    const platform = r.source_platform || 'unknown'
    const existing = attribByPlatform.get(platform) ?? { count: 0, booked: 0 }
    existing.count += 1
    // Supabase nested-select can return either an object or single-element
    // array depending on the FK shape. Normalise.
    const w = Array.isArray(r.weddings) ? r.weddings[0] : r.weddings
    if (w && w.status === 'booked') existing.booked += 1
    attribByPlatform.set(platform, existing)
  }
  const attributionByPlatform: AttributionPlatformRow[] = Array.from(
    attribByPlatform.entries(),
  )
    .map(([platform, v]) => ({
      platform,
      count: v.count,
      conversion_rate: v.count > 0 ? v.booked / v.count : 0,
    }))
    .sort((a, b) => b.count - a.count)

  // Candidate identity summary.
  const candidateRows = candidateIdentitiesResult.data ?? []
  const candidateTotal = candidateRows.length
  const candidateResolved = candidateRows.filter(
    (r) => (r as { resolved_wedding_id: string | null }).resolved_wedding_id != null,
  ).length
  const candidateIdentitySummary: CandidateIdentitySummary = {
    total: candidateTotal,
    resolved_count: candidateResolved,
    unresolved_count: candidateTotal - candidateResolved,
    conversion_rate: candidateTotal > 0 ? candidateResolved / candidateTotal : 0,
  }

  // Cultural moments — VENUE-confirmed only, last-90d window. Migration
  // 167 split state per-venue, so the query joins venue_cultural_moment_state
  // -> cultural_moments. The supabase JS embed returns the nested shape
  // { cultural_moments: { ... } | [...] } depending on the FK
  // direction. We tolerate both for safety.
  type NestedMomentRow = {
    cultural_moments:
      | {
          title?: string
          category?: string | null
          start_at?: string
          end_at?: string | null
          influence_weight?: number | null
          geo_scope?: string | null
        }
      | Array<{
          title?: string
          category?: string | null
          start_at?: string
          end_at?: string | null
          influence_weight?: number | null
          geo_scope?: string | null
        }>
      | null
  }
  const culturalMoments: CulturalMomentRow[] = (
    (culturalMomentsResult.data ?? []) as unknown as NestedMomentRow[]
  )
    .map((r) => {
      const m = Array.isArray(r.cultural_moments)
        ? r.cultural_moments[0]
        : r.cultural_moments
      if (!m) return null
      return {
        name: m.title ?? '',
        category: m.category ?? null,
        start_date: (m.start_at ?? '').split('T')[0],
        end_date: m.end_at ? (m.end_at ?? '').split('T')[0] : null,
        influence_weight: m.influence_weight ?? null,
        geography: m.geo_scope ?? null,
      } satisfies CulturalMomentRow
    })
    .filter((x): x is CulturalMomentRow => x !== null)

  // External calendar events — filter by venue's geo_scope hierarchy
  // (us / us_<state> / us_<state>_<metro>). The DB query already pulled
  // up to 100 future-window events; here we hierarchy-match.
  const venueState = ((venueResult.data?.state as string | null) ?? '')
    .trim()
    .toLowerCase()
  const venueScope: string =
    venueState && /^[a-z]{2}$/.test(venueState) ? `us_${venueState}` : 'us'
  const expandScopes = (scope: string): string[] => {
    const parts = scope.split('_')
    const out: string[] = []
    for (let i = 1; i <= parts.length; i++) {
      out.push(parts.slice(0, i).join('_'))
    }
    return out
  }
  const allowedScopes = new Set(expandScopes(venueScope))
  const upcomingCalendarEvents: CalendarEventRow[] = (
    calendarEventsResult.data ?? []
  )
    .filter((r) => allowedScopes.has((r.geo_scope as string) ?? ''))
    .map((r) => ({
      name: (r.title as string) ?? '',
      category: (r.category as string) ?? 'other',
      date: (r.start_date as string) ?? '',
      geo_scope: (r.geo_scope as string) ?? 'us',
    }))
    .slice(0, 30)

  // Coordinator absences.
  type CoordAbsenceRaw = {
    start_at: string
    end_at: string
    reason: string
    handoff_notes: string | null
    user_profiles: { full_name: string } | { full_name: string }[] | null
  }
  const coordinatorAbsences: CoordinatorAbsenceRow[] = (
    (coordinatorAbsencesResult.data ?? []) as CoordAbsenceRaw[]
  ).map((r) => {
    const profile = Array.isArray(r.user_profiles) ? r.user_profiles[0] : r.user_profiles
    return {
      start_date: (r.start_at ?? '').split('T')[0],
      end_date: (r.end_at ?? '').split('T')[0],
      reason: r.reason ?? '',
      coordinator_name: profile?.full_name ?? null,
    }
  })

  // Operational state.
  const venueOperationalState: OperationalStateRow[] = (
    operationalStateResult.data ?? []
  ).map((r) => ({
    state_type: (r.state_type as string) ?? 'other',
    start_date: ((r.start_at as string) ?? '').split('T')[0],
    end_date: r.end_at ? ((r.end_at as string) ?? '').split('T')[0] : null,
    description:
      (r.title as string) +
      (r.description ? `: ${r.description as string}` : ''),
  }))

  // Pricing history. The new_value/old_value are jsonb {value: <num>};
  // surface field_name as package_name for the prompt.
  type JsonValue = { value?: number | string | null } | null
  const pricingHistory: PricingHistoryRow[] = (
    pricingHistoryResult.data ?? []
  ).map((r) => {
    const oldVal = (r.old_value as JsonValue)?.value
    const newVal = (r.new_value as JsonValue)?.value
    return {
      effective_date: ((r.changed_at as string) ?? '').split('T')[0],
      package_name: (r.field_name as string) ?? 'unknown',
      prior_price: typeof oldVal === 'number' ? oldVal : null,
      new_price: typeof newVal === 'number' ? newVal : null,
    }
  })

  // Marketing channels.
  const marketingChannels: MarketingChannelRow[] = (
    marketingChannelsResult.data ?? []
  ).map((r) => ({
    name: (r.label as string) ?? (r.key as string) ?? '',
    source_key: (r.key as string) ?? '',
    active: !!r.is_active,
  }))

  // Recent inbound interactions — truncate to 200 chars per spec.
  const recentInteractionSnippets: InteractionSnippet[] = (
    interactionsResult.data ?? []
  ).map((r) => {
    const body = ((r.full_body as string | null) ?? (r.body_preview as string | null) ?? '').trim()
    const snippet = body.length > 200 ? body.slice(0, 200) : body
    return {
      date: ((r.timestamp as string) ?? '').split('T')[0],
      snippet,
    }
  }).filter((s) => s.snippet.length > 0)

  // Tour cancellation reasons — tours.cancellation_reason (migration 166).
  // Why-the-tour-itself-was-cancelled signal: weather / date_conflict /
  // family_emergency / etc. Distinct from lost-deal reasons below.
  const tourCancelCounts = new Map<string, number>()
  for (const r of tourCancelResult.data ?? []) {
    const reason = (r.cancellation_reason as string | null) ?? null
    if (!reason) continue
    tourCancelCounts.set(reason, (tourCancelCounts.get(reason) ?? 0) + 1)
  }
  const tourCancellationReasons: TourCancellationReasonRow[] = Array.from(
    tourCancelCounts.entries(),
  )
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)

  // Lost-deal reasons at the tour stage — lost_deals.reason_category.
  // Why-the-deal-died signal: couple chose competitor / price / timing /
  // etc. The two lenses are intentionally separate so Sage doesn't
  // conflate "tour cancelled (rescheduled)" with "deal lost at tour".
  const lostDealCounts = new Map<string, number>()
  for (const r of lostDealsResult.data ?? []) {
    const reason = (r.reason_category as string | null) ?? null
    if (!reason) continue
    lostDealCounts.set(reason, (lostDealCounts.get(reason) ?? 0) + 1)
  }
  const lostDealReasons: LostDealReasonRow[] = Array.from(
    lostDealCounts.entries(),
  )
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)

  // T5-PP: tours bucketed by month (UTC). Outcome breakdown lets Sage
  // answer "busiest tour month" AND distinguish completed vs cancelled
  // (a month with 30 scheduled / 25 completed vs 30 scheduled / 5
  // completed are different stories). Pending = outcome IS NULL.
  type ToursBucket = {
    count: number
    completed: number
    cancelled: number
    no_show: number
    rescheduled: number
    pending: number
  }
  const toursMonthMap = new Map<string, ToursBucket>()
  for (const r of toursByMonthResult.data ?? []) {
    const scheduled = r.scheduled_at as string | null
    if (!scheduled) continue
    const monthKey = scheduled.slice(0, 7) // 'YYYY-MM' (UTC ISO prefix)
    if (!monthKey) continue
    const bucket = toursMonthMap.get(monthKey) ?? {
      count: 0,
      completed: 0,
      cancelled: 0,
      no_show: 0,
      rescheduled: 0,
      pending: 0,
    }
    bucket.count += 1
    const outcome = (r.outcome as string | null) ?? null
    if (outcome === 'completed') bucket.completed += 1
    else if (outcome === 'cancelled') bucket.cancelled += 1
    else if (outcome === 'no_show') bucket.no_show += 1
    else if (outcome === 'rescheduled') bucket.rescheduled += 1
    else bucket.pending += 1
    toursMonthMap.set(monthKey, bucket)
  }
  const toursByMonth: ToursByMonthRow[] = Array.from(toursMonthMap.entries())
    .map(([month, b]) => ({ month, ...b }))
    // Newest month first so the "busiest recent" scan is at the top.
    .sort((a, b) => b.month.localeCompare(a.month))

  // T5-PP: marketing_spend by source × month. We bucket month dates to
  // 'YYYY-MM' so duplicate writes against the same source+month merge
  // (rare, but harmless). The notes field carries confidence flags
  // (`high`, `medium`, `low`) when set by the loader so Sage can reason
  // about data quality.
  type SpendBucket = { amount: number; notes: string | null }
  const spendMap = new Map<string, SpendBucket>()
  for (const r of marketingSpendDirectResult.data ?? []) {
    const source = (r.source as string | null) ?? 'unknown'
    const monthRaw = (r.month as string | null) ?? ''
    if (!monthRaw) continue
    const monthKey = monthRaw.slice(0, 7) // 'YYYY-MM'
    const amount = Number(r.amount ?? 0)
    if (!Number.isFinite(amount)) continue
    const key = `${source}::${monthKey}`
    const existing = spendMap.get(key) ?? { amount: 0, notes: null }
    existing.amount += amount
    if (!existing.notes && r.notes) existing.notes = r.notes as string
    spendMap.set(key, existing)
  }
  const marketingSpendByMonth: MarketingSpendByMonthRow[] = Array.from(
    spendMap.entries(),
  )
    .map(([key, v]) => {
      const [source, month] = key.split('::')
      return { source, month, amount: v.amount, notes: v.notes }
    })
    .sort((a, b) => {
      // Newest month first; within a month, biggest spend first.
      if (a.month !== b.month) return b.month.localeCompare(a.month)
      return b.amount - a.amount
    })

  return {
    venueName: (venueResult.data?.name as string) ?? 'Unknown Venue',
    recentWeddings: (weddingsResult.data ?? []) as WeddingSummary[],
    pipelineCounts,
    sourceAttribution: (attributionResult.data ?? []) as SourceAttributionRow[],
    trendDeviations: (trendsResult.data ?? []) as TrendDeviationRow[],
    recentRecommendations: (recommendationsResult.data ?? []) as RecommendationRow[],
    weatherForecast: (weatherResult.data ?? []) as WeatherRow[],
    economicIndicators: indicators,
    consultantMetrics: (consultantResult.data ?? []) as ConsultantMetricRow[],
    topPhrases: (phrasesResult.data ?? []) as PhraseRow[],
    // T5-θ.2 new fields
    attributionByPlatform,
    candidateIdentitySummary,
    culturalMoments,
    fredSeriesDeltas,
    upcomingCalendarEvents,
    coordinatorAbsences,
    venueOperationalState,
    pricingHistory,
    marketingChannels,
    recentInteractionSnippets,
    tourCancellationReasons,
    lostDealReasons,
    // T5-PP new fields
    toursByMonth,
    marketingSpendByMonth,
  }
}

/**
 * Format venue data into a readable context block for the AI.
 */
function formatDataContext(data: VenueDataContext): string {
  const sections: string[] = []

  // Pipeline summary
  if (Object.keys(data.pipelineCounts).length > 0) {
    const pipelineLines = Object.entries(data.pipelineCounts)
      .map(([status, count]) => `  ${status}: ${count}`)
      .join('\n')
    sections.push(`ACTIVE PIPELINE:\n${pipelineLines}`)
  }

  // Recent weddings
  if (data.recentWeddings.length > 0) {
    const weddingLines = data.recentWeddings.map((w) => {
      const parts = [`status=${w.status}`, `source=${w.source ?? 'unknown'}`]
      // booking_value is cents per Bloom convention (T5-Rixey-NN bug #8); show dollars.
      if (w.booking_value) parts.push(`value=$${(w.booking_value / 100).toFixed(2)}`)
      if (w.guest_count_estimate) parts.push(`guests=${w.guest_count_estimate}`)
      if (w.wedding_date) parts.push(`date=${w.wedding_date}`)
      if (w.inquiry_date) parts.push(`inquiry=${w.inquiry_date}`)
      if (w.heat_score) parts.push(`heat=${w.heat_score} (${w.temperature_tier})`)
      if (w.lost_reason) parts.push(`lost_reason="${w.lost_reason}"`)
      return `  - ${parts.join(', ')}`
    }).join('\n')
    sections.push(`RECENT WEDDINGS (last 365 days activity, top 200 by recency):\n${weddingLines}`)
  } else {
    sections.push('RECENT WEDDINGS: No wedding activity in the last 365 days.')
  }

  // Source attribution
  if (data.sourceAttribution.length > 0) {
    const attrLines = data.sourceAttribution.map((a) => {
      const parts = [`source=${a.source}`, `period=${a.period_start} to ${a.period_end}`]
      if (a.spend != null) parts.push(`spend=$${a.spend}`)
      if (a.inquiries != null) parts.push(`inquiries=${a.inquiries}`)
      if (a.tours != null) parts.push(`tours=${a.tours}`)
      if (a.bookings != null) parts.push(`bookings=${a.bookings}`)
      if (a.revenue != null) parts.push(`revenue=$${a.revenue}`)
      if (a.cost_per_inquiry != null) parts.push(`CPI=$${a.cost_per_inquiry}`)
      if (a.cost_per_booking != null) parts.push(`CPB=$${a.cost_per_booking}`)
      if (a.conversion_rate != null) parts.push(`conv=${a.conversion_rate}%`)
      if (a.roi != null) parts.push(`ROI=${a.roi}%`)
      return `  - ${parts.join(', ')}`
    }).join('\n')
    sections.push(`SOURCE ATTRIBUTION:\n${attrLines}`)
  }

  // Search trends
  if (data.trendDeviations.length > 0) {
    // Group by term and show latest interest values
    const byTerm = new Map<string, { week: string; interest: number }[]>()
    for (const row of data.trendDeviations) {
      if (!byTerm.has(row.term)) byTerm.set(row.term, [])
      byTerm.get(row.term)!.push({ week: row.week, interest: row.interest })
    }
    const trendLines = Array.from(byTerm.entries())
      .map(([term, points]) => {
        const sorted = points.sort((a, b) => b.week.localeCompare(a.week))
        const latest = sorted[0]
        const oldest = sorted[sorted.length - 1]
        return `  - "${term}": latest=${latest.interest} (${latest.week}), earliest in window=${oldest.interest} (${oldest.week})`
      })
      .join('\n')
    sections.push(`SEARCH TRENDS (last 8 weeks):\n${trendLines}`)
  }

  // Recommendations
  if (data.recentRecommendations.length > 0) {
    const recLines = data.recentRecommendations.map((r) =>
      `  - [${r.recommendation_type}] ${r.title} (priority=${r.priority}, status=${r.status})`
    ).join('\n')
    sections.push(`RECENT AI RECOMMENDATIONS:\n${recLines}`)
  }

  // Weather
  if (data.weatherForecast.length > 0) {
    const weatherLines = data.weatherForecast.map((w) =>
      `  - ${w.date}: ${w.conditions ?? 'N/A'}, high=${w.high_temp ?? '?'}°F, low=${w.low_temp ?? '?'}°F, precip=${w.precipitation ?? 0}in`
    ).join('\n')
    sections.push(`WEATHER FORECAST (next 14 days):\n${weatherLines}`)
  }

  // Economic indicators
  if (Object.keys(data.economicIndicators).length > 0) {
    const ecoLines = Object.entries(data.economicIndicators)
      .map(([name, value]) => `  - ${name}: ${value}`)
      .join('\n')
    sections.push(`ECONOMIC INDICATORS (latest):\n${ecoLines}`)
  }

  // Consultant metrics
  if (data.consultantMetrics.length > 0) {
    const consultLines = data.consultantMetrics.map((c) => {
      const parts = [`consultant=${c.consultant_id.substring(0, 8)}...`]
      if (c.inquiries_handled != null) parts.push(`inquiries=${c.inquiries_handled}`)
      if (c.tours_booked != null) parts.push(`tours=${c.tours_booked}`)
      if (c.bookings_closed != null) parts.push(`bookings=${c.bookings_closed}`)
      if (c.conversion_rate != null) parts.push(`conv=${c.conversion_rate}%`)
      if (c.avg_response_time_minutes != null) parts.push(`avg_response=${c.avg_response_time_minutes}min`)
      if (c.avg_booking_value != null) parts.push(`avg_value=$${c.avg_booking_value}`)
      return `  - ${parts.join(', ')}`
    }).join('\n')
    sections.push(`CONSULTANT METRICS:\n${consultLines}`)
  }

  // Review language
  if (data.topPhrases.length > 0) {
    const phraseLines = data.topPhrases.map((p) =>
      `  - "${p.phrase}" (theme=${p.theme}, sentiment=${p.sentiment_score}, freq=${p.frequency})`
    ).join('\n')
    sections.push(`TOP REVIEW PHRASES:\n${phraseLines}`)
  }

  // ---------------------------------------------------------------------
  // T5-θ.2 cross-limb sections
  // ---------------------------------------------------------------------

  // Attribution by platform (last 90d)
  if (data.attributionByPlatform.length > 0) {
    const lines = data.attributionByPlatform
      .map(
        (a) =>
          `  - ${a.platform}: ${a.count} attribution events, ${
            (a.conversion_rate * 100).toFixed(1)
          }% booked-conversion`,
      )
      .join('\n')
    sections.push(`ATTRIBUTION BY PLATFORM (last 90 days):\n${lines}`)
  }

  // Candidate identity summary
  {
    const c = data.candidateIdentitySummary
    if (c.total > 0) {
      sections.push(
        `CANDIDATE IDENTITIES:\n  total=${c.total}, resolved=${c.resolved_count}, unresolved=${c.unresolved_count}, resolved_rate=${(c.conversion_rate * 100).toFixed(1)}%`,
      )
    }
  }

  // Cultural moments
  if (data.culturalMoments.length > 0) {
    const lines = data.culturalMoments
      .map((m) => {
        const parts = [`name="${m.name}"`]
        if (m.category) parts.push(`category=${m.category}`)
        parts.push(`window=${m.start_date}${m.end_date ? ` to ${m.end_date}` : ' (ongoing)'}`)
        if (m.influence_weight != null) parts.push(`influence=${m.influence_weight}`)
        if (m.geography) parts.push(`geo=${m.geography}`)
        return `  - ${parts.join(', ')}`
      })
      .join('\n')
    sections.push(`CULTURAL MOMENTS (confirmed, last 90d window):\n${lines}`)
  }

  // FRED series with deltas
  if (data.fredSeriesDeltas.length > 0) {
    const lines = data.fredSeriesDeltas
      .map((s) => {
        const parts = [`${s.label} (${s.series_id})`, `latest=${s.latest_value}`]
        if (s.latest_date) parts.push(`as_of=${s.latest_date}`)
        if (s.delta_30d != null) parts.push(`Δ30d=${s.delta_30d.toFixed(2)}`)
        if (s.delta_90d != null) parts.push(`Δ90d=${s.delta_90d.toFixed(2)}`)
        return `  - ${parts.join(', ')}`
      })
      .join('\n')
    sections.push(`FRED INDICATORS (latest + 30d/90d delta):\n${lines}`)
  }

  // Upcoming calendar events
  if (data.upcomingCalendarEvents.length > 0) {
    const lines = data.upcomingCalendarEvents
      .map(
        (e) =>
          `  - ${e.date}: ${e.name} [${e.category}] (${e.geo_scope})`,
      )
      .join('\n')
    sections.push(`UPCOMING CALENDAR EVENTS (next 90d):\n${lines}`)
  }

  // Coordinator absences
  if (data.coordinatorAbsences.length > 0) {
    const lines = data.coordinatorAbsences
      .map(
        (a) =>
          `  - ${a.start_date} to ${a.end_date}: ${a.reason}${
            a.coordinator_name ? ` (${a.coordinator_name})` : ' (venue-wide)'
          }`,
      )
      .join('\n')
    sections.push(`COORDINATOR ABSENCES (active or upcoming):\n${lines}`)
  }

  // Operational state
  if (data.venueOperationalState.length > 0) {
    const lines = data.venueOperationalState
      .map(
        (s) =>
          `  - [${s.state_type}] ${s.start_date}${
            s.end_date ? ` to ${s.end_date}` : ' (ongoing)'
          }: ${s.description}`,
      )
      .join('\n')
    sections.push(`VENUE OPERATIONAL STATE (active windows):\n${lines}`)
  }

  // Pricing history
  if (data.pricingHistory.length > 0) {
    const lines = data.pricingHistory
      .map((p) => {
        const parts = [`${p.effective_date}: ${p.package_name}`]
        if (p.prior_price != null && p.new_price != null) {
          parts.push(`$${p.prior_price} → $${p.new_price}`)
        } else if (p.new_price != null) {
          parts.push(`new=$${p.new_price}`)
        }
        return `  - ${parts.join(' | ')}`
      })
      .join('\n')
    sections.push(`PRICING HISTORY (last 365d):\n${lines}`)
  }

  // Marketing channels
  if (data.marketingChannels.length > 0) {
    const lines = data.marketingChannels
      .map(
        (m) =>
          `  - ${m.name} (${m.source_key})${m.active ? '' : ' [inactive]'}`,
      )
      .join('\n')
    sections.push(`MARKETING CHANNELS (registry):\n${lines}`)
  }

  // Recent inbound interaction snippets
  if (data.recentInteractionSnippets.length > 0) {
    const lines = data.recentInteractionSnippets
      .map((i) => `  - ${i.date}: "${i.snippet.replace(/\s+/g, ' ').trim()}"`)
      .join('\n')
    sections.push(`RECENT INBOUND INTERACTIONS (last 90d, top 20 by recency, 200-char excerpt):\n${lines}`)
  }

  // Tour cancellation reasons (migration 166) — WHY THE TOUR ITSELF
  // WAS CANCELLED. The tour never happened, but the lead may still
  // book later (e.g., 'rescheduled', 'weather'). Distinct from lost-
  // deal reasons below.
  if (data.tourCancellationReasons.length > 0) {
    const lines = data.tourCancellationReasons
      .map((r) => `  - ${r.reason}: ${r.count}`)
      .join('\n')
    sections.push(
      `TOUR CANCELLATION REASONS — why scheduled tours did not happen ` +
      `(last 365d, tours.cancellation_reason). Lead may still be alive ` +
      `(reschedule succeeds → couple books later):\n${lines}`,
    )
  }

  // Lost-deal reasons at the tour stage — WHY THE DEAL DIED. Sometimes
  // even a tour that happened ended in the couple choosing another
  // venue. Distinct from "tour cancelled" above.
  if (data.lostDealReasons.length > 0) {
    const lines = data.lostDealReasons
      .map((r) => `  - ${r.reason}: ${r.count}`)
      .join('\n')
    sections.push(
      `LOST-DEAL REASONS AT TOUR STAGE — why deals died at the tour ` +
      `point in the funnel (last 365d, lost_deals.reason_category). ` +
      `Different lens from TOUR CANCELLATION REASONS: this is "couple ` +
      `picked competitor" / "price" / "timing" — the deal is over.\n${lines}`,
    )
  }

  // T5-PP — Tours bucketed by month (busiest-month questions).
  if (data.toursByMonth.length > 0) {
    const lines = data.toursByMonth
      .map(
        (t) =>
          `  - ${t.month}: total=${t.count}, completed=${t.completed}, ` +
          `cancelled=${t.cancelled}, no_show=${t.no_show}, ` +
          `rescheduled=${t.rescheduled}, pending=${t.pending}`,
      )
      .join('\n')
    sections.push(
      `TOURS BY MONTH (last 12 months, scheduled_at, UTC):\n${lines}`,
    )
  }

  // T5-PP — Direct marketing_spend (always-fresh complement to source
  // attribution rollups). Format groups all sources for a given month
  // so the AI can compare cross-channel spend without re-shuffling.
  if (data.marketingSpendByMonth.length > 0) {
    const byMonth = new Map<string, MarketingSpendByMonthRow[]>()
    for (const r of data.marketingSpendByMonth) {
      const arr = byMonth.get(r.month) ?? []
      arr.push(r)
      byMonth.set(r.month, arr)
    }
    const lines = Array.from(byMonth.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, rows]) => {
        const inner = rows
          .map((r) => {
            const note = r.notes ? ` [${r.notes}]` : ''
            return `${r.source}=$${r.amount.toFixed(2)}${note}`
          })
          .join(', ')
        return `  - ${month}: ${inner}`
      })
      .join('\n')
    sections.push(
      `MARKETING SPEND BY MONTH (last 12 months, direct from ` +
      `marketing_spend — always fresh, independent of the weekly ` +
      `source_attribution cron):\n${lines}`,
    )
  }

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Answer a natural language question about venue data.
 *
 * Gathers recent venue data (weddings, attribution, trends, weather, etc.),
 * feeds it as context alongside the question to the AI, logs the query and
 * response, and returns the answer.
 */
export async function answerNaturalLanguageQuery(
  venueId: string,
  userId: string,
  query: string
): Promise<NLQResult> {
  const supabase = createServiceClient()

  // Gather all relevant venue data
  const venueData = await gatherVenueData(venueId)
  const dataContext = formatDataContext(venueData)

  // Call AI with venue data as context
  const aiResult = await callAI({
    systemPrompt: buildNLQSystemPrompt(venueData.venueName),
    userPrompt: `Here is the current data for ${venueData.venueName}:\n\n${dataContext}\n\n---\n\nQuestion: ${query}`,
    maxTokens: 1500,
    temperature: 0.3,
    venueId,
    taskType: 'natural_language_query',
    promptVersion: BRAIN_PROMPT_VERSION,
  })

  // Log the query and response
  const { data: logEntry, error: logError } = await supabase
    .from('natural_language_queries')
    .insert({
      venue_id: venueId,
      user_id: userId,
      query_text: query,
      response_text: aiResult.text,
      model_used: CLAUDE_MODEL,
      tokens_used: aiResult.inputTokens + aiResult.outputTokens,
      cost: aiResult.cost,
    })
    .select('id')
    .single()

  if (logError) {
    console.error('[intel-brain] Failed to log NLQ:', logError.message)
  }

  return {
    response: aiResult.text,
    queryId: (logEntry?.id as string) ?? '',
    tokensUsed: aiResult.inputTokens + aiResult.outputTokens,
    cost: aiResult.cost,
  }
}

/**
 * Generate 3-5 marketing positioning suggestions based on review language,
 * trend data, and venue configuration.
 */
export async function generatePositioningSuggestions(
  venueId: string
): Promise<PositioningSuggestionsResult> {
  const supabase = createServiceClient()

  // Pull review language, trend data, and venue config in parallel
  const [venueResult, configResult, phrasesResult, trendsResult, attributionResult] = await Promise.all([
    supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .single(),

    supabase
      .from('venue_config')
      .select('business_name, catering_model, bar_model, capacity, base_price')
      .eq('venue_id', venueId)
      .single(),

    supabase
      .from('review_language')
      .select('phrase, theme, sentiment_score, frequency')
      .eq('venue_id', venueId)
      .order('frequency', { ascending: false })
      .limit(25),

    supabase
      .from('search_trends')
      .select('term, week, interest')
      .eq('venue_id', venueId)
      .gte('week', new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('week', { ascending: false })
      .limit(80),

    supabase
      .from('source_attribution')
      .select('source, inquiries, bookings, revenue, roi')
      .eq('venue_id', venueId)
      .order('calculated_at', { ascending: false })
      .limit(10),
  ])

  const venueName = (venueResult.data?.name as string) ?? 'the venue'
  const config = configResult.data
  const phrases = phrasesResult.data ?? []
  const trends = trendsResult.data ?? []
  const attribution = attributionResult.data ?? []

  // Build context for positioning AI
  const contextParts: string[] = []

  contextParts.push(`Venue: ${venueName}`)
  if (config) {
    const details: string[] = []
    if (config.capacity) details.push(`capacity=${config.capacity}`)
    if (config.base_price) details.push(`base_price=$${config.base_price}`)
    if (config.catering_model) details.push(`catering=${config.catering_model}`)
    if (config.bar_model) details.push(`bar=${config.bar_model}`)
    if (details.length > 0) contextParts.push(`Venue details: ${details.join(', ')}`)
  }

  if (phrases.length > 0) {
    const phrasesByTheme = new Map<string, string[]>()
    for (const p of phrases) {
      const theme = p.theme as string
      if (!phrasesByTheme.has(theme)) phrasesByTheme.set(theme, [])
      phrasesByTheme.get(theme)!.push(`"${p.phrase}" (sentiment=${p.sentiment_score}, freq=${p.frequency})`)
    }
    const phraseText = Array.from(phrasesByTheme.entries())
      .map(([theme, items]) => `  ${theme}: ${items.join(', ')}`)
      .join('\n')
    contextParts.push(`Review language by theme:\n${phraseText}`)
  }

  if (trends.length > 0) {
    const byTerm = new Map<string, number[]>()
    for (const t of trends) {
      const term = t.term as string
      if (!byTerm.has(term)) byTerm.set(term, [])
      byTerm.get(term)!.push(t.interest as number)
    }
    const trendText = Array.from(byTerm.entries())
      .map(([term, values]) => `  "${term}": avg interest=${Math.round(values.reduce((s, v) => s + v, 0) / values.length)}`)
      .join('\n')
    contextParts.push(`Trending search terms:\n${trendText}`)
  }

  if (attribution.length > 0) {
    const attrText = attribution.map((a) => {
      const parts = [`${a.source}`]
      if (a.inquiries != null) parts.push(`inq=${a.inquiries}`)
      if (a.bookings != null) parts.push(`bookings=${a.bookings}`)
      if (a.roi != null) parts.push(`ROI=${a.roi}%`)
      return `  ${parts.join(', ')}`
    }).join('\n')
    contextParts.push(`Source performance:\n${attrText}`)
  }

  const result = await callAIJson<PositioningSuggestionsResult>({
    systemPrompt: `You are a wedding venue marketing strategist. Given a venue's review language, search trends, and performance data, generate 3-5 marketing positioning suggestions.

Each suggestion should:
- Identify a specific angle or message the venue should lean into
- Be grounded in actual data (what guests say, what people search for, what converts)
- Include a concrete copy example the venue could use on their website, social media, or advertising

Return JSON matching this structure:
{
  "suggestions": [
    {
      "title": "Short positioning headline (under 60 chars)",
      "rationale": "2-3 sentences explaining why this positioning works, citing specific data points",
      "copy_example": "A sample marketing line or paragraph the venue could use"
    }
  ]
}

Rules:
- Ground every suggestion in the data provided — don't invent themes not reflected in reviews or trends
- Make copy examples sound human and warm, not corporate
- Prioritize suggestions by potential impact (strongest positioning first)
- If search trends show rising interest in a specific wedding type, suggest capitalizing on it
- If reviews consistently praise something, suggest making it a headline feature`,

    userPrompt: contextParts.join('\n\n'),
    maxTokens: 1500,
    temperature: 0.5,
    venueId,
    taskType: 'positioning_suggestions',
    promptVersion: BRAIN_PROMPT_VERSION,
  })

  // Validate the response
  if (!result.suggestions || !Array.isArray(result.suggestions)) {
    return { suggestions: [] }
  }

  // Filter out any malformed suggestions
  const validSuggestions = result.suggestions.filter(
    (s) => s.title && s.rationale && s.copy_example
  )

  return { suggestions: validSuggestions }
}

/**
 * Mark a previously logged NLQ as helpful or not helpful.
 * Used to improve future responses through feedback tracking.
 */
export async function markQueryHelpful(
  queryId: string,
  helpful: boolean
): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('natural_language_queries')
    .update({ helpful })
    .eq('id', queryId)

  if (error) throw error
}
