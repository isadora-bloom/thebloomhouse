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

  // Persist by (venue_id, insight_type, context_id, cache_key).
  //
  // T5-Rixey-SS Bug B: the prior `.upsert(..., { onConflict:
  // 'venue_id,insight_type,context_id,cache_key' })` form silently
  // failed against the partial unique index from migration 144
  // (`uq_intelligence_insights_cache_key WHERE cache_key IS NOT NULL`).
  // PostgREST's `on_conflict` shorthand only matches non-partial
  // constraints/indexes — every narration call returned
  // 'there is no unique or exclusion constraint matching the ON
  // CONFLICT specification' and the row never landed. Stream QQ spent
  // ~$0.04 narrating an insight that never persisted; coordinator
  // never saw it. Same bug bites every named insight (heat-narration,
  // cohort-match, risk-flags, correlation, decay, etc.) — they all
  // funnel through here.
  //
  // Fix: explicit lookup-then-insert/update against the same column
  // tuple. Race-window is bounded — two callers racing the same
  // (venue, type, context, cache_key) will both see no row, both
  // attempt INSERT, and one will hit the partial unique index's 23505
  // (which the index DOES enforce internally — it just can't be
  // referenced by `on_conflict` shorthand). The losing INSERT then
  // catches the 23505 and converts to an UPDATE. Net: one row lands,
  // the other call updates it. Identical correctness to the prior
  // upsert IF the upsert had actually worked.
  //
  // (The pre-Bug-B version of this comment claimed atomicity from
  // `.upsert`. That claim was hollow — the upsert was returning
  // success without writing because the constraint match silently
  // fell through. We now have actual writes + a deterministic race
  // resolution.)
  const baseRow: Record<string, unknown> = {
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
  // an environment without that migration the write would fail, so
  // we only set it when present.
  if (args.correlationId) {
    baseRow.correlation_id = args.correlationId
  }

  // Build the lookup query for the existing row. context_id may be
  // NULL — the partial unique index treats NULL as a distinct value,
  // so we must use `is(null)` rather than `eq(null)` for the NULL
  // case (PostgREST translates eq.null to `= NULL` which never
  // matches anything in SQL).
  const existingQuery = supabase
    .from('intelligence_insights')
    .select('id, created_at')
    .eq('venue_id', args.venueId)
    .eq('insight_type', args.insightType)
    .eq('cache_key', args.classical.cacheKey)
  const existingScoped = args.contextId
    ? existingQuery.eq('context_id', args.contextId)
    : existingQuery.is('context_id', null)

  const { data: existing, error: lookupErr } = await existingScoped.maybeSingle()
  if (lookupErr) {
    console.error('[insights/persist] lookup failed:', redact(lookupErr.message))
    return { ok: false }
  }

  const nowIso = new Date().toISOString()

  if (existing) {
    // UPDATE path — bump updated_at + replace narration / classical.
    const { data: updated, error: updErr } = await supabase
      .from('intelligence_insights')
      .update({ ...baseRow, updated_at: nowIso })
      .eq('id', existing.id as string)
      .select('id')
      .single()
    if (updErr || !updated) {
      console.error('[insights/persist] update failed:', redact(updErr?.message ?? 'no row returned'))
      return { ok: false }
    }
    return { ok: true, state: 'updated', insightId: updated.id as string }
  }

  // INSERT path — first writer for this cache key. created_at +
  // updated_at default to now() at the DB; we don't need to stamp
  // updated_at here.
  const { data: inserted, error: insErr } = await supabase
    .from('intelligence_insights')
    .insert(baseRow)
    .select('id')
    .single()

  if (insErr) {
    // 23505 — race lost. A concurrent caller inserted between our
    // lookup and our insert. Re-fetch the row id and convert to an
    // UPDATE so the latest narration wins. This preserves the prior
    // upsert's "last writer's narration is what surfaces" semantic.
    const isUniqueViolation =
      typeof insErr.code === 'string' && insErr.code === '23505'
    if (isUniqueViolation) {
      const retryQuery = supabase
        .from('intelligence_insights')
        .select('id')
        .eq('venue_id', args.venueId)
        .eq('insight_type', args.insightType)
        .eq('cache_key', args.classical.cacheKey)
      const retryScoped = args.contextId
        ? retryQuery.eq('context_id', args.contextId)
        : retryQuery.is('context_id', null)
      const { data: raceRow, error: raceErr } = await retryScoped.maybeSingle()
      if (raceErr || !raceRow) {
        console.error('[insights/persist] insert lost race + re-lookup failed:', redact(raceErr?.message ?? 'no row'))
        return { ok: false }
      }
      const { data: raceUpdated, error: raceUpdErr } = await supabase
        .from('intelligence_insights')
        .update({ ...baseRow, updated_at: nowIso })
        .eq('id', raceRow.id as string)
        .select('id')
        .single()
      if (raceUpdErr || !raceUpdated) {
        console.error('[insights/persist] race-resolve update failed:', redact(raceUpdErr?.message ?? 'no row'))
        return { ok: false }
      }
      return { ok: true, state: 'updated', insightId: raceUpdated.id as string }
    }
    // Postgres error.message can include row content (e.g. unique
    // violation echoes the conflicting row's column values, which here
    // includes title + body — both narration text composed over
    // couple PII). Redact before stdout per OPS-21.3.3.
    console.error('[insights/persist] insert failed:', redact(insErr.message))
    return { ok: false }
  }

  return { ok: true, state: 'inserted', insightId: inserted.id as string }
}
