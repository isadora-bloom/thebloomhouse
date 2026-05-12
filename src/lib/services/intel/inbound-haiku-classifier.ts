/**
 * Bloom House — Inbound Haiku classifier (Pattern 5).
 *
 * Anchor docs
 * -----------
 *   - BLOOM-PATTERNS-ZOOM-OUT.md Pattern 5: classify-once / read-many.
 *     Replace per-prompt heuristics with a single Haiku call on the
 *     source row; every downstream brain reads the cached dimension
 *     instead of re-inferring from raw body.
 *   - bloom-may9-llm-vs-template.md: every "AI/Sage/smart" label must
 *     be backed by a callAI call. Bounded enums on a fixed schema is
 *     the textbook structured-classify shape.
 *   - feedback_deep_fix_vs_bandaid.md: regex for sentiment / urgency
 *     is the band-aid; the LLM is the primitive for extracting truth
 *     from human signal.
 *   - bloom-constitution.md: forensic record on the row, not derived
 *     per-read.
 *
 * Pipeline contract
 * -----------------
 * Called post-insert from the email pipeline as fire-and-forget. The
 * row has already landed; haiku_classified_at is NULL. This service
 * runs the Haiku judge and writes sentiment, urgency, family_mentioned
 * + haiku_classified_at back. NEVER throws upstream — the pipeline
 * must keep flowing even when classification fails.
 *
 * Idempotent: skipped when haiku_classified_at IS NOT NULL. The cron
 * drain (inbound_haiku_drain) is the safety net for fire-and-forget
 * misses and historical backfill.
 *
 * Cost target: ~$0.0003/email on Haiku.
 */

import { callAIJson, type ContentTier } from '@/lib/ai/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'

export const INBOUND_HAIKU_PROMPT_VERSION = 'inbound-haiku.v1'

export type InboundSentiment = 'positive' | 'neutral' | 'concerned' | 'frustrated'
export type InboundUrgency = 'low' | 'medium' | 'high'

export interface InboundHaikuVerdict {
  sentiment: InboundSentiment
  urgency: InboundUrgency
  family_mentioned: boolean
}

export interface ClassifyInboundInput {
  interactionId: string
  body: string | null | undefined
  subject: string | null | undefined
  venueId: string
  /** Optional service-role client. Defaults to a fresh service client. */
  supabase?: SupabaseClient
  /** Audit lineage. */
  correlationId?: string | null
}

const SENTIMENTS: ReadonlySet<InboundSentiment> = new Set([
  'positive',
  'neutral',
  'concerned',
  'frustrated',
])
const URGENCIES: ReadonlySet<InboundUrgency> = new Set(['low', 'medium', 'high'])

const FALLBACK: InboundHaikuVerdict = {
  sentiment: 'neutral',
  urgency: 'low',
  family_mentioned: false,
}

const SYSTEM_PROMPT = `You are a forensic classifier reading one inbound email from a wedding couple to a venue.

Read the SUBJECT and BODY. Emit a single JSON object with exactly these three keys:

{
  "sentiment": "positive" | "neutral" | "concerned" | "frustrated",
  "urgency": "low" | "medium" | "high",
  "family_mentioned": true | false
}

Definitions:

sentiment — the couple's emotional tenor in THIS body.
  - positive: enthusiastic, excited, warm, complimentary.
  - neutral: informational, businesslike, no strong affect.
  - concerned: worried, anxious, hesitant, asking for reassurance.
  - frustrated: annoyed, impatient, escalating, complaining.

urgency — how time-sensitive the body reads.
  - low: idle browsing, casual question, no deadline implied.
  - high: explicit deadline within a week, "ASAP", "today", same-day tour
    request, double-booking risk, contract-signature pressure, or any
    "we need this resolved now" framing.
  - medium: deadline within ~2-4 weeks, or follow-up after silence with
    a "when can we hear back" tone. Default when unclear between low/high.

family_mentioned — true if the body references any non-partner human role:
mom, dad, mother-in-law, father-in-law, sibling, brother, sister, MOH,
maid of honor, best man, bridesmaid, groomsman, planner, wedding
planner, coordinator they hired, family friend, photographer, florist,
caterer, DJ, officiant, or any other named vendor contact. The two
partners themselves do NOT count. "We" and "us" by themselves do NOT
count. A bare "my partner" / "my fiance" does NOT count.

Output ONLY the JSON object. No markdown, no commentary.`

