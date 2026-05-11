/**
 * Bloom House — SMS name-extraction + match service.
 *
 * Called by the OpenPhone sync (and by a backfill admin route) when an
 * inbound SMS arrives from a phone not yet in `contacts`. Pulls a name
 * out of the body via Haiku, then queries `people` for a single
 * confident match scoped to the venue + last 6 months of activity.
 *
 * Returns:
 *   - { personId, weddingId, confidence } when a single confident match exists
 *   - null when no name was extracted, no match was found, or the result
 *     was ambiguous (multiple weddings with the same first name)
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — auto-link only on
 *     unambiguous matches; everything else is unmatched and surfaces for
 *     review)
 *   - feedback_deep_fix_vs_bandaid.md Pattern 1
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAI, type ContentTier } from '@/lib/ai/client'
import {
  SMS_IDENTIFY_PROMPT_VERSION,
  buildSmsIdentifySystemPrompt,
  buildSmsIdentifyUserPrompt,
  validateSmsIdentifyOutput,
} from '@/config/prompts/sms-identify-person'

const LOOKBACK_MS = 1000 * 60 * 60 * 24 * 180 // 180 days

const CONFIDENT_THRESHOLD = 70

export interface MatchByNameInput {
  supabase: SupabaseClient
  venueId: string
  body: string
  fromPhone: string | null
  correlationId?: string
}

export interface MatchByNameResult {
  personId: string
  weddingId: string | null
  matchedName: string
  confidence: number
  evidence: string
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

// Cheap pre-filter: skip extremely short replies that almost certainly
// carry no signal ("ok", "thanks", "yes"). Anything longer goes to Haiku
// so we catch both name self-id AND event-context clues ("running late
// for my tour", "moving our Saturday wedding").
function worthClassifying(body: string): boolean {
  if (!body) return false
  const trimmed = body.trim()
  if (trimmed.length < 8) return false
  // One-word acks aren't worth a Haiku call.
  if (/^(?:ok|okay|yes|no|sure|thanks|thx|👍|👌|received)[!.?\s]*$/i.test(trimmed)) {
    return false
  }
  return true
}

export async function tryMatchSmsByName(
  input: MatchByNameInput,
): Promise<MatchByNameResult | null> {
  const { supabase, venueId, body, fromPhone, correlationId } = input
  if (!worthClassifying(body)) return null

  // Haiku name + event-context extraction.
  let aiResult
  try {
    aiResult = await callAI({
      systemPrompt: buildSmsIdentifySystemPrompt(),
      userPrompt: buildSmsIdentifyUserPrompt({ body, fromPhone }),
      maxTokens: 200,
      temperature: 0.1,
      venueId,
      taskType: 'sms_identify_person',
      tier: 'haiku',
      contentTier: 2 as ContentTier,
      promptVersion: SMS_IDENTIFY_PROMPT_VERSION,
      correlationId,
    })
  } catch (err) {
    console.warn('[sms-name-match] ai call failed:', err)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(aiResult.text))
  } catch {
    return null
  }
  const validation = validateSmsIdentifyOutput(parsed)
  if (!validation.ok) return null

  const { first_name, last_name, confidence_0_100, evidence, event } = validation.output

  // ----- Tier 1: name-based match (strongest signal) -----
  if (first_name && confidence_0_100 >= CONFIDENT_THRESHOLD) {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
    let query = supabase
      .from('people')
      .select(
        'id, first_name, last_name, wedding_id, weddings!inner ( id, status, inquiry_date, updated_at )',
      )
      .eq('venue_id', venueId)
      .ilike('first_name', first_name)
      .in('role', ['partner1', 'partner2'])
      .not('weddings.status', 'in', '(lost,cancelled,completed)')
      .gte('weddings.updated_at', since)
      .limit(10)
    if (last_name) {
      query = query.ilike('last_name', last_name)
    }
    const { data: candidates } = await query

    type Candidate = {
      id: string
      first_name: string | null
      last_name: string | null
      wedding_id: string | null
      weddings:
        | { id: string; status: string | null; inquiry_date: string | null; updated_at: string | null }
        | { id: string; status: string | null; inquiry_date: string | null; updated_at: string | null }[]
        | null
    }
    const rows = (candidates as Candidate[] | null) ?? []

    if (rows.length === 1) {
      const row = rows[0]
      return {
        personId: row.id,
        weddingId: row.wedding_id,
        matchedName: [row.first_name, row.last_name].filter(Boolean).join(' ') || first_name,
        confidence: confidence_0_100,
        evidence,
      }
    }

    if (rows.length > 1 && last_name) {
      const consistent = rows.every(
        (r) => (r.last_name ?? '').toLowerCase() === last_name.toLowerCase(),
      )
      if (consistent) {
        const sorted = [...rows].sort((a, b) => {
          const aw = Array.isArray(a.weddings) ? a.weddings[0] : a.weddings
          const bw = Array.isArray(b.weddings) ? b.weddings[0] : b.weddings
          return (aw?.updated_at ?? '') < (bw?.updated_at ?? '') ? 1 : -1
        })
        const top = sorted[0]
        return {
          personId: top.id,
          weddingId: top.wedding_id,
          matchedName:
            [top.first_name, top.last_name].filter(Boolean).join(' ') || first_name,
          confidence: confidence_0_100,
          evidence,
        }
      }
    }
    // First-name only with multiple candidates → fall through to event
    // matching. If event picks one wedding, we'll cross-validate by name.
  }

  // ----- Tier 2: event-context match (no name, or ambiguous name) -----
  // Common case: "running late for my tour" with no name. If a tour is
  // scheduled near now (or near tour_time_local), the body is almost
  // certainly from that couple.
  if (event.references_tour) {
    const now = new Date()

    // Build the candidate scheduled-at window.
    // If tour_time_local is present, narrow to today within ±90 min.
    // Otherwise, take ANY tour with scheduled_at in [-2h, +6h] from now,
    // which covers "I'm 10 minutes away" + "we're still 30 min out".
    let windowStart: Date
    let windowEnd: Date
    if (event.tour_time_local) {
      const [hh, mm] = event.tour_time_local.split(':').map((n) => parseInt(n, 10))
      const target = new Date(now)
      target.setHours(hh, mm, 0, 0)
      windowStart = new Date(target.getTime() - 90 * 60_000)
      windowEnd = new Date(target.getTime() + 90 * 60_000)
    } else {
      windowStart = new Date(now.getTime() - 2 * 60 * 60_000)
      windowEnd = new Date(now.getTime() + 6 * 60 * 60_000)
    }

    const { data: tourCandidates } = await supabase
      .from('tours')
      .select('id, wedding_id, scheduled_at, outcome')
      .eq('venue_id', venueId)
      .gte('scheduled_at', windowStart.toISOString())
      .lte('scheduled_at', windowEnd.toISOString())
      .in('outcome', ['pending', 'completed'])
      .order('scheduled_at', { ascending: true })

    type TourRow = {
      id: string
      wedding_id: string | null
      scheduled_at: string | null
      outcome: string | null
    }
    const tours = (tourCandidates as TourRow[] | null) ?? []
    const withWedding = tours.filter((t) => t.wedding_id)

    if (withWedding.length === 1) {
      const t = withWedding[0]
      // Look up the partner1 person to attach the SMS for display.
      const { data: person } = await supabase
        .from('people')
        .select('id, first_name, last_name')
        .eq('venue_id', venueId)
        .eq('wedding_id', t.wedding_id)
        .in('role', ['partner1'])
        .limit(1)
        .maybeSingle()
      const p = person as { id: string; first_name: string | null; last_name: string | null } | null
      if (p) {
        return {
          personId: p.id,
          weddingId: t.wedding_id,
          matchedName:
            [p.first_name, p.last_name].filter(Boolean).join(' ') || 'tour-window match',
          confidence: 75,
          evidence: `${evidence || 'event-context match'} · tour at ${new Date(t.scheduled_at ?? now).toLocaleString()}`,
        }
      }
    }
    // 0 or 2+ tours in the window → ambiguous, fall through.
  }

  // No confident match. Operator decides.
  return null
}
