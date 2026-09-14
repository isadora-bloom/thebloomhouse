/**
 * W50 (NOVEMBER-PLAN.md wave 7) — `intentions` on the extraction schema.
 *
 * A stated plan is neither a question nor a special request, and before
 * this it had nowhere to go. The parse side is what these tests cover:
 * given whatever the model returns, does `extractSignals` hand its caller
 * a usable `string[]`?
 *
 * That matters more than it sounds. Every list field on ExtractedSignals
 * is typed `string[]` and callers index into it. A model that omits a
 * field hands them `undefined` typed as an array, and the TypeError lands
 * two modules away from the cause.
 *
 * The model call is stubbed — nothing here touches the Anthropic API.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/ai/client', () => ({
  callAIJson: vi.fn(async () => stubbedModelResponse),
}))

let stubbedModelResponse: Record<string, unknown> = {}

function baseModelResponse(overrides: Record<string, unknown> = {}) {
  return {
    clientName: null,
    partnerName: null,
    eventDate: null,
    guestCount: null,
    eventType: null,
    budgetRange: null,
    questions: [],
    intentions: [],
    sentiment: 'neutral',
    stressSignals: [],
    excitementSignals: [],
    mentionedVendors: [],
    specialRequests: [],
    painPoints: [],
    objectionSignals: [],
    communicationStyle: null,
    keyPriorities: [],
    followUpNeeded: false,
    guestCountMin: null,
    guestCountMax: null,
    searchStage: null,
    venuesTouring: [],
    decisionTimeline: null,
    contactRelationship: null,
    handles: null,
    ...overrides,
  }
}

import { extractSignals, coerceStringList, EXTRACTION_PROMPT_VERSION } from '../extraction'

describe('coerceStringList', () => {
  it('passes a clean array through, trimmed', () => {
    expect(coerceStringList(["  we're having a groom's cake ", 'sparklers at the send-off'])).toEqual([
      "we're having a groom's cake",
      'sparklers at the send-off',
    ])
  })

  it('a missing field is an empty list, not undefined', () => {
    expect(coerceStringList(undefined)).toEqual([])
    expect(coerceStringList(null)).toEqual([])
  })

  it('a bare string becomes a one-item list', () => {
    expect(coerceStringList("we're having a groom's cake")).toEqual([
      "we're having a groom's cake",
    ])
  })

  it('drops blanks and non-strings rather than storing them', () => {
    // A blank entry would become an empty row on the coordinator's queue.
    expect(coerceStringList(['', '   ', 42, null, { x: 1 }, 'real one'])).toEqual(['real one'])
  })

  it('a non-list, non-string is an empty list', () => {
    expect(coerceStringList(42)).toEqual([])
    expect(coerceStringList({ intentions: 'cake' })).toEqual([])
  })
})

describe('extractSignals — intentions', () => {
  it('carries stated plans through to the caller', async () => {
    stubbedModelResponse = baseModelResponse({
      intentions: ["We're having a groom's cake", 'My uncle is officiating'],
      questions: ['Do you allow sparklers?'],
    })

    const signals = await extractSignals('venue-1', 'some email body that is long enough')

    expect(signals.intentions).toEqual([
      "We're having a groom's cake",
      'My uncle is officiating',
    ])
    // Intentions and questions stay separate. That distinction is the
    // whole point of the field: a question needs an answer, an intention
    // needs an event on the day.
    expect(signals.questions).toEqual(['Do you allow sparklers?'])
  })

  it('a model that omits intentions still returns an array', async () => {
    const withoutIntentions = baseModelResponse()
    delete (withoutIntentions as Record<string, unknown>).intentions
    stubbedModelResponse = withoutIntentions

    const signals = await extractSignals('venue-1', 'some email body that is long enough')

    expect(Array.isArray(signals.intentions)).toBe(true)
    expect(signals.intentions).toEqual([])
  })

  it('a model that returns a bare string wraps it', async () => {
    stubbedModelResponse = baseModelResponse({
      intentions: "We're having a groom's cake",
    })

    const signals = await extractSignals('venue-1', 'some email body that is long enough')

    expect(signals.intentions).toEqual(["We're having a groom's cake"])
  })

  it('coerces every list field, not only the new one', async () => {
    const broken = baseModelResponse()
    for (const field of [
      'questions',
      'intentions',
      'stressSignals',
      'excitementSignals',
      'mentionedVendors',
      'specialRequests',
      'painPoints',
      'objectionSignals',
      'keyPriorities',
      'venuesTouring',
    ]) {
      delete (broken as Record<string, unknown>)[field]
    }
    stubbedModelResponse = broken

    const signals = await extractSignals('venue-1', 'some email body that is long enough')

    expect(signals.questions).toEqual([])
    expect(signals.intentions).toEqual([])
    expect(signals.stressSignals).toEqual([])
    expect(signals.excitementSignals).toEqual([])
    expect(signals.mentionedVendors).toEqual([])
    expect(signals.specialRequests).toEqual([])
    expect(signals.painPoints).toEqual([])
    expect(signals.objectionSignals).toEqual([])
    expect(signals.keyPriorities).toEqual([])
    expect(signals.venuesTouring).toEqual([])
  })

  it('the prompt version was bumped for the new field', () => {
    // Adding a field to the schema changes what the model is asked for,
    // so api_costs.prompt_version has to be able to tell the two apart.
    expect(EXTRACTION_PROMPT_VERSION).toBe('extraction.prompt.v1.2')
  })
})
