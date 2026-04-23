/**
 * Prior touches — the multi-touch history a coordinator (and Sage) sees
 * for a person.
 *
 * Pulls tangential_signals matched to a person + prior interactions +
 * prior drafts + prior tours. Returns a chronologically-sorted list of
 * touchpoints so the inquiry card can render "This couple liked you on
 * Instagram March 14, visited your website 3 times in April, and
 * inquired through The Knot today."
 *
 * Used by:
 * - /agent/inbox inquiry card (shows the list)
 * - sage-intelligence.ts (injects into brain context as warmth signal)
 * - weekly-learned.ts (counts the multi-touch couples this week)
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PriorTouch {
  kind: 'tangential_signal' | 'interaction' | 'tour' | 'visit'
  source: string // 'instagram' | 'the_knot' | 'email' | 'tour' | ...
  date: string // ISO
  summary: string
}

export interface PriorTouchSummary {
  personId: string
  warmth: 'cold' | 'warm' | 'hot'
  touches: PriorTouch[]
  counts: {
    tangential: number
    interactions: number
    tours: number
  }
}

const MAX_TOUCHES_RETURNED = 12

export async function getPriorTouches(args: {
  supabase: SupabaseClient
  venueId: string
  personId: string
  beforeIso?: string
}): Promise<PriorTouchSummary> {
  const { supabase, venueId, personId, beforeIso } = args
  const before = beforeIso ?? new Date().toISOString()
  const touches: PriorTouch[] = []
  const counts = { tangential: 0, interactions: 0, tours: 0 }

  // Tangential signals (Instagram engagement, review from this reviewer,
  // storefront activity linked by matching).
  const { data: signals } = await supabase
    .from('tangential_signals')
    .select('signal_type, extracted_identity, source_context, signal_date, created_at')
    .eq('venue_id', venueId)
    .eq('matched_person_id', personId)
    .order('signal_date', { ascending: false, nullsFirst: false })
  for (const s of signals ?? []) {
    const ei = (s.extracted_identity ?? {}) as Record<string, unknown>
    const platform = String(ei.platform ?? 'other')
    const when = (s.signal_date as string | null) ?? (s.created_at as string)
    if (when > before) continue
    const type = String(s.signal_type ?? 'other')
    const context = (s.source_context as string | null) ?? ''
    const summary = context || describeSignal(type, platform)
    touches.push({ kind: 'tangential_signal', source: platform, date: when, summary })
    counts.tangential++
  }

  // Prior interactions (excluding today's — the caller is usually the
  // inquiry that triggered the lookup).
  const { data: ints } = await supabase
    .from('interactions')
    .select('type, direction, subject, timestamp, body_preview')
    .eq('venue_id', venueId)
    .eq('person_id', personId)
    .lt('timestamp', before)
    .order('timestamp', { ascending: false })
    .limit(20)
  for (const i of ints ?? []) {
    touches.push({
      kind: 'interaction',
      source: (i.type as string | null) ?? 'email',
      date: i.timestamp as string,
      summary: (i.subject as string | null) ?? (i.body_preview as string | null)?.slice(0, 80) ?? 'Email',
    })
    counts.interactions++
  }

  // Prior tours — tied via the person's wedding_id.
  const { data: personRow } = await supabase
    .from('people')
    .select('wedding_id')
    .eq('id', personId)
    .single()
  const weddingId = personRow?.wedding_id as string | null
  if (weddingId) {
    const { data: tours } = await supabase
      .from('tours')
      .select('scheduled_at, tour_type, outcome')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .lt('scheduled_at', before)
      .order('scheduled_at', { ascending: false })
    for (const t of tours ?? []) {
      touches.push({
        kind: 'tour',
        source: 'tour',
        date: t.scheduled_at as string,
        summary: `${t.tour_type ?? 'Tour'}${t.outcome ? ` — ${t.outcome}` : ''}`,
      })
      counts.tours++
    }
  }

  touches.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  const total = counts.tangential + counts.interactions + counts.tours
  const warmth: PriorTouchSummary['warmth'] = total === 0 ? 'cold' : total < 3 ? 'warm' : 'hot'

  return {
    personId,
    warmth,
    touches: touches.slice(0, MAX_TOUCHES_RETURNED),
    counts,
  }
}

function describeSignal(signalType: string, platform: string): string {
  switch (signalType) {
    case 'instagram_engagement': return `Engaged on ${humanPlatform(platform)}`
    case 'instagram_follow': return `Followed on ${humanPlatform(platform)}`
    case 'review': return `Left a review on ${humanPlatform(platform)}`
    case 'analytics_entry': return `Showed up in ${humanPlatform(platform)} analytics`
    case 'website_visit': return `Visited the website`
    case 'mention': return `Mentioned on ${humanPlatform(platform)}`
    case 'referral': return `Referred via ${humanPlatform(platform)}`
    default: return humanPlatform(platform)
  }
}

function humanPlatform(p: string): string {
  const s = p.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Render the touches as a compact narrative for Sage's prompt context.
 * Example: "liked you on Instagram March 14, was featured in The Knot
 * analytics March 22, inquired through The Knot April 23"
 */
export function narrateTouches(summary: PriorTouchSummary): string {
  if (summary.touches.length === 0) return ''
  const lines = summary.touches.map((t) => {
    const d = t.date ? new Date(t.date) : null
    const when = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
    return `${t.summary}${when ? ` (${when})` : ''}`
  })
  return lines.join('; ')
}
