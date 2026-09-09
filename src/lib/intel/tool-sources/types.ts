/**
 * Plug-in contract for "Ask your data" tools beyond the five canonical readers.
 *
 * Why this exists (2026-09-08, NOVEMBER-PLAN.md wave 2): after W3 the NLQ brain
 * can only state numbers it got back from a tool call. That killed the
 * confabulation class but left about twenty battery questions answered with
 * an honest refusal even though the data sits in the database (reviews, lost
 * deals, weather against tour outcomes, monthly volume, identity precision,
 * data completeness, drafting). Each of those becomes a tool source here.
 *
 * Rules every source follows:
 *   - venueId is bound by the dispatcher, never a model-supplied argument.
 *   - Input schema lists only parameters the underlying service already accepts.
 *   - The result is plain JSON. Every count or rate carries its `n`, and when
 *     the sample is too small the result says so with `enoughData: false` and a
 *     `reason` instead of a number. Never a fake zero.
 *   - No writes. A source that must write (drafting) returns the proposal and
 *     the id needed to act, and the write happens through the existing route
 *     with the operator's confirmation.
 *   - Names, never ids, are what the operator sees; ids ride alongside so the
 *     model can chain calls.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface HonestCount {
  n: number
  enoughData: boolean
  reason?: string
}

export interface ToolSourceDeps {
  supabase: SupabaseClient
  /** ISO date for "today" so tests can pin the clock. */
  today: string
}

export interface IntelToolSource {
  /** Anthropic tool definition. `name` is snake_case and unique across sources. */
  tool: Anthropic.Tool
  /** Plain-English subjects this tool answers, used in the scope summary the
   *  model reads and to stop it refusing questions it can now answer. */
  subjects: readonly string[]
  /** Battery question ids this source is meant to make answerable (for the
   *  integrator to wire ground-truth probes). */
  batteryQuestions: readonly string[]
  run(venueId: string, args: Record<string, unknown>, deps: ToolSourceDeps): Promise<unknown>
}

export function insufficient(n: number, reason: string): HonestCount {
  return { n, enoughData: false, reason }
}
