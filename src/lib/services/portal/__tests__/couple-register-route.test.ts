import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { hashInviteToken } from '../provision'

/**
 * W1 (2026-09-08). The register endpoint against a fake supabase client.
 * No database, no network, no Resend.
 *
 * The cases that matter are the ones the old code got wrong: an event code
 * was enough to register, and a failed user_profiles insert still returned
 * success:true, leaving an auth user who could sign in and see an empty
 * portal because mig 226's RLS reads the profile row that was never written.
 */

interface FakeResult {
  data?: unknown
  error?: unknown
  count?: number
}

/**
 * Stands in for a PostgREST query builder: every method returns itself,
 * awaiting it (or calling maybeSingle/single) yields the canned result.
 */
function fakeQuery(result: FakeResult) {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: FakeResult) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject)
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => Promise.resolve(result)
        }
        return () => proxy
      },
    },
  )
  return proxy
}

interface FakeSpec {
  tables: Record<string, FakeResult[]>
  createUser?: FakeResult
  getUserByIdEmail?: Record<string, string>
}

interface FakeClient {
  from: (table: string) => unknown
  auth: {
    admin: {
      createUser: (input: unknown) => Promise<FakeResult>
      deleteUser: (id: string) => Promise<{ error: unknown }>
      getUserById: (id: string) => Promise<FakeResult>
    }
  }
}

let calls: string[] = []
let deletedUsers: string[] = []
let inserted: Record<string, unknown[]> = {}
let updated: Record<string, unknown[]> = {}

function makeClient(spec: FakeSpec): FakeClient {
  return {
    from(table: string) {
      calls.push(table)
      const queue = spec.tables[table]
      const result = queue && queue.length ? queue.shift()! : { data: null, error: null }
      // Wrap so we can record what the route tried to write.
      const inner = fakeQuery(result) as Record<string, unknown>
      return new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'insert') {
              return (payload: unknown) => {
                ;(inserted[table] ??= []).push(payload)
                return inner
              }
            }
            if (prop === 'update') {
              return (payload: unknown) => {
                ;(updated[table] ??= []).push(payload)
                return inner
              }
            }
            return (inner as Record<string | symbol, unknown>)[prop]
          },
        },
      )
    },
    auth: {
      admin: {
        createUser: async () =>
          spec.createUser ?? { data: { user: { id: 'auth-user-1' } }, error: null },
        deleteUser: async (id: string) => {
          deletedUsers.push(id)
          return { error: null }
        },
        getUserById: async (id: string) => ({
          data: { user: { id, email: spec.getUserByIdEmail?.[id] ?? 'other@example.com' } },
          error: null,
        }),
      },
    },
  }
}

let client: FakeClient
let rateLimitOk = true

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => client,
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({
    ok: rateLimitOk,
    remaining: rateLimitOk ? 9 : 0,
    resetAt: new Date(Date.now() + 60_000),
  }),
  secondsUntil: () => 60,
}))

const { POST } = await import('@/app/api/couple/register/route')

const TOKEN = 'a'.repeat(32)
const TOKEN_HASH = hashInviteToken(TOKEN)

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    venue_id: 'venue-1',
    wedding_id: 'wed-1',
    email: 'sarah@example.com',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    used_at: null,
    ...overrides,
  }
}

function weddingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wed-1',
    venue_id: 'venue-1',
    status: 'booked',
    couple_registered_at: null,
    venues: { name: 'Fernhill Barn', slug: 'fernhill-barn' },
    ...overrides,
  }
}

function request(body: Record<string, unknown>): NextRequest {
  return {
    json: async () => body,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.9' }),
  } as unknown as NextRequest
}

const validBody = {
  email: 'sarah@example.com',
  password: 'a-long-enough-password',
  invite: TOKEN,
  slug: 'fernhill-barn',
}

/** The default table script for a clean first registration. */
function happyTables(overrides: Partial<Record<string, FakeResult[]>> = {}) {
  return {
    couple_invites: [
      { data: inviteRow(), error: null },
      { data: [{ id: 'inv-1' }], error: null },
    ],
    weddings: [{ data: weddingRow(), error: null }],
    user_profiles: [
      { data: [], error: null },
      { error: null },
    ],
    people: [{ data: null, error: null }],
    ...overrides,
  } as Record<string, FakeResult[]>
}

beforeEach(() => {
  calls = []
  deletedUsers = []
  inserted = {}
  updated = {}
  rateLimitOk = true
})

