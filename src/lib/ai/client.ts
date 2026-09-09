import Anthropic from '@anthropic-ai/sdk'
import { writeOrLog } from '@/lib/db/write-or-log'
import OpenAI from 'openai'
import { createServiceClient } from '@/lib/supabase/service'
import { calculateCost as calculateModelCost } from '@/lib/ai/cost-tracker'
import { redactError } from '@/lib/observability/redact'
import {
  recordCall,
  shouldSkip,
  isFallbackForced,
  isFallbackDisabled,
} from '@/lib/ai/circuit-breaker'
import { alertFallbackFired } from '@/lib/ai/alert-fallback'

let anthropicClient: Anthropic | null = null
let openaiClient: OpenAI | null = null

// Live brain-call model identifiers. Exported so any DB-stored
// `model_used` audit trail (drafts, briefings, journey-narratives,
// post-tour briefs, re-engagement actions) can persist the exact
// constant used for the call rather than a stale hand-typed string.
// Pre-fix several services stored 'claude-sonnet' or 'claude-sonnet-4',
// which drifted from the actual model and made post-hoc audits lie —
// OPS-21.5.2 partial.
export const CLAUDE_MODEL = 'claude-sonnet-4-6'
// Haiku tier for classification + small-label extraction. Per Playbook
// 19.8 model-tier guidance: classifications, small-rubric scoring,
// embedding generation, structured-output extraction with bounded
// schemas. ~3x cheaper than Sonnet, biggest single cost lever.
// Wedgewood-scale (80+ venues × thousands of classifier calls/day)
// makes the right tier mapping the difference between profitable and
// not. OPS-21.4.2.
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
// Opus tier for one-off premium synthesis (voice DNA corpus analysis,
// cross-domain strategic insight composition). Slow and expensive;
// reserved for low-volume / high-stakes work.
export const OPUS_MODEL = 'claude-opus-4-8'
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

/**
 * Thrown when no provider could answer: Claude failed (or was skipped by
 * the breaker/override) AND the OpenAI fallback also failed, is disabled,
 * or was never configured. Couple-facing routes catch THIS specifically
 * and render a warm, in-voice message instead of a raw 500 — a provider
 * outage must never reach a couple as "Internal server error". Internal
 * and coordinator callers can let it propagate.
 */
export class AIUnavailableError extends Error {
  readonly stage: 'both_failed' | 'no_fallback' | 'fallback_disabled' | 'config_conflict'
  constructor(message: string, stage: AIUnavailableError['stage']) {
    super(message)
    this.name = 'AIUnavailableError'
    this.stage = stage
  }
}

/**
 * Couple-safe copy for a total AI outage. Deliberately warm and calm: the
 * last thing a couple sees when every floor has failed should feel like it
 * came from someone who cares, not a system apologising for itself.
 * Name-agnostic so it renders even when we never got far enough to load
 * the venue's Sage identity.
 */
export const COUPLE_AI_UNAVAILABLE_MESSAGE =
  "I'm having trouble reaching my brain just now, so I'd rather not guess and risk telling you " +
  "something wrong. I've let your coordinator know, and they'll follow up with you directly. " +
  'Do try me again in a few minutes.'

// Bounded, deliberate retry (Failure three). The SDK clients retry
// transient errors (network drops, 408/409/429/5xx) with exponential
// backoff up to this many times INSIDE a single call, then give up and
// surface the error, at which point the router changes provider. Setting
// this explicitly rather than taking the default makes "limited retry" an
// owned decision, not blind repetition: a struggling dependency gets a
// small, capped number of second chances, never an unbounded queue of
// duplicate work.
const PROVIDER_MAX_RETRIES = 2

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set')
    }
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: PROVIDER_MAX_RETRIES,
    })
  }
  return anthropicClient
}

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set')
    }
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: PROVIDER_MAX_RETRIES,
    })
  }
  return openaiClient
}

/**
 * Classify a provider error so retry-vs-fallback is a deliberate decision
 * rather than a blanket "any error means fallback" (Failure three). By the
 * time an error reaches the router the SDK has already spent its bounded
 * retries, so this mostly drives observability (the class lands in the log
 * line), but it also names the intent: which failures a limited retry can
 * fix, and which mean changing provider.
 *   retryable  — transient: network drop, timeout, no HTTP status, 5xx,
 *                408/409. A limited retry is worth it (and the SDK did it).
 *   rate_limit — 429. Retried a bounded number of times, then treated as a
 *                provider failure and sent to the fallback path.
 *   fatal      — 4xx a retry can't fix (bad request, auth, not found).
 *                Straight to fallback; re-sending the same request is futile.
 */
