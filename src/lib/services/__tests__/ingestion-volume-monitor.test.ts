/**
 * Unit tests for runGmailConnectionHealthCheck (November plan finding 1,
 * W10). The per-channel volume monitor in this same file only fires once
 * inbound volume has visibly collapsed against a baseline — this direct
 * gmail_connections.status='error' check is meant to catch the outage on
 * the very next cron tick instead. These tests pin that behaviour without
 * touching real Supabase: createServiceClient is mocked to a small
 * chainable stub that resolves based on (table, operation).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock Supabase. Every query-builder chain in the module under test either
// awaits directly (thenable) or terminates in .single() — both resolve via
// the same lazily-evaluated `resolver`, which only runs once the whole sync
// chain (including .insert()/.update() calls) has already happened.
// ---------------------------------------------------------------------------

interface Scenario {
  gmailConnections: { data: unknown[] | null; error: { message: string } | null }
  existingAlerts: { data: unknown[] | null; error: { message: string } | null }
  updateResult: { data: unknown; error: { message: string } | null }
  insertResult: { data: unknown; error: { message: string } | null }
}

const calls: { table: string; op: 'select' | 'update' | 'insert'; payload?: unknown }[] = []

let scenario: Scenario

function defaultScenario(): Scenario {
  return {
    gmailConnections: { data: [], error: null },
    existingAlerts: { data: [], error: null },
    updateResult: { data: { id: 'alert-1', venue_id: 'venue-1', metric_name: 'ingestion_connection_gmail', severity: 'critical' }, error: null },
    insertResult: { data: { id: 'alert-2', venue_id: 'venue-1', metric_name: 'ingestion_connection_gmail', severity: 'critical' }, error: null },
  }
}

function makeChainable(table: string) {
  let op: 'select' | 'update' | 'insert' = 'select'
  let payload: unknown

  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => resolve(),
    update: (p: unknown) => { op = 'update'; payload = p; return chain },
    insert: (p: unknown) => { op = 'insert'; payload = p; return chain },
    single: () => resolve(),
    then: (onResolve: (v: unknown) => unknown, onReject?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onResolve, onReject),
  }

  function resolve() {
    calls.push({ table, op, payload })
    if (table === 'gmail_connections') return scenario.gmailConnections
    if (table === 'anomaly_alerts') {
      if (op === 'update') return scenario.updateResult
      if (op === 'insert') return scenario.insertResult
      return scenario.existingAlerts
    }
    return { data: null, error: { message: `unhandled table ${table}` } }
  }

  return chain
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => makeChainable(table),
  }),
}))

import { runGmailConnectionHealthCheck, CONNECTION_ERROR_ALERT_TYPE } from '@/lib/services/ingestion-volume-monitor'

beforeEach(() => {
  scenario = defaultScenario()
  calls.length = 0
})

describe('runGmailConnectionHealthCheck', () => {
  it('writes nothing when no gmail_connections row is in status=error', async () => {
    scenario.gmailConnections = { data: [], error: null }
    const result = await runGmailConnectionHealthCheck('venue-1')
    expect(result).toEqual([])
    expect(calls.some((c) => c.op === 'insert' || c.op === 'update')).toBe(false)
  })

  it('inserts a critical anomaly_alerts row when a connection is in status=error and no prior alert exists', async () => {
    scenario.gmailConnections = {
      data: [{ id: 'gc-1', email_address: 'venue@example.com', error_message: 'invalid_grant' }],
      error: null,
    }
    scenario.existingAlerts = { data: [], error: null }

    const result = await runGmailConnectionHealthCheck('venue-1')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ severity: 'critical' })

    const insertCall = calls.find((c) => c.table === 'anomaly_alerts' && c.op === 'insert')
    expect(insertCall).toBeDefined()
    const payload = insertCall!.payload as Record<string, unknown>
    expect(payload.alert_type).toBe(CONNECTION_ERROR_ALERT_TYPE)
    expect(payload.severity).toBe('critical')
    expect(payload.metric_name).toBe('ingestion_connection_gmail')
    expect(payload.acknowledged).toBe(false)
    // The explanation must be readable — not a JSON blob — and name the mailbox.
    expect(String(payload.ai_explanation)).toContain('venue@example.com')
  })

  it('refreshes (updates) an existing unacknowledged alert instead of inserting a duplicate', async () => {
    scenario.gmailConnections = {
      data: [{ id: 'gc-1', email_address: 'venue@example.com', error_message: 'token_expired' }],
      error: null,
    }
    scenario.existingAlerts = {
      data: [{ id: 'existing-alert', acknowledged: false, created_at: new Date().toISOString() }],
      error: null,
    }

    const result = await runGmailConnectionHealthCheck('venue-1')

    expect(result).toHaveLength(1)
    const updateCall = calls.find((c) => c.table === 'anomaly_alerts' && c.op === 'update')
    expect(updateCall).toBeDefined()
    expect((updateCall!.payload as Record<string, unknown>).severity).toBe('critical')
    const insertCall = calls.find((c) => c.table === 'anomaly_alerts' && c.op === 'insert')
    expect(insertCall).toBeUndefined()
  })

  it('stays quiet within the realert cooldown after an acknowledged alert', async () => {
    scenario.gmailConnections = {
      data: [{ id: 'gc-1', email_address: 'venue@example.com', error_message: 'invalid_grant' }],
      error: null,
    }
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
    scenario.existingAlerts = {
      data: [{ id: 'existing-alert', acknowledged: true, created_at: twoDaysAgo }],
      error: null,
    }

    const result = await runGmailConnectionHealthCheck('venue-1')

    expect(result).toEqual([])
    expect(calls.some((c) => c.table === 'anomaly_alerts' && (c.op === 'insert' || c.op === 'update'))).toBe(false)
  })

  it('re-alerts after the cooldown window has passed since acknowledgement', async () => {
    scenario.gmailConnections = {
      data: [{ id: 'gc-1', email_address: 'venue@example.com', error_message: 'invalid_grant' }],
      error: null,
    }
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000).toISOString()
    scenario.existingAlerts = {
      data: [{ id: 'existing-alert', acknowledged: true, created_at: twentyDaysAgo }],
      error: null,
    }

    const result = await runGmailConnectionHealthCheck('venue-1')

    expect(result).toHaveLength(1)
    const insertCall = calls.find((c) => c.table === 'anomaly_alerts' && c.op === 'insert')
    expect(insertCall).toBeDefined()
  })

  it('never throws and returns [] on a query error', async () => {
    scenario.gmailConnections = { data: null, error: { message: 'boom' } }
    const result = await runGmailConnectionHealthCheck('venue-1')
    expect(result).toEqual([])
  })
})
