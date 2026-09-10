/**
 * Regression lock for dunning.ts (W18, Nov-plan wave 2 — "confirm it reads
 * a real table and is registered in vercel.json / the cron dispatcher; fix
 * if not").
 *
 * Wave-1 W11 found the scan query selected `autonomous_paused` off
 * `venues` (it lives on `venue_config`), which 400'd the ENTIRE scan query
 * every run — dunning had never fired in production. The fix (already
 * landed, see dunning.ts's own header comment) selects only real `venues`
 * columns and writes `autonomous_paused` to `venue_config` separately.
 * This test pins that shape so the bug class can't silently come back:
 * it fails loudly if the scan query is ever widened to select a column
 * that doesn't exist on `venues`.
 *
 * Registration: vercel.json's `prune_maintenance` cron (daily, 02:00 UTC)
 * calls runPruneMaintenance() in src/app/api/cron/route.ts, which awaits
 * runDunningEscalate() as part of its Promise.allSettled bundle. Verified
 * by inspection for this report (grep, not runtime — cron/route.ts isn't
 * exercised by this unit test); no code change was needed there.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const notifications: Array<Record<string, unknown>> = []
const venueConfigUpdates: Array<{ venueId: string; patch: Record<string, unknown> }> = []
const venueStageUpdates: Array<{ venueId: string; patch: Record<string, unknown> }> = []

// Real venues.* columns only — the exact set the pre-fix bug widened to
// include venue_config.autonomous_paused and 400'd on.
const REAL_VENUES_COLUMNS = new Set(['id', 'name', 'past_due_since', 'dunning_stage', 'dunning_extension_until'])

vi.mock('@/lib/services/admin-notifications', () => ({
  createNotification: vi.fn(async (opts: Record<string, unknown>) => {
    notifications.push(opts)
  }),
}))

let venueRows: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'venues') {
        return {
          select(cols: string) {
            // Pin the exact bug class: fail the test (not silently 400,
            // since this mock has no real Postgres behind it) if the
            // scan ever asks for a column venues doesn't have.
            const requested = cols.split(',').map((c) => c.trim())
            for (const col of requested) {
              if (!REAL_VENUES_COLUMNS.has(col)) {
                throw new Error(`dunning scan selected non-venues column: ${col}`)
              }
            }
            return this
          },
          not(_col: string, _op: string, _val: unknown) {
            return Promise.resolve({ data: venueRows, error: null })
          },
          update(patch: Record<string, unknown>) {
            return {
              eq: (_col: string, val: string) => {
                venueStageUpdates.push({ venueId: val, patch })
                return Promise.resolve({ error: null })
              },
            }
          },
        }
      }
      if (table === 'venue_config') {
        return {
          update(patch: Record<string, unknown>) {
            return {
              eq: (_col: string, val: string) => {
                venueConfigUpdates.push({ venueId: val, patch })
                return Promise.resolve({ error: null })
              },
            }
          },
        }
      }
      throw new Error(`unexpected table in dunning test: ${table}`)
    },
  }),
}))

import { runDunningEscalate } from '@/lib/services/billing/dunning'

const DAY_MS = 24 * 60 * 60 * 1000
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString()
}

describe('runDunningEscalate', () => {
  beforeEach(() => {
    notifications.length = 0
    venueConfigUpdates.length = 0
    venueStageUpdates.length = 0
    venueRows = []
  })

  it('reads only real venues columns (regression lock for the 400 bug)', async () => {
    venueRows = [{ id: 'v1', name: 'Test Venue', past_due_since: daysAgo(9), dunning_stage: null, dunning_extension_until: null }]
    const result = await runDunningEscalate()
    expect(result.errors).toEqual([])
    expect(result.scanned).toBe(1)
  })

  it('advances an 9-day past-due venue to reminder_1 and fires one notification', async () => {
    venueRows = [{ id: 'v1', name: 'Test Venue', past_due_since: daysAgo(9), dunning_stage: null, dunning_extension_until: null }]
    const result = await runDunningEscalate()
    expect(result.reminder_1_fired).toBe(1)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe('dunning_reminder_1')
    expect(venueStageUpdates).toEqual([{ venueId: 'v1', patch: { dunning_stage: 'reminder_1' } }])
  })

  it('pauses autonomous sending on venue_config (not venues) at day 21', async () => {
    venueRows = [{ id: 'v1', name: 'Test Venue', past_due_since: daysAgo(22), dunning_stage: 'reminder_2', dunning_extension_until: null }]
    const result = await runDunningEscalate()
    expect(result.sage_paused_fired).toBe(1)
    expect(venueConfigUpdates).toEqual([{ venueId: 'v1', patch: { autonomous_paused: true } }])
  })

  it('is idempotent — does not re-fire a stage the venue has already reached', async () => {
    venueRows = [{ id: 'v1', name: 'Test Venue', past_due_since: daysAgo(9), dunning_stage: 'reminder_1', dunning_extension_until: null }]
    const result = await runDunningEscalate()
    expect(result.reminder_1_fired).toBe(0)
    expect(notifications).toHaveLength(0)
  })

  it('skips a venue inside its dunning_extension_until grace window', async () => {
    venueRows = [{
      id: 'v1',
      name: 'Test Venue',
      past_due_since: daysAgo(9),
      dunning_stage: null,
      dunning_extension_until: new Date(Date.now() + DAY_MS).toISOString(),
    }]
    const result = await runDunningEscalate()
    expect(result.skipped_extension).toBe(1)
    expect(notifications).toHaveLength(0)
  })
})