interface RawVerdict {
  sentiment?: unknown
  urgency?: unknown
  family_mentioned?: unknown
}

function normalize(raw: RawVerdict): InboundHaikuVerdict | null {
  const s = typeof raw?.sentiment === 'string' ? raw.sentiment.toLowerCase() : ''
  const u = typeof raw?.urgency === 'string' ? raw.urgency.toLowerCase() : ''
  const f = raw?.family_mentioned
  if (!SENTIMENTS.has(s as InboundSentiment)) return null
  if (!URGENCIES.has(u as InboundUrgency)) return null
  if (typeof f !== 'boolean') return null
  return {
    sentiment: s as InboundSentiment,
    urgency: u as InboundUrgency,
    family_mentioned: f,
  }
}

/**
 * Run the Haiku classifier over one inbound interaction. Idempotent:
 * the post-insert UPDATE no-ops when haiku_classified_at IS NOT NULL.
 *
 * Returns the verdict that was persisted (or the fallback on failure).
 * NEVER throws.
 */
export async function classifyInboundInteraction(
  input: ClassifyInboundInput,
): Promise<InboundHaikuVerdict> {
  const { interactionId, venueId, correlationId } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!interactionId || !venueId) return FALLBACK

  // Idempotency gate — skip if a previous run already wrote the row.
  // Belt-and-suspenders the cron drain's WHERE haiku_classified_at IS
  // NULL filter so a duplicated fire-and-forget doesn't burn tokens.
  try {
    const { data: existing } = await supabase
      .from('interactions')
      .select('haiku_classified_at, sentiment, urgency, family_mentioned')
      .eq('id', interactionId)
      .single()
    if (existing?.haiku_classified_at) {
      return {
        sentiment: (existing.sentiment as InboundSentiment) ?? FALLBACK.sentiment,
        urgency: (existing.urgency as InboundUrgency) ?? FALLBACK.urgency,
        family_mentioned: Boolean(existing.family_mentioned),
      }
    }
  } catch {
    // Soft-fail the precheck — proceed to classify; the UPDATE below
    // will still land.
  }

  const subject = (input.subject ?? '').slice(0, 500)
  const body = (input.body ?? '').slice(0, 6000)
  if (!body.trim() && !subject.trim()) return FALLBACK

  const userPrompt = `SUBJECT: ${subject || '(none)'}\n\nBODY:\n${body || '(empty)'}`

  let raw: RawVerdict
  try {
    raw = await callAIJson<RawVerdict>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 200,
      temperature: 0.2,
      venueId,
      taskType: 'inbound_haiku_classify',
      tier: 'haiku',
      contentTier: 2 as ContentTier,
      promptVersion: INBOUND_HAIKU_PROMPT_VERSION,
      correlationId: correlationId ?? undefined,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'inbound_haiku ai call failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_haiku.classify',
      outcome: 'fail',
      data: {
        interactionId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return FALLBACK
  }

  const verdict = normalize(raw)
  if (!verdict) {
    logEvent({
      level: 'warn',
      msg: 'inbound_haiku invalid verdict',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_haiku.classify',
      outcome: 'fail',
      data: {
        interactionId,
        sample: JSON.stringify(raw).slice(0, 300),
      },
    })
    return FALLBACK
  }

  try {
    await supabase
      .from('interactions')
      .update({
        sentiment: verdict.sentiment,
        urgency: verdict.urgency,
        family_mentioned: verdict.family_mentioned,
        haiku_classified_at: new Date().toISOString(),
      })
      .eq('id', interactionId)
      .is('haiku_classified_at', null)
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'inbound_haiku persist failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_haiku.classify',
      outcome: 'fail',
      data: {
        interactionId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }

  return verdict
}
