/**
 * Source-level guards for the two classes that keep coming back.
 * 2026-09-14 security review, items 6, 8 and 9.
 *
 * These read the source rather than running it, which is unusual and worth
 * justifying. Every query below is buried several layers inside a function
 * that needs a database to run at all, and the property being locked is not
 * "the function returns the right thing" — it is "this one predicate is
 * present". A behavioural test for that needs a fake deep enough to be its
 * own source of bugs; a source assertion says exactly what the reviewer
 * said, in the place a future edit would break it.
 *
 * The behavioural cousins live next door: approve-phrase-venue-scope.test.ts
 * for the review-language write, tools-hardening.test.ts for the dispatcher.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/** The text of one chained query, from `.from('<table>')` to the end of the
 *  statement. Good enough to ask whether a predicate is inside THIS query
 *  rather than somewhere else in the file. */
function queryBlock(src: string, table: string, nth = 0): string {
  const marker = `.from('${table}')`
  let idx = -1
  for (let i = 0; i <= nth; i++) {
    idx = src.indexOf(marker, idx + 1)
    if (idx === -1) throw new Error(`no .from('${table}') #${nth} in source`)
  }
  // A chained supabase call ends at the first blank line or at a line that
  // is not part of the chain.
  const rest = src.slice(idx)
  const end = rest.search(/\n\s*\n/)
  return end === -1 ? rest : rest.slice(0, end)
}

// ---------------------------------------------------------------------------
// Item 8 — venue predicates on id-list queries reached from tools
// ---------------------------------------------------------------------------

describe('venue predicates on id-keyed reads', () => {
  const cases: Array<[label: string, file: string, table: string, nth?: number]> = [
    ['bulk-follow-up post_tour_sequence', 'src/lib/services/cohort/bulk-follow-up.ts', 'post_tour_sequence'],
    ['bulk-follow-up people', 'src/lib/services/cohort/bulk-follow-up.ts', 'people'],
    ['calibration prediction_snapshots', 'src/lib/services/calibration/analyze.ts', 'prediction_snapshots'],
    ['calibration couple_intel', 'src/lib/services/calibration/analyze.ts', 'couple_intel'],
    ['reviews-analytics review_solicit_requests', 'src/lib/services/intel/reviews-analytics.ts', 'review_solicit_requests'],
  ]

  for (const [label, file, table, nth] of cases) {
    it(`${label} is scoped to a venue`, () => {
      expect(queryBlock(read(file), table, nth ?? 0)).toContain(".eq('venue_id', venueId)")
    })
  }

  it('the follow-up draft reads in inquiry.ts are scoped to a venue', () => {
    const src = read('src/lib/services/brain/inquiry.ts')
    // The wedding row that carries coordinator notes into a draft.
    const wedding = src.slice(src.indexOf("sage_context_notes, has_toured_in_person"))
    expect(wedding.slice(0, 700)).toContain(".eq('venue_id', venueId)")
    // Both interaction reads keyed on wedding_id.
    for (const select of [
      "'subject, body_preview, direction'",
      "'sentiment, urgency, family_mentioned, haiku_classified_at'",
    ]) {
      const block = src.slice(src.indexOf(select))
      expect(block.slice(0, 400), select).toContain(".eq('venue_id', venueId)")
    }
  })

  it('the reviews route passes the session venue into the approval', () => {
    const src = read('src/app/api/intel/reviews/route.ts')
    expect(src).toContain('approvePhraseForSage(auth.venueId, phraseId)')
    expect(src).toContain('approvePhraseForMarketing(auth.venueId, phraseId)')
  })
})

// ---------------------------------------------------------------------------
// Item 9 — spend guards on authenticated model-spending routes
// ---------------------------------------------------------------------------

describe('spend guards', () => {
  const routes = [
    'src/app/api/settings/personality/preview/route.ts',
    'src/app/api/admin/intel/channel-truth/ask/route.ts',
    'src/app/api/intel/reviews/extract-from-text/route.ts',
    'src/app/api/intel/social-integration/capture/route.ts',
  ]

  for (const route of routes) {
    it(`${route} has both a rate limit and a cost gate`, () => {
      const src = read(route)
      expect(src, 'checkRateLimit').toContain('checkRateLimit(')
      expect(src, 'gateForBrainCall').toContain('gateForBrainCall(')
      // A 429 with a Retry-After, not a silent drop.
      expect(src).toContain('status: 429')
    })
  }
})

// ---------------------------------------------------------------------------
// Item 6 — the public preview
// ---------------------------------------------------------------------------

describe('public sage preview', () => {
  const src = read('src/app/api/public/sage-preview/route.ts')

  it('refuses a venue with no published preview', () => {
    expect(src).toContain('onboarding_completed')
    expect(src).toContain('venue.is_demo === true')
    // Same answer as an unknown slug: whether a venue exists is not public.
    expect(src).toMatch(/if \(!published\)[\s\S]{0,120}status: 404/)
  })

  it('limits per venue as well as per IP', () => {
    expect(src).toContain('sage-preview:${ip}')
    expect(src).toContain('sage-preview-venue:${venue.id}')
  })

  it('honours the venue cost ceiling before calling the model', () => {
    expect(src.indexOf('gateForBrainCall(venue.id)')).toBeGreaterThan(-1)
    expect(src.indexOf('gateForBrainCall(venue.id)')).toBeLessThan(src.indexOf('await callAI('))
  })

  it('keys the IP limit on the trusted helper, not on a raw header', () => {
    expect(src).toContain('clientIpForRateLimit(request)')
    expect(src).not.toContain("headers.get('x-forwarded-for')")
  })
})

// ---------------------------------------------------------------------------
// Item 7e — the legacy escape hatch
// ---------------------------------------------------------------------------

describe('NLQ_LEGACY', () => {
  const src = read('src/lib/intel/canonical.ts')

  it('is refused in production', () => {
    const block = src.slice(src.indexOf("process.env.NLQ_LEGACY === '1'"))
    expect(block.slice(0, 1200)).toContain("process.env.NODE_ENV === 'production'")
    expect(block.slice(0, 1600)).toContain("confidence: 'refused'")
  })

  it('is loud everywhere else', () => {
    const block = src.slice(src.indexOf("process.env.NLQ_LEGACY === '1'"))
    expect(block.slice(0, 2400)).toContain('nlq_legacy_enabled')
  })
})
