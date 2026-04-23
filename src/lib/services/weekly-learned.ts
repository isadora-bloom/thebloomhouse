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

  const [voice, booking, source] = await Promise.all([
    buildVoiceBullet(venueId, aiName),
    buildBookingBullet(venueId),
    buildSourceBullet(venueId),
  ])

  return {
    aiName,
    bullets: [voice, booking, source],
  }
}
