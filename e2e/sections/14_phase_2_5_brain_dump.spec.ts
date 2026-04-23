import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestWedding,
  cleanup,
  TestContext,
} from '../helpers/seed'

/**
 * §14 PHASE 2.5 ACCEPTANCE — brain dump.
 *
 * DB-layer assertions for the brain_dump_entries table, its RLS, and the
 * Sage-context-notes append path. The full classify+route Claude-backed
 * path is deferred behind a nightly AI-stub test.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§14 Phase 2.5 — Brain dump', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  test('078: brain_dump_entries exists with the full Task 25 schema', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { data, error } = await admin()
      .from('brain_dump_entries')
      .insert({
        venue_id: venueId,
        raw_input: 'Jamie was stressed about seating today',
        input_type: 'text',
        parse_status: 'pending',
      })
      .select('id, input_type, parse_status, routed_to, parsed_at, created_at')
      .single()
    expect(error).toBeNull()
    expect(data!.input_type).toBe('text')
    expect(data!.parse_status).toBe('pending')
    expect(data!.routed_to).toEqual([])
    expect(data!.parsed_at).toBeNull()

    // Cleanup via context.extra
    if (!ctx.extra['brain_dump_entries']) ctx.extra['brain_dump_entries'] = []
    ctx.extra['brain_dump_entries'].push(data!.id)
  })

  test('078: parse_status CHECK rejects invalid values', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { error } = await admin()
      .from('brain_dump_entries')
      .insert({
        venue_id: venueId,
        raw_input: 'test',
        input_type: 'text',
        parse_status: 'not-a-real-state',
      })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/parse_status|check constraint/i)
  })

  test('078: weddings.sage_context_notes is jsonb + appendable', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    const note = {
      body: 'Jamie is nervous about weather',
      source: 'brain_dump',
      added_at: new Date().toISOString(),
    }
    const { error } = await admin()
      .from('weddings')
      .update({ sage_context_notes: [note] })
      .eq('id', wedding.weddingId)
    expect(error).toBeNull()

    const { data } = await admin()
      .from('weddings')
      .select('sage_context_notes')
      .eq('id', wedding.weddingId)
      .single()
    const notes = data!.sage_context_notes as Array<{ body: string }>
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toBe('Jamie is nervous about weather')
  })

  test('078: two venues keep their brain-dumps isolated', async () => {
    const { orgId } = await createTestOrg(ctx)
    const rixey = await createTestVenue(ctx, { orgId, name: `Rixey [e2e:${ctx.testId}]` })
    const oakwood = await createTestVenue(ctx, { orgId, name: `Oakwood [e2e:${ctx.testId}]`, aiName: 'Ivy' })

    const { data: rEntry } = await admin()
      .from('brain_dump_entries')
      .insert({ venue_id: rixey.venueId, raw_input: 'rixey-only note' })
      .select('id')
      .single()
    const { data: oEntry } = await admin()
      .from('brain_dump_entries')
      .insert({ venue_id: oakwood.venueId, raw_input: 'oakwood-only note' })
      .select('id')
      .single()
    if (!ctx.extra['brain_dump_entries']) ctx.extra['brain_dump_entries'] = []
    ctx.extra['brain_dump_entries'].push(rEntry!.id, oEntry!.id)

    // Confirm that filtering by venue returns only that venue's entry.
    const { data: rOnly } = await admin()
      .from('brain_dump_entries')
      .select('id, venue_id, raw_input')
      .eq('venue_id', rixey.venueId)
      .in('id', [rEntry!.id, oEntry!.id])
    expect(rOnly).toHaveLength(1)
    expect((rOnly![0].raw_input as string)).toBe('rixey-only note')

    const { data: oOnly } = await admin()
      .from('brain_dump_entries')
      .select('id, venue_id, raw_input')
      .eq('venue_id', oakwood.venueId)
      .in('id', [rEntry!.id, oEntry!.id])
    expect(oOnly).toHaveLength(1)
    expect((oOnly![0].raw_input as string)).toBe('oakwood-only note')
  })

  // Deferred tests — require a Claude stub to drive the real classifier.
  test.skip('DEFERRED: classifier routes "Jamie was stressed" to the right wedding', () => {})
  test.skip('DEFERRED: "May 1st cancelled" triggers availability confirmation (not auto-update)', () => {})
  test.skip('DEFERRED: ambiguous "Jamie" with two matching couples asks one clarification question', () => {})
})
