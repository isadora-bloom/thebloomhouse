import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createServiceClient } from '@/lib/supabase/service'
import { calculateCost as calculateModelCost } from '@/lib/ai/cost-tracker'
import { redactError } from '@/lib/observability/redact'

let anthropicClient: Anthropic | null = null
let openaiClient: OpenAI | null = null

// Live brain-call model identifiers. Exported so any DB-stored
// `model_used` audit trail (drafts, briefings, journey-narratives,
// post-tour briefs, re-engagement actions) can persist the exact
// constant used for the call rather than a stale hand-typed string.
// Pre-fix several services stored 'claude-sonnet' or 'claude-sonnet-4',
// which drifted from the actual model and made post-hoc audits lie —
// OPS-21.5.2 partial.
export const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
// Haiku tier for classification + small-label extraction. Per Playbook
// 19.8 model-tier guidance: classifications, small-rubric scoring,
// embedding generation, structured-output extraction with bounded
// schemas. ~12× cheaper than Sonnet — biggest single cost lever.
// Wedgewood-scale (80+ venues × thousands of classifier calls/day)
// makes the right tier mapping the difference between profitable and
// not. OPS-21.4.2.
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
// Opus tier for one-off premium synthesis (voice DNA corpus analysis,
// cross-domain strategic insight composition). Slow and expensive;
// reserved for low-volume / high-stakes work.
export const OPUS_MODEL = 'claude-opus-4-20250514'
export const OPENAI_FALLBACK_MODEL = 'gpt-4o-mini'
// Complex NLQ/Sage/briefing calls need headroom beyond the default 10s
const CLAUDE_TIMEOUT_MS = 30_000
// OpenAI fallback timeout. Symmetric with Claude — if the primary failed
// and we're already in a degraded state, the fallback must not be allowed
// to hang the request indefinitely. Pre-fix callOpenAIFallback was
// unwrapped, so a stuck OpenAI call would block until the Vercel
// function timeout — much later than the 30s we already promised. See
// OPS-21.5.6-C.
const OPENAI_TIMEOUT_MS = 30_000

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set')
    }
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return anthropicClient
}

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set')
    }
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return openaiClient
}

/**
 * Sensitivity tier of the content this call carries. Per Playbook 21.3.1
 * + 21.3.5:
 *   1 = highly sensitive (tour transcripts, family context, payments,
 *       contracts, third-party mentions). Zero-retention required where
 *       the provider supports it.
 *   2 = PII (couple names, emails, phones, wedding dates). Default.
 *   3 = operational (KB content, marketing material, source attribution
 *       metadata). No PII; standard retention is fine.
 *   4 = aggregate / anonymised.
 *
 * Callers that handle tier-1 content MUST tag explicitly. Default is 2
 * because most brain calls carry couple PII; tier 1 is the strict
 * upgrade for transcripts and family-context paths.
 */
export type ContentTier = 1 | 2 | 3 | 4

/**
 * Model tier per Playbook 19.8 + OPS-21.4.2:
 *   haiku  — classification, small-label extraction, scoring rubrics.
 *            Default for router-brain, brain-dump stage-1 classifier,
 *            structured signal extraction with bounded schemas.
 *   sonnet — nuanced generation (drafts, briefings, NLQ narration,
 *            transcript extraction). Default for inquiry-brain,
 *            client-brain, sage-brain, intel-brain, post-tour brief,
 *            transcript-voice-learning. Default tier when unspecified.
 *   opus   — one-off premium synthesis (voice DNA corpus analysis,
 *            cross-domain strategic insights). Slow + expensive;
 *            reserved for low-volume work where output quality
 *            directly drives a coordinator decision.
 *
 * Mapping discipline: a higher tier than necessary is a defect (a
 * Sonnet call where Haiku suffices burns 12× the cost). The audit
 * surfaces tier-mismatches via api_costs.model rollups.
 */
export type ModelTier = 'haiku' | 'sonnet' | 'opus'

