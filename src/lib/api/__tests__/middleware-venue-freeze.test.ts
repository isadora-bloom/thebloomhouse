/**
 * The middleware refuses API writes for a frozen venue (trial ended, no
 * subscription, migration 417) with a 402 before the route runs. Reads,
 * billing, super admins and live venues pass. The database refuses the
 * write anyway; this is about failing early and clearly.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const FROZEN = '11111111-1111-4111-8111-111111111111'
const LIVE = '22222222-2222-4222-8222-222222222222'

const state = { role: 'coordinator', venueId: FROZEN as string | null }

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select() { return this },
      eq() { return this },
      maybeSingle: async () => ({ data: { role: state.role, venue_id: state.venueId } }),
      single: async () => ({ data: { role: state.role, venue_id: state.venueId } }),
    }),
    rpc: async (_fn: string, args: { p_venue_id: string }) => ({ data: args.p_venue_id === FROZEN, error: null }),
  }),
}))

const { middleware } = await import('../../../middleware')

function req(path: string, method = 'POST', cookie?: string) {
  return middleware(
    new NextRequest(`https://app.bloomhouse.ai${path}`, {
      method,
      headers: cookie ? { cookie } : undefined,
    }),
  )
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon'
})

describe('frozen venue write guard', () => {
  it('402s an API write from a frozen venue', async () => {
    Object.assign(state, { role: 'coordinator', venueId: FROZEN })
    const res = await req('/api/agent/send')
    expect(res.status).toBe(402)
    expect((await res.json()).code).toBe('venue_frozen')
  })

  it('lets reads through', async () => {
    Object.assign(state, { role: 'coordinator', venueId: FROZEN })
    expect((await req('/api/agent/drafts', 'GET')).status).not.toBe(402)
  })

  it('lets billing and Stripe through so the venue can pay', async () => {
    Object.assign(state, { role: 'org_admin', venueId: FROZEN })
    expect((await req('/api/stripe/checkout')).status).not.toBe(402)
    expect((await req('/api/billing/usage')).status).not.toBe(402)
  })

  it('lets a live venue write', async () => {
    Object.assign(state, { role: 'coordinator', venueId: LIVE })
    expect((await req('/api/agent/send')).status).not.toBe(402)
  })

  it('lets Bloom staff through (the trigger still applies to them)', async () => {
    Object.assign(state, { role: 'super_admin', venueId: FROZEN })
    expect((await req('/api/agent/send')).status).not.toBe(402)
  })

  it('checks the venue picked in the scope cookie too', async () => {
    Object.assign(state, { role: 'org_admin', venueId: LIVE })
    expect((await req('/api/agent/send', 'POST', `bloom_venue=${FROZEN}`)).status).toBe(402)
  })

  it("can't be talked out of the profile's own frozen venue by the cookie", async () => {
    Object.assign(state, { role: 'coordinator', venueId: FROZEN })
    expect((await req('/api/agent/send', 'POST', `bloom_venue=${LIVE}`)).status).toBe(402)
  })

  it('still 403s a readonly profile first', async () => {
    Object.assign(state, { role: 'readonly', venueId: FROZEN })
    expect((await req('/api/agent/send')).status).toBe(403)
  })
})
