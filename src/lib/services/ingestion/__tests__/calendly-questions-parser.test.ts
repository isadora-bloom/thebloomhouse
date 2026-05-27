/**
 * Tests for the Calendly custom-questions parser.
 *
 * Fixtures are pulled from real Rixey production examples surfaced
 * 2026-05-27 by Isadora's Gmail inspection:
 *   - Glascow/Minette  → source = "Google"
 *   - Jennifer Nguyen  → source = "The Knot" (booked Calendly directly)
 *   - Erin B           → source = "Google"
 *
 * Edge cases: multi-paragraph answers, HTML entities, missing block,
 * unknown source value.
 */
import { describe, it, expect } from 'vitest'
import {
  parseCalendlyQuestions,
  getCalendlyPartnerName,
  getCalendlyPartnerEmail,
  getCalendlyPhone,
  getCalendlyEventDate,
  getCalendlyGuestCount,
  getCalendlySource,
  getCalendlySourceRaw,
  getCalendlyPackageInterest,
  getCalendlyBuiltCalculator,
  extractCalendlyQuestions,
} from '../calendly-questions-parser'

// ---------------------------------------------------------------------------
// Fixtures — match the operator-verified shape of Calendly's actual HTML
// ---------------------------------------------------------------------------

const GLASCOW_HTML = `
<html><body>
<h1>A new event has been scheduled</h1>

<strong>Invitee:</strong>
<p>Glascow Tennille</p>

<strong>Invitee Email:</strong>
<p>Gtennilledpt@gmail.com</p>

<strong>Event Date/Time:</strong>
<p>11:30am - Saturday, June 1, 2026 (Eastern Time - US &amp; Canada)</p>

<strong>Questions:</strong>

<strong>Partners First and Last Name</strong>
<p>Glascow Tennille</p>

<strong>Partners Email</strong>
<p>Gtennilledpt@gmail.com</p>

<strong>Phone number</strong>
<p>2409170257</p>

<strong>Approximate date</strong>
<p>August 15th 2027</p>

<strong>Number of guests</strong>
<p>150-200</p>

<strong>Where did you first hear about us?</strong>
<p>Google</p>

<strong>Which package or packages are you interested in?</strong>
<p>One Day Weekend</p>

<strong>Have you built a package on our pricing calculator?</strong>
<p>Yes</p>

</body></html>
`

const JENNIFER_NGUYEN_HTML = `
<strong>Invitee:</strong>
<p>Jennifer Nguyen</p>

<strong>Questions:</strong>

<strong>Phone number</strong>
<p>(555) 234-5678</p>

<strong>Where did you first hear about us?</strong>
<p>The Knot</p>

<strong>Number of guests</strong>
<p>120</p>
`

const ERIN_B_HTML = `
<strong>Where did you first hear about us?</strong>
<p>Google</p>
`

// ---------------------------------------------------------------------------
// parseCalendlyQuestions
// ---------------------------------------------------------------------------

