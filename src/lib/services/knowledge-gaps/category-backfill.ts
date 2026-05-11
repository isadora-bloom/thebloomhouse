/**
 * Bloom House — Knowledge-gap category backfill (F22).
 *
 * Why this exists
 * ---------------
 * Mig 298 backfilled NULL knowledge_gaps.category to 'other' and added a
 * NOT NULL + CHECK constraint. That kept the column safe but left ~447
 * legacy rows labelled 'other' — the catch-all bucket — which is useless
 * for the operator-facing review surfaces. This sweep re-categorizes
 * those open 'other' rows with a Haiku judge per row.
 *
 * Per-row cost is intentionally tiny (~$0.0002/row, see callAI haiku
 * pricing in lib/ai/client.ts). Fire-and-forget on per-row errors so a
 * single bad row never poisons the batch.
 *
 * Doctrine: deep fix not bandaid. The capture-route guard (F22 sibling)
 * stops the bleed at the entry point; this sweep heals the back-catalog.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import { logEvent } from '@/lib/observability/logger'
import { KNOWLEDGE_GAP_CATEGORIES } from '@/lib/services/knowledge-gaps/categories'

const BATCH_SIZE = 50
const KNOWLEDGE_GAP_CATEGORIZE_VERSION = 'knowledge-gap-categorize.prompt.v1'

interface CategorizeResult {
  category: string
}

interface GapRow {
  id: string
  venue_id: string
  question: string
}

export interface BackfillResult {
  scanned: number
  updated: number
  skipped: number
  errors: number
}

export async function runKnowledgeGapCategoryBackfill(
  opts: { batchSize?: number } = {},
): Promise<BackfillResult> {
  const batchSize = opts.batchSize ?? BATCH_SIZE
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('knowledge_gaps')
    .select('id, venue_id, question')
    .eq('category', 'other')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) {
    logEvent({
      level: 'error',
      msg: 'knowledge_gap_category_backfill query failed',
      actor: 'cron',
      event_type: 'knowledge_gap.category_backfill',
      outcome: 'fail',
      data: { error: error.message },
    })
    throw new Error(`knowledge_gap_category_backfill query failed: ${error.message}`)
  }

  const rows = (data ?? []) as GapRow[]
  const result: BackfillResult = {
    scanned: rows.length,
    updated: 0,
    skipped: 0,
    errors: 0,
  }

  for (const row of rows) {
    try {
      const decided = await categorizeQuestion(row)
      if (!decided || decided === 'other') {
        result.skipped += 1
        continue
      }
      const { error: upd } = await supabase
        .from('knowledge_gaps')
        .update({ category: decided })
        .eq('id', row.id)
      if (upd) {
        result.errors += 1
        logEvent({
          level: 'warn',
          msg: 'knowledge_gap_category_backfill update failed',
          venueId: row.venue_id,
          actor: 'cron',
          event_type: 'knowledge_gap.category_backfill',
          outcome: 'fail',
          data: { id: row.id, error: upd.message },
        })
        continue
      }
      result.updated += 1
    } catch (err) {
      // Fire-and-forget per row — a single Haiku hiccup must not stop
      // the batch. The next tick will revisit the row.
      result.errors += 1
      logEvent({
        level: 'warn',
        msg: 'knowledge_gap_category_backfill row failed',
        venueId: row.venue_id,
        actor: 'cron',
        event_type: 'knowledge_gap.category_backfill',
        outcome: 'fail',
        data: {
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  logEvent({
    level: 'info',
    msg: 'knowledge_gap_category_backfill ran',
    actor: 'cron',
    event_type: 'knowledge_gap.category_backfill',
    outcome: 'ok',
    data: { ...result } as Record<string, unknown>,
  })

  return result
}

async function categorizeQuestion(row: GapRow): Promise<string | null> {
  const allowed = KNOWLEDGE_GAP_CATEGORIES.filter((c) => c !== 'other')
  const systemPrompt =
    'You are a classifier for a wedding-venue knowledge gap registry. ' +
    'Given a question a coordinator could not answer from existing docs, ' +
    `pick the single best category from: ${allowed.join(', ')}, or "other" ` +
    'if none fits. Reply as JSON only: {"category":"<value>"}.'
  const userPrompt = `Question: ${row.question}\n\nPick one category.`

  const out = await callAIJson<CategorizeResult>({
    systemPrompt,
    userPrompt,
    tier: 'haiku',
    maxTokens: 50,
    temperature: 0,
    venueId: row.venue_id,
    taskType: 'knowledge_gap_categorize',
    promptVersion: KNOWLEDGE_GAP_CATEGORIZE_VERSION,
  })

  const decided = typeof out?.category === 'string' ? out.category.trim().toLowerCase() : ''
  if (!decided) return null
  if (!(KNOWLEDGE_GAP_CATEGORIES as readonly string[]).includes(decided)) return null
  return decided
}
