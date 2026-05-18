/**
 * buildJudgeContext — populate JudgeContext for the LLM identity judge.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §2 ("Read the structured
 * signals AND the touchpoint timelines. The timelines are the
 * tiebreaker"). Tier 8 / T8.0c.
 *
 * Before this, both judge call sites — the Tracer touchpoint sweep
 * (tracer.ts) and the Forwards Linker (forwards-linker.ts) — passed
 * `{ primary_touchpoints: [], secondary_touchpoints: [] }`. The judge
 * ran context-blind on structured signals alone, defeating the §2
 * hybrid design whose whole point is that the timeline is the
 * tiebreaker. This builds the real timelines:
 *
 *  - primary   = the inbound signal being matched. It is a single
 *                event not yet persisted, so its "timeline" is itself.
 *  - secondary = an existing couple. Its timeline is its `touchpoints`
 *                rows, most recent first.
 *
 * One bounded query per judge call. The judge is already budget-capped
 * (200/run, 50/day) and only fires for needs_judge candidates, so the
 * added read volume is negligible.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { JudgeContext } from './llm-judge'
import type { NormalizedSignal } from './sources/types'

const MAX_TOUCHPOINTS = 10

/** raw_payload is channel-shaped; different adapters name the body
 *  field differently. Probe the common ones in priority order. */
const SNIPPET_FIELDS = [
  'snippet',
  'body_preview',
  'body',
  'text',
  'subject',
  'message',
  'content',
  'caption',
]

function snippetFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  for (const field of SNIPPET_FIELDS) {
    const v = rec[field]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200)
  }
  return null
}

type TouchpointEntry = JudgeContext['secondary_touchpoints'][number]

export async function buildJudgeContext(
  supabase: SupabaseClient,
  venueId: string,
  signal: NormalizedSignal,
  coupleId: string,
): Promise<JudgeContext> {
  // primary: the inbound signal is a single not-yet-persisted event.
  const primary_touchpoints: TouchpointEntry[] = [
    {
      channel: signal.channel,
      occurred_at: signal.occurred_at,
      action_type: signal.action_type,
      snippet: snippetFromPayload(signal.raw_payload),
    },
  ]

  // secondary: the couple's real touchpoint timeline, most recent first.
  const { data } = await supabase
    .from('touchpoints')
    .select('channel, occurred_at, action_type, raw_payload')
    .eq('venue_id', venueId)
    .eq('couple_id', coupleId)
    .order('occurred_at', { ascending: false })
    .limit(MAX_TOUCHPOINTS)

  type Row = {
    channel: string
    occurred_at: string
    action_type: string
    raw_payload: unknown
  }
  const secondary_touchpoints: TouchpointEntry[] = ((data ?? []) as Row[]).map(
    (r) => ({
      channel: r.channel,
      occurred_at: r.occurred_at,
      action_type: r.action_type,
      snippet: snippetFromPayload(r.raw_payload),
    }),
  )

  return { primary_touchpoints, secondary_touchpoints }
}
