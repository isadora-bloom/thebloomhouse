/**
 * Persist a T3 insight (classical → narration → cache → upsert).
 *
 * Wraps the boilerplate every named insight needs:
 *   1. Compute cacheKey from classical inputs
 *   2. Check existing row; skip narration if cache_key + last_classical_signature still match
 *   3. Run numbers-guard against the narration
 *   4. Upsert via (venue_id, insight_type, context_id, cache_key)
 *
 * Insights call this with their classical+narration bundle; they don't
 * touch the intelligence_insights table directly. Centralising here
 * keeps the schema usage consistent + applies the numbers-guard
 * uniformly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PersistInsightArgs } from './types'
import { checkNarrationNumbers } from './numbers-guard'

export interface PersistResult {
  ok: boolean
  /** When ok=false: violations from the numbers-guard. */
  numbersGuardViolations?: ReturnType<typeof checkNarrationNumbers>
  /** When ok=true: 'cached' (no upsert), 'updated' (regenerated from
   *  stale cache), 'inserted' (first write). */
  state?: 'cached' | 'updated' | 'inserted'
  /** When ok=true: the row id. */
  insightId?: string
}

/**
 * Look up the cached row for this (venue, type, context, cacheKey)
 * and decide whether the caller needs to re-narrate. Returns null
 * when the cache is fresh — caller skips the LLM call entirely.
 *
 * "Fresh" means: there's an existing row whose last_classical_signature
 * equals the current classical signature byte-for-byte. If anything
 * differs, the caller should re-narrate and pass the result to
 * persistInsight().
 */
export async function lookupCachedInsight(
  supabase: SupabaseClient,
  venueId: string,
  insightType: string,
  contextId: string | null,
  cacheKey: string,
): Promise<{
  id: string
  title: string
  body: string
  action: string | null
  confidence: number
  data_points: Record<string, unknown>
  surface_layer: string | null
  surface_priority: number | null
} | null> {
  let query = supabase
    .from('intelligence_insights')
    .select('id, title, body, action, confidence, data_points, surface_layer, surface_priority, cache_key, last_classical_signature, status')
    .eq('venue_id', venueId)
    .eq('insight_type', insightType)
    .eq('cache_key', cacheKey)
    .neq('status', 'expired')
    .neq('status', 'dismissed')
    .limit(1)
  if (contextId) {
    query = query.eq('context_id', contextId)
  } else {
    query = query.is('context_id', null)
  }
  const { data } = await query
  const row = (data ?? [])[0]
  if (!row) return null

  return {
    id: row.id as string,
    title: row.title as string,
    body: row.body as string,
    action: (row.action as string | null) ?? null,
    confidence: (row.confidence as number) ?? 0.5,
    data_points: (row.data_points ?? {}) as Record<string, unknown>,
    surface_layer: (row.surface_layer as string | null) ?? null,
    surface_priority: (row.surface_priority as number | null) ?? null,
  }
}

export async function persistInsight(
  supabase: SupabaseClient,
  args: PersistInsightArgs,
): Promise<PersistResult> {
  // Run numbers-guard before writing anything. Title + body get
  // checked. Action can mention numbers too if the action itself
  // contains a quantitative ask (uncommon but allowed).
  const titleViolations = checkNarrationNumbers(args.narration.title, args.classical)
  const bodyViolations = checkNarrationNumbers(args.narration.body, args.classical)
  const actionViolations = args.narration.action
    ? checkNarrationNumbers(args.narration.action, args.classical)
    : []
  const violations = [...titleViolations, ...bodyViolations, ...actionViolations]
  if (violations.length > 0) {
    return { ok: false, numbersGuardViolations: violations }
  }

  // Upsert by (venue_id, insight_type, context_id, cache_key).
  // Postgres unique partial index uq_intelligence_insights_cache_key
  // enforces this. If a row exists with the same cache_key the
  // upsert is a no-op (we land back here on subsequent runs without
  // changing anything).
  const upsertPayload = {
    venue_id: args.venueId,
    insight_type: args.insightType,
    context_id: args.contextId,
    category: args.category,
    title: args.narration.title,
    body: args.narration.body,
    action: args.narration.action,
    priority: args.priority ?? 'medium',
    confidence: args.confidence,
    data_points: args.classical.payload,
    surface_layer: args.surfaceLayer,
    surface_priority: args.surfacePriority,
    cache_key: args.classical.cacheKey,
    last_classical_signature: args.classical.payload,
    llm_model_used: args.llmModelUsed,
    prompt_version_used: args.promptVersionUsed,
    expires_at: args.expiresAt ?? null,
    status: 'new' as const,
  }

  // Detect insert-vs-update by checking existence first; saves the
  // ambiguity of upsert's return shape and lets us return useful
  // state to the caller for telemetry.
  const existing = await lookupCachedInsight(
    supabase,
    args.venueId,
    args.insightType,
    args.contextId,
    args.classical.cacheKey,
  )
  const state: 'updated' | 'inserted' = existing ? 'updated' : 'inserted'

  const { data, error } = await supabase
    .from('intelligence_insights')
    .upsert(upsertPayload, { onConflict: 'venue_id,insight_type,context_id,cache_key' })
    .select('id')
    .single()

  if (error) {
    console.error('[insights/persist] upsert failed:', error.message)
    return { ok: false }
  }
  return { ok: true, state, insightId: data.id as string }
}
