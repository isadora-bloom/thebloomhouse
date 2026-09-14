/**
 * S4a / 2026-09-14 ingestion audit item 1.
 *
 * `parseShapeHeuristic` used to fire on ANY sender whose body carried two
 * labelled lines, and it handed the pipeline a reply target read straight
 * out of that body. These tests pin the gate: an anonymous sender cannot
 * produce a form-relay lead, and no parser hands back a body-derived
 * reply target from an untrusted envelope.
 */

import { describe, it, expect } from 'vitest'
import { detectFormRelay, isKnownRelayDomain } from '../form-relay-parsers'

const VENUE_OWN = new Set(['info@ourvenue.com', 'hello@ourvenue.com'])

/** Two labelled fields plus a body-supplied address — the exact shape. */
const LABELLED_BODY = [
  'Hi there,',
  '',
  'Wedding date: 6/6/2027',
  'Guest count: 120',
  'Personal email: attacker-chosen@example.net',
  '',
  'Thanks!',
].join('\n')

describe('form-relay shape heuristic — envelope gate (audit item 1)', () => {
  it('produces NO lead for an anonymous sender with two labelled lines', () => {
    const lead = detectFormRelay(
      {
        from: 'Some Person <random-stranger@gmail.com>',
        to: 'info@ourvenue.com',
        subject: 'hello',
        body: LABELLED_BODY,
      },
      VENUE_OWN,
    )
    expect(lead).toBeNull()
  })

  it('produces no lead even when the sender spoofs a plausible display name', () => {
    const lead = detectFormRelay(
      {
        from: '"Our Venue Website Form" <noreply@totally-unrelated.io>',
        to: 'info@ourvenue.com',
        subject: 'New enquiry',
        body: LABELLED_BODY,
      },
      VENUE_OWN,
    )
    expect(lead).toBeNull()
  })

  it('still fires for the venue-own form notifier, and replies to the envelope', () => {
    const lead = detectFormRelay(
      {
        from: 'Website <hello@ourvenue.com>',
        to: 'info@ourvenue.com',
        subject: 'New enquiry from the website',
        body: LABELLED_BODY,
      },
      VENUE_OWN,
    )
    expect(lead).not.toBeNull()
    // The prospect's address is still the identity key...
    expect(lead!.leadEmail).toBe('attacker-chosen@example.net')
    // ...but never the reply target.
    expect(lead!.replyToEmail).toBe('hello@ourvenue.com')
    expect(lead!.replyToSource).toBe('envelope')
    expect(lead!.envelopeTrusted).toBe(true)
  })

  it('fires for a known form-provider domain', () => {
    const lead = detectFormRelay(
      {
        from: 'forms@jotform.com',
        to: 'info@ourvenue.com',
        subject: 'Form submission',
        body: LABELLED_BODY,
      },
      VENUE_OWN,
    )
    expect(lead).not.toBeNull()
    expect(lead!.replyToEmail).toBe('forms@jotform.com')
  })

  it('never lets the shape heuristic skip the classifier', () => {
    const lead = detectFormRelay(
      {
        from: 'Website <hello@ourvenue.com>',
        to: 'info@ourvenue.com',
        subject: 'New enquiry',
        body: LABELLED_BODY,
      },
      VENUE_OWN,
    )
    expect(lead!.classifierSkipAllowed).toBe(false)
  })
})

describe('form-relay parsers — reply-target provenance (audit item 1)', () => {
  it('flags a Knot body-signature hit from an unknown envelope as body-derived', () => {
    const lead = detectFormRelay(
      {
        from: 'Forged Sender <someone@mail.example>',
        to: 'info@ourvenue.com',
        subject: 'Reminder',
        body: [
          'The Knot Pro Network',
          '',
          'The Knot inbox: abc.venue@member.theknot.com',
          'Personal email: attacker-chosen@example.net',
          'Wedding date: 6/6/2027',
        ].join('\n'),
      },
      VENUE_OWN,
    )
    expect(lead).not.toBeNull()
    expect(lead!.replyToSource).toBe('body')
    // envelopeTrusted false is what makes the pipeline refuse to route
    // the reply at the body address.
    expect(lead!.envelopeTrusted).toBe(false)
    expect(lead!.classifierSkipAllowed).toBe(false)
  })

  it('trusts the same body when it really did come from The Knot', () => {
    const lead = detectFormRelay(
      {
        from: 'The Knot <leads@theknot.com>',
        to: 'info@ourvenue.com',
        subject: 'New lead',
        body: [
          'The Knot Pro Network',
          '',
          'The Knot inbox: abc.venue@member.theknot.com',
          'Personal email: real.couple@example.net',
          'Wedding date: 6/6/2027',
        ].join('\n'),
      },
      VENUE_OWN,
    )
    expect(lead).not.toBeNull()
    expect(lead!.envelopeTrusted).toBe(true)
    expect(lead!.replyToEmail).toBe('real.couple@example.net')
  })
})

describe('isKnownRelayDomain', () => {
  it('matches the domain and its subdomains, not a lookalike', () => {
    expect(isKnownRelayDomain('lead@theknot.com')).toBe(true)
    expect(isKnownRelayDomain('x@abc.member.theknot.com')).toBe(true)
    expect(isKnownRelayDomain('x@theknot.com.evil.net')).toBe(false)
    expect(isKnownRelayDomain('x@nottheknot.com')).toBe(false)
    expect(isKnownRelayDomain('')).toBe(false)
    expect(isKnownRelayDomain(null)).toBe(false)
  })
})