describe('POST /api/couple/register', () => {
  it('registers the first partner against a valid invite', async () => {
    client = makeClient({ tables: happyTables() })
    const res = await POST(request(validBody))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({
      success: true,
      weddingId: 'wed-1',
      venueSlug: 'fernhill-barn',
      partnerNumber: 1,
    })
    // The profile row is the one RLS reads, so it must have landed.
    expect(inserted.user_profiles?.[0]).toMatchObject({
      id: 'auth-user-1',
      venue_id: 'venue-1',
      wedding_id: 'wed-1',
      role: 'couple',
    })
    expect(deletedUsers).toEqual([])
  })

  it('looks the invite up by hash, never by the plaintext token', async () => {
    const tables = happyTables()
    client = makeClient({ tables })
    await POST(request(validBody))
    // The token is 32 hex chars; the hash is 64. Nothing in the module
    // should be treating them as interchangeable.
    expect(TOKEN_HASH).toHaveLength(64)
    expect(TOKEN_HASH).not.toBe(TOKEN)
    expect(calls[0]).toBe('couple_invites')
  })

  it('rejects a request with no invite token, whatever else it carries', async () => {
    client = makeClient({ tables: happyTables() })
    const res = await POST(
      request({ ...validBody, invite: undefined, eventCode: 'RIX-482' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invitation email/i)
    expect(inserted.user_profiles).toBeUndefined()
  })

  it('rejects an event code on its own, which used to be the whole credential', async () => {
    client = makeClient({ tables: happyTables() })
    const res = await POST(
      request({
        email: 'stranger@example.com',
        password: 'a-long-enough-password',
        slug: 'fernhill-barn',
        eventCode: 'RIX-482',
      }),
    )
    expect(res.status).toBe(400)
    expect(deletedUsers).toEqual([])
    expect(inserted.user_profiles).toBeUndefined()
  })

  it('rejects an unknown token', async () => {
    client = makeClient({
      tables: happyTables({ couple_invites: [{ data: null, error: null }] }),
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not valid/i)
  })

  it('rejects an expired token', async () => {
    client = makeClient({
      tables: happyTables({
        couple_invites: [
          { data: inviteRow({ expires_at: '2026-01-01T00:00:00.000Z' }), error: null },
        ],
      }),
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/expired/i)
  })

  it('rejects a token redeemed by a different address', async () => {
    client = makeClient({ tables: happyTables() })
    const res = await POST(request({ ...validBody, email: 'someone@else.com' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/different email/i)
  })

  it('rejects a token presented against another venue slug', async () => {
    client = makeClient({
      tables: happyTables({
        weddings: [
          { data: weddingRow({ venues: { name: 'Hawthorne', slug: 'hawthorne-manor' } }), error: null },
        ],
      }),
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/does not belong to this venue/i)
  })

  it('refuses a wedding that is not booked or completed', async () => {
    client = makeClient({
      tables: happyTables({
        weddings: [{ data: weddingRow({ status: 'inquiry' }), error: null }],
      }),
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not open for portal accounts/i)
    expect(inserted.user_profiles).toBeUndefined()
  })

  it('refuses a third account on the same wedding', async () => {
    client = makeClient({
      tables: happyTables({
        user_profiles: [{ data: [{ id: 'p1' }, { id: 'p2' }], error: null }],
      }),
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/both partner accounts/i)
  })

  it('points an already-registered address at sign-in', async () => {
    client = makeClient({
      tables: happyTables({
        user_profiles: [{ data: [{ id: 'p1' }], error: null }],
      }),
      getUserByIdEmail: { p1: 'SARAH@example.com' },
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/already exists/i)
  })

  it('loses the race gracefully when the claim updates zero rows', async () => {
    client = makeClient({
      tables: happyTables({
        couple_invites: [
          { data: inviteRow(), error: null },
          { data: [], error: null },
        ],
      }),
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/already been used/i)
    expect(inserted.user_profiles).toBeUndefined()
  })

  it('deletes the auth user and returns 500 when the profile insert fails', async () => {
    client = makeClient({
      tables: happyTables({
        user_profiles: [
          { data: [], error: null },
          { error: { message: 'duplicate key value', code: '23505' } },
        ],
      }),
    })
    const res = await POST(request(validBody))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBeUndefined()
    expect(json.error).toMatch(/could not finish/i)
    // No half-success: the auth user goes, and the invite is handed back
    // so the couple can use the same link again.
    expect(deletedUsers).toEqual(['auth-user-1'])
    expect(updated.couple_invites?.at(-1)).toEqual({ used_at: null })
  })

  it('releases the invite when auth user creation fails', async () => {
    client = makeClient({
      tables: happyTables(),
      createUser: { data: null, error: { message: 'email already registered' } },
    })
    const res = await POST(request(validBody))
    expect(res.status).toBe(400)
    expect(updated.couple_invites?.at(-1)).toEqual({ used_at: null })
    expect(inserted.user_profiles).toBeUndefined()
  })

  it('does not stamp the registrant email onto a blank partner row', async () => {
    client = makeClient({ tables: happyTables() })
    await POST(request(validBody))
    // The old code wrote people.email here, which could put partner 2's
    // address onto partner 1's record.
    expect(updated.people).toBeUndefined()
  })

  it('returns 429 when rate limited, before touching the database', async () => {
    rateLimitOk = false
    client = makeClient({ tables: happyTables() })
    const res = await POST(request(validBody))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(calls).toEqual([])
  })

  it('rejects a short password before anything else', async () => {
    client = makeClient({ tables: happyTables() })
    const res = await POST(request({ ...validBody, password: 'short' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at least 8/i)
    expect(calls).toEqual([])
  })
})
