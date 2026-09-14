/**
 * W50 (NOVEMBER-PLAN.md wave 7) — the nightly reconciler.
 *
 * The judge is injected, so nothing here calls a model. What is under
 * test is everything around it: which sentences get asked about, which
 * are answered from cache, which are left alone because a coordinator
 * already decided, and whether one venue's reader can see another
 * venue's wedding.
 */
import { describe, it, expect } from 'vitest'
import { FakeSpineDb } from '@/lib/services/__tests__/fake-spine-db'
import {
  reconcileWedding,
  gatherCommitments,
  coerceVerdicts,
  type CommitmentJudge,
  type JudgeVerdict,
} from '../reconcile'
import { commitmentKey, judgeCacheKey, normaliseQuote } from '../keys'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'
const WEDDING_A = 'wedding-a'
const WEDDING_B = 'wedding-b'

const CAKE = "We're having a groom's cake"
const UNCLE = 'My uncle is officiating'

/**
 * A judge that says "covered" for anything whose text appears in a
 * timeline entry, and is otherwise not covered. Deterministic and dumb on
 * purpose: the real judge's quality is a prompt question, and what these
 * tests care about is the plumbing around it.
 */
function fakeJudge(covered: Record<string, string> = {}): CommitmentJudge & { calls: number } {
  const judge = (async (args) => {
    judge.calls++
    return args.quotes.map<JudgeVerdict>((quote) => {
      const title = covered[quote]
      return title
        ? { quote, covered: true, matchedEventTitle: title, reason: `${title} covers it` }
        : { quote, covered: false, matchedEventTitle: null, reason: 'nothing on the day for this' }
    })
  }) as CommitmentJudge & { calls: number }
  judge.calls = 0
  return judge
}

function seedVenueA(db: FakeSpineDb, opts: { timelineTitles?: string[] } = {}) {
  db.seed('planning_notes', [
    { venue_id: VENUE_A, wedding_id: WEDDING_A, content: CAKE, category: 'note', source_interaction_id: 'int-1' },
    { venue_id: VENUE_A, wedding_id: WEDDING_A, content: UNCLE, category: 'note', source_interaction_id: 'int-1' },
  ])
  db.seed('timeline', [
    {
      venue_id: VENUE_A,
      wedding_id: WEDDING_A,
      config_json: {
        customEvents: (opts.timelineTitles ?? []).map((name, i) => ({
          id: `custom_${i}`,
          name,
          time: '',
          duration: 15,
          notes: '',
          phase: 'reception_intro',
          icon: '🎯',
        })),
      },
    },
  ])
}

describe('keys', () => {
  it('the same sentence keys the same however it is punctuated', () => {
    expect(commitmentKey("We're having a groom's cake.")).toBe(
      commitmentKey("  we're having a groom's cake  "),
    )
  })

  it('two different sentences do not collide', () => {
    expect(commitmentKey(CAKE)).not.toBe(commitmentKey(UNCLE))
  })

  it('normalising does not merge a longer sentence into a shorter one', () => {
    // Over-eager normalisation would make "the cake arrives at four" and
    // "the cake" the same commitment, which loses the detail the
    // coordinator needs.
    expect(normaliseQuote('the cake arrives at four')).not.toBe(normaliseQuote('the cake'))
  })

  it('the judge cache key ignores the order the timeline was read in', () => {
    expect(judgeCacheKey(CAKE, ['Cake cutting', 'First dance'])).toBe(
      judgeCacheKey(CAKE, ['First dance', 'Cake cutting']),
    )
  })

  it('the judge cache key changes when the timeline changes', () => {
    expect(judgeCacheKey(CAKE, ['Cake cutting'])).not.toBe(
      judgeCacheKey(CAKE, ['Cake cutting', "Groom's cake table"]),
    )
  })
})

