/**
 * Unit tests for the November plan finding 5 fix (W10): age-aware
 * demotion in the pulse aggregator. The demo showed a "Critical" insight
 * aged 145 days still pinned at the top of /pulse — demoteByAge re-labels
 * a critical item to 'medium' once it has sat unacted-on past the
 * demotion window, without hiding it (only an explicit snooze/dismiss
 * removes an item from the feed).
 */

import { describe, it, expect } from 'vitest'
import {
  demoteByAge,
  DEFAULT_CRITICAL_DEMOTION_DAYS,
  aggregatePulseFull,
} from '@/lib/services/intel/pulse-aggregator'

// ---------------------------------------------------------------------------
// Pure function: demoteByAge
// ---------------------------------------------------------------------------

describe('demoteByAge', () => {
  it('leaves a fresh critical item as critical', () => {
    expect(demoteByAge('critical', 1)).toBe('critical')
    expect(demoteByAge('critical', DEFAULT_CRITICAL_DEMOTION_DAYS - 1)).toBe('critical')
  })

  it('demotes a critical item to medium once it reaches the demotion window', () => {
    expect(demoteByAge('critical', DEFAULT_CRITICAL_DEMOTION_DAYS)).toBe('medium')
    expect(demoteByAge('critical', 145)).toBe('medium')
  })

  it('respects a configurable demotion window', () => {
    expect(demoteByAge('critical', 10, 7)).toBe('medium')
    expect(demoteByAge('critical', 5, 7)).toBe('critical')
  })

  it('never touches non-critical priorities regardless of age', () => {
    expect(demoteByAge('high', 400)).toBe('high')
    expect(demoteByAge('medium', 400)).toBe('medium')
    expect(demoteByAge('low', 400)).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// Integration: aggregatePulseFull applies demotion + still honours snooze/
// dismiss. Generic predicate-filtering Supabase mock — good enough to
// exercise the real query shapes (eq/gte/in/order/limit/maybeSingle)
// without touching a real database.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

function makeMockClient(fixtures: Record<string, Row[]>) {
  return {
    from(table: string) {
      const predicates: Array<{ col: string; op: 'eq' | 'gte' | 'in'; val: unknown }> = []

      function applyPredicates(rows: Row[]): Row[] {
        return rows.filter((row) =>
          predicates.every((p) => {
            if (p.op === 'eq') return row[p.col] === p.val
            if (p.op === 'gte') return String(row[p.col]) >= String(p.val)
            if (p.op === 'in') return (p.val as unknown[]).includes(row[p.col])
            return true
          }),
        )
      }

      function resolve(limit?: number) {
        const rows = fixtures[table] ?? []
        let filtered = applyPredicates(rows)
        if (typeof limit === 'number') filtered = filtered.slice(0, limit)
        return { data: filtered, error: null }
      }

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          predicates.push({ col, op: 'eq', val })
          return builder
        },
        gte: (col: string, val: unknown) => {
          predicates.push({ col, op: 'gte', val })
          return builder
        },
        in: (col: string, vals: unknown[]) => {
          predicates.push({ col, op: 'in', val: vals })
          return builder
        },
        order: () => builder,
        limit: (n: number) => resolve(n),
        maybeSingle: () => {
          const r = resolve()
          return { data: (r.data as Row[])[0] ?? null, error: null }
        },
        then: (onResolve: (v: unknown) => unknown, onReject?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(onResolve, onReject),
      }
      return builder
    },
  }
}

const VENUE = 'venue-1'

function baseFixtures(): Record<string, Row[]> {
  return {
    admin_notifications: [],
    anomaly_alerts: [],
    intelligence_insights: [],
    pulse_snoozes: [],
    venue_config: [], // no row -> loadPausedBanner returns null immediately
  }
}

describe('aggregatePulseFull — age-aware demotion (finding 5)', () => {
  it('demotes a 145-day-old unacknowledged critical anomaly to medium while a fresh one stays critical', async () => {
    const fixtures = baseFixtures()
    fixtures.anomaly_alerts = [
      {
        id: 'stale',
        venue_id: VENUE,
        alert_type: 'ingestion_volume_drop',
        metric_name: 'ingestion_volume_knot',
        severity: 'critical',
        ai_explanation: 'stale',
        current_value: 1,
        baseline_value: 10,
        acknowledged: false,
        created_at: daysAgoIso(145),
      },
      {
        id: 'fresh',
        venue_id: VENUE,
        alert_type: 'ingestion_connection_error',
        metric_name: 'ingestion_connection_gmail',
        severity: 'critical',
        ai_explanation: 'fresh',
        current_value: 1,
        baseline_value: 0,
        acknowledged: false,
        created_at: daysAgoIso(1),
      },
    ]

    const client = makeMockClient(fixtures) as unknown as Parameters<typeof aggregatePulseFull>[0]
    const result = await aggregatePulseFull(client, VENUE, {})

    const stale = result.items.find((i) => i.id === 'anomaly:stale')
    const fresh = result.items.find((i) => i.id === 'anomaly:fresh')

    expect(stale?.priority).toBe('medium')
    expect(fresh?.priority).toBe('critical')

    // Fresh critical must sort ahead of the demoted stale item.
    const freshIdx = result.items.findIndex((i) => i.id === 'anomaly:fresh')
    const staleIdx = result.items.findIndex((i) => i.id === 'anomaly:stale')
    expect(freshIdx).toBeLessThan(staleIdx)
  })

  it('a dismissed item stays hidden regardless of demotion', async () => {
    const fixtures = baseFixtures()
    fixtures.anomaly_alerts = [
      {
        id: 'stale',
        venue_id: VENUE,
        alert_type: 'ingestion_volume_drop',
        metric_name: 'ingestion_volume_knot',
        severity: 'critical',
        ai_explanation: 'stale',
        current_value: 1,
        baseline_value: 10,
        acknowledged: false,
        created_at: daysAgoIso(200),
      },
    ]
    fixtures.pulse_snoozes = [
      {
        venue_id: VENUE,
        item_key: 'anomaly:stale',
        action: 'dismissed',
        snoozed_until: null,
        created_at: daysAgoIso(1), // well within the 90-day dismissal TTL
      },
    ]

    const client = makeMockClient(fixtures) as unknown as Parameters<typeof aggregatePulseFull>[0]
    const result = await aggregatePulseFull(client, VENUE, {})

    expect(result.items.find((i) => i.id === 'anomaly:stale')).toBeUndefined()
  })

  it('respects a custom demotionDays option', async () => {
    const fixtures = baseFixtures()
    fixtures.anomaly_alerts = [
      {
        id: 'a1',
        venue_id: VENUE,
        alert_type: 'ingestion_volume_drop',
        metric_name: 'ingestion_volume_knot',
        severity: 'critical',
        ai_explanation: null,
        current_value: 1,
        baseline_value: 10,
        acknowledged: false,
        created_at: daysAgoIso(10),
      },
    ]

    const client = makeMockClient(fixtures) as unknown as Parameters<typeof aggregatePulseFull>[0]
    const result = await aggregatePulseFull(client, VENUE, { demotionDays: 7 })

    expect(result.items.find((i) => i.id === 'anomaly:a1')?.priority).toBe('medium')
  })
})

// ---------------------------------------------------------------------------
// Finding 3 (November plan W10): Sage escalation emission reaches Pulse at
// the intended priority. runEscalationCheck (email/escalation-detector.ts)
// writes admin_notifications with type='escalation', priority='urgent' on
// a tense/emotional message — this pins that it lands on /pulse as
// 'critical', matching the pitch-deck promise ("a Sage chat turning tense
// triggers a Pulse flag"). It also pins the route.ts fix: the three
// 'sage_uncertain' notifications (forbidden-topic, AI-outage, low-
// confidence) now pass priority='high' explicitly instead of relying on
// createNotification's 'normal' default, which previously left them at
// 'medium' on /pulse despite the type-based fallback intending 'high'.
// ---------------------------------------------------------------------------

describe('aggregatePulseFull — Sage escalation priority (finding 3)', () => {
  it('an "escalation" notification (tense-trigger) surfaces as critical', async () => {
    const fixtures = baseFixtures()
    fixtures.admin_notifications = [
      {
        id: 'n1',
        venue_id: VENUE,
        type: 'escalation',
        title: 'Escalation: "lawyer" from Jane & Sam',
        body: 'Detected in Sage chat: "..."',
        wedding_id: 'wedding-1',
        created_at: daysAgoIso(0),
        read: false,
        priority: 'urgent',
      },
    ]
    const client = makeMockClient(fixtures) as unknown as Parameters<typeof aggregatePulseFull>[0]
    const result = await aggregatePulseFull(client, VENUE, {})
    expect(result.items.find((i) => i.id === 'notif:n1')?.priority).toBe('critical')
  })

  it('a "sage_uncertain" notification with the fixed explicit priority surfaces as high, not medium', async () => {
    const fixtures = baseFixtures()
    fixtures.admin_notifications = [
      {
        id: 'n2',
        venue_id: VENUE,
        type: 'sage_uncertain',
        title: 'Forbidden topic flagged: "refund"',
        body: 'Sage skipped generation...',
        wedding_id: 'wedding-1',
        created_at: daysAgoIso(0),
        read: false,
        priority: 'high', // set explicitly by the route.ts fix
      },
    ]
    const client = makeMockClient(fixtures) as unknown as Parameters<typeof aggregatePulseFull>[0]
    const result = await aggregatePulseFull(client, VENUE, {})
    expect(result.items.find((i) => i.id === 'notif:n2')?.priority).toBe('high')
  })

  it('a legacy sage_uncertain row with no stored priority still falls back to high via type inference', async () => {
    const fixtures = baseFixtures()
    fixtures.admin_notifications = [
      {
        id: 'n3',
        venue_id: VENUE,
        type: 'sage_uncertain',
        title: 'Pre-migration-207 row',
        body: null,
        wedding_id: null,
        created_at: daysAgoIso(0),
        read: false,
        priority: null,
      },
    ]
    const client = makeMockClient(fixtures) as unknown as Parameters<typeof aggregatePulseFull>[0]
    const result = await aggregatePulseFull(client, VENUE, {})
    expect(result.items.find((i) => i.id === 'notif:n3')?.priority).toBe('high')
  })
})
