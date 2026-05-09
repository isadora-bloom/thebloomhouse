/**
 * Bloom House: "What Bloom Learned This Week" digest (Phase 5 Task 50).
 *
 * Produces three bullets for the intel dashboard:
 *   - voice   : voice-training and voice-preference activity in the last 7 days
 *   - booking : pipeline motion (bookings vs last week, otherwise inquiries)
 *   - source  : highest-priority lead-conversion insight, with a source-quality
 *               fallback derived from computeSourceQuality
 *
 * Each bullet is either a populated string or an explicit empty state that
 * explains the data gap. No generic placeholder copy ever emitted.
 *
 * The AI name is always read from venue_ai_config.ai_name so the card is
 * white-label safe. Never hardcode 'Sage'.
 *
 * AI-VS-TEMPLATED-AUDIT finding #5: in addition to the deterministic
 * bullets above, the digest now composes a 3-5 sentence weekly
 * observation via Sonnet. The deterministic counts become STRUCTURED
 * INPUT to the LLM call; the LLM narrates the week as a paragraph that
 * a coordinator reads as "the AI noticed patterns this week", not
 * "Sage learned 5 voice preferences" (which is a count, not a learning).
 *
 * Both paths are kept: when the LLM call fails or `gateForBrainCall`
 * closes (autonomous paused, cost ceiling), the bullets remain the
 * safety net. The response is stamped with `narration_source` so the
 * UI can render the narrative paragraph (LLM path) or fall back to
 * bullet rendering (template path).
 */

import { createServiceClient } from '@/lib/supabase/service'
import { computeSourceQuality } from '@/lib/services/intel/source-quality'
import { callAIJson } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'

export const WEEKLY_LEARNED_PROMPT_VERSION = 'weekly-learned.v1'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WeeklyLearnedBullet =
  | { kind: 'voice'; text: string; empty?: false }
  | { kind: 'voice'; empty: true; text: string }
  | { kind: 'booking'; text: string; empty?: false }
  | { kind: 'booking'; empty: true; text: string }
  | { kind: 'source'; text: string; empty?: false }
  | { kind: 'source'; empty: true; text: string }
  | { kind: 'correlation'; text: string; empty?: false }
  | { kind: 'multi_touch_journey'; text: string; empty?: false }

