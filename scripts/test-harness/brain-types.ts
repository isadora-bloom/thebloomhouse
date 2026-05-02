/**
 * Mirrors the public shape of CallAIOptions / CallAIResult from
 * src/lib/ai/client.ts so the brain-regression harness can stub
 * callAI without importing the live module (which pulls in
 * Anthropic SDK + Supabase service client at module-init time —
 * not what we want in a unit test).
 */

export interface CallAIOptions {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  temperature?: number
  venueId?: string
  taskType?: string
  contentTier?: number
  tier?: 'sonnet' | 'haiku' | 'opus'
  promptVersion?: string
  correlationId?: string
  model?: string  // resolved at call time; stub uses for fingerprinting
}

export interface CallAIResult {
  text: string
  inputTokens: number
  outputTokens: number
  cost: number
}
