/**
 * Wave 7B — bulk re-classification service.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B)
 *
 * Iterates attribution_events for one venue (paged), classifies each
 * via classifyAndPersistAttributionEvent, returns a summary. Designed
 * for /api/admin/attribution/reclassify-roles mode='sync'. The
 * 'enqueue' mode of that endpoint hits enqueueRoleClassification
 * directly so this service stays focused on the inline path.
 *
 * Skips events already classified within the last 30 days unless
 * force=true. The window matches the cron drift-refresh cadence so
 * re-running the bulk endpoint inside the freshness window is a no-op.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { classifyAndPersistAttributionEvent, type ClassifyResult } from './classify'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const FRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface ReclassifyVenueInput {
  venueId: string
  /** Page size (default 50, max 200). */
  limit?: number
  /** Page offset (default 0). */
  offset?: number
  /** When true, re-classify even rows whose role_classified_at is fresh. */
  force?: boolean
  /** When true, skip the LLM judge for ambiguous cases (mass dry-run). */
  noLLM?: boolean
  /** Optional Supabase client override (tests). */
  supabase?: SupabaseClient
  /** Time budget for the loop (ms). Defaults to 280s for Vercel Pro. */
  timeboxMs?: number
}

export interface ReclassifyVenueResult {
  ok: boolean
  venueId: string
  limit: number
  offset: number
  totalCount: number
  processed: number
  classified: number
  deferred_to_llm: number
  failed: number
  skipped_fresh: number
  hasMore: boolean
  nextOffset: number
  totalCostCents: number
  byRole: Record<ClassifyResult['role'], number>
  failures: Array<{ attributionEventId: string; error: string }>
  timeboxed: boolean
  duration_ms: number
}

interface AttributionEventPick {
  id: string
  role_classified_at: string | null
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function clampOffset(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

export async function reclassifyVenueAttribution(
  input: ReclassifyVenueInput,
): Promise<ReclassifyVenueResult> {
  const sb = input.supabase ?? createServiceClient()
  const venueId = input.venueId
  const limit = clampLimit(input.limit ?? DEFAULT_LIMIT)
  const offset = clampOffset(input.offset ?? 0)
  const force = input.force === true
  const noLLM = input.noLLM === true
  const timeboxMs = input.timeboxMs ?? 280_000
  const startedAt = Date.now()

  // Total candidates for paging UI.
  const { count: totalCount } = await sb
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .is('reverted_at', null)

  // Page of attribution_events ordered oldest-classified first so the
  // staleness frontier drains forward.
  const { data: pageRows, error: pageErr } = await sb
    .from('attribution_events')
    .select('id, role_classified_at')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
    .order('role_classified_at', { ascending: true, nullsFirst: true })
    .range(offset, offset + limit - 1)
  if (pageErr) {
    return {
      ok: false,
      venueId,
      limit,
      offset,
      totalCount: totalCount ?? 0,
      processed: 0,
      classified: 0,
      deferred_to_llm: 0,
      failed: 0,
      skipped_fresh: 0,
      hasMore: false,
      nextOffset: offset,
      totalCostCents: 0,
      byRole: { acquisition: 0, validation: 0, conversion: 0, mixed: 0, unknown: 0 },
      failures: [{ attributionEventId: '__page_fetch__', error: pageErr.message }],
      timeboxed: false,
      duration_ms: Date.now() - startedAt,
    }
  }

  const rows = (pageRows ?? []) as AttributionEventPick[]
  const result: ReclassifyVenueResult = {
    ok: true,
    venueId,
    limit,
    offset,
    totalCount: totalCount ?? 0,
    processed: 0,
    classified: 0,
    deferred_to_llm: 0,
    failed: 0,
    skipped_fresh: 0,
    hasMore: false,
    nextOffset: offset + rows.length,
    totalCostCents: 0,
    byRole: { acquisition: 0, validation: 0, conversion: 0, mixed: 0, unknown: 0 },
    failures: [],
    timeboxed: false,
    duration_ms: 0,
  }

  for (const row of rows) {
    if (Date.now() - startedAt >= timeboxMs) {
      result.timeboxed = true
      break
    }
    result.processed += 1

    if (!force && row.role_classified_at) {
      const last = Date.parse(row.role_classified_at)
      if (Number.isFinite(last) && Date.now() - last < FRESH_WINDOW_MS) {
        result.skipped_fresh += 1
        continue
      }
    }

    try {
      const out = await classifyAndPersistAttributionEvent(
        { attributionEventId: row.id },
        { supabase: sb, noLLM },
      )
      result.classified += 1
      result.totalCostCents += out.cost_cents
      result.byRole[out.role] = (result.byRole[out.role] ?? 0) + 1
      if (out.evidence.forensic_path === 'mixed_deferred_to_llm' && out.cost_cents > 0) {
        result.deferred_to_llm += 1
      }
    } catch (err) {
      result.failed += 1
      result.failures.push({
        attributionEventId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  result.totalCostCents = Math.round(result.totalCostCents * 10_000) / 10_000
  result.hasMore = result.totalCount > 0 && offset + rows.length < result.totalCount
  result.duration_ms = Date.now() - startedAt
  return result
}