export interface WeeklyLearned {
  aiName: string
  bullets: WeeklyLearnedBullet[]
  /**
   * 3-5 sentence weekly observation composed by Sonnet from the same
   * structured counts the bullets are derived from. Null when the LLM
   * call failed, the cost-ceiling gate closed, or there were no
   * non-empty bullets to narrate.
   *
   * UI contract: when this is non-null AND narration_source === 'llm',
   * render the paragraph as the headline body and the bullets become a
   * smaller "by the numbers" footer. When null OR narration_source ===
   * 'template', render the bullets as the primary content (legacy
   * behaviour).
   */
  narrative: string | null
  /**
   * Provenance stamp for the narration. AI-VS-TEMPLATED-AUDIT #5 +
   * cross-cutting recommendation: never frame templated counts as Sage
   * "learning" anything. When `narration_source === 'template'`, the UI
   * MUST avoid the "[Sage] learned" framing on the bullet headline.
   */
  narration_source: 'llm' | 'template'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// ---------------------------------------------------------------------------
// Bullet builders
// ---------------------------------------------------------------------------

async function buildVoiceBullet(
  venueId: string,
  aiName: string
): Promise<WeeklyLearnedBullet> {
  const supabase = createServiceClient()
  const sevenDaysAgo = daysAgoIso(7)

  // T5-Rixey-LL: window on signal_date (migration 179) so backfill-
  // derived voice anchors land on their underlying email's occurred_at,
  // not the import date. Pre-fix a Day-0 onboarding venue would always
  // see "waiting for voice training activity" because every imported
  // pref shared the import day's created_at and that day was no longer
  // "this week" by the time the coordinator opened the panel.
  const { count: prefCount } = await supabase
    .from('voice_preferences')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('signal_date', sevenDaysAgo)

  // Count voice training responses for this venue's sessions in the last 7 days.
  // voice_training_sessions.started_at IS the event timestamp (the game
  // session started time) — telemetry-correct as-is.
  const { data: recentSessions } = await supabase
    .from('voice_training_sessions')
    .select('id')
    .eq('venue_id', venueId)
    .gte('started_at', sevenDaysAgo)

  const sessionIds = (recentSessions ?? []).map((r) => r.id as string)
  let responseCount = 0
  if (sessionIds.length > 0) {
    // signal_date (migration 179) on voice_training_responses defaults to
    // created_at for live entries; backfill writers set it explicitly.
    const { count } = await supabase
      .from('voice_training_responses')
      .select('id', { count: 'exact', head: true })
      .in('session_id', sessionIds)
      .gte('signal_date', sevenDaysAgo)
    responseCount = count ?? 0
  }

  const prefs = prefCount ?? 0
  const total = prefs + responseCount

  if (total <= 0) {
    return {
      kind: 'voice',
      empty: true,
      text: `${aiName} is waiting for voice training activity.`,
    }
  }

  // Prefer the preference count for the headline number since those are
  // the durable learnings. Training responses are the raw signal.
  if (prefs > 0) {
    const plural = prefs === 1 ? 'new voice preference' : 'new voice preferences'
    return {
      kind: 'voice',
      text: `${aiName} learned ${prefs} ${plural} this week from your training games and review approvals.`,
    }
  }

  // Training happened but preferences haven't been derived yet.
  const plural = responseCount === 1 ? 'training response' : 'training responses'
  return {
    kind: 'voice',
    text: `${aiName} reviewed ${responseCount} ${plural} this week. Preferences will update once patterns emerge.`,
  }
}

async function buildBookingBullet(venueId: string): Promise<WeeklyLearnedBullet> {
  const supabase = createServiceClient()
  const sevenDaysAgo = daysAgoIso(7)
  const fourteenDaysAgo = daysAgoIso(14)

  const [thisWeekInquiries, thisWeekBookings, lastWeekBookings] = await Promise.all([
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('inquiry_date', sevenDaysAgo),
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .gte('booked_at', sevenDaysAgo),
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .gte('booked_at', fourteenDaysAgo)
      .lt('booked_at', sevenDaysAgo),
  ])

  const inquiries = thisWeekInquiries.count ?? 0
  const bookings = thisWeekBookings.count ?? 0
  const lastBookings = lastWeekBookings.count ?? 0

  if (bookings > 0) {
    const plural = bookings === 1 ? 'wedding' : 'weddings'
    const delta = bookings - lastBookings
    let suffix = ''
    if (delta > 0) {
      suffix = `, ${delta} more than last week`
    } else if (delta < 0) {
      suffix = `, ${Math.abs(delta)} fewer than last week`
    }
    return {
      kind: 'booking',
      text: `You confirmed ${bookings} ${plural} this week${suffix}.`,
    }
  }

  if (inquiries > 0) {
    const plural = inquiries === 1 ? 'new inquiry' : 'new inquiries'
    return {
      kind: 'booking',
      text: `${inquiries} ${plural} this week.`,
    }
  }

  return {
    kind: 'booking',
    empty: true,
    text: 'No new pipeline activity this week.',
  }
}

async function buildSourceBullet(venueId: string): Promise<WeeklyLearnedBullet> {
  const supabase = createServiceClient()
  const fourteenDaysAgo = daysAgoIso(14)

  // Pull recent lead-conversion / source-quality insights, highest priority first.
  const { data: insights } = await supabase
    .from('intelligence_insights')
    .select('title, priority, category, insight_type, created_at')
    .eq('venue_id', venueId)
    .or('category.eq.lead_conversion,insight_type.eq.source_quality')
    .gte('created_at', fourteenDaysAgo)
    .in('status', ['new', 'seen'])

  if (insights && insights.length > 0) {
    const priorityRank: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    }
    const top = [...insights].sort((a, b) => {
      const pa = priorityRank[(a.priority as string) ?? 'low'] ?? 0
      const pb = priorityRank[(b.priority as string) ?? 'low'] ?? 0
      if (pb !== pa) return pb - pa
      // Tie-break on recency.
      const ta = new Date((a.created_at as string) ?? 0).getTime()
      const tb = new Date((b.created_at as string) ?? 0).getTime()
      return tb - ta
    })[0]
    if (top?.title) {
      return { kind: 'source', text: top.title as string }
    }
  }

