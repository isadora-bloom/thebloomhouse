/**
 * D4 Point-Zero unit lock (migration 381 / CANONICAL-RECONCILIATION-SPECS.md
 * D4 / CONSOLIDATION-PLAN-PHASED.md v2.1 §1.8).
 *
 * Locks the pure rules (direction mapping, qualification) and the stamping
 * orchestration (set-once establishment, pre_zero re-stamp, phase relative
 * to point_zero_at, outbound-never-establishes) against a mock supabase —
 * no DB. The runtime/golden proof (GC-8) runs on the test branch.
 *
 * Run: npx tsx scripts/test-point-zero.ts
 */

import {
  signalDirection,
  signalQualifiesForPointZero,
  stampTouchpointAndPointZero,
} from '../src/lib/services/identity/point-zero'
import type { NormalizedSignal } from '../src/lib/services/identity/sources/types'

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function sig(overrides: Partial<NormalizedSignal>): NormalizedSignal {
  return {
    external_id: 'ext-1',
    channel: 'gmail',
    action_type: 'inquiry',
    occurred_at: '2026-06-01T12:00:00Z',
    signal_tier: 'high',
    identity_hint: null,
    raw_payload: {},
    ...overrides,
  } as NormalizedSignal
}

// ---------------------------------------------------------------------------
// Mock supabase: programmable point_zero reads + establish outcome; records
// every terminal call so assertions can inspect payloads/filters.
// ---------------------------------------------------------------------------
interface RecordedCall {
  table: string
  op: 'select' | 'update'
  payload?: Record<string, unknown>
  filters: Array<unknown[]>
}

function makeSupabase(opts: {
  pointZeroReads: Array<string | null>
  establishSucceeds?: boolean
}) {
  const calls: RecordedCall[] = []
  let readIdx = 0
  const from = (table: string) => {
    const ctx: RecordedCall = { table, op: 'select', payload: undefined, filters: [] }
    const q: Record<string, unknown> = {}
    const chain = (fn: string) =>
      ((...a: unknown[]) => {
        ctx.filters.push([fn, ...a])
        return q
      })
    Object.assign(q, {
      select: (_cols: string) => q,
      update: (payload: Record<string, unknown>) => {
        ctx.op = 'update'
        ctx.payload = payload
        return q
      },
      eq: chain('eq'),
      is: chain('is'),
      lt: chain('lt'),
      neq: chain('neq'),
      maybeSingle: () => {
        calls.push(ctx)
        const v = opts.pointZeroReads[readIdx] ?? null
        readIdx += 1
        return Promise.resolve({ data: { point_zero_at: v }, error: null })
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        calls.push(ctx)
        const isEstablish = ctx.table === 'couples' && ctx.op === 'update'
        const data = isEstablish
          ? (opts.establishSucceeds ?? true)
            ? [{ id: 'c1' }]
            : []
          : null
        return Promise.resolve({ data, error: null }).then(res, rej)
      },
    })
    return q
  }
  return { supabase: { from } as never, calls }
}

const updatesOf = (calls: RecordedCall[], table: string) =>
  calls.filter((c) => c.table === table && c.op === 'update')

// ---------------------------------------------------------------------------
console.log('D4: signalDirection (write-time, no read-time inference)')
check('explicit raw_payload inbound wins', signalDirection(sig({ action_type: 'venue_sent', raw_payload: { direction: 'inbound' } })) === 'inbound')
check('explicit raw_payload outbound wins', signalDirection(sig({ raw_payload: { direction: 'outbound' } })) === 'outbound')
check('venue_sent -> outbound', signalDirection(sig({ action_type: 'venue_sent' })) === 'outbound')
check('auto_send -> outbound', signalDirection(sig({ action_type: 'auto_send' })) === 'outbound')
check('sms_outbound -> outbound', signalDirection(sig({ action_type: 'sms_outbound' })) === 'outbound')
check('plain inquiry -> inbound', signalDirection(sig({})) === 'inbound')

console.log('D4: signalQualifiesForPointZero (name + reachable identifier)')
check('name + email qualifies', signalQualifiesForPointZero(sig({ primary_name: 'Sarah Ross', primary_email: 'sarah@x.com' })))
check('name + phone qualifies', signalQualifiesForPointZero(sig({ primary_name: 'Sarah', primary_phone: '+15550001111' })))
check('partner name + partner email qualifies', signalQualifiesForPointZero(sig({ partner_name: 'Will Carter', partner_email: 'will@x.com' })))
check('relay email qualifies (direct OR relay per spec)', signalQualifiesForPointZero(sig({ primary_name: 'Ashley B', primary_email: 'ashley.b.123@member.theknot.com' })))
check('name only does NOT qualify', !signalQualifiesForPointZero(sig({ primary_name: 'Sarah Ross' })))
check('email only does NOT qualify', !signalQualifiesForPointZero(sig({ primary_email: 'sarah@x.com' })))
check('handle-only does NOT qualify', !signalQualifiesForPointZero(sig({ identity_hint: '@sarahross' })))

