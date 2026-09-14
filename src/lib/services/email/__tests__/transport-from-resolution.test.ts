/**
 * W55 (NOVEMBER-PLAN.md wave 8) — per-venue sending domains.
 *
 * Pins transport.ts's resolveFrom: the venue's own domain is used only
 * when sending_domain_status is 'verified', every other case falls back
 * to the platform default with a structured, non-silent reason, and two
 * venues never see each other's domain (venue isolation). No real
 * Supabase / no real Resend — createServiceClient and the structured
 * logger are mocked. No network in this file: sendEmail's Resend branch
 * (the actual `client.emails.send` call) is exercised separately by
 * sending-domain.test.ts's Resend-response-shape fixtures against a
 * mocked 'resend' module, never the real API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-test config table. Keyed by venue_id, same shape venue_config
// returns for the columns resolveFrom selects.
const venueConfigRows: Record<
  string,
  { sending_domain: string | null; sending_from_name: string | null; sending_domain_status: string | null } | undefined
> = {}

const logEventMock = vi.fn()

vi.mock('@/lib/observability/logger', () => ({
  logEvent: (...args: unknown[]) => logEventMock(...args),
}))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'venue_config') throw new Error(`unexpected table: ${table}`)
      return {
        select(_cols: string) {
          return this
        },
        eq(_col: string, venueId: string) {
          return {
            maybeSingle: async () => {
              if (venueId === 'throws') throw new Error('connection reset')
              if (venueId === 'db-error') return { data: null, error: { message: 'db exploded' } }
              return { data: venueConfigRows[venueId] ?? null, error: null }
            },
          }
        },
      }
    },
  }),
}))

import { _internal } from '../transport'

const { resolveFrom } = _internal

beforeEach(() => {
  logEventMock.mockClear()
  for (const key of Object.keys(venueConfigRows)) delete venueConfigRows[key]
  delete process.env.EMAIL_FROM
})

describe('resolveFrom — verified venue', () => {
  it("uses the venue's own domain and chosen display name", async () => {
    venueConfigRows['venue-a'] = {
      sending_domain: 'theglasshouse.com',
      sending_from_name: 'The Glass House',
      sending_domain_status: 'verified',
    }
    const { from, fallbackReason } = await resolveFrom('venue-a', undefined)
    expect(from).toBe('The Glass House <hello@theglasshouse.com>')
    expect(fallbackReason).toBeNull()
  })

  it('does not fall back even when the caller also passed a fromName override', async () => {
    venueConfigRows['venue-a'] = {
      sending_domain: 'theglasshouse.com',
      sending_from_name: 'The Glass House',
      sending_domain_status: 'verified',
    }
    const { from, fallbackReason } = await resolveFrom('venue-a', 'Some Other Name')
    expect(from).toBe('The Glass House <hello@theglasshouse.com>')
    expect(fallbackReason).toBeNull()
  })
})

describe('resolveFrom — unverified / pending / failed venue', () => {
  it('falls back to the platform domain, keeping the venue display name, with a structured reason', async () => {
    venueConfigRows['venue-b'] = {
      sending_domain: 'hawthornemanor.com',
      sending_from_name: 'Hawthorne Manor',
      sending_domain_status: 'pending',
    }
    const { from, fallbackReason } = await resolveFrom('venue-b', undefined)
    expect(from).toBe('Hawthorne Manor <hello@thebloomhouse.ai>')
    expect(fallbackReason).toBe('sending_domain_status_pending')
  })

  it('falls back when status is failed', async () => {
    venueConfigRows['venue-c'] = {
      sending_domain: 'glasshouse.com',
      sending_from_name: 'The Glass House',
      sending_domain_status: 'failed',
    }
    const { fallbackReason } = await resolveFrom('venue-c', undefined)
    expect(fallbackReason).toBe('sending_domain_status_failed')
  })

  it("falls back when no domain has been configured at all, using the caller's fromName", async () => {
    venueConfigRows['venue-d'] = {
      sending_domain: null,
      sending_from_name: null,
      sending_domain_status: 'unverified',
    }
    const { from, fallbackReason } = await resolveFrom('venue-d', 'Rose Hill Gardens')
    expect(from).toBe('Rose Hill Gardens <hello@thebloomhouse.ai>')
    expect(fallbackReason).toBe('sending_domain_not_configured')
  })

  it('falls back to the bare platform default when neither venue nor caller has a display name', async () => {
    venueConfigRows['venue-e'] = {
      sending_domain: null,
      sending_from_name: null,
      sending_domain_status: 'unverified',
    }
    const { from } = await resolveFrom('venue-e', undefined)
    expect(from).toBe('The Bloom House <hello@thebloomhouse.ai>')
  })
})

describe('resolveFrom — missing config / lookup failure', () => {
  it('falls back when the venue has no venue_config row at all', async () => {
    const { from, fallbackReason } = await resolveFrom('no-such-venue', 'A Venue')
    expect(from).toBe('A Venue <hello@thebloomhouse.ai>')
    expect(fallbackReason).toBe('venue_config_missing')
  })

  it('falls back when the query returns a Postgres error', async () => {
    const { fallbackReason } = await resolveFrom('db-error', undefined)
    expect(fallbackReason).toBe('venue_config_lookup_failed')
  })

  it('falls back when the query throws', async () => {
    const { fallbackReason } = await resolveFrom('throws', undefined)
    expect(fallbackReason).toBe('venue_config_lookup_threw')
  })
})

describe('resolveFrom — venueId: null is a platform-level send, not a fallback', () => {
  it('resolves the platform default with no venue lookup and no logged reason', async () => {
    const { from, fallbackReason } = await resolveFrom(null, undefined)
    expect(from).toBe('The Bloom House <hello@thebloomhouse.ai>')
    expect(fallbackReason).toBeNull()
  })

  it('honours a fromName override for a platform-level send', async () => {
    const { from } = await resolveFrom(null, 'Bloom Ops')
    expect(from).toBe('Bloom Ops <hello@thebloomhouse.ai>')
  })
})

describe('resolveFrom — venue isolation', () => {
  it("never returns venue B's domain for venue A, or vice versa", async () => {
    venueConfigRows['venue-a'] = {
      sending_domain: 'theglasshouse.com',
      sending_from_name: 'The Glass House',
      sending_domain_status: 'verified',
    }
    venueConfigRows['venue-b'] = {
      sending_domain: 'crestwoodfarm.com',
      sending_from_name: 'Crestwood Farm',
      sending_domain_status: 'verified',
    }

    const a = await resolveFrom('venue-a', undefined)
    const b = await resolveFrom('venue-b', undefined)

    expect(a.from).toBe('The Glass House <hello@theglasshouse.com>')
    expect(b.from).toBe('Crestwood Farm <hello@crestwoodfarm.com>')
    expect(a.from).not.toContain('crestwoodfarm.com')
    expect(b.from).not.toContain('theglasshouse.com')
  })

  it('a verified venue and an unverified venue resolved back to back never cross-contaminate', async () => {
    venueConfigRows['venue-a'] = {
      sending_domain: 'theglasshouse.com',
      sending_from_name: 'The Glass House',
      sending_domain_status: 'verified',
    }
    venueConfigRows['venue-b'] = {
      sending_domain: 'crestwoodfarm.com',
      sending_from_name: 'Crestwood Farm',
      sending_domain_status: 'pending',
    }

    const first = await resolveFrom('venue-b', undefined)
    const second = await resolveFrom('venue-a', undefined)

    expect(first.from).toBe('Crestwood Farm <hello@thebloomhouse.ai>')
    expect(second.from).toBe('The Glass House <hello@theglasshouse.com>')
  })
})

describe('the fallback log', () => {
  it('emits one structured email.from_fallback log line per fallback, with the venue id and reason', async () => {
    venueConfigRows['venue-b'] = {
      sending_domain: 'hawthornemanor.com',
      sending_from_name: 'Hawthorne Manor',
      sending_domain_status: 'pending',
    }

    const { sendEmail } = await import('../transport')
    // Force the console-fallback send path (no RESEND_API_KEY) so this
    // test never touches the network — only the from-resolution + its
    // logging are under test here.
    const prevKey = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      await sendEmail({ // disclosure-justified: From-resolution test, fixture body, no couple-facing send
        to: 'couple@example.com',
        subject: 'Hi',
        html: '<p>hi</p>',
        venueId: 'venue-b',
      })
    } finally {
      if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey
    }

    const fallbackCalls = logEventMock.mock.calls.filter(
      (call) => (call[0] as { msg?: string }).msg === 'email.from_fallback',
    )
    expect(fallbackCalls).toHaveLength(1)
    const envelope = fallbackCalls[0][0] as {
      level: string
      event_type: string
      venueId: string
      data: { reason: string }
    }
    expect(envelope.level).toBe('warn')
    expect(envelope.event_type).toBe('email.sending_domain')
    expect(envelope.venueId).toBe('venue-b')
    expect(envelope.data.reason).toBe('sending_domain_status_pending')
  })

  it('never logs a fallback for a verified venue', async () => {
    venueConfigRows['venue-a'] = {
      sending_domain: 'theglasshouse.com',
      sending_from_name: 'The Glass House',
      sending_domain_status: 'verified',
    }
    const { sendEmail } = await import('../transport')
    const prevKey = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      await sendEmail({ // disclosure-justified: From-resolution test, fixture body, no couple-facing send
        to: 'couple@example.com',
        subject: 'Hi',
        html: '<p>hi</p>',
        venueId: 'venue-a',
      })
    } finally {
      if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey
    }
    const fallbackCalls = logEventMock.mock.calls.filter(
      (call) => (call[0] as { msg?: string }).msg === 'email.from_fallback',
    )
    expect(fallbackCalls).toHaveLength(0)
  })

  it('never logs a fallback for an explicit platform-level (venueId: null) send', async () => {
    const { sendEmail } = await import('../transport')
    const prevKey = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      await sendEmail({ // disclosure-justified: From-resolution test, fixture body, no couple-facing send
        to: 'ops@example.com',
        subject: 'Alert',
        html: '<p>alert</p>',
        venueId: null,
      })
    } finally {
      if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey
    }
    const fallbackCalls = logEventMock.mock.calls.filter(
      (call) => (call[0] as { msg?: string }).msg === 'email.from_fallback',
    )
    expect(fallbackCalls).toHaveLength(0)
  })
})
