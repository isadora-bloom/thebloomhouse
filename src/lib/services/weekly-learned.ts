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
 */

import { createServiceClient } from '@/lib/supabase/service'
import { computeSourceQuality } from '@/lib/services/source-quality'

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

  // Count voice preferences added in the last 7 days.
  const { count: prefCount } = await supabase
    .from('voice_preferences')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('created_at', sevenDaysAgo)

  // Count voice training responses for this venue's sessions in the last 7 days.
  // voice_training_responses links to voice_training_sessions which has venue_id.
  const { data: recentSessions } = await supabase
    .from('voice_training_sessions')
    .select('id')
    .eq('venue_id', venueId)
    .gte('started_at', sevenDaysAgo)

  const sessionIds = (recentSessions ?? []).map((r) => r.id as string)
  let responseCount = 0
  if (sessionIds.length > 0) {
    const { count } = await supabase
      .from('voice_training_responses')
      .select('id', { count: 'exact', head: true })
      .in('session_id', sessionIds)
      .gte('created_at', sevenDaysAgo)
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
      return {
        kind: 'source',
        text: `${top.source} sent your highest-value couples this month: avg $${top.avgRevenue.toFixed(0)} per booking.`,
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

  const [voice, booking, source, correlation, multiTouch] = await Promise.all([
    buildVoiceBullet(venueId, aiName),
    buildBookingBullet(venueId),
    buildSourceBullet(venueId),
    buildCorrelationBullet(venueId),
    buildMultiTouchJourneyBullet(venueId),
  ])

  const bullets: WeeklyLearnedBullet[] = [voice, booking, source]
  if (correlation) bullets.push(correlation)
  if (multiTouch) bullets.push(multiTouch)
  return { aiName, bullets }
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
