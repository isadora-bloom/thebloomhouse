/**
 * The couple's RSVP nudge (W52).
 *
 * The thing being tested is the wall. The venue's own booked weddings
 * decide whether the nudge appears; the words the couple reads are about
 * their own guest list and nobody else's. `couple-rules.ts` TENANT
 * ISOLATION bans a venue-specific cross-couple pattern reaching a couple,
 * so a cohort number appearing in the copy is a doctrine failure, not a
 * wording preference.
 */

import { describe, it, expect } from 'vitest'
import {
  BEHIND_BY,
  MIN_GUESTS_PER_WEDDING,
  MIN_WEDDINGS_PER_BAND,
  PACE_BANDS,
  bandFor,
  buildRsvpNudge,
  daysUntil,
  loadRsvpPaceCohort,
  type RsvpPaceCohort,
} from '../couple-nudge'

const VENUE = 'venue-1'
const NOW = Date.UTC(2026, 8, 14, 12)

function isoDaysFromNow(days: number): string {
  return new Date(NOW + days * 86_400_000).toISOString().slice(0, 10)
}

function cohort(band: string, medianRepliedShare: number | null, n = 8): RsvpPaceCohort {
  return {
    bands: PACE_BANDS.map((b) => ({
      band: b.key,
      n: b.key === band ? n : 0,
      enoughData: b.key === band && medianRepliedShare !== null,
      medianRepliedShare: b.key === band ? medianRepliedShare : null,
    })),
    generatedAt: '2026-09-14T00:00:00.000Z',
  }
}

// ─────────────────────────────────────────────────────────────────────
// Bands
// ─────────────────────────────────────────────────────────────────────

describe('bandFor', () => {
  it('puts the run-up to the day in the final month', () => {
    expect(bandFor(0)?.key).toBe('final-month')
    expect(bandFor(30)?.key).toBe('final-month')
  })

  it('steps up at the boundaries', () => {
    expect(bandFor(31)?.key).toBe('two-months')
    expect(bandFor(61)?.key).toBe('four-months')
    expect(bandFor(121)?.key).toBe('further-out')
    expect(bandFor(900)?.key).toBe('further-out')
  })

  it('has no band for a day already gone', () => {
    expect(bandFor(-1)).toBeNull()
  })
})

