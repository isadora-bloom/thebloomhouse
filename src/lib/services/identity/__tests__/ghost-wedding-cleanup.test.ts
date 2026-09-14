/**
 * W66 — the ghost sweep tombstones; it never deletes.
 *
 * The fake client records every operation by table, so a `delete` on
 * `weddings` or `people` would show up as a recorded call and fail the
 * test. That is the assertion that matters: the constitution forbids
 * destroying the row that records the bug fired.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  cleanupGhostWeddings,
  GhostCleanupError,
} from '../ghost-wedding-cleanup'

interface Op {
  table: string
  op: string
  payload?: unknown
  filters: Array<{ method: string; args: unknown[] }>
}

const CHAIN = ['select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit'] as const

function fakeClient(
  rowsByTable: Record<string, unknown[]>,
  errors: Record<string, string> = {},
): { client: SupabaseClient; ops: Op[] } {
  const ops: Op[] = []
  function builder(table: string) {
    const filters: Op['filters'] = []
    let op = 'select'
    let payload: unknown
    const result = () => {
      ops.push({ table, op, payload, filters })
      const err = errors[`${table}.${op}`]
      return {
        data: err ? null : (rowsByTable[table] ?? []),
        error: err ? { message: err } : null,
      }
    }

    const chain: any = {}
    for (const m of CHAIN) {
      chain[m] = (...args: unknown[]) => {
        if (m === 'select') op = 'select'
        filters.push({ method: m, args })
        return chain
      }
    }
    for (const m of ['update', 'insert', 'upsert', 'delete'] as const) {
      chain[m] = (...args: unknown[]) => {
        op = m
        payload = args[0]
        return chain
      }
    }
    chain.maybeSingle = () => Promise.resolve(result())
    chain.single = () => Promise.resolve(result())
    chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(ok, bad)
    return chain
  }
  return { client: { from: builder } as unknown as SupabaseClient, ops }
}

const GHOST = 'wed-ghost'

function baseRows(over: Record<string, unknown[]> = {}) {
  return {
    weddings: [{ id: GHOST }],
    people: [{ wedding_id: GHOST, email: 'sage@rixeymanor.com' }],
    gmail_connections: [{ email_address: 'Sage@RixeyManor.com' }],
    interactions: [],
    ...over,
  }
}

describe('cleanupGhostWeddings', () => {
  it('tombstones a self-bug wedding and never deletes anything', async () => {
    const { client, ops } = fakeClient(baseRows())
    const result = await cleanupGhostWeddings(client, 'venue-1')

    expect(result).toMatchObject({ scanned: 1, tombstoned: 1 })

    // Nothing was deleted, anywhere.
    expect(ops.filter((o) => o.op === 'delete')).toEqual([])

    // The wedding got the migration-332 tombstone, not a removal.
    const tomb = ops.find((o) => o.table === 'weddings' && o.op === 'update')
    expect(tomb).toBeDefined()
    const patch = tomb!.payload as Record<string, unknown>
    expect(patch.non_couple_reason).toBe('venue_self_bug')
    expect(typeof patch.non_couple_at).toBe('string')
    // Re-applying is guarded, so a second run is a no-op on already-
    // tombstoned rows rather than a fresh timestamp.
    expect(tomb!.filters).toContainEqual({ method: 'is', args: ['non_couple_at', null] })

    // The evidence rows were detached, not destroyed.
    const peopleUpdate = ops.find((o) => o.table === 'people' && o.op === 'update')
    expect(peopleUpdate!.payload).toEqual({ wedding_id: null })
    const interactionUpdate = ops.find((o) => o.table === 'interactions' && o.op === 'update')
    expect(interactionUpdate!.payload).toEqual({ wedding_id: null })
  })

  it('matches a self domain passed in when Gmail is not linked', async () => {
    const { client, ops } = fakeClient(
      baseRows({ gmail_connections: [] }),
    )
    const result = await cleanupGhostWeddings(client, 'venue-1', ['rixeymanor.com'])
    expect(result.tombstoned).toBe(1)
    expect(ops.some((o) => o.table === 'weddings' && o.op === 'update')).toBe(true)
  })

  it('catches a wedding whose every inbound is the venue itself (rule B prime)', async () => {
    const { client } = fakeClient(
      baseRows({
        people: [],
        interactions: [
          { wedding_id: GHOST, from_email: 'sage@rixeymanor.com' },
          { wedding_id: GHOST, from_email: 'SAGE@rixeymanor.com' },
        ],
      }),
    )
    const result = await cleanupGhostWeddings(client, 'venue-1')
    expect(result.tombstoned).toBe(1)
  })

  it('leaves a real couple alone and writes nothing', async () => {
    const { client, ops } = fakeClient(
      baseRows({
        people: [{ wedding_id: GHOST, email: 'alex@gmail.com' }],
        interactions: [{ wedding_id: GHOST, from_email: 'alex@gmail.com' }],
      }),
    )
    const result = await cleanupGhostWeddings(client, 'venue-1')
    expect(result).toMatchObject({ scanned: 1, tombstoned: 0 })
    expect(ops.filter((o) => o.op !== 'select')).toEqual([])
  })

  it('is a no-op when the venue has no untombstoned inquiries', async () => {
    const { client, ops } = fakeClient(baseRows({ weddings: [] }))
    const result = await cleanupGhostWeddings(client, 'venue-1')
    expect(result).toMatchObject({ scanned: 0, tombstoned: 0 })
    expect(ops).toHaveLength(1)
  })

  it('surfaces a failed scan rather than reporting a clean sweep', async () => {
    const { client } = fakeClient(baseRows(), { 'weddings.select': 'boom' })
    await expect(cleanupGhostWeddings(client, 'venue-1')).rejects.toBeInstanceOf(
      GhostCleanupError,
    )
  })
})
