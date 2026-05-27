/**
 * Unit tests for the Knot visitor-activity CSV parser.
 *
 * Pins the contract migration 377 + knot-visitor-match.ts both depend
 * on (action classification, date parsing, name splitting, and the
 * row_fingerprint shape that makes re-uploads idempotent).
 */

import { describe, it, expect } from 'vitest'
import {
  classifyKnotAction,
  parseKnotDate,
  parseVisitorName,
  computeRowFingerprint,
  parseKnotVisitorActivityCsv,
} from '../knot-visitor-activity'

describe('classifyKnotAction', () => {
  it('maps Storefront View to storefront_view', () => {
    expect(classifyKnotAction('Storefront View')).toBe('storefront_view')
  })
  it('maps Storefront Save to storefront_save', () => {
    expect(classifyKnotAction('Storefront Save')).toBe('storefront_save')
  })
  it('maps Message to message', () => {
    expect(classifyKnotAction('Message')).toBe('message')
  })
  it('maps Click to Website to click_to_website (not collapsed to bare click)', () => {
    expect(classifyKnotAction('Click to Website')).toBe('click_to_website')
  })
  it('maps Click to Social to click_to_social (not collapsed to bare click)', () => {
    expect(classifyKnotAction('Click to Social')).toBe('click_to_social')
  })
  it('falls back to click_to_website for bare Click', () => {
    expect(classifyKnotAction('Click')).toBe('click_to_website')
  })
  it('lands unknown verbs as other', () => {
    expect(classifyKnotAction('Reviewed')).toBe('other')
  })
  it('returns null for empty input so the caller can skip the row', () => {
    expect(classifyKnotAction('')).toBe(null)
    expect(classifyKnotAction(null)).toBe(null)
    expect(classifyKnotAction(undefined)).toBe(null)
  })
  it('is case-insensitive', () => {
    expect(classifyKnotAction('MESSAGE')).toBe('message')
    expect(classifyKnotAction('storefront save')).toBe('storefront_save')
  })
})

describe('parseKnotDate', () => {
  it('parses MM/DD/YYYY (Knot default)', () => {
    const iso = parseKnotDate('04/15/2026')
    expect(iso).not.toBeNull()
    expect(iso!.slice(0, 4)).toBe('2026')
  })
  it('parses "Mon DD, YYYY" (US long form)', () => {
    const iso = parseKnotDate('Apr 15, 2026')
    expect(iso).not.toBeNull()
    expect(iso!.slice(0, 4)).toBe('2026')
  })
  it('rejects fuzzy values', () => {
    expect(parseKnotDate('TBD')).toBeNull()
    expect(parseKnotDate('n/a')).toBeNull()
  })
  it('rejects years outside 2000-2100 (off-by-100 guard)', () => {
    expect(parseKnotDate('0024-04-15')).toBeNull()
  })
  it('returns null for empty / null input', () => {
    expect(parseKnotDate('')).toBeNull()
    expect(parseKnotDate(null)).toBeNull()
  })
})

describe('parseVisitorName', () => {
  it('splits "Doug L." → first=Doug, last_initial=L', () => {
    expect(parseVisitorName('Doug L.')).toEqual({
      first_name: 'Doug',
      last_initial: 'L',
      raw: 'Doug L.',
    })
  })
  it('handles bare first name (no last initial)', () => {
    expect(parseVisitorName('Doug')).toEqual({
      first_name: 'Doug',
      last_initial: null,
      raw: 'Doug',
    })
  })
  it('uppercases the last initial', () => {
    expect(parseVisitorName('Sarah r.')).toEqual({
      first_name: 'Sarah',
      last_initial: 'R',
      raw: 'Sarah r.',
    })
  })
  it('strips punctuation from a single-letter last "L."', () => {
    expect(parseVisitorName('Doug L.').last_initial).toBe('L')
  })
  it('returns nulls for empty input', () => {
    expect(parseVisitorName('')).toEqual({
      first_name: null,
      last_initial: null,
      raw: null,
    })
  })
  it('preserves raw for multi-word edge cases', () => {
    // Some Knot rows have a middle initial: "Mary J P." — we take the
    // first token as the first name and the LAST token's first letter
    // as the initial.
    const parsed = parseVisitorName('Mary J P.')
    expect(parsed.first_name).toBe('Mary')
    expect(parsed.last_initial).toBe('P')
  })
})