export type ProviderErrorClass = 'retryable' | 'rate_limit' | 'fatal'

export function classifyProviderError(err: unknown): ProviderErrorClass {
  const rawStatus =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : undefined
  if (rawStatus === 429) return 'rate_limit'
  if (rawStatus === undefined || Number.isNaN(rawStatus)) return 'retryable'
  if (rawStatus >= 500 || rawStatus === 408 || rawStatus === 409) return 'retryable'
  return 'fatal'
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
 * Sonnet call where Haiku suffices burns 3x the cost). The audit
 * surfaces tier-mismatches via api_costs.model rollups.
 */
export type ModelTier = 'haiku' | 'sonnet' | 'opus'

export interface CallAIOptions {
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
  /**
   * Prompt revision identifier (e.g. 'inquiry-brain.prompt.v1.0'). Each
   * brain module exports a BRAIN_PROMPT_VERSION constant the caller
   * threads through. Logged to api_costs.prompt_version so prompt-
   * regression audits can correlate cost / latency / output quality
   * to specific prompt revisions. Per Playbook OPS-21.5.1 / T1-E.
   */
  promptVersion?: string
  /**
   * Request-scoped uuid that ties this LLM call back to the inbound
   * event (email, sage chat, cron tick) that produced it. Logged to
   * api_costs.correlation_id so a coordinator can query "all costs
   * for this inbound" with a single ID. Optional — calls without a
   * correlationId are still logged but not threaded into a lineage.
   * Per Playbook OPS-21.2.1 / T1-G.
   */
  correlationId?: string
  /**
   * Internal: force this call onto the OpenAI fallback, skipping Claude,
   * for THIS request only (unlike the global AI_FORCE_FALLBACK env). Used
   * by callAIJson's Failure-four path: when floor one returns unparseable
   * or schema-invalid output, the retry is forced onto a genuinely
   * different provider rather than re-rolling the same model. Not for
   * general callers.
   */
  forceFallbackProvider?: boolean
  /**
   * Tool definitions for a tool-use turn. Additive: when omitted the call
   * behaves exactly as before. When present, Claude may answer with
   * `stop_reason: 'tool_use'` and the caller is responsible for running the
   * loop — see callAITools in `@/lib/ai/tools`. The OpenAI fallback does NOT
   * implement function calling, so a tools call that lands on the fallback
   * provider is refused honestly rather than answered without tools.
   */
  tools?: Anthropic.Tool[]
  /**
   * Full message history for a multi-turn (tool-use) call. When present it
   * REPLACES the single `userPrompt` turn. `userPrompt` is still required by
   * the type so existing callers compile unchanged; pass an empty string when
   * you supply `messages`.
   */
  messages?: Anthropic.MessageParam[]
  /**
   * Tool-choice control. Only meaningful alongside `tools`. Left undefined
   * (Claude decides) for every caller in this repo today.
   */
  toolChoice?: Anthropic.ToolChoice
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

export interface CallAIResult {
  text: string
  inputTokens: number
  outputTokens: number
  cost: number
  /**
   * Why the model stopped. Additive and optional so nothing that only reads
   * `.text` has to change. A tool-use loop MUST read this: 'tool_use' means
   * the turn is not an answer, it is a request to run tools.
   */
  stopReason?: Anthropic.StopReason | null
  /**
   * The raw assistant content blocks, including any `tool_use` blocks. The
   * flattened `.text` above keeps the old contract; this is what a tool loop
   * needs to append back to the transcript verbatim.
   */
  content?: Anthropic.ContentBlock[]
  /** Which model actually answered. Set on the Anthropic path. */
  model?: string
}

/** First text block of a response, or '' when the turn was tools-only.
 *  Pre-tools this read content[0] positionally, which is wrong the moment a
 *  tool_use block comes first. */
function firstText(content: Anthropic.ContentBlock[]): string {
  for (const block of content) {
    if (block.type === 'text') return block.text
  }
  return ''
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
  promptVersion?: string,
  correlationId?: string,
) {
  try {
    const supabase = createServiceClient()
    await writeOrLog(supabase.from('api_costs').insert({
      venue_id: venueId,
      service,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost,
      context: taskType,
      content_tier: contentTier,
      prompt_version: promptVersion ?? null,
      correlation_id: correlationId ?? null,
    }), { op: 'api_costs.insert', venueId })
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
    promptVersion,
    correlationId,
    tools,
    messages,
    toolChoice,
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
      messages: messages ?? [{ role: 'user', content: userPrompt }],
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    }),
    CLAUDE_TIMEOUT_MS,
    'Anthropic call'
  )

  const text = firstText(response.content)
  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cost = calculateCost(model, inputTokens, outputTokens)

  logUsage(venueId, taskType, inputTokens, outputTokens, cost, model, 'anthropic', contentTier, promptVersion, correlationId)

  return {
    text,
    inputTokens,
    outputTokens,
    cost,
    stopReason: response.stop_reason,
    content: response.content,
    model,
  }
}

