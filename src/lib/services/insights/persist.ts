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
import { redact } from '@/lib/observability/redact'
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
  // enforces this. The upsert is ATOMIC: a concurrent caller racing
  // the same insight either inserts (winner) or updates (loser) — no
  // duplicate row escapes.
  //
  // Pre-fix: a non-atomic pattern (existence-check → upsert) had a
  // window where two parallel callers (lead-detail open in two tabs,
  // React StrictMode dev double-fire, Promise.allSettled on the same
  // insight type via overlapping requests) could both pass the check
  // and one would catch a 23505 unique violation that the surrounding
  // Promise.allSettled silently swallowed. The user saw 200 OK with
  // one insight card silently null. Per T3 review P0 #2.
  const upsertPayload: Record<string, unknown> = {
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
  // T5-eta.3: stamp correlation_id when caller threaded one through.
  // Lets us answer "which insights were (re)generated by this Refresh
  // click" with a single SQL query. The column was added in 160; on
  // an environment without that migration the upsert would fail, so
  // we only set it when present.
  if (args.correlationId) {
    upsertPayload.correlation_id = args.correlationId
  }

  // Honest 'inserted' vs 'updated' telemetry (T5-eta.4 / C1 finding
  // #8). Pre-fix the upsert always returned state='inserted', so
  // any telemetry counting "stale invalidations" (where an upsert
  // updated an existing cache row) was permanently zero.
  //
  // Strategy: stamp the upsert with updated_at = now(). New rows
  // get created_at = updated_at (default-equal at insert time);
  // existing rows get updated_at strictly greater than created_at.
  // After the upsert, RETURNING created_at, updated_at lets us tell
  // them apart. This is atomic with the upsert (single SQL
  // statement) so there's no race window — same correctness
  // guarantee as the prior P0-fix version that just gave up on
  // telemetry.
  //
  // The xmax trick (RETURNING xmax = 0) is the canonical Postgres
  // way to do this, but supabase-js / PostgREST does not expose
  // xmax as a selectable column without a custom view, so the
  // updated_at-vs-created_at comparison is the cleanest portable
  // shape.
  const upsertWithStamp: Record<string, unknown> = {
    ...upsertPayload,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('intelligence_insights')
    .upsert(upsertWithStamp, { onConflict: 'venue_id,insight_type,context_id,cache_key' })
    .select('id, created_at, updated_at')
    .single()

  if (error) {
    // Postgres error.message can include row content (e.g. unique
    // violation echoes the conflicting row's column values, which here
    // includes title + body — both narration text composed over
    // couple PII). Redact before stdout per OPS-21.3.3.
    console.error('[insights/persist] upsert failed:', redact(error.message))
    return { ok: false }
  }

  // Insert: row's created_at is set to now() by the column default
  // and updated_at is set to our stamped value. They land within the
  // same millisecond (defaults computed from the same now() snapshot),
  // and PostgREST returns them as ISO strings rounded to microseconds.
  // We compare with a tiny tolerance to be safe against clock-edge
  // truncation differences. >100ms apart definitely means "the row
  // already existed and we just bumped updated_at."
  const created = Date.parse((data as { created_at: string }).created_at)
  const updated = Date.parse((data as { updated_at: string }).updated_at)
  const wasInserted = Number.isFinite(created) && Number.isFinite(updated)
    ? Math.abs(updated - created) < 1000
    : true
  const state: 'inserted' | 'updated' = wasInserted ? 'inserted' : 'updated'

  return { ok: true, state, insightId: data.id as string }
}
