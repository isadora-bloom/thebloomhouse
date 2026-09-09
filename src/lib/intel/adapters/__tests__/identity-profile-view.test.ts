/**
 * Identity-profile view — parsing the Wave-4 jsonb.
 *
 * The card these tests back had never rendered a value, for two reasons
 * that are both about shape: the row is keyed on wedding_id, and the
 * content is one nested jsonb rather than flat columns. The reader fixes
 * the first. This fixes the second, and these tests pin it, including
 * the ugly real-world cases (a claim with a null name, a profile that is
 * present but entirely refusals).
 */

import { describe, it, expect } from 'vitest'
import { buildIdentityProfileView } from '../identity-profile-view'

const full = {
  names: {
    partner1: {
      first: 'Ashley',
      last: 'Wren',
      confidence_0_100: 92,
      evidence_quote: 'Hi, this is Ashley Wren',
    },
    partner2: { first: 'Ryan', last: null, confidence_0_100: 61, evidence_quote: null },
    is_phantom_partner_relationship: false,
    name_quality: 'high',
  },
  occupations: [
    { partner_role: 'partner1', occupation: 'paediatric nurse', evidence_quote: 'my shifts at the hospital' },
    { partner_role: 'partner2', occupation: 'joiner', evidence_quote: 'on site all week' },
  ],
  residence: { city: 'Warrenton', state: 'VA', evidence_quote: 'we are just up the road in Warrenton' },
  emotional_truths: [
    { theme: 'wants her late father remembered', evidence_quote: 'dad passed in March', confidence_0_100: 80, sensitive: true },
    { theme: 'nervous about the budget', evidence_quote: 'is that the full price?', confidence_0_100: 70, sensitive: false },
  ],
  family_dynamics: [
    { relationship: 'mother of the bride', signal: 'makes the decisions', evidence_quote: 'let me ask my mum' },
  ],
  vendor_preferences: [],
  handles: [{ platform: 'instagram', handle: '@ashandry', evidence_quote: 'find us at @ashandry' }],
  accessibility_needs: [{ need: 'step-free access for grandmother', evidence_quote: 'nan uses a walker' }],
  cultural_signals: [{ signal: 'Catholic ceremony', evidence_quote: 'the priest will travel' }],
  relationship_history: null,
  decision_dynamics: null,
  refusals: [{ field: 'budget', reason: 'no figure was stated' }],
}

describe('buildIdentityProfileView', () => {
  it('reports no content for a null profile', () => {
    const v = buildIdentityProfileView(null)
    expect(v.hasContent).toBe(false)
    expect(v.partner1).toBeNull()
    expect(v.refusals).toEqual([])
  })

  it('reports no content for an empty object', () => {
    expect(buildIdentityProfileView({}).hasContent).toBe(false)
  })

  it('joins names and attaches the matching occupation by partner role', () => {
    const v = buildIdentityProfileView(full)
    expect(v.partner1?.name).toBe('Ashley Wren')
    expect(v.partner1?.occupation).toBe('paediatric nurse')
    expect(v.partner1?.confidence).toBe(92)
    expect(v.partner1?.evidenceQuote).toBe('Hi, this is Ashley Wren')
    expect(v.partner2?.name).toBe('Ryan')
    expect(v.partner2?.occupation).toBe('joiner')
    expect(v.partner2?.evidenceQuote).toBeNull()
  })

  it('drops a name claim where both parts are null rather than rendering a blank', () => {
    const v = buildIdentityProfileView({
      names: {
        partner1: { first: null, last: null, confidence_0_100: 0, evidence_quote: null },
        partner2: null,
        is_phantom_partner_relationship: true,
        name_quality: 'unknown',
      },
    })
    expect(v.partner1).toBeNull()
    expect(v.partner2).toBeNull()
    expect(v.phantomPartner).toBe(true)
    expect(v.nameQuality).toBe('unknown')
    expect(v.hasContent).toBe(false)
  })

  it('formats residence as city, state and keeps its quote', () => {
    const v = buildIdentityProfileView(full)
    expect(v.residence).toBe('Warrenton, VA')
    expect(v.residenceQuote).toContain('Warrenton')
  })

  it('carries the sensitive flag rather than dropping the claim', () => {
    const v = buildIdentityProfileView(full)
    expect(v.emotionalTruths).toHaveLength(2)
    expect(v.emotionalTruths.filter((c) => c.sensitive)).toHaveLength(1)
  })

  it('reads label and detail off the right keys per claim family', () => {
    const v = buildIdentityProfileView(full)
    expect(v.familyDynamics[0]).toMatchObject({
      label: 'mother of the bride',
      detail: 'makes the decisions',
    })
    expect(v.handles[0]).toMatchObject({ label: 'instagram', detail: '@ashandry' })
    expect(v.accessibilityNeeds[0].label).toContain('step-free')
    expect(v.culturalSignals[0].label).toBe('Catholic ceremony')
  })

  it('treats a profile of nothing but refusals as content — a refusal is information', () => {
    const v = buildIdentityProfileView({
      refusals: [{ field: 'guest_count', reason: 'never mentioned' }],
    })
    expect(v.hasContent).toBe(true)
    expect(v.refusals).toEqual([{ field: 'guest_count', reason: 'never mentioned' }])
  })

  it('survives wrong-typed jsonb without throwing', () => {
    const v = buildIdentityProfileView({
      names: 'not an object',
      occupations: 42,
      residence: [],
      emotional_truths: [null, 7, { theme: '' }, { theme: 'ok', evidence_quote: 3 }],
      refusals: [{ field: 'x' }, 'nope'],
    })
    expect(v.hasContent).toBe(true)
    expect(v.emotionalTruths).toHaveLength(1)
    expect(v.emotionalTruths[0].label).toBe('ok')
    expect(v.emotionalTruths[0].evidenceQuote).toBeNull()
    expect(v.refusals).toEqual([])
  })

  it('trims whitespace-only strings to null rather than rendering blanks', () => {
    const v = buildIdentityProfileView({
      residence: { city: '   ', state: 'VA', evidence_quote: '  ' },
    })
    expect(v.residence).toBe('VA')
    expect(v.residenceQuote).toBeNull()
  })
})
