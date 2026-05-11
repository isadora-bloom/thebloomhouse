/**
 * Bloom House — Wave 19 knowledge-capture fold-in for the brain prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — captured answers
 *     are authoritative; brain prompt MUST reference them before
 *     hedging)
 *   - memory/feedback_deep_fix_vs_bandaid.md Pattern 8 (close the
 *     loop)
 *
 * What this service does
 * ----------------------
 * Loads the venue's active, in-window knowledge_captures rows, scores
 * them by tag overlap with the current inquiry context (or falls back
 * to recency), and produces a "## VENUE KNOWLEDGE" block to fold into
 * the brain's system prompt.
 *
 * Designed for low-overhead inline use by brain modules: ~20 rows
 * max, single SELECT, in-process scoring.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

export interface FoldInOptions {
  venueId: string
  /**
   * Optional context tags inferred from the inbound message — pricing /
   * availability / logistics / etc. Used to rank captures by relevance.
   * When empty, the loader falls back to recency.
   */
  contextTags?: string[]
  /** Hard cap on rows folded in. Default 20. */
  limit?: number
  /** Inject a supabase client (test path). */
  supabase?: SupabaseClient
}

export interface FoldInResult {
  /** Prompt block ready to concatenate into the system prompt. Empty string when no relevant captures. */
  block: string
  /** Number of captures matched (post-scoring). */
  matchedCount: number
  /** Total active captures for the venue (used by observability). */
  totalActive: number
}

interface CaptureRow {
  id: string
  question: string
  answer: string
  tags: string[] | null
  confidence_0_100: number | null
  applies_until: string | null
  created_at: string
}

const DEFAULT_LIMIT = 20

/**
 * Build the "## VENUE KNOWLEDGE" fold-in block for a venue. Returns
 * an empty string when there's nothing to fold in (so the caller can
 * concat unconditionally).
 */
export async function buildVenueKnowledgeBlock(
  options: FoldInOptions,
): Promise<FoldInResult> {
  const { venueId, contextTags, limit, supabase } = options
  if (!venueId) return { block: '', matchedCount: 0, totalActive: 0 }

  const sb = supabase ?? createServiceClient()
  const cap = typeof limit === 'number' && limit > 0 ? Math.min(limit, 50) : DEFAULT_LIMIT

  const nowIso = new Date().toISOString()

  // Pull active rows whose applies_until is NULL or in the future.
  // PostgREST `or` filter handles the NULL-OR-future predicate.
  const { data: rowsRaw, error } = await sb
    .from('knowledge_captures')
    .select('id, question, answer, tags, confidence_0_100, applies_until, created_at')
    .eq('venue_id', venueId)
    .eq('active', true)
    .or(`applies_until.is.null,applies_until.gt.${nowIso}`)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) {
    return { block: '', matchedCount: 0, totalActive: 0 }
  }

  const rows = (rowsRaw ?? []) as CaptureRow[]
  if (rows.length === 0) {
    return { block: '', matchedCount: 0, totalActive: 0 }
  }

  // Score by tag overlap. When contextTags is empty, every row gets
  // score 0 and the order falls back to recency.
  const tagSet = new Set((contextTags ?? []).map((t) => t.toLowerCase()))
  const scored = rows.map((r) => {
    const rowTags = (r.tags ?? []).map((t) => t.toLowerCase())
    let overlap = 0
    for (const t of rowTags) {
      if (tagSet.has(t)) overlap += 1
    }
    return { row: r, overlap }
  })

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap
    // Tiebreak by recency
    const at = Date.parse(a.row.created_at)
    const bt = Date.parse(b.row.created_at)
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0)
  })

  const picked = scored.slice(0, cap).map((s) => s.row)
  if (picked.length === 0) {
    return { block: '', matchedCount: 0, totalActive: rows.length }
  }

  const lines: string[] = []
  lines.push('## VENUE KNOWLEDGE (operator-authored — authoritative; use these before hedging)')
  lines.push('')
  for (const r of picked) {
    const q = (r.question ?? '').trim()
    const a = (r.answer ?? '').trim()
    if (!q || !a) continue
    lines.push(`Q: ${q}`)
    lines.push(`A: ${a}`)
    if (Array.isArray(r.tags) && r.tags.length > 0) {
      lines.push(`Tags: ${r.tags.join(', ')}`)
    }
    lines.push('')
  }

  return {
    block: lines.join('\n').trimEnd(),
    matchedCount: picked.length,
    totalActive: rows.length,
  }
}

/**
 * Lightweight tag inference from a free-text inquiry body. Used by
 * brain modules that don't have a structured classifier output handy.
 * Returns a small set of candidate tags ('pricing' / 'availability' /
 * etc.) based on simple keyword matching.
 *
 * This is intentionally trivial — the LLM detector handles nuance.
 * The tag inference here is just enough to give the fold-in relevance
 * scorer a signal.
 */
export function inferContextTags(text: string): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const tags = new Set<string>()

  const rules: Array<[string, RegExp]> = [
    ['pricing', /(pric|cost|fee|deposit|rate|package|quote|budget)/],
    ['availability', /(avail|date|book|saturday|sunday|weekend|calendar)/],
    ['logistics', /(parking|shuttle|hotel|load-in|setup|timeline|schedule)/],
    ['policy', /(rain|cancel|alcohol|liquor|music|curfew|insurance|pet)/],
    ['vendor', /(vendor|caterer|photographer|florist|dj|band|planner)/],
    ['ceremony', /(ceremony|rehearsal|aisle|officiant|processional|vow)/],
    ['catering', /(catering|food|menu|dietary|allerg|bar|drink|beverage)/],
    ['inclusions', /(includ|table|chair|linen|dish|glassware|tent)/],
  ]
  for (const [tag, pattern] of rules) {
    if (pattern.test(lower)) tags.add(tag)
  }
  return Array.from(tags)
}
