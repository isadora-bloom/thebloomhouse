import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createServiceClient } from '@/lib/supabase/service'
import { calculateCost as calculateModelCost } from '@/lib/ai/cost-tracker'

let anthropicClient: Anthropic | null = null
let openaiClient: OpenAI | null = null

const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const OPENAI_FALLBACK_MODEL = 'gpt-4o-mini'
const CLAUDE_TIMEOUT_MS = 10_000

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
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

interface CallAIOptions {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  temperature?: number
  venueId?: string
  taskType?: string
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
  service: 'anthropic' | 'openai' = 'anthropic'
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
  } = options

  const anthropic = getAnthropic()

  const response = await withTimeout(
    anthropic.messages.create({
      model: CLAUDE_MODEL,
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
  const cost = calculateCost(CLAUDE_MODEL, inputTokens, outputTokens)

  logUsage(venueId, taskType, inputTokens, outputTokens, cost, CLAUDE_MODEL, 'anthropic')

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
  } = options

  const openai = getOpenAI()

  const response = await openai.chat.completions.create({
    model: OPENAI_FALLBACK_MODEL,
    max_completion_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  })

  const text = response.choices[0]?.message?.content ?? ''
  const inputTokens = response.usage?.prompt_tokens ?? 0
  const outputTokens = response.usage?.completion_tokens ?? 0
  const cost = calculateCost(OPENAI_FALLBACK_MODEL, inputTokens, outputTokens)

  logUsage(venueId, taskType, inputTokens, outputTokens, cost, OPENAI_FALLBACK_MODEL, 'openai')

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

  try {
    const result = await callAnthropic(options)
    console.log(
      JSON.stringify({
        model: CLAUDE_MODEL,
        fallback: false,
        taskType,
        durationMs: Date.now() - started,
      })
    )
    return result
  } catch (claudeErr) {
    const claudeDuration = Date.now() - started
    console.warn(
      JSON.stringify({
        model: CLAUDE_MODEL,
        fallback: false,
        taskType,
        durationMs: claudeDuration,
        error: claudeErr instanceof Error ? claudeErr.message : String(claudeErr),
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
      console.error(
        JSON.stringify({
          model: OPENAI_FALLBACK_MODEL,
          fallback: true,
          taskType,
          durationMs: Date.now() - fallbackStarted,
          error: openaiErr instanceof Error ? openaiErr.message : String(openaiErr),
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
}): Promise<CallAIResult> {
  const model = 'claude-sonnet-4-20250514'
  const anthropic = getAnthropic()

  const response = await anthropic.messages.create({
    model,
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
  const cost = calculateCost(model, inputTokens, outputTokens)

  logUsage(options.venueId, options.taskType ?? 'vision', inputTokens, outputTokens, cost, model)

  return { text, inputTokens, outputTokens, cost }
}
