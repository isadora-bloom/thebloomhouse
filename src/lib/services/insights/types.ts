/**
 * Shared types for the T3 insight architecture (Playbook Part 19-20).
 *
 * Every named insight follows the same shape:
 *   classical compute  →  LLM narration  →  cache  →  surface
 *
 * The CLASSICAL pass produces the numbers. The LLM pass produces the
 * 1-2 sentence reasoning grounded in those numbers (per-insight
 * prompts forbid the LLM from generating numbers itself; numbers-guard
 * verifies post-generation). The CACHE keys on a stable hash of the
 * classical inputs so re-runs don't re-narrate unchanged data. The
 * SURFACE is one of inline / pulse / digest / on_demand per Part 20.
 */

export type SurfaceLayer = 'inline' | 'pulse' | 'digest' | 'on_demand'

export type ConfidenceLevel = 'low' | 'medium' | 'high'

/** Classical numbers the LLM is told it CAN reference. Numbers-guard
 *  later asserts the narration only mentions numbers from this set. */
export interface ClassicalEvidence {
  /** Stable hash of the inputs. Same numbers → same key → same row. */
  cacheKey: string
  /** The numeric values. Pass anything; the guard treats the
   *  stringified form as the allowlist. Use raw integers / floats /
   *  formatted strings ('$5,000' / '12 days') as appropriate. */
  numbers: Array<number | string>
  /** Free-form structured payload the prompt formatter can render
   *  into the user-prompt block. Stored on the insight row's
   *  data_points jsonb so /intel surfaces can re-render the
   *  evidence without re-fetching. */
  payload: Record<string, unknown>
  /** Sample size for the classical pass. Drives confidence: smaller N
   *  → more cautious narration ("based on 4 weddings" vs "based on
   *  87"). */
  sampleSize: number
  /** Effect size on a 0-1 scale, where 0 = no effect detected, 1 = a
   *  textbook-clear pattern. The narrator weights certainty by this. */
  effectSize?: number
}

export interface InsightNarration {
  /** Short headline (~60 chars) — surfaces as the title. */
  title: string
  /** 1-2 sentence body grounded in the classical evidence. */
  body: string
  /** Specific action the coordinator can take this week, OR null if
   *  the insight is on the no-action allowlist (informational). */
  action: string | null
}

export interface PersistInsightArgs {
  venueId: string
  insightType: string
  contextId: string | null
  category: string
  surfaceLayer: SurfaceLayer
  classical: ClassicalEvidence
  narration: InsightNarration
  llmModelUsed: string
  promptVersionUsed: string
  /** 0..1 confidence. confidenceFor(sampleSize, effectSize) is the
   *  default helper. */
  confidence: number
  /** Numeric composite priority for sort within a surface_layer. */
  surfacePriority: number
  /** Insight expires_at (optional). For time-bounded insights like
   *  "tour cancelled — re-engage within 7 days". */
  expiresAt?: string | null
  /** Priority bucket for the existing schema column. */
  priority?: 'critical' | 'high' | 'medium' | 'low'
  /** Forensic-chain correlation id (T5-eta.3). Lets a coordinator
   *  query "which insights were (re)generated while processing this
   *  click / inbound email" via a single id. Optional — many
   *  cron-driven generators don't have one. */
  correlationId?: string | null
}