/**
 * ONE Anthropic turn, cost-logged, no OpenAI fallback.
 *
 * `callAI` owns the two-provider resilience contract; a tool-use loop cannot
 * use it, because the OpenAI fallback has no function calling and silently
 * answering a tool-grounded question without tools is exactly the
 * confabulation this whole workstream exists to stop. So the loop in
 * `@/lib/ai/tools` drives this instead and refuses honestly when Claude is
 * unavailable. Cost per turn still lands in api_costs, same as callAI.
 */
export async function callAnthropicTurn(options: CallAIOptions): Promise<CallAIResult> {
  return callAnthropic(options)
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
    promptVersion,
    correlationId,
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

  logUsage(venueId, taskType, inputTokens, outputTokens, cost, OPENAI_FALLBACK_MODEL, 'openai', contentTier, promptVersion, correlationId)

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

  // Operator overrides + circuit-breaker (T1-F / OPS-21.5.6).
  // AI_FORCE_FALLBACK skips Claude entirely (degraded-Anthropic
  // incident, or local fallback testing). The breaker also skips
  // Claude when its rolling 5-min error rate is ≥20%.
  const skipClaude =
    options.forceFallbackProvider || isFallbackForced() || shouldSkip('anthropic')

  if (!skipClaude) {
    try {
      const result = await callAnthropic(options)
      recordCall('anthropic', true)
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
      recordCall('anthropic', false)
      const claudeDuration = Date.now() - started
      const errorClass = classifyProviderError(claudeErr)
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
          errorClass,
          error: redactError(claudeErr),
        })
      )

      if (isFallbackDisabled()) {
        throw new AIUnavailableError(
          'AI unavailable: Claude failed and AI_DISABLE_FALLBACK is set.',
          'fallback_disabled'
        )
      }
      if (!process.env.OPENAI_API_KEY) {
        throw new AIUnavailableError(
          'AI unavailable: Claude failed and no OpenAI fallback is configured.',
          'no_fallback'
        )
      }
      // fall through to fallback below
    }
  } else if (isFallbackDisabled()) {
    // Forced-fallback + disabled-fallback is a contradiction; surface
    // it loudly rather than silently picking one.
    throw new AIUnavailableError(
      'AI config conflict: AI_FORCE_FALLBACK and AI_DISABLE_FALLBACK both set.',
      'config_conflict'
    )
  }

  // Either Claude was skipped (override / breaker) or it failed above.
  if (!process.env.OPENAI_API_KEY) {
    throw new AIUnavailableError('AI unavailable: no OpenAI fallback configured.', 'no_fallback')
  }
  const fallbackStarted = Date.now()
  try {
    const result = await callOpenAIFallback(options)
    recordCall('openai', true)
    const skipReason = skipClaude
      ? (isFallbackForced() ? 'force_fallback' : 'breaker_tripped')
      : 'claude_failed'
    console.log(
      JSON.stringify({
        model: OPENAI_FALLBACK_MODEL,
        fallback: true,
        taskType,
        durationMs: Date.now() - fallbackStarted,
        skipReason,
      })
    )
    // Floor two fired — page the operator (rate-limited, fire-and-forget).
    void alertFallbackFired({ kind: 'fallback_fired', taskType, vision: false, skipReason })
    return result
  } catch (openaiErr) {
    recordCall('openai', false)
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
    // Both floors down — page the operator (rate-limited, fire-and-forget).
    void alertFallbackFired({ kind: 'total_outage', taskType, vision: false })
    throw new AIUnavailableError('AI unavailable: both Claude and OpenAI fallback failed.', 'both_failed')
  }
}

