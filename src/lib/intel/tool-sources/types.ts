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
  /**
   * Result field names whose value is prose this product INGESTED rather
   * than computed: a review body, the quote around a keyword match in an
   * inbound email, a loss reason an operator typed, a blocking detail on a
   * follow-up.
   *
   * 2026-09-14 security review, item 7b. Those fields used to go back to
   * the model as plain JSON, in the same channel as the tool contract
   * itself, with nothing marking where the venue's data stopped and a
   * stranger's writing began. The dispatcher now wraps every field named
   * here in the untrusted-data envelope from lib/security/prompt-sanitize
   * before the result reaches the model, and the grounding check refuses
   * to take a figure or a name from one.
   *
   * Declare a field here whenever the value can contain text somebody
   * outside this venue wrote. A source that computes every field it
   * returns leaves this empty. The names are matched at any depth, so a
   * field nested inside a row of results is covered by naming it once.
   */
  freeTextFields?: readonly string[]
  run(venueId: string, args: Record<string, unknown>, deps: ToolSourceDeps): Promise<unknown>
}

export function insufficient(n: number, reason: string): HonestCount {
  return { n, enoughData: false, reason }
}
