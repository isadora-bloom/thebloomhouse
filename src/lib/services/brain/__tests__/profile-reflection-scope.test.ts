/**
 * What the couple's own assistant may say back to them (W52).
 *
 * These tests are the doctrine. The scope module decides which parts of
 * the reconstructed identity profile may be reflected back at a couple,
 * and the only way that decision stays honest is if a change that widens
 * it has to break a test first.
 *
 * The shape of the proof is deliberately blunt: hand the scope a profile
 * with a distinctive, unmistakable string in every excluded block, then
 * assert that string appears nowhere in the scope OR in the rendered
 * prompt block. A future contributor who adds a field to the allow-list
 * without thinking will fail here rather than in front of a couple.
 */

import { describe, it, expect } from 'vitest'
import {
  NEVER_COUPLE_FACING,
  REFLECTABLE_BLOCKS,
  WITHHELD_REASONS,
  formatProfileReflectionBlock,
  scopeProfileForReflection,
} from '../profile-reflection-scope'

/**
 * A profile with something in every block the reconstruction prompt can
 * produce (`CoupleIdentityProfile` in
 * src/config/prompts/identity-reconstruction.ts). Each excluded value
 * carries a unique LEAK-* marker so a leak is unambiguous.
 */
const FULL_PROFILE: Record<string, unknown> = {
  names: {
    partner1: {
      first: 'Ashley',
      last: 'LEAK-SURNAME-ONE',
      confidence_0_100: 91,
      evidence_quote: 'LEAK-NAME-QUOTE',
    },
    partner2: {
      first: 'Ryan',
      last: 'LEAK-SURNAME-TWO',
      confidence_0_100: 44,
      evidence_quote: 'LEAK-NAME-QUOTE-TWO',
    },
    name_quality: 'LEAK-NAME-QUALITY',
    is_phantom_partner_relationship: true,
  },
  emotional_truths: [
    { theme: 'LEAK-EMOTIONAL-THEME', evidence_quote: 'LEAK-EMOTIONAL-QUOTE', confidence_0_100: 80, sensitive: true },
  ],
  occupations: [
    { partner_role: 'partner1', occupation: 'LEAK-OCCUPATION', evidence_quote: 'LEAK-OCCUPATION-QUOTE' },
  ],
  residence: { city: 'LEAK-CITY', state: 'LEAK-STATE', evidence_quote: 'LEAK-RESIDENCE-QUOTE' },
  family_dynamics: [
    { relationship: 'LEAK-RELATIONSHIP', signal: 'LEAK-FAMILY-SIGNAL', evidence_quote: 'LEAK-FAMILY-QUOTE' },
  ],
  vendor_preferences: [
    { vendor_type: 'ceremony', preference: 'wants it outdoors', evidence_quote: 'LEAK-VENDOR-QUOTE' },
    { vendor_type: 'music', preference: 'a DJ rather than a band', evidence_quote: 'LEAK-VENDOR-QUOTE-TWO' },
  ],
  handles: [{ platform: 'instagram', handle: 'LEAK-HANDLE', evidence_quote: 'LEAK-HANDLE-QUOTE' }],
  accessibility_needs: [{ need: 'LEAK-ACCESS-NEED', evidence_quote: 'LEAK-ACCESS-QUOTE' }],
  cultural_signals: [{ signal: 'LEAK-CULTURAL-SIGNAL', evidence_quote: 'LEAK-CULTURAL-QUOTE' }],
  relationship_history: {
    length_signal: 'LEAK-RELATIONSHIP-LENGTH',
    prior_engagement_signal: 'LEAK-PRIOR-ENGAGEMENT',
  },
  decision_dynamics: {
    who_decides: 'LEAK-WHO-DECIDES',
    who_questions: 'LEAK-WHO-QUESTIONS',
    who_negotiates: 'LEAK-WHO-NEGOTIATES',
  },
  refusals: [{ field: 'LEAK-REFUSAL-FIELD', reason: 'LEAK-REFUSAL-REASON' }],
  // Things that are not part of the profile but that a careless caller
  // might merge in on the way past.
  ghost_risk: 'LEAK-GHOST-RISK',
  heat_score: 97,
  lifecycle_state: 'LEAK-LIFECYCLE',
  coordinator_notes: 'LEAK-COORDINATOR-NOTE',
}

function everythingSaid(scope: ReturnType<typeof scopeProfileForReflection>): string {
  // The scope minus its own `withheld` list (which names the excluded
  // fields on purpose), plus the rendered block.
  const { withheld: _withheld, ...reflected } = scope
  return `${JSON.stringify(reflected)}\n${formatProfileReflectionBlock(scope)}`
}