/**
 * JSON entry point with schema-validated fallback (Failure four).
 *
 * An HTTP 200 is not success. A provider can return valid JSON in the
 * wrong shape, JSON wrapped in prose, or text that only stops being valid
 * JSON at character 4,000. So a response isn't accepted just because
 * something came back: it's parsed AND (optionally) shape-checked. If
 * floor one returns unusable output, the task is sent to floor two — a
 * genuinely different provider, not a re-roll of the same model — and
 * validated again. If both return unusable output, that's an
 * AIUnavailableError, same as a total outage, so couple-facing callers
 * degrade the same graceful way.
 *
 * `validate` is an optional predicate over the parsed value. Return false
 * to reject a structurally-wrong response (missing key, wrong type) and
 * trigger the fallback. Omit it to accept any parseable JSON.
 */
export async function callAIJson<T = unknown>(
  options: CallAIOptions & { validate?: (parsed: unknown) => boolean }
): Promise<T> {
  const { validate, ...rest } = options
  const jsonInstruction =
    '\n\nRespond with valid JSON only. No markdown, no code blocks, no explanation.'
  const systemPrompt = rest.systemPrompt + jsonInstruction
  const taskType = rest.taskType ?? 'general'

  const tryParse = (text: string): { ok: true; value: T } | { ok: false } => {
    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(cleaned)
      if (validate && !validate(parsed)) return { ok: false }
      return { ok: true, value: parsed as T }
    } catch {
      return { ok: false }
    }
  }

  // Floor one — normally Claude (callAI may already have dropped to OpenAI
  // if Claude was down; that's fine, this layer only cares whether the
  // OUTPUT is usable).
  const first = await callAI({ ...rest, systemPrompt })
  const firstParsed = tryParse(first.text)
  if (firstParsed.ok) return firstParsed.value

  console.warn(
    JSON.stringify({ event: 'json_validation_failed', stage: 'primary', taskType })
  )

  // Floor one produced unusable output. Retry forcing the OpenAI fallback —
  // a different provider is far more likely to fix a shape/parse problem
  // than asking the same model again.
  if (isFallbackDisabled()) {
    throw new AIUnavailableError(
      'AI unavailable: primary returned unusable JSON and AI_DISABLE_FALLBACK is set.',
      'fallback_disabled'
    )
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new AIUnavailableError(
      'AI unavailable: primary returned unusable JSON and no fallback is configured.',
      'no_fallback'
    )
  }

  const second = await callAI({ ...rest, systemPrompt, forceFallbackProvider: true })
  const secondParsed = tryParse(second.text)
  if (secondParsed.ok) return secondParsed.value

  console.error(
    JSON.stringify({ event: 'json_validation_failed', stage: 'fallback', taskType })
  )
  throw new AIUnavailableError(
    'AI unavailable: both providers returned unusable JSON.',
    'both_failed'
  )
}

interface CallAIVisionOptions {
  systemPrompt: string
  userPrompt: string
  imageBase64: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  maxTokens?: number
  venueId?: string
  taskType?: string
  contentTier?: ContentTier
  promptVersion?: string
  correlationId?: string
}

async function callAnthropicVision(options: CallAIVisionOptions): Promise<CallAIResult> {
  const anthropic = getAnthropic()
  const contentTier = options.contentTier ?? 2

  // Vision callers handle screenshots — frequently coordinator dashboards
  // (storefront analytics) which are tier 3, but also tier-1 cases like
  // contract images or family photos. Pass contentTier through so the
  // audit trail tags it correctly.
  const response = await withTimeout(
    anthropic.messages.create({
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
    }),
    CLAUDE_TIMEOUT_MS,
    'Anthropic vision call'
  )

  const text = firstText(response.content)
  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cost = calculateCost(CLAUDE_MODEL, inputTokens, outputTokens)

  logUsage(options.venueId, options.taskType ?? 'vision', inputTokens, outputTokens, cost, CLAUDE_MODEL, 'anthropic', contentTier, options.promptVersion, options.correlationId)

  return { text, inputTokens, outputTokens, cost }
}