describe('computeRowFingerprint', () => {
  it('produces the same hash for the same inputs (idempotency)', () => {
    const a = computeRowFingerprint({
      venueId: 'v-1',
      visitorName: 'Doug L.',
      actionTaken: 'message',
      actionAtIso: '2026-04-15T00:00:00.000Z',
      city: 'Fairfax',
      state: 'VA',
    })
    const b = computeRowFingerprint({
      venueId: 'v-1',
      visitorName: 'Doug L.',
      actionTaken: 'message',
      actionAtIso: '2026-04-15T00:00:00.000Z',
      city: 'Fairfax',
      state: 'VA',
    })
    expect(a).toBe(b)
  })
  it('is venue-scoped (same row in two venues hashes differently)', () => {
    const a = computeRowFingerprint({
      venueId: 'v-1',
      visitorName: 'Doug L.',
      actionTaken: 'message',
      actionAtIso: '2026-04-15T00:00:00.000Z',
      city: null,
      state: null,
    })
    const b = computeRowFingerprint({
      venueId: 'v-2',
      visitorName: 'Doug L.',
      actionTaken: 'message',
      actionAtIso: '2026-04-15T00:00:00.000Z',
      city: null,
      state: null,
    })
    expect(a).not.toBe(b)
  })
  it('is case-insensitive on city/state but stable on case of name', () => {
    const a = computeRowFingerprint({
      venueId: 'v-1',
      visitorName: 'Doug L.',
      actionTaken: 'message',
      actionAtIso: '2026-04-15T00:00:00.000Z',
      city: 'Fairfax',
      state: 'VA',
    })
    const b = computeRowFingerprint({
      venueId: 'v-1',
      visitorName: 'Doug L.',
      actionTaken: 'message',
      actionAtIso: '2026-04-15T00:00:00.000Z',
      city: 'fairfax',
      state: 'va',
    })
    expect(a).toBe(b)
  })
  it('hashes return 64-char hex (sha256)', () => {
    const h = computeRowFingerprint({
      venueId: 'v-1',
      visitorName: 'Doug L.',
      actionTaken: 'message',
      actionAtIso: '2026-04-15T00:00:00.000Z',
      city: null,
      state: null,
    })
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('parseKnotVisitorActivityCsv', () => {
  const SAMPLE = [
    'Action Taken,Visitor Name,Date of Visit,City,State',
    'Storefront View,Doug L.,04/15/2026,Fairfax,VA',
    'Message,Doug L.,04/16/2026,Fairfax,VA',
    'Storefront Save,Jayden P.,04/17/2026,Reston,VA',
    'Click to Website,"Sarah, Lou",04/18/2026,DC,DC',
  ].join('\n')

  it('parses every recognised row', () => {
    const res = parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: SAMPLE })
    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(4)
    expect(res.rows[0]!.action_taken).toBe('storefront_view')
    expect(res.rows[1]!.action_taken).toBe('message')
    expect(res.rows[2]!.action_taken).toBe('storefront_save')
    expect(res.rows[3]!.action_taken).toBe('click_to_website')
  })

  it('handles quoted fields with embedded commas in the visitor name', () => {
    const res = parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: SAMPLE })
    const sarah = res.rows.find((r) => r.visitor_name.includes('Sarah'))
    expect(sarah).toBeDefined()
    expect(sarah!.visitor_name).toBe('Sarah, Lou')
  })

  it('flags the Doug L. canary case as a parseable row (operator instruction 2026-05-27)', () => {
    const res = parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: SAMPLE })
    const doug = res.rows.filter((r) => r.visitor_first_name === 'Doug')
    expect(doug.length).toBe(2)
    expect(doug.every((r) => r.visitor_last_initial === 'L')).toBe(true)
  })

  it('skips in-file duplicates (same row twice)', () => {
    const dup = [
      'Action Taken,Visitor Name,Date of Visit,City,State',
      'Storefront View,Doug L.,04/15/2026,Fairfax,VA',
      'Storefront View,Doug L.,04/15/2026,Fairfax,VA',
    ].join('\n')
    const res = parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: dup })
    expect(res.rows).toHaveLength(1)
    expect(res.warnings.some((w) => w.includes('in-file duplicate'))).toBe(true)
  })

  it('rejects empty CSVs', () => {
    expect(parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: '' }).ok).toBe(false)
    expect(
      parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: '\n' }).ok,
    ).toBe(false)
  })

  it('rejects CSVs missing required columns', () => {
    const noAction = 'Visitor Name,Date of Visit\nDoug L.,04/15/2026'
    const res = parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: noAction })
    expect(res.ok).toBe(false)
    expect(res.errors[0]).toMatch(/missing required column/i)
  })

  it('parses with no city/state columns (optional)', () => {
    const minimal = [
      'Action Taken,Visitor Name,Date of Visit',
      'Message,Doug L.,04/15/2026',
    ].join('\n')
    const res = parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: minimal })
    expect(res.ok).toBe(true)
    expect(res.rows[0]!.city).toBeNull()
    expect(res.rows[0]!.state).toBeNull()
  })

  it('warns about rows with unparseable dates rather than aborting the batch', () => {
    const bad = [
      'Action Taken,Visitor Name,Date of Visit',
      'Message,Doug L.,not-a-date',
      'Message,Sarah R.,04/15/2026',
    ].join('\n')
    const res = parseKnotVisitorActivityCsv({ venueId: 'v-1', csvText: bad })
    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(1)
    expect(res.warnings.some((w) => w.includes('parse Date of Visit'))).toBe(true)
  })
})