  // Fallback: rank sources by booking count + avg revenue.
  try {
    const rows = await computeSourceQuality(venueId)
    const ranked = rows
      .filter((r) => r.bookedCount >= 2)
      .sort((a, b) => {
        if (b.bookedCount !== a.bookedCount) return b.bookedCount - a.bookedCount
        return b.avgRevenue - a.avgRevenue
      })
    const top = ranked[0]
    if (top && top.avgRevenue > 0) {
      // T5-Rixey-VV Y1: avgRevenue is now in CENTS — divide here for
      // display. computeSourceQuality changed to keep cents-scale
      // consistent with Stream RR doctrine.
      const avgDollars = top.avgRevenue / 100
      return {
        kind: 'source',
        text: `${top.source} sent your highest-value couples this month: avg $${avgDollars.toFixed(0)} per booking.`,
      }
    }
  } catch (err) {
    console.error('[weekly-learned] source-quality fallback failed:', err)
  }

  return {
    kind: 'source',
    empty: true,
    text: 'Not enough booked weddings yet to rank sources.',
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function computeWeeklyLearned(
  venueId: string
): Promise<WeeklyLearned> {
  const supabase = createServiceClient()

  const { data: aiConfig } = await supabase
    .from('venue_ai_config')
    .select('ai_name')
    .eq('venue_id', venueId)
    .maybeSingle()

  const aiName =
    (aiConfig?.ai_name as string | undefined)?.trim() || 'Your AI assistant'

  const [voice, booking, source, correlation, multiTouch, counts] = await Promise.all([
    buildVoiceBullet(venueId, aiName),
    buildBookingBullet(venueId),
    buildSourceBullet(venueId),
    buildCorrelationBullet(venueId),
    buildMultiTouchJourneyBullet(venueId),
    gatherStructuredCounts(venueId),
  ])

  const bullets: WeeklyLearnedBullet[] = [voice, booking, source]
  if (correlation) bullets.push(correlation)
  if (multiTouch) bullets.push(multiTouch)

  // LLM narration. Cost-ceiling gate first; deterministic bullets are
  // the fallback when the gate closes or the call fails.
  let narrative: string | null = null
  let narration_source: 'llm' | 'template' = 'template'

  const hasNonEmptySignal = bullets.some((b) => !b.empty)
  if (hasNonEmptySignal) {
    const gate = await gateForBrainCall(venueId)
    if (gate.ok) {
      try {
        narrative = await composeWeeklyNarrative(venueId, aiName, counts, bullets)
        if (narrative) narration_source = 'llm'
      } catch (err) {
        // PII-redacted log; bullets carry the same numbers and still
        // render below the failure.
        console.warn(
          '[weekly-learned] narration failed; falling back to bullets:',
          redactError(err),
        )
      }
    }
  }

  return { aiName, bullets, narrative, narration_source }
}

// ---------------------------------------------------------------------------
// LLM narration
// ---------------------------------------------------------------------------

/**
 * Structured counts the LLM is allowed to reference. The bullets above
 * already shape these numbers into prose; the LLM gets the raw form so
 * it can compose its own sentences without re-deriving anything.
 *
 * Every field is either a non-negative integer or null. The LLM is
 * instructed to ignore null fields rather than substitute zeros (the
 * difference between "no data yet" and "zero events" matters).
 */
interface WeeklyStructuredCounts {
  voicePreferences: number
  voiceTrainingResponses: number
  bookingsThisWeek: number
  bookingsLastWeek: number
  inquiriesThisWeek: number
  topInsightTitle: string | null
  topInsightCategory: string | null
  topInsightPriority: string | null
  topSourceLabel: string | null
  topSourceAvgRevenueDollars: number | null
  strongestCorrelationTitle: string | null
  strongestCorrelationLagDays: number | null
  multiTouchInquiries: number | null
  multiTouchInquiriesTotal: number | null
}

async function gatherStructuredCounts(
  venueId: string,
): Promise<WeeklyStructuredCounts> {
  const supabase = createServiceClient()
  const sevenDaysAgo = daysAgoIso(7)
  const fourteenDaysAgo = daysAgoIso(14)

  // Voice
  const { count: prefCount } = await supabase
    .from('voice_preferences')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('signal_date', sevenDaysAgo)
  const { data: recentSessions } = await supabase
    .from('voice_training_sessions')
    .select('id')
    .eq('venue_id', venueId)
    .gte('started_at', sevenDaysAgo)
  const sessionIds = (recentSessions ?? []).map((r) => r.id as string)
  let trainingResponses = 0
  if (sessionIds.length > 0) {
    const { count } = await supabase
      .from('voice_training_responses')
      .select('id', { count: 'exact', head: true })
      .in('session_id', sessionIds)
      .gte('signal_date', sevenDaysAgo)
    trainingResponses = count ?? 0
  }

  // Pipeline motion
  const [thisWeekInquiries, thisWeekBookings, lastWeekBookings] = await Promise.all([
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('inquiry_date', sevenDaysAgo),
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .gte('booked_at', sevenDaysAgo),
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .gte('booked_at', daysAgoIso(14))
      .lt('booked_at', sevenDaysAgo),
  ])

  // Top lead-conversion insight
  let topInsightTitle: string | null = null
  let topInsightCategory: string | null = null
  let topInsightPriority: string | null = null
  const { data: insights } = await supabase
    .from('intelligence_insights')
    .select('title, priority, category, insight_type, created_at')
    .eq('venue_id', venueId)
    .or('category.eq.lead_conversion,insight_type.eq.source_quality')
    .gte('created_at', fourteenDaysAgo)
    .in('status', ['new', 'seen'])
  if (insights && insights.length > 0) {
    const priorityRank: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    }
    const top = [...insights].sort((a, b) => {
      const pa = priorityRank[(a.priority as string) ?? 'low'] ?? 0
      const pb = priorityRank[(b.priority as string) ?? 'low'] ?? 0
      if (pb !== pa) return pb - pa
      const ta = new Date((a.created_at as string) ?? 0).getTime()
      const tb = new Date((b.created_at as string) ?? 0).getTime()
      return tb - ta
    })[0]
    if (top?.title) {
      topInsightTitle = top.title as string
      topInsightCategory = (top.category as string | null) ?? null
      topInsightPriority = (top.priority as string | null) ?? null
    }
  }

  // Top source by booked count + avg revenue (cents -> dollars)
  let topSourceLabel: string | null = null
  let topSourceAvgRevenueDollars: number | null = null
  try {
    const rows = await computeSourceQuality(venueId)
    const ranked = rows
      .filter((r) => r.bookedCount >= 2)
      .sort((a, b) => {
        if (b.bookedCount !== a.bookedCount) return b.bookedCount - a.bookedCount
        return b.avgRevenue - a.avgRevenue
      })
    const top = ranked[0]
    if (top && top.avgRevenue > 0) {
      topSourceLabel = top.source
      topSourceAvgRevenueDollars = Math.round(top.avgRevenue / 100)
    }
  } catch (err) {
    console.warn('[weekly-learned] source-quality fetch for narrative failed:', redactError(err))
  }

  // Strongest correlation (mirror buildCorrelationBullet thresholds)
  let strongestCorrelationTitle: string | null = null
  let strongestCorrelationLagDays: number | null = null
  const { data: corr } = await supabase
    .from('intelligence_insights')
    .select('title, data_points, confidence')
    .eq('venue_id', venueId)
    .eq('insight_type', 'correlation')
    .gte('confidence', 0.7)
    .order('confidence', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (corr?.title) {
    strongestCorrelationTitle = corr.title as string
    const dp = (corr.data_points ?? {}) as { lag_days?: number }
    strongestCorrelationLagDays = Number.isFinite(Number(dp.lag_days))
      ? Number(dp.lag_days)
      : null
  }

  // Multi-touch journey aggregate. Mirrors buildMultiTouchJourneyBullet's
  // shape but only counts journeys vs total weekly inquiries.
  let multiTouchInquiries: number | null = null
  let multiTouchInquiriesTotal: number | null = null
  const { data: weeklyWeddings } = await supabase
    .from('weddings')
    .select(
      'id, inquiry_date, people!people_wedding_id_fkey(id)'
    )
    .eq('venue_id', venueId)
    .gte('inquiry_date', sevenDaysAgo)
  if (weeklyWeddings && weeklyWeddings.length > 0) {
    type WW = { id: string; inquiry_date: string; people?: Array<{ id: string }> }
    const rows = weeklyWeddings as unknown as WW[]
    const personIds = rows.flatMap((r) => (r.people ?? []).map((p) => p.id))
    if (personIds.length > 0) {
      const { data: signals } = await supabase
        .from('tangential_signals')
        .select('matched_person_id, signal_date')
        .in('matched_person_id', personIds)
        .not('signal_date', 'is', null)
      const sigByPerson = new Map<string, string[]>()
      for (const s of signals ?? []) {
        const pid = s.matched_person_id as string
        if (!pid) continue
        const arr = sigByPerson.get(pid) ?? []
        arr.push(s.signal_date as string)
        sigByPerson.set(pid, arr)
      }
      let count = 0
      for (const w of rows) {
        const inq = new Date(w.inquiry_date).getTime()
        const peopleHere = (w.people ?? []).map((p) => p.id)
        const hadPrior = peopleHere.some((pid) => {
          const arr = sigByPerson.get(pid) ?? []
          return arr.some((d) => new Date(d).getTime() < inq)
        })
        if (hadPrior) count++
      }
      multiTouchInquiries = count
      multiTouchInquiriesTotal = rows.length
    }
  }

  return {
    voicePreferences: prefCount ?? 0,
    voiceTrainingResponses: trainingResponses,
    bookingsThisWeek: thisWeekBookings.count ?? 0,
    bookingsLastWeek: lastWeekBookings.count ?? 0,
    inquiriesThisWeek: thisWeekInquiries.count ?? 0,
    topInsightTitle,
    topInsightCategory,
    topInsightPriority,
    topSourceLabel,
    topSourceAvgRevenueDollars,
    strongestCorrelationTitle,
    strongestCorrelationLagDays,
    multiTouchInquiries,
    multiTouchInquiriesTotal,
  }
}

interface WeeklyNarrativeJson {
  narrative?: string
}

/**
 * Compose a 3-5 sentence weekly observation from the structured counts
 * and the bullet shapes the deterministic builders already produced.
 *
 * Hard rule for the prompt: numbers in the narrative MUST come from the
 * structured counts block. We don't run a numbers-guard here (this isn't
 * a persisted insight row), but the prompt is explicit about the bound
 * so a misbehaving model can't invent a "tour-conversion lift" that isn't
 * in the data. If the LLM returns nothing usable, we return null and
 * the bullets render alone.
 */
async function composeWeeklyNarrative(
  venueId: string,
  aiName: string,
  counts: WeeklyStructuredCounts,
  bullets: WeeklyLearnedBullet[],
): Promise<string | null> {
  const bookingDelta = counts.bookingsThisWeek - counts.bookingsLastWeek
  const bulletLines = bullets
    .filter((b) => !b.empty)
    .map((b) => `  - [${b.kind}] ${b.text}`)
    .join('\n') || '  (no non-empty bullets)'

  const systemPrompt = `You are ${aiName}, the wedding-venue coordinator's
intelligence assistant. The coordinator opens a "what happened this week"
panel on their dashboard. Compose a 3-5 sentence observation that reads
like you actually noticed patterns, not like a count of database rows.

Output JSON:
  {
    "narrative": "<3-5 sentences, plain English, no bullets, no markdown>"
  }

CRITICAL RULES:
- The ONLY numbers you may use are the integers and dollar amount in the
  STRUCTURED COUNTS block. Never invent ratios, percentages, or counts
  that are not directly listed.
- Skip any field whose value is null. Null means "no data this week",
  not zero. Do NOT say "0 inquiries this week" when the field is null.
- Never anthropomorphise database operations. Phrases like "I learned 5
  voice preferences" are banned. Prefer "voice training added 5 new
  preferences" or "the team approved 5 voice updates".
- Do not promise predictions ("you'll book more next week"). Frame
  observations and patterns only.
- Do not use em dashes. Use commas, periods, or "and / but / so" instead.
- No emojis. No exclamation marks.
- Do NOT name specific couples, vendors, or third parties. Aggregate only.
- 3-5 sentences total. Tighter is better than longer.`

  const userPrompt = `STRUCTURED COUNTS (this week vs last week)

Voice training:
  - new voice preferences derived: ${counts.voicePreferences}
  - voice training responses recorded: ${counts.voiceTrainingResponses}

Pipeline motion:
  - new inquiries this week: ${counts.inquiriesThisWeek}
  - bookings confirmed this week: ${counts.bookingsThisWeek}
  - bookings confirmed last week: ${counts.bookingsLastWeek}
  - delta vs last week: ${bookingDelta >= 0 ? '+' : ''}${bookingDelta}

Source quality:
  - top source by recent booked-count: ${counts.topSourceLabel ?? 'null'}
  - average booking value from that source (USD): ${counts.topSourceAvgRevenueDollars ?? 'null'}
  - top lead-conversion insight title: ${counts.topInsightTitle ?? 'null'}
  - top lead-conversion insight category: ${counts.topInsightCategory ?? 'null'}
  - top lead-conversion insight priority: ${counts.topInsightPriority ?? 'null'}

Cross-channel signal:
  - strongest correlation row title: ${counts.strongestCorrelationTitle ?? 'null'}
  - lag in days for that correlation: ${counts.strongestCorrelationLagDays ?? 'null'}

Multi-touch journey:
  - inquiries this week with prior touchpoints: ${counts.multiTouchInquiries ?? 'null'}
  - total inquiries this week: ${counts.multiTouchInquiriesTotal ?? 'null'}

For reference, the bulleted breakdown the dashboard would otherwise show:
${bulletLines}

Compose the JSON narrative. 3-5 sentences. Numbers strictly from the
STRUCTURED COUNTS block.`

  const result = await callAIJson<WeeklyNarrativeJson>({
    systemPrompt,
    userPrompt,
    maxTokens: 360,
    temperature: 0.6,
    venueId,
    taskType: 'weekly_learned',
    tier: 'sonnet',
    promptVersion: WEEKLY_LEARNED_PROMPT_VERSION,
  })

  const narrative = (result?.narrative ?? '').trim()
  if (!narrative) return null
  // Belt-and-braces: strip em dashes the model might still emit despite
  // the prompt rule. Same convention as the rest of the user-facing
  // copy in this repo.
  return narrative.replace(/—/g, ', ').replace(/\s+/g, ' ').trim()
}

/**
 * Phase 8 correlation bullet. Surfaces the strongest intelligence_insights
 * row of type='correlation' when its confidence is >= 0.7 AND the
 * underlying series has a lag (so the coordinator gets a forward-
 * looking signal, not just "these move together"). No empty state —
 * we omit the bullet entirely when no strong correlation exists
 * rather than crowd the card with a null-result line.
 */
async function buildCorrelationBullet(venueId: string): Promise<WeeklyLearnedBullet | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('intelligence_insights')
    .select('title, body, confidence, data_points, created_at')
    .eq('venue_id', venueId)
    .eq('insight_type', 'correlation')
    .gte('confidence', 0.7)
    .order('confidence', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const dp = (data.data_points ?? {}) as { lag_days?: number }
  const lag = Number(dp.lag_days ?? 0)
  // Lean toward forward-looking phrasing when there's a lag.
  if (lag > 0) {
    return {
      kind: 'correlation',
      text: `${data.title} Expect a move in the trailing channel within ${lag} days.`,
    }
  }
  return { kind: 'correlation', text: (data.title as string) }
}

/**
 * Phase 8 F11. Multi-touch journey bullet — surfaces when a recent inquiry
 * had tangential_signals attached BEFORE the inquiry landed. Three
 * explicit templates, picked in priority order. No free-form LLM copy —
 * the shape is deterministic so coordinators learn to recognize it.
 *
 * Template 1 (couple + multiple channels):
 *   "(first_name) found you on (source); (N) prior touchpoints across
 *    (platforms) over (D) days."
 *
 * Template 2 (couple + single earlier touch):
 *   "(first_name) came via (source) — first appeared (D) days earlier
 *    on (platform)."
 *
 * Template 3 (aggregate — N of K had prior history):
 *   "(N) of this week's (K) new inquiries already had touchpoints with
 *    the venue before writing in."
 *
 * Returns null when fewer than one inquiry this week had a prior
 * signal. No empty-state text — we'd rather omit than add noise.
 */
async function buildMultiTouchJourneyBullet(
  venueId: string
): Promise<WeeklyLearnedBullet | null> {
  const supabase = createServiceClient()
  const sevenDaysAgo = daysAgoIso(7)

  // 1. Pull this week's inquiries with their people.
  const { data: weddings } = await supabase
    .from('weddings')
    .select(
      'id, source, inquiry_date, people!people_wedding_id_fkey(id, first_name, role)'
    )
    .eq('venue_id', venueId)
    .gte('inquiry_date', sevenDaysAgo)
  if (!weddings || weddings.length === 0) return null

  type WeddingRow = {
    id: string
    source: string | null
    inquiry_date: string
    people?: Array<{ id: string; first_name: string | null; role: string | null }>
  }
  const rows = weddings as unknown as WeddingRow[]

  // 2. For each wedding's people, pull tangential_signals matched to them
  // with signal_date BEFORE the inquiry_date. Those are the "prior
  // history" touches.
  const personIds = rows.flatMap((r) => (r.people ?? []).map((p) => p.id))
  if (personIds.length === 0) return null

  const { data: signals } = await supabase
    .from('tangential_signals')
    .select('id, matched_person_id, signal_type, signal_date, extracted_identity')
    .in('matched_person_id', personIds)
    .not('signal_date', 'is', null)

  if (!signals || signals.length === 0) return null

  type SignalRow = {
    id: string
    matched_person_id: string
    signal_type: string
    signal_date: string
    extracted_identity: Record<string, unknown> | null
  }
  const signalRows = signals as SignalRow[]

  // Build per-wedding journey summary.
  const journeys: Array<{
    weddingId: string
    firstName: string
    source: string | null
    inquiryDate: Date
    priorSignals: SignalRow[]
    priorSpanDays: number
    platforms: string[]
  }> = []

  for (const w of rows) {
    const partner1 = (w.people ?? []).find((p) => p.role === 'partner1') ?? (w.people ?? [])[0]
    const firstName = partner1?.first_name ?? 'A couple'
    const peopleIds = new Set((w.people ?? []).map((p) => p.id))
    const inquiryDate = new Date(w.inquiry_date)
    const related = signalRows
      .filter((s) => peopleIds.has(s.matched_person_id))
      .filter((s) => new Date(s.signal_date).getTime() < inquiryDate.getTime())
      .sort(
        (a, b) => new Date(a.signal_date).getTime() - new Date(b.signal_date).getTime()
      )
    if (related.length === 0) continue

    const earliest = new Date(related[0].signal_date).getTime()
    const priorSpanDays = Math.max(
      0,
      Math.floor((inquiryDate.getTime() - earliest) / (1000 * 60 * 60 * 24))
    )
    const platforms = Array.from(
      new Set(
        related
          .map((s) => {
            const eid = s.extracted_identity ?? {}
            return (
              (eid.platform as string | undefined) ??
              s.signal_type.replace(/_.+$/, '')
            )
          })
          .filter(Boolean)
      )
    )
    journeys.push({
      weddingId: w.id,
      firstName,
      source: w.source,
      inquiryDate,
      priorSignals: related,
      priorSpanDays,
      platforms,
    })
  }

  if (journeys.length === 0) return null

  // Template 1 — one couple, multi-channel. Pick the couple with the most
  // distinct platforms (most compelling story). Ties break on span length.
  const multiChannel = journeys
    .filter((j) => j.platforms.length >= 2 && j.priorSignals.length >= 2)
    .sort((a, b) => {
      if (b.platforms.length !== a.platforms.length) {
        return b.platforms.length - a.platforms.length
      }
      return b.priorSpanDays - a.priorSpanDays
    })[0]
  if (multiChannel) {
    const platformsStr = multiChannel.platforms.slice(0, 3).join(' + ')
    const sourceLabel = multiChannel.source ?? 'a direct channel'
    return {
      kind: 'multi_touch_journey',
      text: `${multiChannel.firstName} found you on ${sourceLabel}; ${multiChannel.priorSignals.length} prior touchpoints across ${platformsStr} over ${multiChannel.priorSpanDays} days.`,
    }
  }

  // Template 2 — one couple, single earlier touch. Pick the longest span.
  const singleTouch = journeys
    .filter((j) => j.priorSignals.length >= 1 && j.priorSpanDays >= 1)
    .sort((a, b) => b.priorSpanDays - a.priorSpanDays)[0]
  if (singleTouch) {
    const platform = singleTouch.platforms[0] ?? singleTouch.priorSignals[0].signal_type
    const sourceLabel = singleTouch.source ?? 'a direct channel'
    return {
      kind: 'multi_touch_journey',
      text: `${singleTouch.firstName} came via ${sourceLabel} — first appeared ${singleTouch.priorSpanDays} days earlier on ${platform}.`,
    }
  }

  // Template 3 — aggregate. Only meaningful if multiple inquiries did this.
  if (journeys.length >= 2 && rows.length >= 2) {
    return {
      kind: 'multi_touch_journey',
      text: `${journeys.length} of this week's ${rows.length} new inquiries already had touchpoints with the venue before writing in.`,
    }
  }

  return null
}
