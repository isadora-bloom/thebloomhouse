/**
 * S4a / 2026-09-14 ingestion audit item 4.
 *
 * `referenced_couple_name` is a string an LLM pulled out of an inbound
 * body — i.e. a string an outsider chose. At 0.55 bigram-Jaccard it could
 * re-point `interactions.wedding_id` at another couple's wedding, with no
 * venue predicate on the UPDATE and nobody asked.
 *
 * Now: below 0.70 nothing happens, 0.70 to 0.92 becomes a proposal in the
 * identity review queue, and only a near-exact match still auto-attaches
 * — with the venue predicate on every write.
 *
 * The fake below is deliberately literal: it answers the exact query
 * chain the resolver makes and records the filters each write carried,
 * because the filters are what this test is actually about.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveReferencedCouple } from '../referenced-couple-resolver'

const VENUE = 'venue-rc-1'
const INTERACTION = 'interaction-rc-1'
const SOURCE_WEDDING = 'wedding-source'
const TARGET_WEDDING = 'wedding-target'

interface Recorded {
  table: string
  op: 'select' | 'update' | 'insert'
  filters: Array<[string, unknown]>
  payload?: Record<string, unknown>
}

class Fake {
  recorded: Recorded[] = []
  /** partner1 first name on the one candidate wedding. */
  candidateFirstName = 'Kajlie'
  /** Whether both weddings have a couples mirror. */
  coupleMirrors = true

  client(): SupabaseClient {
    return { from: (table: string) => this.query(table) } as unknown as SupabaseClient
  }

  private query(table: string) {
    const rec: Recorded = { table, op: 'select', filters: [] }
    const self = this
    const q: Record<string, unknown> = {}
    const chain = () => q
    for (const m of ['select', 'gte', 'not', 'is', 'limit', 'order', 'neq']) {
      q[m] = (...args: unknown[]) => {
        if (m === 'is' || m === 'not') rec.filters.push([m, args[0]])
        return chain()
      }
    }
    q.eq = (col: string, val: unknown) => {
      rec.filters.push([col, val])
      return chain()
    }
    q.update = (payload: Record<string, unknown>) => {
      rec.op = 'update'
      rec.payload = payload
      return chain()
    }
    q.insert = (payload: Record<string, unknown>) => {
      rec.op = 'insert'
      rec.payload = payload
      self.recorded.push(rec)
      return Promise.resolve({ data: null, error: null })
    }
    q.maybeSingle = async () => {
      self.recorded.push(rec)
      return { data: self.rowFor(rec), error: null }
    }
    q.then = (resolve: (v: { data: unknown; error: null }) => unknown) => {
      self.recorded.push(rec)
      return Promise.resolve(resolve({ data: self.rowsFor(rec), error: null }))
    }
    return q
  }

  private rowsFor(rec: Recorded): unknown {
    if (rec.table === 'weddings') {
      return [
        {
          id: TARGET_WEDDING,
          people: [{ role: 'partner1', first_name: this.candidateFirstName }],
        },
      ]
    }
    return []
  }

  private rowFor(rec: Recorded): unknown {
    if (rec.table === 'interactions') {
      return { wedding_id: SOURCE_WEDDING, person_id: 'person-1' }
    }
    if (rec.table === 'couples') {
      if (!this.coupleMirrors) return null
      const wedding = rec.filters.find(([c]) => c === 'source_wedding_id')?.[1]
      return { id: `couple-of-${String(wedding)}` }
    }
    return null
  }

  writes(table: string, op: Recorded['op']): Recorded[] {
    return this.recorded.filter((r) => r.table === table && r.op === op)
  }
}

let fake: Fake

beforeEach(() => {
  fake = new Fake()
})

async function resolve(referencedName: string) {
  await resolveReferencedCouple({
    supabase: fake.client(),
    venueId: VENUE,
    interactionId: INTERACTION,
    referencedName,
    intentClass: 'family_member_proxy',
  })
}

describe('referenced-couple resolver thresholds', () => {
  it('does nothing at all for a weak name match', async () => {
    // "Kate" against "Kajlie" scores well under the propose floor.
    await resolve('Kate')
    expect(fake.writes('interactions', 'update')).toHaveLength(0)
    expect(fake.writes('candidate_matches', 'insert')).toHaveLength(0)
  })

  it('proposes rather than re-points a mid-confidence match', async () => {
    // "Kajli" against "Kajlie": clearly related, not certain.
    await resolve('Kajli')
    expect(fake.writes('interactions', 'update')).toHaveLength(0)
    const proposals = fake.writes('candidate_matches', 'insert')
    expect(proposals).toHaveLength(1)
    const row = proposals[0].payload as Record<string, unknown>
    expect(row.venue_id).toBe(VENUE)
    expect(row.primary_record_type).toBe('couple')
    expect(row.secondary_record_type).toBe('couple')
    expect(row.confidence_tier).toBe('medium')
    expect(String(row.matcher_reason)).toContain(INTERACTION)
  })

  it('auto-attaches an exact match, and scopes the update to the venue', async () => {
    await resolve('Kajlie')
    const updates = fake.writes('interactions', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ wedding_id: TARGET_WEDDING })
    const filterCols = updates[0].filters.map(([c]) => c)
    expect(filterCols).toContain('venue_id')
    expect(filterCols).toContain('id')
    expect(fake.writes('candidate_matches', 'insert')).toHaveLength(0)
  })

  it('scopes the interaction read to the venue too', async () => {
    await resolve('Kajlie')
    const reads = fake.writes('interactions', 'select')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads[0].filters.map(([c]) => c)).toContain('venue_id')
  })

  it('writes no proposal, and re-points nothing, when a couple mirror is missing', async () => {
    fake.coupleMirrors = false
    await resolve('Kajli')
    expect(fake.writes('candidate_matches', 'insert')).toHaveLength(0)
    expect(fake.writes('interactions', 'update')).toHaveLength(0)
  })
})
