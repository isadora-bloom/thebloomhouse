/**
 * S2 (2026-09-14 security audit) — the cron auth helper's fail-closed
 * contract.
 *
 * The bug this pins down: ninety-two routes compared
 * `req.headers.get('authorization')` against the template string
 * `Bearer ${process.env.CRON_SECRET}`. With the variable unset that
 * right-hand side is the literal `Bearer undefined`, so anyone sending
 * that header was admitted to every one of them. The helper must refuse
 * instead, and it must refuse in a way that says the deployment is
 * broken (503) rather than that the caller is wrong (401).
 *
 * No network, no database, no Supabase. Pure env + Request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SECRET_LENGTH, isCronSecretConfigured, verifyCronAuth } from '../cron-auth'

/** 64 chars, the shape `openssl rand -hex 32` produces. */
const GOOD_SECRET = 'a'.repeat(64)
const GOOD_DESTRUCTIVE = 'b'.repeat(64)

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://bloom.test/api/cron', { headers })
}

const ORIGINAL = {
  CRON_SECRET: process.env.CRON_SECRET,
  CRON_SECRET_DESTRUCTIVE: process.env.CRON_SECRET_DESTRUCTIVE,
  VERCEL_ENV: process.env.VERCEL_ENV,
}

function setEnv(env: {
  secret?: string
  destructive?: string
  vercelEnv?: string
}): void {
  if (env.secret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = env.secret

  if (env.destructive === undefined) delete process.env.CRON_SECRET_DESTRUCTIVE
  else process.env.CRON_SECRET_DESTRUCTIVE = env.destructive

  if (env.vercelEnv === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = env.vercelEnv
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('verifyCronAuth — base secret', () => {
  it('refuses with 503 when CRON_SECRET is unset', () => {
    setEnv({})
    const result = verifyCronAuth(req({ authorization: 'Bearer anything' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(503)
    expect(result.error).toContain('CRON_SECRET unset')
  })

  it('refuses the literal `Bearer undefined` when CRON_SECRET is unset', () => {
    // The exact string the old inline comparison produced and accepted.
    setEnv({})
    const result = verifyCronAuth(req({ authorization: 'Bearer undefined' }))
    expect(result.ok).toBe(false)
  })

  it('refuses a request with no Authorization header at all', () => {
    setEnv({ secret: GOOD_SECRET })
    const result = verifyCronAuth(req())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(401)
  })

  it('accepts the matching bearer token', () => {
    setEnv({ secret: GOOD_SECRET })
    expect(verifyCronAuth(req({ authorization: `Bearer ${GOOD_SECRET}` })).ok).toBe(true)
  })

  it('refuses a near-miss token', () => {
    setEnv({ secret: GOOD_SECRET })
    const result = verifyCronAuth(req({ authorization: `Bearer ${'a'.repeat(63)}c` }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(401)
  })

  it('refuses a token of a different length without throwing', () => {
    // timingSafeEqual throws on mismatched buffer lengths; the helper
    // has to short-circuit before calling it.
    setEnv({ secret: GOOD_SECRET })
    expect(() => verifyCronAuth(req({ authorization: 'Bearer short' }))).not.toThrow()
    expect(verifyCronAuth(req({ authorization: 'Bearer short' })).ok).toBe(false)
  })

  it('refuses a short secret in production', () => {
    setEnv({ secret: 'short-but-set', vercelEnv: 'production' })
    const result = verifyCronAuth(req({ authorization: 'Bearer short-but-set' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(503)
    expect(result.error).toContain(String(MIN_SECRET_LENGTH))
  })

  it('tolerates a short secret outside production', () => {
    setEnv({ secret: 'short-but-set', vercelEnv: 'preview' })
    expect(verifyCronAuth(req({ authorization: 'Bearer short-but-set' })).ok).toBe(true)
  })

  it('accepts a secret of exactly the minimum length in production', () => {
    const exact = 'c'.repeat(MIN_SECRET_LENGTH)
    setEnv({ secret: exact, vercelEnv: 'production' })
    expect(verifyCronAuth(req({ authorization: `Bearer ${exact}` })).ok).toBe(true)
  })
})

describe('verifyCronAuth — destructive tier', () => {
  it('refuses a destructive job in production when CRON_SECRET_DESTRUCTIVE is unset', () => {
    setEnv({ secret: GOOD_SECRET, vercelEnv: 'production' })
    const result = verifyCronAuth(req({ authorization: `Bearer ${GOOD_SECRET}` }), {
      alwaysDestructive: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(503)
    expect(result.error).toContain('CRON_SECRET_DESTRUCTIVE')
  })

  it('refuses a named destructive job in production when the secret is unset', () => {
    setEnv({ secret: GOOD_SECRET, vercelEnv: 'production' })
    const result = verifyCronAuth(req({ authorization: `Bearer ${GOOD_SECRET}` }), {
      jobName: 'prune_telemetry',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(503)
  })

  it('leaves non-destructive jobs alone in production with the secret unset', () => {
    setEnv({ secret: GOOD_SECRET, vercelEnv: 'production' })
    const result = verifyCronAuth(req({ authorization: `Bearer ${GOOD_SECRET}` }), {
      jobName: 'weather_refresh',
    })
    expect(result.ok).toBe(true)
  })

  it('allows a destructive job outside production, with a warning', () => {
    setEnv({ secret: GOOD_SECRET, vercelEnv: 'preview' })
    const result = verifyCronAuth(req({ authorization: `Bearer ${GOOD_SECRET}` }), {
      alwaysDestructive: true,
    })
    expect(result.ok).toBe(true)
    expect(console.warn).toHaveBeenCalled()
  })

  it('accepts a vercel-cron user agent when the destructive secret is set', () => {
    setEnv({
      secret: GOOD_SECRET,
      destructive: GOOD_DESTRUCTIVE,
      vercelEnv: 'production',
    })
    const result = verifyCronAuth(
      req({ authorization: `Bearer ${GOOD_SECRET}`, 'user-agent': 'vercel-cron/1.0' }),
      { alwaysDestructive: true },
    )
    expect(result.ok).toBe(true)
  })

  it('accepts the explicit destructive header', () => {
    setEnv({
      secret: GOOD_SECRET,
      destructive: GOOD_DESTRUCTIVE,
      vercelEnv: 'production',
    })
    const result = verifyCronAuth(
      req({
        authorization: `Bearer ${GOOD_SECRET}`,
        'x-destructive-secret': GOOD_DESTRUCTIVE,
      }),
      { alwaysDestructive: true },
    )
    expect(result.ok).toBe(true)
  })

  it('refuses a wrong destructive header with 403', () => {
    setEnv({
      secret: GOOD_SECRET,
      destructive: GOOD_DESTRUCTIVE,
      vercelEnv: 'production',
    })
    const result = verifyCronAuth(
      req({
        authorization: `Bearer ${GOOD_SECRET}`,
        'x-destructive-secret': 'd'.repeat(64),
      }),
      { alwaysDestructive: true },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('refuses a missing destructive header without throwing on the length compare', () => {
    setEnv({
      secret: GOOD_SECRET,
      destructive: GOOD_DESTRUCTIVE,
      vercelEnv: 'production',
    })
    const call = () =>
      verifyCronAuth(req({ authorization: `Bearer ${GOOD_SECRET}` }), {
        alwaysDestructive: true,
      })
    expect(call).not.toThrow()
    expect(call().ok).toBe(false)
  })
})

describe('isCronSecretConfigured', () => {
  it('reports the variable', () => {
    setEnv({})
    expect(isCronSecretConfigured()).toBe(false)
    setEnv({ secret: GOOD_SECRET })
    expect(isCronSecretConfigured()).toBe(true)
  })
})