interface CallAIOptions {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  temperature?: number
  venueId?: string
  taskType?: string
  /**
   * Sensitivity tier (see ContentTier). Default 2. When set to 1, the
   * OpenAI fallback runs with `store: false`. Anthropic per-request
   * zero-retention is not supported on the standard API — ZDR is an
   * account-level setting that must be enabled by Anthropic for the
   * org before tier-1 calls are compliant. The contentTier column on
   * api_costs records the tag so an audit can verify which calls carry
   * tier-1 content. Playbook OPS-21.3.5.
   */
  contentTier?: ContentTier
  /**
   * Model tier (see ModelTier). Default 'sonnet'. Set 'haiku' for
   * classification + small-label extraction (router-brain, brain-dump
   * stage-1, structured extraction). Set 'opus' for premium one-off
   * synthesis. Higher tier than necessary = budget bleed.
   */
  tier?: ModelTier
}

function modelForTier(tier: ModelTier | undefined): string {
  switch (tier) {
    case 'haiku':
      return HAIKU_MODEL
    case 'opus':
      return OPUS_MODEL
    case 'sonnet':
    default:
      return CLAUDE_MODEL
  }
}

interface CallAIResult {
  text: string
  inputTokens: number
  outputTokens: number
  cost: number
}

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  return calculateModelCost(model, inputTokens, outputTokens)
}

async function logUsage(
  venueId: string | undefined,
  taskType: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  model: string,
  service: 'anthropic' | 'openai' = 'anthropic',
  contentTier: ContentTier = 2,
) {
  try {
    const supabase = createServiceClient()
    await supabase.from('api_costs').insert({
      venue_id: venueId,
      service,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost,
      context: taskType,
      content_tier: contentTier,
    })
  } catch {
    // Fire and forget — never block AI calls for logging
  }
}

/**
 * Runs a promise with a hard timeout. If it doesn't resolve in `ms`,
 * the returned promise rejects with a timeout error.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

async function callAnthropic(options: CallAIOptions): Promise<CallAIResult> {
  const {
    systemPrompt,
    userPrompt,
    maxTokens = 2000,
    temperature = 0.3,
    venueId,
    taskType = 'general',
    contentTier = 2,
    tier,
  } = options

  const anthropic = getAnthropic()
  const model = modelForTier(tier)

  // Tier-1 content (tour transcripts, family context, payment-adjacent
  // emails) MUST land at zero-retention. Anthropic's per-request
  // no-store header is not supported on the standard API — ZDR is an
  // account-level setting the org must have enabled. We log the tier
  // tag so post-hoc audits can verify the org-level config matched
  // the calls that carried tier-1 content. If an audit shows
  // tier=1 calls hit Anthropic without org-level ZDR, that's the gap.
  // OPS-21.3.5.
  const response = await withTimeout(
    anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    CLAUDE_TIMEOUT_MS,
    'Anthropic call'
  )

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cost = calculateCost(model, inputTokens, outputTokens)

  logUsage(venueId, taskType, inputTokens, outputTokens, cost, model, 'anthropic', contentTier)

  return { text, inputTokens, outputTokens, cost }
}

async function callOpenAIFallback(options: CallAIOptions): Promise<CallAIResult> {
  const {
    systemPrompt,
    userPrompt,
    maxTokens = 2000,
    temperature = 0.3,
    venueId,
    taskType = 'general',
    contentTier = 2,
  } = options

  const openai = getOpenAI()

  // Tier-1 → store: false. OpenAI's Chat Completions API supports
  // per-request opt-out from logging; using it on tier-1 fallback
  // calls satisfies OPS-21.3.5 the per-request side. This is the
  // first line of defense — even if Anthropic is down and we drop to
  // OpenAI for a sensitive call, no copy persists at OpenAI.
  const store = contentTier === 1 ? false : undefined

  // Wrap the fallback in withTimeout to mirror the primary's bound.
  // Without this, a hung OpenAI call after a Claude failure blocks the
  // request until the Vercel function timeout, well past the 30s
  // budget. OPS-21.5.6-C.
  const response = await withTimeout(
    openai.chat.completions.create({
      model: OPENAI_FALLBACK_MODEL,
      max_completion_tokens: maxTokens,
      temperature,
      // Only include `store` when explicitly false — the SDK treats
      // undefined as "use account default" which keeps tier-2+ calls
      // logged for OpenAI's normal trust+safety window. Tier-1 forces
      // the opt-out.
      ...(store === false ? { store: false as const } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    OPENAI_TIMEOUT_MS,
    'OpenAI fallback call'
  )

  const text = response.choices[0]?.message?.content ?? ''
  const inputTokens = response.usage?.prompt_tokens ?? 0
  const outputTokens = response.usage?.completion_tokens ?? 0
  const cost = calculateCost(OPENAI_FALLBACK_MODEL, inputTokens, outputTokens)

  logUsage(venueId, taskType, inputTokens, outputTokens, cost, OPENAI_FALLBACK_MODEL, 'openai', contentTier)

  return { text, inputTokens, outputTokens, cost }
}

/**
 * Main AI entry point. Tries Claude first; if it fails (error or >10s timeout),
 * retries once with OpenAI gpt-4o-mini using the same system prompt + user message.
 *
 * The fallback is transparent to callers — they get the same CallAIResult shape
 * regardless of which model actually answered. A structured log line is emitted
 * on every call so we can observe fallback rates.
 *
 * If neither model is available, throws a clean error the route can catch.
 *
 * Testing the fallback path: temporarily set ANTHROPIC_API_KEY to an invalid
 * value in .env.local — Claude will fail immediately and the fallback will
 * engage. Requires OPENAI_API_KEY to be set.
 */