async function callOpenAIVisionFallback(options: CallAIVisionOptions): Promise<CallAIResult> {
  const openai = getOpenAI()
  const contentTier = options.contentTier ?? 2

  // Tier-1 (contract images, family photos) → store: false, same
  // per-request opt-out discipline as the text fallback. gpt-4o-mini
  // accepts images via a data URL on a chat-completions content part.
  const store = contentTier === 1 ? false : undefined

  const response = await withTimeout(
    openai.chat.completions.create({
      model: OPENAI_FALLBACK_MODEL,
      max_completion_tokens: options.maxTokens ?? 2000,
      ...(store === false ? { store: false as const } : {}),
      messages: [
        { role: 'system', content: options.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: options.userPrompt },
            {
              type: 'image_url',
              image_url: { url: `data:${options.mediaType};base64,${options.imageBase64}` },
            },
          ],
        },
      ],
    }),
    OPENAI_TIMEOUT_MS,
    'OpenAI vision fallback call'
  )

  const text = response.choices[0]?.message?.content ?? ''
  const inputTokens = response.usage?.prompt_tokens ?? 0
  const outputTokens = response.usage?.completion_tokens ?? 0
  const cost = calculateCost(OPENAI_FALLBACK_MODEL, inputTokens, outputTokens)

  logUsage(options.venueId, options.taskType ?? 'vision', inputTokens, outputTokens, cost, OPENAI_FALLBACK_MODEL, 'openai', contentTier, options.promptVersion, options.correlationId)

  return { text, inputTokens, outputTokens, cost }
}

/**
 * Vision entry point. Same resilience contract as callAI: Claude first
 * (timeout-bounded, circuit-breaker aware), OpenAI gpt-4o-mini vision on
 * failure, honouring AI_FORCE_FALLBACK / AI_DISABLE_FALLBACK. Pre-fix
 * this path called Anthropic directly with no timeout and no fallback, so
 * contract OCR and image classification were floor-one-only — if Claude
 * was down they failed outright. Throws AIUnavailableError when no
 * provider can answer, so couple-facing vision paths degrade the same way
 * as chat. OPS-21.5.6-D.
 */
export async function callAIVision(options: CallAIVisionOptions): Promise<CallAIResult> {
  const taskType = options.taskType ?? 'vision'
  const started = Date.now()

  const skipClaude = isFallbackForced() || shouldSkip('anthropic')

  if (!skipClaude) {
    try {
      const result = await callAnthropicVision(options)
      recordCall('anthropic', true)
      console.log(
        JSON.stringify({ model: CLAUDE_MODEL, vision: true, fallback: false, taskType, durationMs: Date.now() - started })
      )
      return result
    } catch (claudeErr) {
      recordCall('anthropic', false)
      console.warn(
        JSON.stringify({
          model: CLAUDE_MODEL,
          vision: true,
          fallback: false,
          taskType,
          durationMs: Date.now() - started,
          error: redactError(claudeErr),
        })
      )
      if (isFallbackDisabled()) {
        throw new AIUnavailableError(
          'AI unavailable: Claude vision failed and AI_DISABLE_FALLBACK is set.',
          'fallback_disabled'
        )
      }
      if (!process.env.OPENAI_API_KEY) {
        throw new AIUnavailableError(
          'AI unavailable: Claude vision failed and no OpenAI fallback is configured.',
          'no_fallback'
        )
      }
      // fall through to fallback below
    }
  } else if (isFallbackDisabled()) {
    throw new AIUnavailableError(
      'AI config conflict: AI_FORCE_FALLBACK and AI_DISABLE_FALLBACK both set.',
      'config_conflict'
    )
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new AIUnavailableError('AI unavailable: no OpenAI vision fallback configured.', 'no_fallback')
  }
  const fallbackStarted = Date.now()
  try {
    const result = await callOpenAIVisionFallback(options)
    recordCall('openai', true)
    const skipReason = skipClaude
      ? (isFallbackForced() ? 'force_fallback' : 'breaker_tripped')
      : 'claude_failed'
    console.log(
      JSON.stringify({
        model: OPENAI_FALLBACK_MODEL,
        vision: true,
        fallback: true,
        taskType,
        durationMs: Date.now() - fallbackStarted,
        skipReason,
      })
    )
    // Floor two fired on a vision call — page the operator.
    void alertFallbackFired({ kind: 'fallback_fired', taskType, vision: true, skipReason })
    return result
  } catch (openaiErr) {
    recordCall('openai', false)
    console.error(
      JSON.stringify({
        model: OPENAI_FALLBACK_MODEL,
        vision: true,
        fallback: true,
        taskType,
        durationMs: Date.now() - fallbackStarted,
        error: redactError(openaiErr),
      })
    )
    // Both floors down on a vision call — page the operator.
    void alertFallbackFired({ kind: 'total_outage', taskType, vision: true })
    throw new AIUnavailableError(
      'AI unavailable: both Claude and OpenAI vision fallback failed.',
      'both_failed'
    )
  }
}
