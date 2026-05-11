/**
 * Wave 16 — bulk intent re-classification service.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-may9-llm-vs-template.md
 *
 * Iterates attribution_events for one venue, classifies each via
 * classifyAndPersistInquiryIntent, returns a summary. Mirrors the
 * Wave 7B reclassifyVenueAttribution shape.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  classifyAndPersistInquiryIntent,
  type IntentClass,
} from './intent-classifier'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const FRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export interface ReclassifyVenueIntentInput {
  venueId: string
  limit?: number
  offset?: number
  force?: boolean
  noLLM?: boolean
  supabase?: SupabaseClient
  timeboxMs?: number
}

export interface ReclassifyVenueIntentResult {
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
  byIntent: Record<IntentClass, number>
  failures: Array<{ attributionEventId: string; error: string }>
  timeboxed: boolean
  duration_ms: number
}

interface PickRow {
  id: string
  intent_classified_at: string | null
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

export async function reclassifyVenueIntent(
  input: ReclassifyVenueIntentInput,
): Promise<ReclassifyVenueIntentResult> {
  const sb = input.supabase ?? createServiceClient()
  const venueId = input.venueId
  const limit = clampLimit(input.limit ?? DEFAULT_LIMIT)
  const offset = clampOffset(input.offset ?? 0)
  const force = input.force === true
  const noLLM = input.noLLM === true
  const timeboxMs = input.timeboxMs ?? 280_000
  const startedAt = Date.now()

  const { count: totalCount } = await sb
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .is('reverted_at', null)

  const { data: pageRows, error: pageErr } = await sb
    .from('attribution_events')
    .select('id, intent_classified_at')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
    .order('intent_classified_at', { ascending: true, nullsFirst: true })
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
      byIntent: { targeted: 0, broadcast: 0, validation: 0, unknown: 0 },
      failures: [{ attributionEventId: '__page_fetch__', error: pageErr.message }],
      timeboxed: false,
      duration_ms: Date.now() - startedAt,
    }
  }

  const rows = (pageRows ?? []) as PickRow[]
  const result: ReclassifyVenueIntentResult = {
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
    byIntent: { targeted: 0, broadcast: 0, validation: 0, unknown: 0 },
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

    if (!force && row.intent_classified_at) {
      const last = Date.parse(row.intent_classified_at)
      if (Number.isFinite(last) && Date.now() - last < FRESH_WINDOW_MS) {
        result.skipped_fresh += 1
        continue
      }
    }

    try {
      const out = await classifyAndPersistInquiryIntent(
        { attributionEventId: row.id },
        { supabase: sb, noLLM },
      )
      result.classified += 1
      result.totalCostCents += out.cost_cents
      result.byIntent[out.intentClass] = (result.byIntent[out.intentClass] ?? 0) + 1
      if (out.signals.llmJudgeFired) result.deferred_to_llm += 1
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