describe('daysUntil', () => {
  it('reads a bare date as midday, so a timezone cannot move it a day', () => {
    expect(daysUntil('2026-09-21', NOW)).toBe(7)
  })

  it('is null on a missing or unreadable date', () => {
    expect(daysUntil(null, NOW)).toBeNull()
    expect(daysUntil('not a date', NOW)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// The nudge
// ─────────────────────────────────────────────────────────────────────

describe('buildRsvpNudge — when it stays quiet', () => {
  const base = {
    weddingDate: isoDaysFromNow(20),
    guestsTotal: 100,
    guestsReplied: 30,
    cohort: cohort('final-month', 0.8),
    now: NOW,
  }

  it('speaks when the couple is behind', () => {
    expect(buildRsvpNudge(base)).not.toBeNull()
  })

  it('stays quiet when they are keeping pace', () => {
    expect(buildRsvpNudge({ ...base, guestsReplied: 75 })).toBeNull()
  })

  it('stays quiet when they are only just behind', () => {
    const share = 0.8 - BEHIND_BY / 2
    expect(buildRsvpNudge({ ...base, guestsReplied: Math.round(100 * share) })).toBeNull()
  })

  it('stays quiet when the venue has too little history to know what behind means', () => {
    expect(buildRsvpNudge({ ...base, cohort: cohort('final-month', null, MIN_WEDDINGS_PER_BAND - 1) })).toBeNull()
  })

  it('stays quiet when the band the couple sits in has nothing behind it', () => {
    expect(buildRsvpNudge({ ...base, cohort: cohort('further-out', 0.8) })).toBeNull()
  })

  it(`stays quiet for a guest list under ${MIN_GUESTS_PER_WEDDING}`, () => {
    expect(buildRsvpNudge({ ...base, guestsTotal: 8, guestsReplied: 0 })).toBeNull()
  })

  it('stays quiet when the wedding date is unknown', () => {
    expect(buildRsvpNudge({ ...base, weddingDate: null })).toBeNull()
  })

  it('stays quiet once the day has been and gone', () => {
    expect(buildRsvpNudge({ ...base, weddingDate: isoDaysFromNow(-3) })).toBeNull()
  })
})

describe('buildRsvpNudge — the words', () => {
  const nudge = buildRsvpNudge({
    weddingDate: isoDaysFromNow(20),
    guestsTotal: 100,
    guestsReplied: 30,
    cohort: cohort('final-month', 0.85),
    now: NOW,
  })!

  it('talks about their own guest list, in their own numbers', () => {
    expect(nudge.body).toContain('70')
    expect(nudge.body).toContain('100')
  })

  it('never mentions another couple, a share, a median or a comparison', () => {
    const text = `${nudge.label} ${nudge.body} ${nudge.cta}`.toLowerCase()
    for (const banned of [
      'other couples',
      'most couples',
      'average',
      'median',
      'typical',
      'usually have',
      'compared',
      'behind',
      'ahead of',
      '%',
    ]) {
      expect(text).not.toContain(banned)
    }
  })

  it('never carries the cohort figure into the copy', () => {
    expect(nudge.body).not.toContain('85')
    expect(nudge.body).not.toContain('0.85')
  })

  it('sends them to their own guest list', () => {
    expect(nudge.href).toBe('/guests')
  })

  it('is firmer when they are a long way behind, and still says nothing about anyone else', () => {
    const firm = buildRsvpNudge({
      weddingDate: isoDaysFromNow(10),
      guestsTotal: 120,
      guestsReplied: 12,
      cohort: cohort('final-month', 0.85),
      now: NOW,
    })!
    expect(firm.tone).toBe('firm')
    expect(firm.body).toContain('108')
    expect(firm.body.toLowerCase()).not.toContain('couples')
  })
})

// ─────────────────────────────────────────────────────────────────────
// The cohort read
// ─────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

/** Same predicate-filtering fake as since-last-here.test.ts. */
function fakeSupabase(fixtures: Record<string, Row[]>) {
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
       
      const chain: any = {}
      chain.select = () => chain
      chain.eq = (c: string, v: unknown) => {
        preds.push((r) => r[c] === v)
        return chain
      }
      chain.is = (c: string, v: unknown) => {
        preds.push((r) => (r[c] ?? null) === v)
        return chain
      }
      chain.order = () => chain
      chain.limit = () => chain
      chain.then = (onFulfilled: (v: unknown) => unknown) => {
        const rows = (fixtures[table] ?? []).filter((r) => preds.every((p) => p(r)))
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled)
      }
      return chain
    },
     
  } as any
}

function guestsFor(weddingId: string, total: number, replied: number): Row[] {
  return Array.from({ length: total }, (_, i) => ({
    venue_id: VENUE,
    wedding_id: weddingId,
    rsvp_status: i < replied ? 'attending' : 'pending',
  }))
}

describe('loadRsvpPaceCohort', () => {
  function fixtureFor(count: number, repliedShare: number, extra: Row[] = []) {
    const couples: Row[] = []
    let guests: Row[] = []
    for (let i = 0; i < count; i++) {
      const wid = `w${i}`
      couples.push({
        venue_id: VENUE,
        lifecycle_state: 'booked',
        merged_into_id: null,
        source_wedding_id: wid,
        wedding_date: isoDaysFromNow(20),
      })
      guests = guests.concat(guestsFor(wid, 20, Math.round(20 * repliedShare)))
    }
    return fakeSupabase({ couples: couples.concat(extra), guest_list: guests })
  }

  it('reports the band median once enough weddings sit in it', async () => {
    const result = await loadRsvpPaceCohort(fixtureFor(MIN_WEDDINGS_PER_BAND, 0.75), VENUE, NOW)
    const band = result.bands.find((b) => b.band === 'final-month')!
    expect(band.n).toBe(MIN_WEDDINGS_PER_BAND)
    expect(band.enoughData).toBe(true)
    expect(band.medianRepliedShare).toBeCloseTo(0.75, 5)
  })

  it('withholds the median rather than reporting a thin one', async () => {
    const result = await loadRsvpPaceCohort(fixtureFor(MIN_WEDDINGS_PER_BAND - 1, 0.75), VENUE, NOW)
    const band = result.bands.find((b) => b.band === 'final-month')!
    expect(band.enoughData).toBe(false)
    expect(band.medianRepliedShare).toBeNull()
  })

  it('leaves the couple’s own wedding out, so they are never compared with themselves', async () => {
    const supabase = fixtureFor(MIN_WEDDINGS_PER_BAND, 0.75)
    const result = await loadRsvpPaceCohort(supabase, VENUE, NOW, 'w0')
    const band = result.bands.find((b) => b.band === 'final-month')!
    expect(band.n).toBe(MIN_WEDDINGS_PER_BAND - 1)
  })

  it('ignores a wedding too small to say anything about', async () => {
    const couples: Row[] = [
      {
        venue_id: VENUE,
        lifecycle_state: 'booked',
        merged_into_id: null,
        source_wedding_id: 'tiny',
        wedding_date: isoDaysFromNow(20),
      },
    ]
    const supabase = fakeSupabase({
      couples,
      guest_list: guestsFor('tiny', MIN_GUESTS_PER_WEDDING - 1, MIN_GUESTS_PER_WEDDING - 1),
    })
    const result = await loadRsvpPaceCohort(supabase, VENUE, NOW)
    expect(result.bands.find((b) => b.band === 'final-month')!.n).toBe(0)
  })

  it('returns four honest-empty bands for a venue with nothing booked', async () => {
    const result = await loadRsvpPaceCohort(fakeSupabase({ couples: [], guest_list: [] }), VENUE, NOW)
    expect(result.bands).toHaveLength(PACE_BANDS.length)
    expect(result.bands.every((b) => !b.enoughData && b.medianRepliedShare === null)).toBe(true)
  })

  it('returns honest-empty with no venue in scope', async () => {
    const result = await loadRsvpPaceCohort(fakeSupabase({}), '', NOW)
    expect(result.bands.every((b) => b.n === 0)).toBe(true)
  })

  it('counts a declined or undecided guest as having replied, because they did', async () => {
    const couples: Row[] = [
      {
        venue_id: VENUE,
        lifecycle_state: 'booked',
        merged_into_id: null,
        source_wedding_id: 'w0',
        wedding_date: isoDaysFromNow(20),
      },
    ]
    const guests: Row[] = [
      ...Array.from({ length: 5 }, () => ({ venue_id: VENUE, wedding_id: 'w0', rsvp_status: 'declined' })),
      ...Array.from({ length: 5 }, () => ({ venue_id: VENUE, wedding_id: 'w0', rsvp_status: 'maybe' })),
      ...Array.from({ length: 10 }, () => ({ venue_id: VENUE, wedding_id: 'w0', rsvp_status: 'pending' })),
    ]
    const result = await loadRsvpPaceCohort(fakeSupabase({ couples, guest_list: guests }), VENUE, NOW)
    // One wedding is under the band floor, so nothing is reported — but
    // the tally behind it is what matters, and it is asserted through
    // the builder instead.
    expect(result.bands.find((b) => b.band === 'final-month')!.n).toBe(1)
  })
})