describe('parseCalendlyQuestions', () => {
  it('extracts all six Rixey questions from the Glascow fixture', () => {
    const qs = parseCalendlyQuestions(GLASCOW_HTML)
    expect(qs).toMatchObject({
      'partners first and last name': 'Glascow Tennille',
      'partners email': 'Gtennilledpt@gmail.com',
      'phone number': '2409170257',
      'approximate date': 'August 15th 2027',
      'number of guests': '150-200',
      'where did you first hear about us': 'Google',
      'which package or packages are you interested in': 'One Day Weekend',
      'have you built a package on our pricing calculator': 'Yes',
    })
  })

  it('decodes HTML entities in answers', () => {
    const html = `
<strong>Where did you first hear about us?</strong>
<p>Google &amp; The Knot</p>
`
    const qs = parseCalendlyQuestions(html)
    expect(qs['where did you first hear about us']).toBe('Google & The Knot')
  })

  it('joins multi-paragraph answers with a single space', () => {
    const html = `
<strong>Notes</strong>
<p>First paragraph.</p>
<p>Second paragraph.</p>
`
    const qs = parseCalendlyQuestions(html)
    expect(qs.notes).toBe('First paragraph. Second paragraph.')
  })

  it('returns {} when no Questions block is present', () => {
    expect(parseCalendlyQuestions('<p>just a plain email body</p>')).toEqual({})
    expect(parseCalendlyQuestions('')).toEqual({})
    expect(parseCalendlyQuestions(null)).toEqual({})
    expect(parseCalendlyQuestions(undefined)).toEqual({})
  })

  it('parses plain-text fallback when no <strong> tags are present', () => {
    const text = `Questions:

Where did you first hear about us?
Google

Number of guests
120
`
    const qs = parseCalendlyQuestions(text)
    expect(qs['where did you first hear about us']).toBe('Google')
    expect(qs['number of guests']).toBe('120')
  })

  it('never throws on malformed input', () => {
    expect(() => parseCalendlyQuestions('<strong>broken')).not.toThrow()
    expect(() => parseCalendlyQuestions('<strong></strong><p></p>')).not.toThrow()
    expect(() => parseCalendlyQuestions('<<><><<<><>')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Typed accessors — Glascow happy path
// ---------------------------------------------------------------------------

describe('typed accessors against Glascow fixture', () => {
  const qs = parseCalendlyQuestions(GLASCOW_HTML)

  it('extracts partner name', () => {
    expect(getCalendlyPartnerName(qs)).toBe('Glascow Tennille')
  })

  it('extracts partner email lowercased', () => {
    expect(getCalendlyPartnerEmail(qs)).toBe('gtennilledpt@gmail.com')
  })

  it('extracts phone digits only', () => {
    expect(getCalendlyPhone(qs)).toBe('2409170257')
  })

  it('parses "August 15th 2027" into ISO yyyy-mm-dd', () => {
    expect(getCalendlyEventDate(qs)).toBe('2027-08-15')
  })

  it('computes guest midpoint from "150-200"', () => {
    expect(getCalendlyGuestCount(qs)).toBe(175)
  })

  it('canonicalizes Google to "google"', () => {
    expect(getCalendlySource(qs)).toBe('google')
  })

  it('preserves the literal source answer', () => {
    expect(getCalendlySourceRaw(qs)).toBe('Google')
  })

  it('extracts package interest', () => {
    expect(getCalendlyPackageInterest(qs)).toBe('One Day Weekend')
  })

  it('parses "Yes" as built-calculator true', () => {
    expect(getCalendlyBuiltCalculator(qs)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Source canonicalization — three real cases
// ---------------------------------------------------------------------------

describe('source canonicalization', () => {
  it('Jennifer Nguyen "The Knot" → the_knot', () => {
    const qs = parseCalendlyQuestions(JENNIFER_NGUYEN_HTML)
    expect(getCalendlySource(qs)).toBe('the_knot')
    expect(getCalendlySourceRaw(qs)).toBe('The Knot')
  })

  it('Erin B "Google" → google', () => {
    const qs = parseCalendlyQuestions(ERIN_B_HTML)
    expect(getCalendlySource(qs)).toBe('google')
  })

  it('handles "Instagram"', () => {
    const html = `<strong>Where did you first hear about us?</strong><p>Instagram</p>`
    expect(getCalendlySource(parseCalendlyQuestions(html))).toBe('instagram')
  })

  it('handles "Pinterest"', () => {
    const html = `<strong>Where did you first hear about us?</strong><p>Pinterest</p>`
    expect(getCalendlySource(parseCalendlyQuestions(html))).toBe('pinterest')
  })

  it('handles "WeddingWire"', () => {
    const html = `<strong>How did you hear about us?</strong><p>WeddingWire</p>`
    expect(getCalendlySource(parseCalendlyQuestions(html))).toBe('wedding_wire')
  })

  it('treats "a friend" as referral', () => {
    const html = `<strong>Where did you first hear about us?</strong><p>a friend recommended you</p>`
    expect(getCalendlySource(parseCalendlyQuestions(html))).toBe('referral')
  })

  it('returns "other" for unknown free-text', () => {
    const html = `<strong>Where did you first hear about us?</strong><p>drove by once</p>`
    // "drove by" → walk_in, so use a truly unknown:
    const html2 = `<strong>Where did you first hear about us?</strong><p>my cousin</p>`
    expect(getCalendlySource(parseCalendlyQuestions(html2))).toBe('other')
    // Drove by IS in the table → walk_in
    expect(getCalendlySource(parseCalendlyQuestions(html))).toBe('walk_in')
  })

  it('returns null when there is no source question at all', () => {
    const html = `<strong>Phone</strong><p>5551234</p>`
    expect(getCalendlySource(parseCalendlyQuestions(html))).toBeNull()
  })

  it('supports the reworded "How did you find us?"', () => {
    const html = `<strong>How did you find us?</strong><p>Google</p>`
    expect(getCalendlySource(parseCalendlyQuestions(html))).toBe('google')
  })
})

// ---------------------------------------------------------------------------
// Guest count + date edge cases
// ---------------------------------------------------------------------------

describe('guest count parser', () => {
  it('parses single integer', () => {
    const html = `<strong>Number of guests</strong><p>120</p>`
    expect(getCalendlyGuestCount(parseCalendlyQuestions(html))).toBe(120)
  })

  it('parses "80-100" → midpoint', () => {
    const html = `<strong>Number of guests</strong><p>80-100</p>`
    expect(getCalendlyGuestCount(parseCalendlyQuestions(html))).toBe(90)
  })

  it('parses "approximately 150 guests" → 150', () => {
    const html = `<strong>Number of guests</strong><p>approximately 150 guests</p>`
    expect(getCalendlyGuestCount(parseCalendlyQuestions(html))).toBe(150)
  })
})

describe('event date parser', () => {
  it('parses ISO date verbatim', () => {
    const html = `<strong>Approximate date</strong><p>2027-08-15</p>`
    expect(getCalendlyEventDate(parseCalendlyQuestions(html))).toBe('2027-08-15')
  })

  it('parses "August 15, 2027" → ISO', () => {
    const html = `<strong>Approximate date</strong><p>August 15, 2027</p>`
    expect(getCalendlyEventDate(parseCalendlyQuestions(html))).toBe('2027-08-15')
  })

  it('returns the raw string when unparseable', () => {
    const html = `<strong>Approximate date</strong><p>tbd later</p>`
    expect(getCalendlyEventDate(parseCalendlyQuestions(html))).toBe('tbd later')
  })
})

// ---------------------------------------------------------------------------
// One-shot bundle
// ---------------------------------------------------------------------------

describe('extractCalendlyQuestions', () => {
  it('returns null when the body has no Questions block', () => {
    expect(extractCalendlyQuestions('<p>plain</p>')).toBeNull()
    expect(extractCalendlyQuestions('')).toBeNull()
  })

  it('returns the full bundle for the Glascow fixture', () => {
    const bundle = extractCalendlyQuestions(GLASCOW_HTML)
    expect(bundle).not.toBeNull()
    if (!bundle) return
    expect(bundle.source).toBe('google')
    expect(bundle.sourceLiteral).toBe('Google')
    expect(bundle.partnerName).toBe('Glascow Tennille')
    expect(bundle.partnerEmail).toBe('gtennilledpt@gmail.com')
    expect(bundle.phone).toBe('2409170257')
    expect(bundle.eventDate).toBe('2027-08-15')
    expect(bundle.guestCount).toBe(175)
    expect(bundle.packageInterest).toBe('One Day Weekend')
    expect(bundle.builtCalculator).toBe(true)
  })
})
