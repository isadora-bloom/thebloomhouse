/**
 * W20 — the parents and planners on a HoneyBook project land on the
 * spine as Agent-class people instead of being warned about and dropped.
 *
 * These run the real `commitRelatedContacts` → real `linkSignal` → real
 * Agent branch against an in-memory Supabase (./fake-supabase.ts), so
 * they assert the outcome table by table: `couples`, `agent_couple_links`,
 * `wedding_relationships`, `crm_import_rows`. No network, no database.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { FakeDb } from './fake-supabase'
import { commitRelatedContacts, type PendingRelatedContact } from '../related-contacts'
import type { NormalisedRelatedContactRow } from '../index'

const VENUE = 'venue-1'
const WEDDING = 'wedding-1'
const OTHER_WEDDING = 'wedding-2'

function seedCouple(db: FakeDb, opts: {
  id: string
  weddingId: string
  name: string
  email: string
  lifecycle?: string
}): void {
  db.table('couples').push({
    id: opts.id,
    venue_id: VENUE,
    primary_contact_name: opts.name,
    primary_contact_email: opts.email,
    primary_contact_phone: null,
    lifecycle_state: opts.lifecycle ?? 'booked',
    channel_scope: null,
    source_wedding_id: opts.weddingId,
  })
}

function parent(over: Partial<NormalisedRelatedContactRow> = {}): NormalisedRelatedContactRow {
  return {
    first_name: 'Sharon',
    last_name: 'Bubenhofer',
    email: 'bubenhofers@example.com',
    phone: null,
    role: 'parent',
    role_detail: 'shares the surname Bubenhofer with the couple',
    external_id: 'honeybook:contact:katie_wedding:bubenhofers@example.com',
    source_row: 3,
    raw_row: { 'First Name': 'Sharon' },
    ...over,
  }
}

function pendingFor(
  contact: NormalisedRelatedContactRow,
  weddingId = WEDDING,
): PendingRelatedContact {
  return {
    contact,
    weddingId,
    rowSourceId: 'Katie Bubenhofer Benjamin Lazo Wedding',
    weddingDate: '2025-06-14',
  }
}

// `commitRelatedContacts` reaches the linker through a dynamic import,
// and that module graph is large. Warm it once here so the first test
// is not paying for the whole identity module's cold start.
beforeAll(async () => {
  await import('@/lib/services/identity/forwards-linker')
  await import('@/lib/services/identity/agent-link')
  await import('../import-rows')
}, 60_000)

async function run(db: FakeDb, pending: PendingRelatedContact[], surviving = [WEDDING, OTHER_WEDDING]) {
  return commitRelatedContacts({
    supabase: db.client(),
    venueId: VENUE,
    crmSource: 'honeybook',
    pending,
    survivingWeddings: new Set(surviving),
  })
}

describe('commitRelatedContacts — a parent ends up on the spine', () => {
  let db: FakeDb
  beforeEach(() => {
    db = new FakeDb()
    seedCouple(db, {
      id: 'couple-katie', weddingId: WEDDING,
      name: 'Katie Bubenhofer', email: 'katie.b@example.com',
    })
  })

  it('mints the parent an agent-class couples row, joins it, and records the role', async () => {
    const summary = await run(db, [pendingFor(parent())])

    expect(summary).toMatchObject({ seen: 1, created: 1, linked: 1, rolesRecorded: 1 })
    expect(summary.skipped).toEqual([])

    // couples — a second row, at the Agent lifecycle, not channel_scoped.
    const agent = db.table('couples').find((c) => c.id !== 'couple-katie')!
    expect(agent.primary_contact_name).toBe('Sharon Bubenhofer')
    expect(agent.primary_contact_email).toBe('bubenhofers@example.com')
    expect(agent.lifecycle_state).toBe('agent')
    expect(agent.channel_scope).toBeNull()

    // agent_couple_links — the join that answers "who is on this file".
    expect(db.table('agent_couple_links')).toHaveLength(1)
    expect(db.table('agent_couple_links')[0]).toMatchObject({
      agent_id: agent.id,
      couple_id: 'couple-katie',
      // adapter-source-justified: agent_couple_links.source (how the link was established), not a weddings.source attribution write.
      source: 'operator_confirmed',
    })

    // wedding_relationships — the role, on the legacy limb (mig 255).
    expect(db.table('wedding_relationships')).toHaveLength(1)
    expect(db.table('wedding_relationships')[0]).toMatchObject({
      venue_id: VENUE,
      wedding_id: WEDDING,
      full_name: 'Sharon Bubenhofer',
      relationship_role: 'parent',
      email: 'bubenhofers@example.com',
      // adapter-source-justified: wedding_relationships.source (mig 255 — where the role came from), not a weddings.source attribution write.
      source: 'csv_import',
    })

    // touchpoints — on the agent's own record, keyed on the contact id.
    const tp = db.table('touchpoints')[0]!
    expect(tp.couple_id).toBe(agent.id)
    expect(tp.action_type).toBe('crm_related_contact')
    expect(tp.external_id).toBe(parent().external_id)
  })

  it('anchors the agent touchpoint on the wedding date, not on import day', async () => {
    await run(db, [pendingFor(parent())])
    expect(String(db.table('touchpoints')[0]!.occurred_at)).toContain('2025-06-14')
  })

  it('is a no-op on a second upload of the same export', async () => {
    const first = await run(db, [pendingFor(parent())])
    expect(first.linked).toBe(1)

    const second = await run(db, [pendingFor(parent())])
    expect(second).toMatchObject({ seen: 1, created: 0, linked: 0, rolesRecorded: 0 })
    expect(second.skipped).toEqual([
      { contact: 'Sharon Bubenhofer', reason: 'already_imported' },
    ])

    // Nothing doubled.
    expect(db.table('couples')).toHaveLength(2)
    expect(db.table('agent_couple_links')).toHaveLength(1)
    expect(db.table('wedding_relationships')).toHaveLength(1)
  })

  it('collapses the same planner across two projects into one agent with two links', async () => {
    seedCouple(db, {
      id: 'couple-bria', weddingId: OTHER_WEDDING,
      name: 'Bria Kelly', email: 'bria@example.com',
    })
    const planner = (extId: string): NormalisedRelatedContactRow => ({
      first_name: 'Ivy', last_name: 'Lane', email: 'ivy@ivylaneevents.example',
      phone: null, role: 'planner', role_detail: 'Company: Ivy Lane Events',
      external_id: extId, source_row: 4, raw_row: null,
    })

    const summary = await run(db, [
      pendingFor(planner('honeybook:contact:katie:ivy@ivylaneevents.example'), WEDDING),
      pendingFor(planner('honeybook:contact:bria:ivy@ivylaneevents.example'), OTHER_WEDDING),
    ])

    // One agent record (the mint re-checks by email), two links.
    expect(summary).toMatchObject({ seen: 2, created: 1, linked: 2 })
    const agents = db.table('couples').filter((c) => c.lifecycle_state === 'agent')
    expect(agents).toHaveLength(1)
    expect(db.table('agent_couple_links').map((l) => l.couple_id).sort())
      .toEqual(['couple-bria', 'couple-katie'])
  })

  it('never demotes an existing couple to the Agent class', async () => {
    // The parent's email is already a booked couple at this venue.
    seedCouple(db, {
      id: 'couple-sharon', weddingId: 'wedding-old',
      name: 'Sharon Bubenhofer', email: 'bubenhofers@example.com',
      lifecycle: 'booked',
    })

    const summary = await run(db, [pendingFor(parent())])

    expect(summary).toMatchObject({ created: 0, linked: 1 })
    expect(db.table('couples').find((c) => c.id === 'couple-sharon')!.lifecycle_state)
      .toBe('booked')
    expect(db.table('agent_couple_links')[0]).toMatchObject({
      agent_id: 'couple-sharon', couple_id: 'couple-katie',
    })
  })
})

describe('commitRelatedContacts — refusals are always explained', () => {
  let db: FakeDb
  beforeEach(() => {
    db = new FakeDb()
    seedCouple(db, {
      id: 'couple-katie', weddingId: WEDDING,
      name: 'Katie Bubenhofer', email: 'katie.b@example.com',
    })
  })

  it('skips the contact when the processed marker cannot be written, and imports nothing', async () => {
    db.failOn('crm_import_rows.insert')
    const summary = await run(db, [pendingFor(parent())])

    expect(summary).toMatchObject({ seen: 1, created: 0, linked: 0 })
    expect(summary.skipped[0]!.contact).toBe('Sharon Bubenhofer')
    expect(summary.skipped[0]!.reason).toContain('processed_marker_failed')
    // The swallowed-dedup rule: no spine write, so the next upload can
    // try again from a clean slate rather than double-importing.
    expect(db.table('couples')).toHaveLength(1)
    expect(db.table('agent_couple_links')).toEqual([])
    expect(db.table('wedding_relationships')).toEqual([])
  })

  it('skips a contact whose wedding row was rolled back mid-import', async () => {
    const summary = await run(db, [pendingFor(parent())], [])
    expect(summary.skipped).toEqual([
      { contact: 'Sharon Bubenhofer', reason: 'wedding_row_rolled_back' },
    ])
    expect(db.table('agent_couple_links')).toEqual([])
  })

  it('writes a fragment, not an agent, when the contact has no usable identity', async () => {
    const summary = await run(db, [pendingFor(parent({
      first_name: 'Mum', last_name: null, email: null, phone: null,
      external_id: 'honeybook:contact:katie:mum',
    }))])

    expect(summary).toMatchObject({ created: 0, linked: 0 })
    expect(summary.skipped[0]!.reason).toBe('identity_too_thin')
    expect(db.table('fragments')).toHaveLength(1)
    expect(db.table('agent_couple_links')).toEqual([])
  })

  it('refuses when the couple is not on the spine yet, and keeps the signal as a fragment', async () => {
    const summary = await run(db, [pendingFor(parent(), 'wedding-not-mirrored')], ['wedding-not-mirrored'])
    expect(summary.skipped[0]!.reason).toBe('couple_not_on_spine')
    expect(db.table('fragments')).toHaveLength(1)
    expect(db.table('couples')).toHaveLength(1)
  })

  it('refuses when the contact identifier resolves to the couple itself', async () => {
    const summary = await run(db, [pendingFor(parent({
      first_name: 'Katie', last_name: 'Bubenhofer',
      email: 'katie.b@example.com',
      external_id: 'honeybook:contact:katie:dup',
    }))])
    expect(summary).toMatchObject({ created: 0, linked: 0 })
    expect(summary.skipped[0]!.reason).toBe('same_record_as_couple')
    expect(db.table('agent_couple_links')).toEqual([])
  })

  it('does not write a second wedding_relationships row for a role already recorded', async () => {
    db.table('wedding_relationships').push({
      id: 'wr-existing', venue_id: VENUE, wedding_id: WEDDING,
      full_name: 'Sharon Bubenhofer', relationship_role: 'parent',
    })
    const summary = await run(db, [pendingFor(parent())])
    expect(summary.rolesRecorded).toBe(0)
    expect(summary.linked).toBe(1)
    expect(db.table('wedding_relationships')).toHaveLength(1)
  })

  it('reports an empty batch without touching anything', async () => {
    const summary = await run(db, [])
    expect(summary).toEqual({ seen: 0, created: 0, linked: 0, rolesRecorded: 0, skipped: [] })
    expect(db.calls).toEqual([])
  })
})
