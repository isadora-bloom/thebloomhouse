/**
 * Rendering a contract from one fixture package.
 *
 * The fixture is a realistic booked wedding: a package, a total, a part
 * payment, and two of the seven wedding_details fields left empty, because
 * that is what a real row looks like. The tests that matter are the ones
 * about the empty ones: a figure nobody recorded must never print as a
 * zero on a document somebody is about to sign.
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CONTRACT_TEMPLATE,
  UNKNOWN_VALUE,
  balanceCents,
  escapeHtml,
  fillTokens,
  formatContractDate,
  formatMoney,
  parseContractTemplate,
  renderContract,
  renderContractHtml,
  renderContractText,
  tokenValues,
  type ContractPackageSnapshot,
} from '../templates'

const FIXTURE: ContractPackageSnapshot = {
  venueName: 'Crestwood Farm',
  coordinatorName: 'Sarah Chen',
  coordinatorEmail: 'sarah@crestwood.test',
  coordinatorPhone: '540 555 0142',
  currency: 'USD',

  coupleNames: 'Chloe Barnes and Ryan Okafor',
  weddingDate: '2027-06-12',
  eventCode: 'CW-2706-12',
  guestCount: 120,

  packageName: 'Saturday Full Weekend',
  totalCents: 1_850_000,
  depositCents: 500_000,
  paidCents: 500_000,
  taxCents: null,
  gratuityCents: null,

  checkIn: '10:00am on the Friday',
  checkOut: '11:00am on the Sunday',
  weddingHours: '8 hours',
  rehearsalHours: '2 hours',
  maxWeddingGuests: 150,
  maxRehearsalGuests: null,
  overnights: null,

  generatedAt: '2026-09-14T10:30:00Z',
}

describe('formatMoney', () => {
  it('formats a round total without trailing cents', () => {
    expect(formatMoney(1_850_000, 'USD')).toBe('$18,500')
  })

  it('keeps the cents when there are any', () => {
    expect(formatMoney(1_850_050, 'USD')).toBe('$18,500.50')
  })

  it('honours the venue currency', () => {
    expect(formatMoney(1_000_000, 'GBP')).toContain('10,000')
  })

  it('never turns a missing figure into a zero', () => {
    expect(formatMoney(null, 'USD')).toBe(UNKNOWN_VALUE)
    expect(formatMoney(undefined, 'USD')).toBe(UNKNOWN_VALUE)
    expect(formatMoney(Number.NaN, 'USD')).toBe(UNKNOWN_VALUE)
  })

  it('keeps the number when the currency code is unknown', () => {
    // A well-formed but unassigned code still formats, with the code as
    // the symbol. Nothing is lost.
    expect(formatMoney(150_000, 'ZZZ')).toContain('1,500')
  })

  it('keeps the number when the currency code is malformed', () => {
    // Anything that is not three letters makes Intl throw. The fallback
    // prints the amount and the code rather than losing the figure.
    expect(formatMoney(150_000, 'X')).toBe('1500.00 X')
  })
})

describe('balanceCents', () => {
  it('is the total less what has been paid', () => {
    expect(balanceCents(FIXTURE)).toBe(1_350_000)
  })

  it('treats no recorded payment as nothing paid', () => {
    expect(balanceCents({ ...FIXTURE, paidCents: null })).toBe(1_850_000)
  })

  it('is unknown when the total is unknown, not zero', () => {
    expect(balanceCents({ ...FIXTURE, totalCents: null })).toBeNull()
  })

  it('never goes negative when they have overpaid', () => {
    expect(balanceCents({ ...FIXTURE, paidCents: 2_000_000 })).toBe(0)
  })
})

describe('formatContractDate', () => {
  it('writes a date a couple can read', () => {
    expect(formatContractDate('2027-06-12')).toBe('Saturday, 12 June 2027')
  })

  it('says so when there is no date', () => {
    expect(formatContractDate(null)).toBe(UNKNOWN_VALUE)
    expect(formatContractDate('not a date')).toBe(UNKNOWN_VALUE)
  })
})

describe('tokenValues', () => {
  it('fills every figure the fixture has', () => {
    const v = tokenValues(FIXTURE)
    expect(v.couple_names).toBe('Chloe Barnes and Ryan Okafor')
    expect(v.venue_name).toBe('Crestwood Farm')
    expect(v.package_name).toBe('Saturday Full Weekend')
    expect(v.total).toBe('$18,500')
    expect(v.deposit).toBe('$5,000')
    expect(v.balance).toBe('$13,500')
    expect(v.guest_count).toBe('120')
    expect(v.event_code).toBe('CW-2706-12')
  })

  it('marks the fields nobody has filled in', () => {
    const v = tokenValues(FIXTURE)
    expect(v.max_rehearsal).toBe(UNKNOWN_VALUE)
    expect(v.overnights).toBe(UNKNOWN_VALUE)
  })

  it('drops the phone clause entirely when there is no phone', () => {
    const withPhone = tokenValues(FIXTURE)
    expect(withPhone.coordinator_phone_suffix).toBe(', or on 540 555 0142')
    const without = tokenValues({ ...FIXTURE, coordinatorPhone: null })
    expect(without.coordinator_phone_suffix).toBe('')
  })
})

describe('fillTokens', () => {
  const values = tokenValues(FIXTURE)

  it('substitutes a known token', () => {
    expect(fillTokens('Hello {{couple_names}}.', values)).toBe(
      'Hello Chloe Barnes and Ryan Okafor.',
    )
  })

  it('tolerates whitespace inside the braces', () => {
    expect(fillTokens('{{ venue_name }}', values)).toBe('Crestwood Farm')
  })

  it('leaves an unknown token visible so a typo is obvious', () => {
    expect(fillTokens('Deposit: {{deposti}}', values)).toBe('Deposit: {{deposti}}')
  })
})

describe('renderContract', () => {
  const doc = renderContract(DEFAULT_CONTRACT_TEMPLATE, FIXTURE)

  it('numbers the clauses', () => {
    expect(doc.sections[0].heading).toBe('1. What you have booked')
    expect(doc.sections[1].heading).toBe('2. What it costs')
  })

  it('puts the real figures on the page', () => {
    const money = doc.sections[1].lines.join('\n')
    expect(money).toContain('$18,500')
    expect(money).toContain('$5,000')
    expect(money).toContain('$13,500')
  })

  it('leaves no unfilled token anywhere in the document', () => {
    const whole = renderContractText(doc)
    expect(whole).not.toMatch(/\{\{/)
  })

  it('names the couple and the venue in the opening paragraph', () => {
    expect(doc.intro).toContain('Chloe Barnes and Ryan Okafor')
    expect(doc.intro).toContain('Crestwood Farm')
    expect(doc.intro).toContain('Saturday, 12 June 2027')
  })

  it('says "to be confirmed" where the venue recorded nothing', () => {
    const rehearsal = doc.sections.find((s) => s.heading.includes('Rehearsal'))
    expect(rehearsal?.lines.join(' ')).toContain(UNKNOWN_VALUE)
  })
})

describe('renderContractHtml', () => {
  const doc = renderContract(DEFAULT_CONTRACT_TEMPLATE, FIXTURE)

  it('escapes what the venue typed', () => {
    const nasty = renderContract(
      {
        ...DEFAULT_CONTRACT_TEMPLATE,
        clauses: [{ heading: '<script>alert(1)</script>', body: 'a & b' }],
      },
      FIXTURE,
    )
    const html = renderContractHtml(nasty)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a &amp; b')
  })

  it('escapes a figure that arrived from the database', () => {
    const doctored = renderContract(DEFAULT_CONTRACT_TEMPLATE, {
      ...FIXTURE,
      coupleNames: '<img src=x onerror=alert(1)>',
    })
    expect(renderContractHtml(doctored)).not.toContain('<img')
  })

  it('carries the title and every clause', () => {
    const html = renderContractHtml(doc)
    expect(html).toContain('Wedding agreement')
    for (const section of doc.sections) {
      expect(html).toContain(escapeHtml(section.heading))
    }
  })
})

describe('parseContractTemplate', () => {
  it('falls back to the standard wording when nothing is stored', () => {
    expect(parseContractTemplate(undefined)).toEqual(DEFAULT_CONTRACT_TEMPLATE)
    expect(parseContractTemplate(null)).toEqual(DEFAULT_CONTRACT_TEMPLATE)
    expect(parseContractTemplate('a string')).toEqual(DEFAULT_CONTRACT_TEMPLATE)
    expect(parseContractTemplate([])).toEqual(DEFAULT_CONTRACT_TEMPLATE)
  })

  it('keeps what the venue saved', () => {
    const saved = parseContractTemplate({
      key: 'elopement',
      title: 'Elopement agreement',
      clauses: [{ heading: 'The day', body: 'Two of you, one hour.' }],
    })
    expect(saved.key).toBe('elopement')
    expect(saved.title).toBe('Elopement agreement')
    expect(saved.clauses).toHaveLength(1)
    // The boxes they did not touch keep the standard wording.
    expect(saved.intro).toBe(DEFAULT_CONTRACT_TEMPLATE.intro)
  })

  it('refuses an empty clause list rather than sending a bare contract', () => {
    expect(parseContractTemplate({ clauses: [] }).clauses).toEqual(
      DEFAULT_CONTRACT_TEMPLATE.clauses,
    )
  })

  it('drops rubbish inside the clause list without losing the rest', () => {
    const parsed = parseContractTemplate({
      clauses: [
        'not a clause',
        42,
        null,
        { heading: 'Real', body: 'Kept.' },
        { heading: '', body: '' },
      ],
    })
    expect(parsed.clauses).toEqual([{ heading: 'Real', body: 'Kept.' }])
  })
})