export async function callAI(options: CallAIOptions): Promise<CallAIResult> {
  const taskType = options.taskType ?? 'general'
  const started = Date.now()
  const requestedModel = modelForTier(options.tier)

  try {
    const result = await callAnthropic(options)
    console.log(
      JSON.stringify({
        model: requestedModel,
        tier: options.tier ?? 'sonnet',
        fallback: false,
        taskType,
        durationMs: Date.now() - started,
      })
    )
    return result
  } catch (claudeErr) {
    const claudeDuration = Date.now() - started
    // Anthropic 4xx errors echo the prompt content in error.message
    // (e.g. "input length exceeded: 'Hi, my email is alice@... (snip)'").
    // For tier-1 calls (transcripts, sage chat with family context),
    // that prompt content can include PII. Redact before stdout.
    // OPS-21.3.3.
    console.warn(
      JSON.stringify({
        model: requestedModel,
        tier: options.tier ?? 'sonnet',
        fallback: false,
        taskType,
        durationMs: claudeDuration,
        error: redactError(claudeErr),
      })
    )

    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'AI unavailable: Claude failed and no OpenAI fallback is configured.'
      )
    }

    const fallbackStarted = Date.now()
    try {
      const result = await callOpenAIFallback(options)
      console.log(
        JSON.stringify({
          model: OPENAI_FALLBACK_MODEL,
          fallback: true,
          taskType,
          durationMs: Date.now() - fallbackStarted,
        })
      )
      return result
    } catch (openaiErr) {
      // OpenAI 4xx errors can also echo prompt content. Same redaction
      // discipline as the Anthropic side. OPS-21.3.3.
      console.error(
        JSON.stringify({
          model: OPENAI_FALLBACK_MODEL,
          fallback: true,
          taskType,
          durationMs: Date.now() - fallbackStarted,
          error: redactError(openaiErr),
        })
      )
      throw new Error('AI unavailable: both Claude and OpenAI fallback failed.')
    }
  }
}

export async function callAIJson<T = unknown>(options: CallAIOptions): Promise<T> {
  const result = await callAI({
    ...options,
    systemPrompt: options.systemPrompt + '\n\nRespond with valid JSON only. No markdown, no code blocks, no explanation.',
  })

  const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  return JSON.parse(cleaned) as T
}

export async function callAIVision(options: {
  systemPrompt: string
  userPrompt: string
  imageBase64: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  maxTokens?: number
  venueId?: string
  taskType?: string
  contentTier?: ContentTier
}): Promise<CallAIResult> {
  const anthropic = getAnthropic()
  const contentTier = options.contentTier ?? 2

  // Vision callers handle screenshots — frequently coordinator dashboards
  // (storefront analytics) which are tier 3, but also tier-1 cases like
  // contract images or family photos. Pass contentTier through so the
  // audit trail tags it correctly.
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: options.maxTokens ?? 2000,
    system: options.systemPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: options.mediaType, data: options.imageBase64 } },
        { type: 'text', text: options.userPrompt },
      ],
    }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cost = calculateCost(CLAUDE_MODEL, inputTokens, outputTokens)

  logUsage(options.venueId, options.taskType ?? 'vision', inputTokens, outputTokens, cost, CLAUDE_MODEL, 'anthropic', contentTier)

  return { text, inputTokens, outputTokens, cost }
}
