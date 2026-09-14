/**
 * W50 (NOVEMBER-PLAN.md wave 7) — planning notes from coordinator-venue
 * conversations.
 *
 * Until wave 7 a planning note could only come from a couple's chatbot
 * message or a contract PDF, which is not where couples say most of what
 * they say. This writer reads the body of an inbound interaction.
 *
 * The thing worth testing hardest is the replay guard. Gmail backfills,
 * the intent drain and the operator reprocess scripts all put the same
 * interaction through the pipeline again, and the 24-hour content dedup
 * in savePlanningNotes does not reach a replay six weeks later. Without
 * the guard, every backfill would multiply the coordinator's queue.
 *
 * The model call is stubbed — nothing here touches the Anthropic API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSpineDb } from '@/lib/services/__tests__/fake-spine-db'

const db = { current: new FakeSpineDb() }

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => db.current.client(),
}))

vi.mock('@/lib/ai/client', () => ({
  callAIJson: vi.fn(async () => stubbedNotes),
}))

let stubbedNotes: unknown = []

import {
  extractVenueConversationNotes,
  planningNotesExistForInteraction,
  savePlanningNotes,
} from '../planning-extraction'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'
const WEDDING_A = 'wedding-a'
const INTERACTION = 'interaction-1'

const BODY =
  "Thanks for the seating chart. Also, we're having a groom's cake, my uncle is bringing it down on the Friday."

beforeEach(() => {
  db.current = new FakeSpineDb()
  stubbedNotes = [
    { category: 'note', content: "They're having a groom's cake", confidence: 0.9 },
  ]
})

describe('extractVenueConversationNotes', () => {
  it('writes a note stamped with the interaction it came from', async () => {
    const result = await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: INTERACTION,
      channel: 'email',
      text: BODY,
    })

    expect(result.saved).toBe(1)
    const rows = db.current.table('planning_notes')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source_interaction_id).toBe(INTERACTION)
    expect(rows[0]!.source_channel).toBe('email')
    expect(rows[0]!.venue_id).toBe(VENUE_A)
    expect(rows[0]!.wedding_id).toBe(WEDDING_A)
  })

  it('a replay of the same interaction writes nothing more', async () => {
    await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: INTERACTION,
      channel: 'email',
      text: BODY,
    })

    const replay = await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: INTERACTION,
      channel: 'email',
      text: BODY,
    })

    expect(replay.skipped).toBe('already_extracted')
    expect(replay.saved).toBe(0)
    expect(db.current.table('planning_notes')).toHaveLength(1)
  })

  it('a different interaction is not blocked by the first one', async () => {
    await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: INTERACTION,
      channel: 'email',
      text: BODY,
    })

    const second = await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: 'interaction-2',
      channel: 'sms',
      text: 'Also the bar needs to close at eleven, not midnight.',
    })

    // The replay guard is per interaction, not per venue and not per
    // sentence. A second message must still be read.
    expect(second.skipped).toBeNull()
    const channels = db.current.table('planning_notes').map((r) => r.source_channel)
    expect(channels).toContain('email')
    expect(channels).toContain('sms')
  })

  it('the same sentence twice in one day is deduped by content', async () => {
    // savePlanningNotes has always deduped on category + content within a
    // 24-hour window. That is a separate guard from the replay one and it
    // still has to hold for notes carrying an interaction id. created_at
    // is set explicitly here because the fake has no column defaults.
    const now = new Date().toISOString()
    db.current.seed('planning_notes', [
      {
        venue_id: VENUE_A,
        wedding_id: WEDDING_A,
        category: 'note',
        content: "They're having a groom's cake",
        source_interaction_id: 'interaction-earlier',
        created_at: now,
      },
    ])

    await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: 'interaction-2',
      channel: 'sms',
      text: BODY,
    })

    expect(db.current.table('planning_notes')).toHaveLength(1)
  })

  it('carries loose details from the extractor alongside the AI notes', async () => {
    stubbedNotes = []
    const result = await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: INTERACTION,
      channel: 'email',
      text: BODY,
      additionalNotes: [
        { category: 'note', content: "We're having a groom's cake", source_message: BODY },
      ],
    })

    expect(result.saved).toBe(1)
    expect(db.current.table('planning_notes')[0]!.source_interaction_id).toBe(INTERACTION)
  })

  it('a message too short to carry anything is skipped before the model', async () => {
    const result = await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: INTERACTION,
      channel: 'email',
      text: 'ok',
    })

    expect(result.skipped).toBe('empty')
    expect(db.current.table('planning_notes')).toHaveLength(0)
  })

  it('a category the model invented is stored as note, not refused', async () => {
    // planning_notes.category has a CHECK constraint (migration 015). An
    // invented value fails the INSERT with 23514, savePlanningNotes logs
    // it and carries on, and the note is lost quietly. Coerce instead.
    stubbedNotes = [{ category: 'cake_logistics', content: 'Groom cake', confidence: 0.9 }]

    await extractVenueConversationNotes({
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      interactionId: INTERACTION,
      channel: 'email',
      text: BODY,
    })

    expect(db.current.table('planning_notes')[0]!.category).toBe('note')
  })
})

describe('planningNotesExistForInteraction — venue isolation', () => {
  it('one venue cannot see another venue is holding the interaction', async () => {
    await savePlanningNotes(VENUE_B, 'wedding-b', [
      {
        category: 'note',
        content: 'Venue B note',
        source_message: 'x',
        source_interaction_id: INTERACTION,
        source_channel: 'email',
      },
    ])

    // Venue A asking about the same interaction id gets false, so it goes
    // on to extract its own. Anything else would let one venue's write
    // suppress another venue's.
    expect(await planningNotesExistForInteraction(VENUE_A, INTERACTION)).toBe(false)
    expect(await planningNotesExistForInteraction(VENUE_B, INTERACTION)).toBe(true)
  })

  it('a failed read reports existence, so nothing is written twice', async () => {
    // "I could not look" must not read as "nothing is there". A missed
    // extraction is recoverable on the next pass; a duplicated one needs
    // a person to clean up.
    const broken = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }),
          }),
        }),
      }),
    }
    db.current = { client: () => broken } as unknown as FakeSpineDb

    expect(await planningNotesExistForInteraction(VENUE_A, INTERACTION)).toBe(true)
  })
})