describe('coerceVerdicts', () => {
  it('a quote the model did not answer stays on the queue', () => {
    const out = coerceVerdicts([{ quote: CAKE, covered: true, matchedEventTitle: 'Cake cutting' }], [
      CAKE,
      UNCLE,
    ])
    expect(out).toHaveLength(2)
    expect(out[1].quote).toBe(UNCLE)
    expect(out[1].covered).toBe(false)
  })

  it('covered with no event title is not covered', () => {
    // The model must name the event. "Covered, but I cannot say by what"
    // is not an answer a coordinator can check.
    const out = coerceVerdicts([{ quote: CAKE, covered: true, matchedEventTitle: null }], [CAKE])
    expect(out[0].covered).toBe(false)
  })

  it('junk from the model leaves every quote on the queue', () => {
    const out = coerceVerdicts('not an array', [CAKE, UNCLE])
    expect(out.map((v) => v.covered)).toEqual([false, false])
  })
})

describe('reconcileWedding', () => {
  it('leaves a commitment with no matching event on the queue', async () => {
    const db = new FakeSpineDb()
    seedVenueA(db, { timelineTitles: ['First dance'] })
    const judge = fakeJudge()

    const result = await reconcileWedding({
      supabase: db.client(),
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      judge,
    })

    expect(result.captured).toBe(2)
    expect(result.judged).toBe(2)
    expect(result.unmatched).toBe(2)

    const rows = db.table('commitment_reconciliation')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'unmatched')).toBe(true)
    expect(rows.every((r) => r.venue_id === VENUE_A)).toBe(true)
  })

  it('marks a commitment matched when the judge finds an event for it', async () => {
    const db = new FakeSpineDb()
    seedVenueA(db, { timelineTitles: ["Groom's cake table", 'First dance'] })
    const judge = fakeJudge({ [CAKE]: "Groom's cake table" })

    const result = await reconcileWedding({
      supabase: db.client(),
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      judge,
    })

    expect(result.unmatched).toBe(1)
    const cake = db
      .table('commitment_reconciliation')
      .find((r) => r.commitment_key === commitmentKey(CAKE))
    expect(cake?.status).toBe('matched')
    expect(cake?.matched_event_title).toBe("Groom's cake table")
  })

  it('is idempotent: a second run updates rather than duplicates', async () => {
    const db = new FakeSpineDb()
    seedVenueA(db, { timelineTitles: ['First dance'] })
    const judge = fakeJudge()
    const args = { supabase: db.client(), venueId: VENUE_A, weddingId: WEDDING_A, judge }

    await reconcileWedding(args)
    await reconcileWedding(args)

    expect(db.table('commitment_reconciliation')).toHaveLength(2)
  })

  it('spends nothing on a second run when nothing has changed', async () => {
    const db = new FakeSpineDb()
    seedVenueA(db, { timelineTitles: ['First dance'] })
    const judge = fakeJudge()
    const args = { supabase: db.client(), venueId: VENUE_A, weddingId: WEDDING_A, judge }

    await reconcileWedding(args)
    expect(judge.calls).toBe(1)

    const second = await reconcileWedding(args)
    // Same sentences, same timeline, so the cached verdicts stand and the
    // model is never called again.
    expect(judge.calls).toBe(1)
    expect(second.cached).toBe(2)
    expect(second.judged).toBe(0)
  })

  it('re-judges when the timeline changes under a commitment', async () => {
    const db = new FakeSpineDb()
    seedVenueA(db, { timelineTitles: ['First dance'] })
    const judge = fakeJudge()
    const args = { supabase: db.client(), venueId: VENUE_A, weddingId: WEDDING_A, judge }

    await reconcileWedding(args)
    expect(judge.calls).toBe(1)

    // The couple adds a cake table. The old verdict cannot stand.
    const timelineRow = db.table('timeline')[0]!
    ;(timelineRow.config_json as { customEvents: unknown[] }).customEvents.push({
      id: 'custom_x',
      name: "Groom's cake table",
      time: '',
      duration: 15,
      notes: '',
      phase: 'reception_intro',
      icon: '🎯',
    })

    const second = await reconcileWedding(args)
    expect(judge.calls).toBe(2)
    expect(second.judged).toBe(2)
    expect(second.cached).toBe(0)
  })

  it('never reopens a row a coordinator dismissed', async () => {
    const db = new FakeSpineDb()
    seedVenueA(db, { timelineTitles: ['First dance'] })
    const judge = fakeJudge()
    const args = { supabase: db.client(), venueId: VENUE_A, weddingId: WEDDING_A, judge }

    await reconcileWedding(args)

    // The coordinator decides the groom's cake needs no event.
    const cake = db
      .table('commitment_reconciliation')
      .find((r) => r.commitment_key === commitmentKey(CAKE))!
    cake.status = 'dismissed'

    const second = await reconcileWedding(args)

    expect(second.resolved).toBe(1)
    expect(cake.status).toBe('dismissed')
  })

  it('does not mark anything unmatched when the timeline cannot be read', async () => {
    const db = new FakeSpineDb()
    db.seed('planning_notes', [
      { venue_id: VENUE_A, wedding_id: WEDDING_A, content: CAKE, category: 'note' },
    ])
    // No timeline row at all is a readable empty timeline, so seed one and
    // break the read instead.
    const client = db.client()
    const broken = {
      from: (name: string) =>
        name === 'timeline'
          ? { select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: 'boom' } }) }) }) }
          : client.from(name),
    } as unknown as ReturnType<FakeSpineDb['client']>

    const result = await reconcileWedding({
      supabase: broken,
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      judge: fakeJudge(),
    })

    expect(result.skipped).toBe('timeline_unreadable')
    expect(db.table('commitment_reconciliation')).toHaveLength(0)
  })

  it('an empty timeline is a real answer, not a failure', async () => {
    const db = new FakeSpineDb()
    db.seed('planning_notes', [
      { venue_id: VENUE_A, wedding_id: WEDDING_A, content: CAKE, category: 'note' },
    ])
    const result = await reconcileWedding({
      supabase: db.client(),
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      judge: fakeJudge(),
    })

    expect(result.skipped).toBeNull()
    expect(result.unmatched).toBe(1)
  })
})

