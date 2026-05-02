/**
 * In-memory TTL cache for repeat AI prompts (OPS-21.4.4).
 *
 * The T3 named-insights pattern caches via the database
 * (intelligence_insights.cache_key + last_classical_signature). That
 * works for surface-level read paths. This module covers the OTHER
 * cost-bleed: brain-call paths that re-prompt with semantically
 * identical inputs within a short window — daily-digest summarising
 * the same wedding twice on the same day, the briefing cron firing
 * twice within an hour because of cron misconfiguration, the same
 * coordinator hitting "regenerate" repeatedly while the first call
 * is still in flight.
 *
 * Design choices:
 *   - Process-local Map (no Redis dependency). Vercel functions go
 *     warm/cold; on cold start cache is empty. That's the right
 *     trade-off for a non-shared cache — paying for a Redis
 *     dependency for a "save us from cron-misconfig" guard would
 *     dwarf the savings.
 *   - Default TTL 5 minutes. Long enough to absorb double-fires +
 *     concurrent reads; short enough that prompt revisions land
 *     within one Anthropic prompt-cache window (5min Anthropic TTL).
 *   - Singleflight: in-flight promise is returned to subsequent
 *     callers asking for the same key. Two coordinators clicking
 *     "Refresh" simultaneously share the same Anthropic call.
 *   - Cache key is FNV-1a 32-bit of {systemPrompt + userPrompt +
 *     model + temperature}. Same shape as buildCacheKey in
 *     insights/confidence.ts so future readers don't trip over
 *     two different hash functions.
 *   - Soft cap at 256 entries per process; LRU-style eviction by
 *     touch order. Prevents memory growth on long-running serverless
 *     functions.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000   // 5 minutes
const MAX_ENTRIES = 256

interface CacheEntry<T> {
  value: T
  expiresAt: number
  /** Last-touch timestamp for LRU eviction. */
  touchedAt: number
}

const responseCache = new Map<string, CacheEntry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

/** FNV-1a 32-bit; mirrors buildCacheKey in insights/confidence.ts. */
function hash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export interface AiCacheKeyArgs {
  systemPrompt: string
  userPrompt: string
  /** Resolved model identifier (CLAUDE_MODEL / HAIKU_MODEL / etc.). */
  model: string
  temperature?: number
  /** Brain prompt revision — cache invalidates on prompt bump. */
  promptVersion?: string
}

export function aiCacheKey(args: AiCacheKeyArgs): string {
  const composite = JSON.stringify({
    s: args.systemPrompt,
    u: args.userPrompt,
    m: args.model,
    t: args.temperature ?? 0.4,
    v: args.promptVersion ?? '',
  })
  return hash(composite)
}

function evictExpired(): void {
  const now = Date.now()
  for (const [k, v] of responseCache.entries()) {
    if (v.expiresAt <= now) responseCache.delete(k)
  }
}

function evictOldestIfFull(): void {
  if (responseCache.size < MAX_ENTRIES) return
  let oldestKey: string | null = null
  let oldestTouch = Infinity
  for (const [k, v] of responseCache.entries()) {
    if (v.touchedAt < oldestTouch) {
      oldestTouch = v.touchedAt
      oldestKey = k
    }
  }
  if (oldestKey !== null) responseCache.delete(oldestKey)
}

/**
 * Look up a cached AI response by key. Returns the value (and
 * touches it for LRU) when present + unexpired; null otherwise.
 */
export function getCachedAiResponse<T>(key: string): T | null {
  const entry = responseCache.get(key) as CacheEntry<T> | undefined
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key)
    return null
  }
  entry.touchedAt = Date.now()
  return entry.value
}

export function setCachedAiResponse<T>(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): void {
  evictExpired()
  evictOldestIfFull()
  responseCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    touchedAt: Date.now(),
  })
}

/**
 * Cache wrapper with single-flight de-duplication. Two parallel
 * callers asking for the same key share one in-flight call. Use
 * around any callAI invocation where same-input, repeat-call is
 * plausible (cron-driven briefings, coordinator "Refresh", etc.).
 *
 * Returns the cached value on subsequent calls within ttlMs without
 * invoking the loader.
 */
export async function withAiCache<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const cached = getCachedAiResponse<T>(key)
  if (cached !== null) return cached

  // Single-flight: another caller already running; await theirs.
  const inflightPromise = inflight.get(key) as Promise<T> | undefined
  if (inflightPromise) return inflightPromise

  const p = (async () => {
    try {
      const value = await loader()
      setCachedAiResponse(key, value, ttlMs)
      return value
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

// Test-only hooks.
export const __test__ = {
  hash,
  reset(): void {
    responseCache.clear()
    inflight.clear()
  },
  size(): number {
    return responseCache.size
  },
  inflightSize(): number {
    return inflight.size
  },
  DEFAULT_TTL_MS,
  MAX_ENTRIES,
}
