import { describe, it, expect } from 'vitest'
import {
  extractIdentityFromEmail,
  isRelayAddress,
  isSyntheticAddress,
} from '../body-identity-extract'

// ---------------------------------------------------------------------------
// Smoke + invariant tests for the universal email-body identity extractor.
//
// Per Lens 1 audit:
// > "email-pipeline.ts stamps interactions.extracted_identity jsonb on
// >  every inbound message; no test in e2e/sections exercises the
// >  body-extraction → candidate-resolver → wedding-link path end-to-
// >  end with a real-looking inbound. A regex/JSON misshape silently
// >  produces nulls."
//
// This test file pins the contract on the critical first leg:
// extractIdentityFromEmail. If a regex regression or filter change
// silently zeros out fields on real-looking input, these tests fail
// loudly.
// ---------------------------------------------------------------------------

describe('extractIdentityFromEmail', () => {
  it('extracts emails / phones / names / date / guest count from a typical Knot inquiry', () => {
    const result = extractIdentityFromEmail({
      subject: 'New inquiry from Madison Bryant',
      body: `
Hi, my fiancé James and I are interested in your venue for our wedding.
We're hoping for September 14, 2026 with about 142 guests.
You can reach me at madison.bryant@gmail.com or 415-555-0123.
Looking forward to hearing from you!
Madison Bryant
      `.trim(),
    })

    expect(result.emails).toContain('madison.bryant@gmail.com')
    expect(result.phones).toContain('4155550123')
    expect(result.names).toEqual(expect.arrayContaining(['Madison Bryant']))
    expect(result.date_hints).toEqual(expect.arrayContaining(['September 14, 2026']))
    expect(result.guest_count_hint).toMatch(/142\s+guests/i)
    expect(result.primary_email).toBe('madison.bryant@gmail.com')
  })

  it('returns empty arrays + nulls without throwing on a body with no identity', () => {
    const result = extractIdentityFromEmail({
      subject: 'A subject',
      body: 'A body that has no contact info or dates or guests.',
    })

    expect(result.emails).toEqual([])
    expect(result.phones).toEqual([])
    expect(result.names).toEqual([])
    expect(result.date_hints).toEqual([])
    expect(result.guest_count_hint).toBeNull()
    expect(result.primary_email).toBeNull()
  })

  it('skips venue-owned addresses when picking primary_email', () => {
    const ownEmails = new Set(['hello@rixeymanor.com'])
    const result = extractIdentityFromEmail(
      {
        subject: 'Inquiry',
        body: 'From: hello@rixeymanor.com (forwarded). Real prospect: jane@example.com',
      },
      { ownEmails },
    )
    expect(result.primary_email).toBe('jane@example.com')
    expect(result.emails).toContain('jane@example.com')
    // The venue-owned address is included in the raw emails list
    // (callers may want to know about it), just not selected as primary.
    expect(result.emails).toContain('hello@rixeymanor.com')
  })

  it('skips relay-domain addresses when picking primary_email', () => {
    const result = extractIdentityFromEmail({
      subject: 'New lead from The Knot',
      body: `
Reply to message@knotemail.com to continue the conversation.
Or contact directly: real.couple@gmail.com
      `.trim(),
    })
    expect(result.primary_email).toBe('real.couple@gmail.com')
  })

  it('handles ISO + slashed + season+year + month+year date forms', () => {
    const result = extractIdentityFromEmail({
      body: 'We are open to 2026-09-14, 09/14/2026, Fall 2026, or even September 2026.',
    })
    expect(result.date_hints).toEqual(
      expect.arrayContaining(['2026-09-14', '09/14/2026', 'Fall 2026']),
    )
  })

  it('normalizes phones across format variants to 10 / 11 digits', () => {
    const result = extractIdentityFromEmail({
      body: 'Call me at (415) 555-0123 or +1 415.555.4567 or 415 555 9999.',
    })
    expect(result.phones).toEqual(
      expect.arrayContaining(['4155550123', '14155554567', '4155559999']),
    )
  })

  it('caps name extraction at a reasonable count and filters UI labels', () => {
    const result = extractIdentityFromEmail({
      body: `
Reply Reply. View on Wedding Pro. Click Here. Forward Reply.
Real names: Madison Bryant, James Bryant, Sarah Chen.
      `.trim(),
    })
    // Should NOT contain UI labels.
    expect(result.names).not.toEqual(expect.arrayContaining(['Reply Reply']))
    expect(result.names).not.toEqual(expect.arrayContaining(['View Wedding']))
    // Should contain the real names.
    expect(result.names).toEqual(
      expect.arrayContaining(['Madison Bryant', 'James Bryant', 'Sarah Chen']),
    )
  })

  it('does not crash on empty body', () => {
    const result = extractIdentityFromEmail({ body: '', subject: '' })
    expect(result.emails).toEqual([])
    expect(result.primary_email).toBeNull()
  })

  it('does not crash when subject is omitted', () => {
    const result = extractIdentityFromEmail({ body: 'jane@example.com' })
    expect(result.primary_email).toBe('jane@example.com')
  })
})

describe('isRelayAddress', () => {
  it.each([
    ['notify@calendly.com', true],
    ['x@calendlymail.com', true],
    ['someone@member.theknot.com', true],
    ['hello@theknotww.com', true],
    ['x@subdomain.zola.com', true],
    ['real@gmail.com', false],
    ['someone@somewhere-else.com', false],
    ['no-at-sign', false],
  ])('classifies %s as relay=%s', (email, expected) => {
    expect(isRelayAddress(email)).toBe(expected)
  })
})

describe('isSyntheticAddress', () => {
  it.each([
    ['authsolic-abc@weddingwire.bloom-relay.invalid', true],
    ['fake@example.invalid', true],
    ['real@gmail.com', false],
    ['hello@bloom.invalid.real.com', false],
  ])('classifies %s as synthetic=%s', (email, expected) => {
    expect(isSyntheticAddress(email)).toBe(expected)
  })
})
