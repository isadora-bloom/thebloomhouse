/**
 * Unit tests for the Knot per-prospect personId extractor.
 *
 * Pins the regex contract that the identity-cascade stage 1b and the
 * email-pipeline draft-suppression gate both depend on (2026-05-27,
 * Tara Simpson operator-reported flood).
 */

import { describe, it, expect } from 'vitest'
import {
  extractKnotPersonId,
  knotPersonIdsFromEmails,
} from '../knot-sender-id'

describe('extractKnotPersonId', () => {
  it('extracts the trailing personId from a standard Knot relay', () => {
    expect(
      extractKnotPersonId('tara.simpson.2.772357@member.theknot.com'),
    ).toBe('772357')
  })

  it('extracts the personId from the reminder variant', () => {
    expect(
      extractKnotPersonId('tara.simpson.2.772357.reminder@member.theknot.com'),
    ).toBe('772357')
  })

  it('is case-insensitive (uppercase domain + name)', () => {
    expect(
      extractKnotPersonId('Tara.Simpson.2.772357@MEMBER.THEKNOT.COM'),
    ).toBe('772357')
  })

  it('handles hyphenated last names', () => {
    expect(
      extractKnotPersonId('mary-jane.olsen-smith.1.555@member.theknot.com'),
    ).toBe('555')
  })

  it('returns null for the shared bareword theknot relay', () => {
    expect(extractKnotPersonId('noreply@theknot.com')).toBeNull()
    expect(extractKnotPersonId('leads@theknot.com')).toBeNull()
  })

  it('returns null for non-Knot real email addresses', () => {
    expect(extractKnotPersonId('tim@bloggs.com')).toBeNull()
    expect(extractKnotPersonId('sarah@gmail.com')).toBeNull()
  })

  it('returns null for malformed Knot localparts (missing personId)', () => {
    expect(extractKnotPersonId('tara.simpson@member.theknot.com')).toBeNull()
    expect(extractKnotPersonId('@member.theknot.com')).toBeNull()
  })

  it('returns null for garbage strings', () => {
    expect(extractKnotPersonId('')).toBeNull()
    expect(extractKnotPersonId('not an email')).toBeNull()
    expect(extractKnotPersonId('@@@')).toBeNull()
    expect(extractKnotPersonId(null)).toBeNull()
    expect(extractKnotPersonId(undefined)).toBeNull()
  })

  it('refuses subdomain variants that aren\'t the canonical member relay', () => {
    // Defends against a future "members.theknot.com" / "test.theknot.com"
    // shape that we don't have a stable per-prospect contract for.
    expect(
      extractKnotPersonId('tara.simpson.2.772357@members.theknot.com'),
    ).toBeNull()
    expect(
      extractKnotPersonId('tara.simpson.2.772357@theknot.com'),
    ).toBeNull()
  })
})

describe('cascade integration — stage 1b (knot_person_id_match)', () => {
  it('matches a reminder variant to a candidate whose alias_emails holds the initial Knot relay', async () => {
    const { cascadeMatch } = await import('../identity-cascade')
    const res = cascadeMatch(
      {
        primaryEmail: 'tara.simpson.2.772357.reminder@member.theknot.com',
      },
      [
        {
          coupleId: 'c-tara',
          weddingDate: null,
          people: [
            {
              firstName: 'Tara',
              lastName: 'Simpson',
              email: 'tara.simpson.2.772357@member.theknot.com',
              phone: null,
            },
          ],
        },
      ],
    )
    expect(res.matched).toBe(true)
    if (res.matched) {
      expect(res.stage).toBe('knot_person_id_match')
      expect(res.coupleId).toBe('c-tara')
    }
  })

  it('matches when the initial Knot address was folded into alias_emails post-merge', async () => {
    const { cascadeMatch } = await import('../identity-cascade')
    const res = cascadeMatch(
      {
        primaryEmail: 'tara.simpson.2.772357.reminder@member.theknot.com',
      },
      [
        {
          coupleId: 'c-tara',
          weddingDate: null,
          people: [
            {
              firstName: 'Tara',
              lastName: 'Simpson',
              email: 'tara@gmail.com', // post-merge canonical real address
              phone: null,
              aliasEmails: ['tara.simpson.2.772357@member.theknot.com'],
            },
          ],
        },
      ],
    )
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('knot_person_id_match')
  })

  it('does not fire when signal is not a Knot relay', async () => {
    const { cascadeMatch } = await import('../identity-cascade')
    const res = cascadeMatch(
      { primaryEmail: 'tara@gmail.com' },
      [
        {
          coupleId: 'c-tara',
          weddingDate: null,
          people: [
            {
              firstName: 'Other',
              lastName: 'Person',
              email: 'tara.simpson.2.772357@member.theknot.com',
              phone: null,
            },
          ],
        },
      ],
    )
    // The signal's email is non-Knot so stage 1b cannot fire. Stage 1
    // (exact_email) also cannot fire because the candidate's email is a
    // Knot relay and they differ. The signal carries no first/last
    // name, so no name stages match either. Result: no match.
    expect(res.matched).toBe(false)
  })

  it('does not fire stage 1b when personIds differ', async () => {
    const { cascadeMatch } = await import('../identity-cascade')
    const res = cascadeMatch(
      { primaryEmail: 'tara.simpson.2.772357@member.theknot.com' },
      [
        {
          coupleId: 'c-other',
          weddingDate: null,
          people: [
            {
              firstName: 'Lauren',
              lastName: 'Airey',
              email: 'lauren.airey.1.999999@member.theknot.com',
              phone: null,
            },
          ],
        },
      ],
    )
    // Different personIds + different names + different Knot localparts.
    // Stage 1b cannot fire (personIds differ); stage 5 (email-localpart
    // logical name) cannot fire (tara.simpson vs lauren.airey are not
    // logically equivalent); no name stages match because signal has no
    // first/last name. Cascade falls through to matched:false.
    expect(res.matched).toBe(false)
  })
})

describe('knotPersonIdsFromEmails', () => {
  it('collects every distinct Knot personId from a mixed list', () => {
    const ids = knotPersonIdsFromEmails([
      'tara.simpson.2.772357@member.theknot.com',
      'tara.simpson.2.772357.reminder@member.theknot.com',
      'tara@gmail.com',
      null,
      undefined,
    ])
    expect(ids.size).toBe(1)
    expect(ids.has('772357')).toBe(true)
  })

  it('returns an empty set when no Knot relays are present', () => {
    const ids = knotPersonIdsFromEmails([
      'tara@gmail.com',
      'someone@yahoo.com',
      null,
    ])
    expect(ids.size).toBe(0)
  })

  it('handles two distinct prospects on the same list', () => {
    const ids = knotPersonIdsFromEmails([
      'tara.simpson.2.772357@member.theknot.com',
      'lauren.airey.1.888@member.theknot.com',
    ])
    expect(ids.size).toBe(2)
    expect(ids.has('772357')).toBe(true)
    expect(ids.has('888')).toBe(true)
  })
})