describe('scopeProfileForReflection — the exclusions', () => {
  const scope = scopeProfileForReflection({
    profile: FULL_PROFILE,
    statedDates: [{ label: 'Wedding date', value: '2027-06-12' }],
  })
  const said = everythingSaid(scope)

  it('reflects nothing carrying a leak marker', () => {
    const leaks = said.match(/LEAK-[A-Z-]+/g) ?? []
    expect(leaks).toEqual([])
  })

  it.each([
    ['an inferred emotional theme', 'LEAK-EMOTIONAL-THEME'],
    ['a sensitive evidence quote', 'LEAK-EMOTIONAL-QUOTE'],
    ['anything read off a family member', 'LEAK-FAMILY-SIGNAL'],
    ['a social handle', 'LEAK-HANDLE'],
    ['an occupation', 'LEAK-OCCUPATION'],
    ['where they live', 'LEAK-CITY'],
    ['an accessibility need', 'LEAK-ACCESS-NEED'],
    ['an inferred cultural signal', 'LEAK-CULTURAL-SIGNAL'],
    ['a read on who decides', 'LEAK-WHO-DECIDES'],
    ['how long they have been together', 'LEAK-RELATIONSHIP-LENGTH'],
    ['an internal refusal record', 'LEAK-REFUSAL-REASON'],
    ['a surname', 'LEAK-SURNAME-ONE'],
    ['the name-quality score', 'LEAK-NAME-QUALITY'],
    ['the evidence quote behind a name', 'LEAK-NAME-QUOTE'],
    ['the evidence quote behind a stated preference', 'LEAK-VENDOR-QUOTE'],
  ])('never reflects %s', (_label, marker) => {
    expect(said).not.toContain(marker)
  })

  it.each(NEVER_COUPLE_FACING.map((f) => [f] as const))(
    'never reflects the operator-side field %s, even when merged into the profile object',
    (field) => {
      expect(said).not.toContain(field)
    },
  )

  it('never reflects a score, however it arrives', () => {
    expect(said).not.toContain('97')
    expect(said).not.toContain('91')
    expect(said).not.toMatch(/confidence/i)
    expect(said).not.toMatch(/engagement score/i)
  })

  it('names every exclusion, with a reason, so the decision is auditable', () => {
    for (const entry of scope.withheld) {
      expect(entry.reason.length).toBeGreaterThan(10)
    }
    const fields = scope.withheld.map((w) => w.field)
    for (const key of Object.keys(WITHHELD_REASONS)) {
      expect(fields).toContain(key)
    }
  })
})

describe('scopeProfileForReflection — what it does reflect', () => {
  const scope = scopeProfileForReflection({
    profile: FULL_PROFILE,
    statedDates: [{ label: 'Wedding date', value: '2027-06-12' }],
  })

  it('keeps the first names they use for each other, and only the first names', () => {
    expect(scope.firstNames).toEqual(['Ashley', 'Ryan'])
  })

  it('keeps what they said they wanted', () => {
    expect(scope.statedPriorities).toEqual([
      { label: 'ceremony', detail: 'wants it outdoors' },
      { label: 'music', detail: 'a DJ rather than a band' },
    ])
  })

  it('keeps a date the couple gave', () => {
    expect(scope.statedDates).toEqual([{ label: 'Wedding date', detail: '2027-06-12' }])
  })

  it('lists exactly the blocks the allow-list names', () => {
    expect(REFLECTABLE_BLOCKS).toEqual([
      'names.partner1.first',
      'names.partner2.first',
      'vendor_preferences',
    ])
  })

  it('takes only the first word when a full name lands in the first-name slot', () => {
    const s = scopeProfileForReflection({
      profile: { names: { partner1: { first: 'Ashley Fairweather-Hughes' } } },
    })
    expect(s.firstNames).toEqual(['Ashley'])
  })

  it('records one person once when both name claims are the same person', () => {
    const s = scopeProfileForReflection({
      profile: { names: { partner1: { first: 'Ashley' }, partner2: { first: 'ashley' } } },
    })
    expect(s.firstNames).toEqual(['Ashley'])
  })
})

describe('scopeProfileForReflection — honest empties', () => {
  it('has no content when there is no profile and no dates', () => {
    const s = scopeProfileForReflection({ profile: null })
    expect(s.hasContent).toBe(false)
    expect(formatProfileReflectionBlock(s)).toBe('')
  })

  it('has no content when the profile is an empty object', () => {
    const s = scopeProfileForReflection({ profile: {} })
    expect(s.hasContent).toBe(false)
  })

  it('drops a stated date whose value is missing rather than printing a blank', () => {
    const s = scopeProfileForReflection({
      profile: null,
      statedDates: [{ label: 'Wedding date', value: null }],
    })
    expect(s.statedDates).toEqual([])
    expect(s.hasContent).toBe(false)
  })

  it('drops a vendor preference with no preference recorded', () => {
    const s = scopeProfileForReflection({
      profile: { vendor_preferences: [{ vendor_type: 'florist', preference: '  ' }] },
    })
    expect(s.statedPriorities).toEqual([])
  })

  it('survives a profile whose blocks are the wrong shape entirely', () => {
    const s = scopeProfileForReflection({
      profile: { names: 'not an object', vendor_preferences: 'not an array' },
    })
    expect(s.hasContent).toBe(false)
    expect(s.firstNames).toEqual([])
    expect(s.statedPriorities).toEqual([])
  })
})

describe('formatProfileReflectionBlock — the register', () => {
  const block = formatProfileReflectionBlock(
    scopeProfileForReflection({
      profile: FULL_PROFILE,
      statedDates: [{ label: 'Wedding date', value: '2027-06-12' }],
    }),
  )

  it('carries the rule that stops the model reciting the block as a list', () => {
    expect(block).toMatch(/never read this block out as a list/i)
  })

  it('tells the model it knows nothing beyond the block', () => {
    expect(block).toMatch(/if it is not in this block, you do not know it/i)
  })

  it('bans the surveillance register by name', () => {
    expect(block).toMatch(/no scores/i)
    expect(block).toMatch(/social accounts/i)
  })

  it('is delimited the same way every other Sage context block is', () => {
    expect(block).toContain('--- WHAT THEY HAVE TOLD YOU (SAFE TO MENTION) ---')
    expect(block).toContain('--- END WHAT THEY HAVE TOLD YOU ---')
  })

  it('says what they told us in their own terms', () => {
    expect(block).toContain('Ashley and Ryan')
    expect(block).toContain('wants it outdoors')
  })
})