async function main() {
  console.log('D4: establishment — qualifying inbound on a pz-null couple')
  {
    const { supabase, calls } = makeSupabase({ pointZeroReads: [null] })
    const r = await stampTouchpointAndPointZero({
      supabase, venueId: 'v1', coupleId: 'c1', touchpointId: 'tp9',
      signal: sig({ primary_name: 'Sarah Ross', primary_email: 'sarah@x.com' }),
    })
    check('establishes point-zero', r.established === true)
    check('establishing touchpoint is post_zero', r.zeroPhase === 'post_zero')
    const coupleUpd = updatesOf(calls, 'couples')[0]
    check('couples update carries point_zero_at + touchpoint id',
      coupleUpd?.payload?.point_zero_at === '2026-06-01T12:00:00Z' &&
      coupleUpd?.payload?.point_zero_touchpoint_id === 'tp9')
    check('set-once guard (is point_zero_at null) present',
      coupleUpd?.filters.some((f) => f[0] === 'is' && f[1] === 'point_zero_at'))
    const tpUpds = updatesOf(calls, 'touchpoints')
    check('prior touchpoints re-stamped pre_zero',
      tpUpds.some((u) => u.payload?.zero_phase === 'pre_zero' && u.filters.some((f) => f[0] === 'lt')))
    check('this touchpoint stamped direction+phase',
      tpUpds.some((u) => u.payload?.direction === 'inbound' && u.payload?.zero_phase === 'post_zero'))
  }

  console.log('D4: outbound NEVER establishes')
  {
    const { supabase, calls } = makeSupabase({ pointZeroReads: [null] })
    const r = await stampTouchpointAndPointZero({
      supabase, venueId: 'v1', coupleId: 'c1', touchpointId: 'tp1',
      signal: sig({ action_type: 'venue_sent', primary_name: 'Sarah Ross', primary_email: 'sarah@x.com' }),
    })
    check('not established by outbound', r.established === false)
    check('no couples update issued', updatesOf(calls, 'couples').length === 0)
    check('touchpoint still stamped outbound + pre_zero',
      updatesOf(calls, 'touchpoints').some((u) => u.payload?.direction === 'outbound' && u.payload?.zero_phase === 'pre_zero'))
  }

  console.log('D4: phase relative to an existing point-zero')
  {
    const { supabase } = makeSupabase({ pointZeroReads: ['2026-05-01T00:00:00Z'] })
    const r = await stampTouchpointAndPointZero({
      supabase, venueId: 'v1', coupleId: 'c1', touchpointId: 'tp2',
      signal: sig({ occurred_at: '2026-04-20T00:00:00Z', primary_name: 'S', primary_email: 's@x.com' }),
    })
    check('earlier-dated touchpoint is pre_zero', r.zeroPhase === 'pre_zero' && !r.established)
  }
  {
    const { supabase } = makeSupabase({ pointZeroReads: ['2026-05-01T00:00:00Z'] })
    const r = await stampTouchpointAndPointZero({
      supabase, venueId: 'v1', coupleId: 'c1', touchpointId: 'tp3',
      signal: sig({ occurred_at: '2026-05-02T00:00:00Z' }),
    })
    check('later touchpoint is post_zero', r.zeroPhase === 'post_zero')
  }

  console.log('D4: non-qualifying inbound on pz-null couple -> pre_zero, no establish')
  {
    const { supabase, calls } = makeSupabase({ pointZeroReads: [null] })
    const r = await stampTouchpointAndPointZero({
      supabase, venueId: 'v1', coupleId: 'c1', touchpointId: 'tp4',
      signal: sig({ primary_email: 'noname@x.com' }),
    })
    check('no establish without a name', r.established === false && updatesOf(calls, 'couples').length === 0)
    check('phase pre_zero while couple has no point-zero', r.zeroPhase === 'pre_zero')
  }

  console.log('D4: set-once race — loser re-reads the winner point-zero')
  {
    const { supabase } = makeSupabase({
      pointZeroReads: [null, '2026-05-30T00:00:00Z'],
      establishSucceeds: false,
    })
    const r = await stampTouchpointAndPointZero({
      supabase, venueId: 'v1', coupleId: 'c1', touchpointId: 'tp5',
      signal: sig({ primary_name: 'S', primary_email: 's@x.com', occurred_at: '2026-06-01T12:00:00Z' }),
    })
    check('race loser not established', r.established === false)
    check('race loser phase relative to winner pz', r.zeroPhase === 'post_zero')
  }

  if (failures > 0) {
    console.error(`\ntest-point-zero: ${failures} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\ntest-point-zero: all assertions pass')
}

void main()
