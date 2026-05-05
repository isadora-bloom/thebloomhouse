/**
 * Unit tests for rate-limit.ts — circuit breaker + in-memory floor.
 *
 * Key challenge: `consecutiveFailures`, `circuitOpen`, and `circuitOpenUntil`
 * are module-level variables. We isolate each test group by resetting
 * modules with vi.resetModules() so each import gets a fresh module instance.
 *
 * Supabase and observability are mocked throughout — no network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Top-level mock declarations. vi.mock() is hoisted, so even though we import
// the module under test dynamically per-test, the factory is registered before
// any module loads.
// ---------------------------------------------------------------------------

vi.mock('@/lib/observability/metrics', () => ({
  recordCounter: vi.fn().mockResolvedValue(undefined),
  recordHistogram: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/observability/redact', () => ({
  redact: (s: string) => s,
  redactError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  redactObject: <T>(obj: T) => obj,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamically import `rate-limit` so tests that call vi.resetModules() first
 * get a fresh module with zeroed circuit-breaker state.
 */
async function freshModule(mockRpc: ReturnType<typeof vi.fn>) {
  // Re-register the service mock each time so it uses the latest mockRpc.
  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: () => ({ rpc: mockRpc }),
  }))
  const mod = await import('@/lib/rate-limit')
  return mod
}

beforeEach(() => {
  vi.resetModules()
})

// ---------------------------------------------------------------------------
// Guard: :shared namespace must throw
// ---------------------------------------------------------------------------

describe(':shared namespace guard', () => {
  it('throws immediately when key contains :shared', async () => {
    const mockRpc = vi.fn()
    const { checkRateLimit } = await freshModule(mockRpc)

    await expect(
      checkRateLimit({ key: 'sage:shared', limit: 10, windowSec: 60 }),
    ).rejects.toThrow(/:shared/)

    // The guard must throw before any Supabase call.
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('throws even when :shared is embedded in a longer key', async () => {
    const mockRpc = vi.fn()
    const { checkRateLimit } = await freshModule(mockRpc)

    await expect(
      checkRateLimit({ key: 'prefix:shared:suffix', limit: 10, windowSec: 60 }),
    ).rejects.toThrow(/:shared/)
  })
})

// ---------------------------------------------------------------------------
// Postgres success path: result shape
// ---------------------------------------------------------------------------

describe('successful Postgres response', () => {
  it('returns { ok, remaining, resetAt } with the correct shape', async () => {
    const futureReset = new Date(Date.now() + 60_000).toISOString()
    const mockRpc = vi.fn().mockResolvedValue({
      data: [{ allowed: true, remaining: 29, reset_at: futureReset }],
      error: null,
    })
    const { checkRateLimit } = await freshModule(mockRpc)

    const result = await checkRateLimit({ key: 'sage:abc123', limit: 30, windowSec: 60 })

    expect(result.ok).toBe(true)
    expect(result.remaining).toBe(29)
    expect(result.resetAt).toBeInstanceOf(Date)
  })

  it('returns ok=false when Postgres says not allowed', async () => {
    const futureReset = new Date(Date.now() + 60_000).toISOString()
    const mockRpc = vi.fn().mockResolvedValue({
      data: [{ allowed: false, remaining: 0, reset_at: futureReset }],
      error: null,
    })
    const { checkRateLimit } = await freshModule(mockRpc)

    const result = await checkRateLimit({ key: 'nlq:user-xyz', limit: 10, windowSec: 60 })

    expect(result.ok).toBe(false)
    expect(result.remaining).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Postgres error path: in-memory floor fallback
// ---------------------------------------------------------------------------

describe('Postgres error fallback — in-memory floor', () => {
  it('returns a valid result (does not throw) when Postgres RPC errors', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'connection refused' },
    })
    const { checkRateLimit } = await freshModule(mockRpc)

    const result = await checkRateLimit({ key: 'sage:venue-a', limit: 20, windowSec: 60 })

    expect(typeof result.ok).toBe('boolean')
    expect(typeof result.remaining).toBe('number')
    expect(result.resetAt).toBeInstanceOf(Date)
  })

  it('returns a valid result when Postgres throws', async () => {
    const mockRpc = vi.fn().mockRejectedValue(new Error('Postgres down'))
    const { checkRateLimit } = await freshModule(mockRpc)

    const result = await checkRateLimit({ key: 'sage:venue-b', limit: 20, windowSec: 60 })

    expect(typeof result.ok).toBe('boolean')
    expect(result.resetAt).toBeInstanceOf(Date)
  })

  it('in-memory floor: allows first call after Postgres failure', async () => {
    const mockRpc = vi.fn().mockRejectedValue(new Error('Postgres down'))
    const { checkRateLimit } = await freshModule(mockRpc)

    // First call must succeed (floor bucket is fresh).
    const result = await checkRateLimit({ key: 'sage:floor-test', limit: 40, windowSec: 60 })
    expect(result.ok).toBe(true)
  })

  it('in-memory floor: blocks after limit/4 calls per window', async () => {
    const mockRpc = vi.fn().mockRejectedValue(new Error('Postgres down'))
    const { checkRateLimit } = await freshModule(mockRpc)

    const limit = 20
    const key = 'sage:block-test'
    const floor = Math.max(1, Math.floor(limit / 4)) // = 5

    // First `floor` calls should succeed.
    for (let i = 0; i < floor; i++) {
      const r = await checkRateLimit({ key, limit, windowSec: 60 })
      expect(r.ok).toBe(true)
    }

    // The next call should be blocked (tokens exhausted).
    const blocked = await checkRateLimit({ key, limit, windowSec: 60 })
    expect(blocked.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Circuit breaker: 3 consecutive failures → circuit opens
// ---------------------------------------------------------------------------

describe('circuit breaker', () => {
  it('opens after 3 consecutive Postgres failures and keeps using in-memory floor', async () => {
    const mockRpc = vi.fn().mockRejectedValue(new Error('Postgres down'))
    const { checkRateLimit } = await freshModule(mockRpc)

    // Trigger 3 consecutive failures to open the circuit.
    for (let i = 0; i < 3; i++) {
      await checkRateLimit({ key: `sage:circuit-${i}`, limit: 20, windowSec: 60 })
    }

    // After 3 failures the circuit is open. A 4th call must still return
    // a valid result (not throw) — the fallback continues to work.
    const result = await checkRateLimit({ key: 'sage:circuit-open', limit: 20, windowSec: 60 })
    expect(typeof result.ok).toBe('boolean')
    expect(result.resetAt).toBeInstanceOf(Date)

    // The circuit should not call Postgres again once open.
    // The first 3 calls each triggered one RPC attempt; the 4th should not.
    expect(mockRpc).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// secondsUntil helper
// ---------------------------------------------------------------------------

describe('secondsUntil', () => {
  it('returns a number >= 1 for a future resetAt', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({ rpc: vi.fn() }),
    }))
    const { secondsUntil } = await import('@/lib/rate-limit')
    const future = new Date(Date.now() + 5_000)
    expect(secondsUntil(future)).toBeGreaterThanOrEqual(1)
  })

  it('returns 1 (clamped) for a past resetAt', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({ rpc: vi.fn() }),
    }))
    const { secondsUntil } = await import('@/lib/rate-limit')
    const past = new Date(Date.now() - 10_000)
    expect(secondsUntil(past)).toBe(1)
  })
})
