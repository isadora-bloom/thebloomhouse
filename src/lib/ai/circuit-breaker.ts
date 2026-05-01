/**
 * Provider circuit breaker (T1-F / Playbook 21.5.6).
 *
 * Tracks rolling 5-minute error rates per provider. When the primary
 * (Anthropic) trips the threshold, callAI skips it and goes straight
 * to OpenAI fallback for one minute. Avoids burning latency budget
 * 30s per request hammering a degraded provider.
 *
 * Two manual-override controls:
 *   - AI_FORCE_FALLBACK env var — when 'true', Claude is bypassed and
 *     every call goes straight to OpenAI. Useful during a known
 *     Anthropic incident or for testing the fallback path locally.
 *   - AI_DISABLE_FALLBACK env var — when 'true', OpenAI fallback is
 *     disabled and Claude failures throw immediately. Useful for
 *     A/B regression isolation when debugging Claude-only output.
 *
 * State is in-process (per-Vercel-function-instance). For
 * cross-instance trip propagation, a future iteration could persist
 * to Redis / Vercel KV. Per-instance is enough for the v1 cut: each
 * cold instance learns within ~30s if Anthropic is degraded.
 */

const WINDOW_MS = 5 * 60 * 1000 // rolling 5-minute window
const TRIP_THRESHOLD = 0.2 // 20% error rate trips the breaker
const TRIP_DURATION_MS = 60_000 // skip primary for 1 minute when tripped
const MIN_SAMPLES = 5 // need at least 5 calls before a trip can fire

export type Provider = 'anthropic' | 'openai'

interface ProviderState {
  events: Array<{ ts: number; ok: boolean }>
  trippedUntil: number
}

const state: Record<Provider, ProviderState> = {
  anthropic: { events: [], trippedUntil: 0 },
  openai: { events: [], trippedUntil: 0 },
}

function pruneOldEvents(s: ProviderState, now: number): void {
  const cutoff = now - WINDOW_MS
  // events is roughly time-ordered (we always push); drop from front.
  let drop = 0
  while (drop < s.events.length && s.events[drop].ts < cutoff) drop++
  if (drop > 0) s.events.splice(0, drop)
}

export function recordCall(provider: Provider, ok: boolean): void {
  const now = Date.now()
  const s = state[provider]
  s.events.push({ ts: now, ok })
  pruneOldEvents(s, now)

  if (s.events.length < MIN_SAMPLES) return
  const failures = s.events.filter((e) => !e.ok).length
  const rate = failures / s.events.length
  if (rate >= TRIP_THRESHOLD && now > s.trippedUntil) {
    s.trippedUntil = now + TRIP_DURATION_MS
  }
}

/**
 * Should we skip calling this provider right now? Returns true when
 * the breaker is tripped — caller should fall through to its fallback
 * (or fail fast for the openai side).
 */
export function shouldSkip(provider: Provider): boolean {
  const now = Date.now()
  return state[provider].trippedUntil > now
}

/**
 * Force-fallback override — read AI_FORCE_FALLBACK env var. Returns
 * true when the operator has explicitly told us to bypass Claude.
 * Per Playbook OPS-21.5.6-A.
 */
export function isFallbackForced(): boolean {
  const v = process.env.AI_FORCE_FALLBACK
  return v === 'true' || v === '1'
}

/**
 * Disable-fallback override — read AI_DISABLE_FALLBACK env var.
 * Returns true when the operator has told us to NOT fall back to
 * OpenAI (e.g. for A/B regression isolation, or to surface Claude
 * failures cleanly during debugging).
 */
export function isFallbackDisabled(): boolean {
  const v = process.env.AI_DISABLE_FALLBACK
  return v === 'true' || v === '1'
}

/**
 * Snapshot of breaker state — for the structured logger and for
 * /api/health surfacing per-provider error rate. Exported so the
 * cron health-check route can publish a venue-agnostic dashboard.
 */
export function getProviderHealth(provider: Provider): {
  samplesInWindow: number
  errorRate: number
  tripped: boolean
  trippedUntil: number | null
} {
  const now = Date.now()
  const s = state[provider]
  pruneOldEvents(s, now)
  const failures = s.events.filter((e) => !e.ok).length
  return {
    samplesInWindow: s.events.length,
    errorRate: s.events.length === 0 ? 0 : failures / s.events.length,
    tripped: s.trippedUntil > now,
    trippedUntil: s.trippedUntil > now ? s.trippedUntil : null,
  }
}

/**
 * Test-only — wipes state. Tests should call this in beforeEach so
 * one test's failures don't trip another's breaker.
 */
export function _resetBreaker(): void {
  state.anthropic.events = []
  state.anthropic.trippedUntil = 0
  state.openai.events = []
  state.openai.trippedUntil = 0
}
