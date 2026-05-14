/**
 * Sage prose summary for brain-dump confirmations.
 *
 * Anchor: Round 2 audit TIER 1 fourth-consumer (2026-05-14). The
 * agent-impact pass flagged that brain-dump confirmation prose was
 * template-y and would benefit from the manifest. Pre-this-helper
 * the resolve endpoint just stamped status='resolved' and routed
 * to the next surface — operators saw "Imported 12 rows" with no
 * context.
 *
 * This helper generates a one-to-two-sentence summary that reads
 * the manifest, looks at what just landed, and produces something
 * like "Imported 12 new candidates on Knot. 3 share fingerprints
 * with existing weddings — review at /intel/candidates."
 *
 * Fault-tolerant: returns null on any failure. The resolve endpoint
 * surfaces the prose if present but never blocks on it.
 */

import { callAI } from '@/lib/ai/client'
import {
  getVenueManifest,
  manifestToSystemPrompt,
} from '@/lib/services/manifest/venue-manifest'

export interface BrainDumpConfirmContext {
  venueId: string
  /** Short label of what was imported, e.g. "12 Knot identity signals". */
  importLabel: string
  /** How many rows landed. */
  rowsImported: number
  /** Domain — controls which manifest tables we reference in the prompt. */
  domain:
    | 'reviews'
    | 'storefront_analytics'
    | 'identity_signals'
    | 'lead_inquiry'
    | 'calendar_event'
    | 'csv_import'
    | 'other'
  /** Optional: brief details to include (e.g. platform names, sample data). */
  details?: string
}

/**
 * Bounded-timeout wrapper. The brain-dump confirm endpoint is on
 * the operator hot path — every confirm adds latency. We cap the
 * LLM round-trip at 1500ms so confirms that exceed the budget
 * return without prose instead of hanging the UI. Templated import
 * count still shows.
 */
export async function generateBrainDumpSummaryBounded(
  ctx: BrainDumpConfirmContext,
  timeoutMs = 1500,
): Promise<string | null> {
  return Promise.race([
    generateBrainDumpSummary(ctx),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

export async function generateBrainDumpSummary(
  ctx: BrainDumpConfirmContext,
): Promise<string | null> {
  try {
    const manifest = await getVenueManifest(ctx.venueId)
    const manifestPrompt = manifestToSystemPrompt(manifest)

    const systemPrompt = `${manifestPrompt}

---

You are Sage, the venue's intelligence layer. The operator just confirmed a brain-dump import. Your job is to write a one-or-two-sentence summary that:

1. Names what landed (e.g. "12 Knot identity signals" or "3 Google reviews from Sept").
2. Connects it to the manifest — if the new data overlaps an empty/unconnected source the operator should know. If it surfaces a likely match against existing data, mention that directly.
3. Includes a concrete next surface link when one fits ("Review candidates at /intel/candidates").

DO NOT:
- Repeat the row count if it's already in the import label.
- Speculate about data you don't have.
- Use engineering vocabulary (no "Wave", "Phase B", "tier_2_ai" etc.).
- Use snake_case strings; humanize them.

Respond with prose only. No JSON, no markdown headers.`

    const userPrompt = `Domain: ${ctx.domain}
Import: ${ctx.importLabel} (${ctx.rowsImported} rows)
${ctx.details ? `Details: ${ctx.details}` : ''}

Write the one-or-two-sentence summary.`

    const result = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 200,
      temperature: 0.3,
      venueId: ctx.venueId,
      taskType: 'brain_dump_summary',
      tier: 'haiku',
    })
    const text = (result.text ?? '').trim()
    if (!text || text.length < 10) return null
    return text
  } catch {
    return null
  }
}
