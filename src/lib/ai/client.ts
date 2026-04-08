import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { calculateCost as calculateModelCost } from '@/lib/ai/cost-tracker'

let anthropicClient: Anthropic | null = null

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  }
  return anthropicClient
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
  model: string
) {
  try {
    const supabase = createServiceClient()
    await supabase.from('api_costs').insert({
      venue_id: venueId,
      service: 'anthropic',
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

export async function callAI(options: CallAIOptions): Promise<CallAIResult> {
  const {
    systemPrompt,
    userPrompt,
    maxTokens = 2000,
    temperature = 0.3,
    venueId,
    taskType = 'general',
  } = options

  const model = 'claude-sonnet-4-20250514'
  const anthropic = getAnthropic()

  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cost = calculateCost(model, inputTokens, outputTokens)

  logUsage(venueId, taskType, inputTokens, outputTokens, cost, model)

  return { text, inputTokens, outputTokens, cost }
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
