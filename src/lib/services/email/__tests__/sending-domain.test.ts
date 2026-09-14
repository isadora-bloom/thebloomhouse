/**
 * W55 (NOVEMBER-PLAN.md wave 8) — the Resend domain-verification flow.
 *
 * Pins: env-gating on RESEND_API_KEY (no key = no network call, ever),
 * and the Resend-response-shape parsers (status mapping + DNS record
 * mapping) against fixtures shaped like Resend's documented API
 * responses (https://resend.com/docs/api-reference/domains). No network
 * in this file — the 'resend' module is mocked; a real HTTP call would
 * fail the test by construction (mockCreate/mockVerify/mockGet are the
 * only way data comes back).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const logEventMock = vi.fn()
vi.mock('@/lib/observability/logger', () => ({
  logEvent: (...args: unknown[]) => logEventMock(...args),
}))

const mockCreate = vi.fn()
const mockVerify = vi.fn()
const mockGet = vi.fn()
const resendConstructorSpy = vi.fn()

vi.mock('resend', () => ({
  Resend: class {
    domains: { create: typeof mockCreate; verify: typeof mockVerify; get: typeof mockGet }
    constructor(apiKey: string) {
      resendConstructorSpy(apiKey)
      this.domains = { create: mockCreate, verify: mockVerify, get: mockGet }
    }
  },
}))

import {
  createSendingDomain,
  verifySendingDomain,
  refreshSendingDomainStatus,
} from '../sending-domain'

const ORIGINAL_KEY = process.env.RESEND_API_KEY

beforeEach(() => {
  logEventMock.mockClear()
  mockCreate.mockClear()
  mockVerify.mockClear()
  mockGet.mockClear()
  resendConstructorSpy.mockClear()
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = ORIGINAL_KEY
})

describe('env-gating — no RESEND_API_KEY', () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY
  })

  it('createSendingDomain never touches the network', async () => {
    const result = await createSendingDomain('rixeymanor.com', 'venue-a')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/RESEND_API_KEY/)
    expect(resendConstructorSpy).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('verifySendingDomain never touches the network', async () => {
    const result = await verifySendingDomain('domain-123', 'venue-a')
    expect(result.ok).toBe(false)
    expect(resendConstructorSpy).not.toHaveBeenCalled()
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('refreshSendingDomainStatus never touches the network', async () => {
    const result = await refreshSendingDomainStatus('domain-123', 'venue-a')
    expect(result.ok).toBe(false)
    expect(resendConstructorSpy).not.toHaveBeenCalled()
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('createSendingDomain — Resend response shape', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key'
  })

  it('maps a fresh create() response (SPF + DKIM records, not_started) to our shape', async () => {
    // Shape per Resend's documented POST /domains response.
    mockCreate.mockResolvedValue({
      data: {
        id: 'd1',
        name: 'rixeymanor.com',
        status: 'not_started',
        created_at: '2026-09-14T00:00:00.000Z',
        region: 'us-east-1',
        records: [
          { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, ttl: 'Auto', status: 'not_started' },
          { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto', status: 'not_started' },
          { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC...', ttl: 'Auto', status: 'not_started' },
        ],
      },
      error: null,
    })

    const result = await createSendingDomain('rixeymanor.com', 'venue-a')

    expect(resendConstructorSpy).toHaveBeenCalledWith('test-key')
    expect(mockCreate).toHaveBeenCalledWith({ name: 'rixeymanor.com' })
    expect(result.ok).toBe(true)
    expect(result.domainId).toBe('d1')
    expect(result.status).toBe('unverified') // not_started maps to unverified
    expect(result.records).toHaveLength(3)
    expect(result.records?.[0]).toEqual({
      record: 'SPF',
      type: 'MX',
      name: 'send',
      value: 'feedback-smtp.us-east-1.amazonses.com',
      priority: 10,
      status: 'not_started',
    })
    expect(result.records?.[2].record).toBe('DKIM')
  })

  it('surfaces a Resend error without throwing', async () => {
    mockCreate.mockResolvedValue({ data: null, error: { message: 'Domain already exists' } })
    const result = await createSendingDomain('rixeymanor.com', 'venue-a')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Domain already exists')
    expect(logEventMock).toHaveBeenCalled()
  })

  it('catches a thrown network error', async () => {
    mockCreate.mockRejectedValue(new Error('fetch failed'))
    const result = await createSendingDomain('rixeymanor.com', 'venue-a')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('fetch failed')
  })
})

describe('verifySendingDomain — verify then get', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key'
  })

  it("calls verify() then get(), returning get()'s status (verify() itself carries none)", async () => {
    mockVerify.mockResolvedValue({ data: { id: 'd1', object: 'domain' }, error: null })
    mockGet.mockResolvedValue({
      data: {
        id: 'd1',
        name: 'rixeymanor.com',
        status: 'pending',
        created_at: '2026-09-14T00:00:00.000Z',
        region: 'us-east-1',
        object: 'domain',
        records: [
          { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=abc', status: 'pending' },
        ],
      },
      error: null,
    })

    const result = await verifySendingDomain('d1', 'venue-a')

    expect(mockVerify).toHaveBeenCalledWith('d1')
    expect(mockGet).toHaveBeenCalledWith('d1')
    expect(result.ok).toBe(true)
    expect(result.status).toBe('pending')
    expect(result.records).toHaveLength(1)
  })

  it('stops and returns an error when verify() itself fails, without calling get()', async () => {
    mockVerify.mockResolvedValue({ data: null, error: { message: 'domain not found' } })
    const result = await verifySendingDomain('d1', 'venue-a')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('domain not found')
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('refreshSendingDomainStatus — status mapping', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key'
  })

  const cases: Array<[string, string]> = [
    ['verified', 'verified'],
    ['pending', 'pending'],
    ['failed', 'failed'],
    ['temporary_failure', 'failed'],
    ['not_started', 'unverified'],
  ]

  for (const [resendStatus, expected] of cases) {
    it(`maps Resend status '${resendStatus}' to '${expected}'`, async () => {
      mockGet.mockResolvedValue({
        data: {
          id: 'd1',
          name: 'rixeymanor.com',
          status: resendStatus,
          created_at: '2026-09-14T00:00:00.000Z',
          region: 'us-east-1',
          object: 'domain',
          records: [],
        },
        error: null,
      })
      const result = await refreshSendingDomainStatus('d1', 'venue-a')
      expect(result.ok).toBe(true)
      expect(result.status).toBe(expected)
    })
  }

  it('surfaces a Resend error without throwing', async () => {
    mockGet.mockResolvedValue({ data: null, error: { message: 'domain not found' } })
    const result = await refreshSendingDomainStatus('missing', 'venue-a')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('domain not found')
  })
})
