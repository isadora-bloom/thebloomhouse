/**
 * Unit tests for src/lib/services/intel/nws-alerts.ts (W49, wave 7).
 *
 * Covers: the typed parser against a fixture shaped like the real
 * api.weather.gov/alerts/active response, the fail-closed fetch
 * wrapper (network error + non-2xx both resolve to ok:false/alerts:[]
 * rather than throwing), the severe-alert classifier, and venue
 * isolation on the alerts read (getAlertDayMap only ever reads rows
 * for the venue_id it was called with).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Fixture — shaped like a real api.weather.gov/alerts/active response.
// Trimmed to the fields the parser reads; real responses carry more
// (geometry, affectedZones, parameters, ...) that we intentionally ignore.
// ---------------------------------------------------------------------------
const NWS_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.demo.severe-tstorm.001',
      type: 'Feature',
      geometry: null,
      properties: {
        id: 'urn:oid:2.49.0.1.840.0.demo.severe-tstorm.001',
        areaDesc: 'Albemarle, VA',
        sent: '2026-09-14T14:03:00-04:00',
        effective: '2026-09-14T14:03:00-04:00',
        onset: '2026-09-14T14:03:00-04:00',
        expires: '2026-09-14T15:00:00-04:00',
        ends: '2026-09-14T14:45:00-04:00',
        status: 'Actual',
        messageType: 'Alert',
        severity: 'Severe',
        certainty: 'Observed',
        urgency: 'Immediate',
        event: 'Severe Thunderstorm Warning',
        headline: 'Severe Thunderstorm Warning issued for Albemarle County',
        description: 'A severe thunderstorm capable of producing damaging winds was located near Crestwood Farm.',
        instruction: 'Move to an interior room on the lowest floor.',
      },
    },
    {
      // No properties.id and no feature id — must be skipped (no stable key).
      id: undefined,
      type: 'Feature',
      geometry: null,
      properties: {
        event: 'Small Craft Advisory',
      },
    },
  ],
}

describe('parseNwsAlertsResponse', () => {
  it('extracts every field the fixture provides, in the normalised shape', async () => {
    const { parseNwsAlertsResponse } = await import('../nws-alerts')
    const parsed = parseNwsAlertsResponse(NWS_FIXTURE)
    expect(parsed).toHaveLength(1) // the id-less feature is dropped
    expect(parsed[0]).toEqual({
      nwsId: 'urn:oid:2.49.0.1.840.0.demo.severe-tstorm.001',
      event: 'Severe Thunderstorm Warning',
      severity: 'Severe',
      certainty: 'Observed',
      urgency: 'Immediate',
      headline: 'Severe Thunderstorm Warning issued for Albemarle County',
      description: 'A severe thunderstorm capable of producing damaging winds was located near Crestwood Farm.',
      instruction: 'Move to an interior room on the lowest floor.',
      areaDesc: 'Albemarle, VA',
      status: 'Actual',
      messageType: 'Alert',
      onset: '2026-09-14T14:03:00-04:00',
      ends: '2026-09-14T14:45:00-04:00',
      expires: '2026-09-14T15:00:00-04:00',
    })
  })

  it('returns [] for a malformed body instead of throwing', async () => {
    const { parseNwsAlertsResponse } = await import('../nws-alerts')
    expect(parseNwsAlertsResponse(null)).toEqual([])
    expect(parseNwsAlertsResponse(undefined)).toEqual([])
    expect(parseNwsAlertsResponse({})).toEqual([])
    expect(parseNwsAlertsResponse({ features: 'not an array' })).toEqual([])
    expect(parseNwsAlertsResponse('a string')).toEqual([])
  })

  it('returns [] for an empty features array', async () => {
    const { parseNwsAlertsResponse } = await import('../nws-alerts')
    expect(parseNwsAlertsResponse({ type: 'FeatureCollection', features: [] })).toEqual([])
  })
})

describe('fetchActiveAlertsForPoint — fails closed', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.resetModules()
  })

  it('returns ok:false, alerts:[] on a network error (fetch throws)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch
    const { fetchActiveAlertsForPoint } = await import('../nws-alerts')
    const result = await fetchActiveAlertsForPoint(38.0293, -78.4767)
    expect(result.ok).toBe(false)
    expect(result.alerts).toEqual([])
    expect(result.error).toContain('ECONNRESET')
    global.fetch = originalFetch
  })

  it('returns ok:false, alerts:[] on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }) as unknown as typeof fetch
    const { fetchActiveAlertsForPoint } = await import('../nws-alerts')
    const result = await fetchActiveAlertsForPoint(38.0293, -78.4767)
    expect(result.ok).toBe(false)
    expect(result.alerts).toEqual([])
    global.fetch = originalFetch
  })

  it('sends a descriptive User-Agent header (NWS policy)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: 'FeatureCollection', features: [] }),
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const { fetchActiveAlertsForPoint } = await import('../nws-alerts')
    await fetchActiveAlertsForPoint(38.0293, -78.4767)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['User-Agent']).toBeTruthy()
    expect(String(init.headers['User-Agent']).length).toBeGreaterThan(10)
    global.fetch = originalFetch
  })

  it('returns ok:true with parsed alerts on a healthy 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => NWS_FIXTURE,
    }) as unknown as typeof fetch
    const { fetchActiveAlertsForPoint } = await import('../nws-alerts')
    const result = await fetchActiveAlertsForPoint(38.0293, -78.4767)
    expect(result.ok).toBe(true)
    expect(result.alerts).toHaveLength(1)
    global.fetch = originalFetch
  })
})

describe('isSevereAlert', () => {
  it('treats NWS severity Extreme/Severe as severe regardless of event name', async () => {
    const { isSevereAlert } = await import('../nws-alerts')
    expect(isSevereAlert({ event: 'Special Weather Statement', severity: 'Severe' })).toBe(true)
    expect(isSevereAlert({ event: 'Special Weather Statement', severity: 'Extreme' })).toBe(true)
  })

  it('treats known severe event names as severe even at lower severity', async () => {
    const { isSevereAlert } = await import('../nws-alerts')
    expect(isSevereAlert({ event: 'Tornado Warning', severity: 'Moderate' })).toBe(true)
    expect(isSevereAlert({ event: 'Hurricane Warning', severity: 'Minor' })).toBe(true)
  })

  it('does not flag a routine advisory', async () => {
    const { isSevereAlert } = await import('../nws-alerts')
    expect(isSevereAlert({ event: 'Small Craft Advisory', severity: 'Minor' })).toBe(false)
    expect(isSevereAlert({ event: null, severity: null })).toBe(false)
  })
})

describe('getAlertDayMap — venue isolation', () => {
  it('scopes the read to exactly the venue_id it was called with', async () => {
    const eqCalls: Array<[string, unknown]> = []
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        eqCalls.push([col, val])
        return chain
      },
      lte: () => chain,
      or: () => Promise.resolve({ data: [], error: null }),
    }
    const supabase = { from: () => chain } as unknown as import('@supabase/supabase-js').SupabaseClient

    const { getAlertDayMap } = await import('../nws-alerts')
    await getAlertDayMap(supabase, 'venue-A', '2026-01-01', '2026-01-31')

    expect(eqCalls).toContainEqual(['venue_id', 'venue-A'])
    // Never queried for a different venue's id in the same call.
    expect(eqCalls.some(([col, val]) => col === 'venue_id' && val !== 'venue-A')).toBe(false)
  })

  it('picks the most severe alert when two overlap the same day', async () => {
    const rows = [
      { event: 'Winter Weather Advisory', severity: 'Minor', onset: '2026-01-10T00:00:00Z', ends: '2026-01-10T23:00:00Z', expires: null },
      { event: 'Tornado Warning', severity: 'Extreme', onset: '2026-01-10T01:00:00Z', ends: '2026-01-10T02:00:00Z', expires: null },
    ]
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      lte: () => chain,
      or: () => Promise.resolve({ data: rows, error: null }),
    }
    const supabase = { from: () => chain } as unknown as import('@supabase/supabase-js').SupabaseClient

    const { getAlertDayMap } = await import('../nws-alerts')
    const map = await getAlertDayMap(supabase, 'venue-A', '2026-01-01', '2026-01-31')
    expect(map.get('2026-01-10')?.event).toBe('Tornado Warning')
  })
})
