/**
 * Bloom House: AI Cost Tracking Utilities
 *
 * Standalone helpers for logging and querying AI usage costs.
 * The main callAI function in client.ts handles per-call logging;
 * this module provides querying, summaries, and cost constants.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { writeOrLog } from '@/lib/db/write-or-log'

// ---------------------------------------------------------------------------
// Cost constants (per million tokens)
//
// 2026-08-28 correction. Both current-model rows below were wrong from the
// day they were added, because each was copied off the legacy row above it
// rather than looked up: haiku-4-5 carried Haiku 3's 0.25/1.25 (really 1.0/5.0,
// so every Haiku call was under-costed 4x) and opus-4-8 carried Opus 4's
// 15.0/75.0 (really 5.0/25.0, over-costed 3x). The ledger recorded every call
// and priced it wrong in both directions for months, and nothing caught it,
// because nothing checks a constant against the provider's price list. The
// legacy rows are correct as-is and are kept so historical api_costs rows
// still resolve. api_costs.cost is stored at write time, so rows written
// before this date carry the old arithmetic and need a backfill.
// ---------------------------------------------------------------------------

export const CLAUDE_COSTS = {
  // Current models
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
  },
  'claude-opus-4-8': {
    input: 5.0,
    output: 25.0,
  },
  // Haiku 4.5, current Haiku tier. ~3x cheaper than Sonnet.
  // Use for classification, small-label extraction, scoring rubrics. Per Playbook 19.8.
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
  },
  // Legacy model IDs kept so historical api_costs audit rows resolve correctly
  'claude-sonnet-4-20250514': {
    input: 3.0,
    output: 15.0,
  },
  'claude-opus-4-20250514': {
    input: 15.0,
    output: 75.0,
  },
  'claude-haiku-3-20240307': {
    input: 0.25,
    output: 1.25,
  },
} as const

export const OPENAI_COSTS = {
  'gpt-4o-mini': {
    input: 0.15,
    output: 0.60,
  },
  'gpt-4o': {
    input: 2.50,
    output: 10.0,
  },
} as const

export type ClaudeModel = keyof typeof CLAUDE_COSTS
export type OpenAIModel = keyof typeof OPENAI_COSTS

/**
 * Calculate cost for a given model and token usage.
 * Supports both Claude and OpenAI models.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const claudeCosts = CLAUDE_COSTS[model as ClaudeModel]
  if (claudeCosts) {
    return (inputTokens * claudeCosts.input + outputTokens * claudeCosts.output) / 1_000_000
  }
  const openaiCosts = OPENAI_COSTS[model as OpenAIModel]
  if (openaiCosts) {
    return (inputTokens * openaiCosts.input + outputTokens * openaiCosts.output) / 1_000_000
  }
  // Fallback to Sonnet pricing
  return (inputTokens * 3.0 + outputTokens * 15.0) / 1_000_000
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

interface LogAICostOptions {
  venueId?: string
  service: string
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
  context: string
}

/**
 * Inserts a cost record to the api_costs table.
 * Fire-and-forget — never throws.
 */
export async function logAICost(options: LogAICostOptions): Promise<void> {
  try {
    const supabase = createServiceClient()
    await writeOrLog(supabase.from('api_costs').insert({
      venue_id: options.venueId,
      service: options.service,
      model: options.model,
      input_tokens: options.inputTokens,
      output_tokens: options.outputTokens,
      cost: options.cost,
      context: options.context,
    }), { op: 'api_costs.insert', venueId: options.venueId })
  } catch {
    // Fire and forget — never block for logging
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface CostBreakdown {
  label: string
  cost: number
  calls: number
}

interface VenueCostReport {
  totalCost: number
  totalCalls: number
  byContext: CostBreakdown[]
  byModel: CostBreakdown[]
}

/**
 * Returns total cost, breakdown by context, and breakdown by model
 * for a venue over the specified period.
 */
export async function getVenueCosts(
  venueId: string,
  period: 'today' | 'week' | 'month'
): Promise<VenueCostReport> {
  const supabase = createServiceClient()

  const now = new Date()
  let since: string

  if (period === 'today') {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  } else if (period === 'week') {
    const weekAgo = new Date(now)
    weekAgo.setDate(weekAgo.getDate() - 7)
    since = weekAgo.toISOString()
  } else {
    const monthAgo = new Date(now)
    monthAgo.setMonth(monthAgo.getMonth() - 1)
    since = monthAgo.toISOString()
  }

  const { data, error } = await supabase
    .from('api_costs')
    .select('cost, context, model')
    .eq('venue_id', venueId)
    .gte('created_at', since)

  if (error) throw error

  const rows = data ?? []

  let totalCost = 0
  const contextMap = new Map<string, { cost: number; calls: number }>()
  const modelMap = new Map<string, { cost: number; calls: number }>()

  for (const row of rows) {
    const cost = (row.cost as number) ?? 0
    const context = (row.context as string) ?? 'unknown'
    const model = (row.model as string) ?? 'unknown'

    totalCost += cost

    const ctxEntry = contextMap.get(context) ?? { cost: 0, calls: 0 }
    ctxEntry.cost += cost
    ctxEntry.calls++
    contextMap.set(context, ctxEntry)

    const modelEntry = modelMap.get(model) ?? { cost: 0, calls: 0 }
    modelEntry.cost += cost
    modelEntry.calls++
    modelMap.set(model, modelEntry)
  }

  const byContext: CostBreakdown[] = [...contextMap.entries()]
    .map(([label, data]) => ({
      label,
      cost: Math.round(data.cost * 10000) / 10000,
      calls: data.calls,
    }))
    .sort((a, b) => b.cost - a.cost)

  const byModel: CostBreakdown[] = [...modelMap.entries()]
    .map(([label, data]) => ({
      label,
      cost: Math.round(data.cost * 10000) / 10000,
      calls: data.calls,
    }))
    .sort((a, b) => b.cost - a.cost)

  return {
    totalCost: Math.round(totalCost * 10000) / 10000,
    totalCalls: rows.length,
    byContext,
    byModel,
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

interface CostSummary {
  today: number
  thisWeek: number
  thisMonth: number
  allTime: number
}

/**
 * Returns a quick cost summary: today, this week, this month, all time.
 */
export async function getCostSummary(venueId: string): Promise<CostSummary> {
  const supabase = createServiceClient()

  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()

  const weekAgo = new Date(now)
  weekAgo.setDate(weekAgo.getDate() - 7)
  const startOfWeek = weekAgo.toISOString()

  const monthAgo = new Date(now)
  monthAgo.setMonth(monthAgo.getMonth() - 1)
  const startOfMonth = monthAgo.toISOString()

  // Fetch all costs for this venue (we'll bucket client-side for simplicity)
  const { data, error } = await supabase
    .from('api_costs')
    .select('cost, created_at')
    .eq('venue_id', venueId)

  if (error) throw error

  const rows = data ?? []

  let today = 0
  let thisWeek = 0
  let thisMonth = 0
  let allTime = 0

  for (const row of rows) {
    const cost = (row.cost as number) ?? 0
    const createdAt = row.created_at as string

    allTime += cost

    if (createdAt >= startOfMonth) thisMonth += cost
    if (createdAt >= startOfWeek) thisWeek += cost
    if (createdAt >= startOfDay) today += cost
  }

  return {
    today: Math.round(today * 10000) / 10000,
    thisWeek: Math.round(thisWeek * 10000) / 10000,
    thisMonth: Math.round(thisMonth * 10000) / 10000,
    allTime: Math.round(allTime * 10000) / 10000,
  }
}