describe('venue isolation', () => {
  it('gatherCommitments returns nothing for another venue', async () => {
    const db = new FakeSpineDb()
    seedVenueA(db)
    db.seed('planning_notes', [
      { venue_id: VENUE_B, wedding_id: WEDDING_B, content: 'Venue B secret', category: 'note' },
    ])

    // Venue A asking about its own wedding sees its own two notes.
    const mine = await gatherCommitments(db.client(), VENUE_A, WEDDING_A)
    expect(mine.map((c) => c.quote).sort()).toEqual([CAKE, UNCLE].sort())

    // Venue A asking about venue B's wedding sees nothing. Both filters
    // have to bite: the venue AND the wedding.
    const theirs = await gatherCommitments(db.client(), VENUE_A, WEDDING_B)
    expect(theirs).toEqual([])

    // And the reverse.
    const alsoNothing = await gatherCommitments(db.client(), VENUE_B, WEDDING_A)
    expect(alsoNothing).toEqual([])
  })

  it('reconciling venue A never writes a row carrying venue B', async () => {
    const db = new FakeSpineDb()
    seedVenueA(db, { timelineTitles: [] })
    db.seed('planning_notes', [
      { venue_id: VENUE_B, wedding_id: WEDDING_B, content: 'Venue B secret', category: 'note' },
    ])

    await reconcileWedding({
      supabase: db.client(),
      venueId: VENUE_A,
      weddingId: WEDDING_A,
      judge: fakeJudge(),
    })

    const written = db.table('commitment_reconciliation')
    expect(written.length).toBeGreaterThan(0)
    expect(written.every((r) => r.venue_id === VENUE_A)).toBe(true)
    expect(written.every((r) => r.wedding_id === WEDDING_A)).toBe(true)
    expect(written.some((r) => String(r.quote).includes('secret'))).toBe(false)
  })

  it('deduplicates a sentence captured by two routes', async () => {
    const db = new FakeSpineDb()
    db.seed('planning_notes', [
      { venue_id: VENUE_A, wedding_id: WEDDING_A, content: CAKE, category: 'note', source_interaction_id: 'int-1' },
    ])
    db.seed('interactions', [
      { venue_id: VENUE_A, wedding_id: WEDDING_A, extracted_facts: { intentions: [CAKE, UNCLE] } },
    ])

    const out = await gatherCommitments(db.client(), VENUE_A, WEDDING_A)

    expect(out).toHaveLength(2)
    // The planning note wins, because it is the row with a source the
    // coordinator can click through to.
    expect(out.find((c) => c.quote === CAKE)?.kind).toBe('planning_note')
    expect(out.find((c) => c.quote === UNCLE)?.kind).toBe('intention')
  })
})
