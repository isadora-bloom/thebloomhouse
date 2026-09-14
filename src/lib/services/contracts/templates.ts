/**
 * The contract a venue sends, and the figures it is built from.
 *
 * One template per venue, editable at /settings/contract-template. It is
 * stored inside `venue_config.feature_flags` under the `contract_template`
 * key, which is where every other per-venue settings blob in this repo
 * already lives (see src/lib/services/couple-portal-config.ts for the
 * read-merge-write convention the settings pages follow). A venue that has
 * never opened the settings page gets DEFAULT_CONTRACT_TEMPLATE, so there
 * is no such thing as a venue with no contract.
 *
 * The template is a title, an opening paragraph, a list of clauses and a
 * closing paragraph, all plain text with {{tokens}} in it. It is not HTML
 * and it is not markdown: the venue is typing terms, not authoring a web
 * page, and letting HTML through would put an injection surface into an
 * email and a public page for no gain.
 *
 * Clause copy is deliberately plain. "If you cancel" rather than
 * "in the event of cancellation by the Client". A couple should be able to
 * read their own contract once and know what they agreed to.
 *
 * Everything in this file is pure. No database, no React, no network, no
 * model in the loop. The figures arrive as a snapshot the caller has
 * already read, which is also what gets frozen into
 * `contracts.generated_from`.
 */

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

/**
 * What a contract is rendered from. Frozen at generation time into
 * `contracts.generated_from`, because the wedding's guest count and
 * balance move and a contract that has been sent must not.
 *
 * Money is in integer cents throughout, matching weddings.booking_value
 * and friends. Nulls are real: a booked wedding can genuinely have no
 * deposit recorded, and the render says so rather than printing a zero
 * that nobody agreed to.
 */
export interface ContractPackageSnapshot {
  /** The venue, as the couple knows it. */
  venueName: string
  coordinatorName: string | null
  coordinatorEmail: string | null
  coordinatorPhone: string | null
  /** ISO 4217, from venue_config.currency. Defaults to USD upstream. */
  currency: string

  /** "Chloe and Ryan", assembled from the people rows. */
  coupleNames: string
  /** ISO date (YYYY-MM-DD) or null when the date is not fixed yet. */
  weddingDate: string | null
  eventCode: string | null
  guestCount: number | null

  packageName: string | null
  totalCents: number | null
  depositCents: number | null
  paidCents: number | null
  taxCents: number | null
  gratuityCents: number | null

  /** From wedding_details, migration 390. All optional. */
  checkIn: string | null
  checkOut: string | null
  weddingHours: string | null
  rehearsalHours: string | null
  maxWeddingGuests: number | null
  maxRehearsalGuests: number | null
  overnights: number | null

  /** ISO instant the snapshot was taken. */
  generatedAt: string
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/**
 * Where the venue's template lives inside `venue_config.feature_flags`.
 *
 * Spelled once, here, in the file with no server imports in it, so the
 * settings page and the contract builder can share the constant without
 * the browser bundle pulling in a service-role client.
 */
export const TEMPLATE_FLAG_KEY = 'contract_template'

export interface ContractClause {
  heading: string
  body: string
}

export interface ContractTemplate {
  /** Stored on the row as template_key. */
  key: string
  title: string
  intro: string
  clauses: ContractClause[]
  closing: string
  /** The line above the name box on the signing page. */
  signaturePrompt: string
}

/**
 * The template every venue starts with. Plain language on purpose: each
 * clause says what happens, to whom, and when, in the words a couple
 * would use themselves.
 *
 * The money clauses read their figures from the snapshot rather than
 * naming amounts in prose, so a venue editing the wording cannot
 * accidentally leave last season's price in the paragraph.
 */
export const DEFAULT_CONTRACT_TEMPLATE: ContractTemplate = {
  key: 'standard',
  title: 'Wedding agreement',
  intro:
    'This is the agreement between {{couple_names}} and {{venue_name}} for a wedding on {{wedding_date}}. ' +
    'It sets out what we are holding for you, what it costs, and what happens if anything changes. ' +
    'If any part of it does not match what you were told, tell us before you sign and we will fix it.',
  clauses: [
    {
      heading: 'What you have booked',
      body:
        'Package: {{package_name}}.\n' +
        'Date: {{wedding_date}}.\n' +
        'Guests: up to {{guest_count}}.\n' +
        'On the day you have the venue from {{check_in}} until {{check_out}}, with {{wedding_hours}} of event time.\n' +
        'Your reference for this booking is {{event_code}}.',
    },
    {
      heading: 'What it costs',
      body:
        'Total: {{total}}.\n' +
        'Deposit to hold the date: {{deposit}}.\n' +
        'Paid so far: {{paid}}.\n' +
        'Still to pay: {{balance}}.\n' +
        'The balance is due 30 days before the wedding. We will remind you; you do not need to keep track of it yourself.',
    },
    {
      heading: 'Holding your date',
      body:
        'Your date is held for you from the moment the deposit clears. ' +
        'We will not offer it to anyone else while this agreement stands. ' +
        'The deposit comes off your total, it is not an extra charge.',
    },
    {
      heading: 'If you cancel',
      body:
        'Tell us as early as you can and we will do what we can. ' +
        'The deposit is not refundable, because the date came off the calendar the day you booked it. ' +
        'Anything you have paid beyond the deposit is refunded in full if you cancel more than 180 days before the wedding, ' +
        'and half of it is refunded between 180 and 90 days. Inside 90 days we cannot refund payments already made.',
    },
    {
      heading: 'If we cannot host',
      body:
        'If something on our side stops the wedding going ahead, we refund everything you have paid, including the deposit, ' +
        'and we help you find somewhere else. That is the whole of what we owe you in that situation.',
    },
    {
      heading: 'If the guest count changes',
      body:
        'Small changes are normal and cost nothing. ' +
        'Going above {{guest_count}} guests needs to be agreed with us first, because of the room and the fire limit, ' +
        'and may change the price. Going below does not reduce the total.',
    },
    {
      heading: 'The day itself',
      body:
        'Your suppliers can get in from {{check_in}}. Everything and everyone needs to be out by {{check_out}}. ' +
        'You are responsible for your guests and your suppliers while they are here, including any damage. ' +
        'We keep the right to stop the music or end the event early if anyone is unsafe.',
    },
    {
      heading: 'Rehearsal',
      body:
        'Your rehearsal time is {{rehearsal_hours}}, for up to {{max_rehearsal}} people, ' +
        'on a date we agree closer to the wedding. Overnight stays included: {{overnights}}.',
    },
    {
      heading: 'Photos',
      body:
        'We may use photographs of the venue on the day in our own marketing. ' +
        'If you would rather we did not, say so in writing and we will not. No reason needed.',
    },
    {
      heading: 'Changes to this agreement',
      body:
        'Any change to this agreement needs to be in writing and agreed by both of us. ' +
        'A conversation, a phone call or a text is not enough on its own, only because ' +
        'neither of us will remember it accurately a year later.',
    },
  ],
  closing:
    'Questions go to {{coordinator_name}} at {{coordinator_email}}{{coordinator_phone_suffix}}. ' +
    'Prepared on {{generated_on}}.',
  signaturePrompt:
    'Type your full name below to agree to this. We will email you a copy.',
}

// ---------------------------------------------------------------------------
// Reading a stored template back
// ---------------------------------------------------------------------------

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback
}

/**
 * Read the venue's stored template out of `feature_flags.contract_template`.
 *
 * Defensive on purpose: the blob is edited by a settings page and shares a
 * column with a dozen other sub-objects, so half a template, an empty
 * clause list, or a clause that is a number all have to degrade to the
 * default rather than render a broken contract. A venue that has saved
 * nothing gets the default and never knows this function ran.
 */
export function parseContractTemplate(raw: unknown): ContractTemplate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return DEFAULT_CONTRACT_TEMPLATE
  }
  const r = raw as Record<string, unknown>

  const clauses: ContractClause[] = Array.isArray(r.clauses)
    ? r.clauses
        .filter(
          (c): c is Record<string, unknown> =>
            typeof c === 'object' && c !== null && !Array.isArray(c),
        )
        .map((c) => ({
          heading: str(c.heading, '').trim(),
          body: str(c.body, '').trim(),
        }))
        .filter((c) => c.heading !== '' || c.body !== '')
    : []

  return {
    key: str(r.key, DEFAULT_CONTRACT_TEMPLATE.key),
    title: str(r.title, DEFAULT_CONTRACT_TEMPLATE.title),
    intro: str(r.intro, DEFAULT_CONTRACT_TEMPLATE.intro),
    clauses: clauses.length > 0 ? clauses : DEFAULT_CONTRACT_TEMPLATE.clauses,
    closing: str(r.closing, DEFAULT_CONTRACT_TEMPLATE.closing),
    signaturePrompt: str(
      r.signaturePrompt,
      DEFAULT_CONTRACT_TEMPLATE.signaturePrompt,
    ),
  }
}

// ---------------------------------------------------------------------------
// Formatting the figures
// ---------------------------------------------------------------------------

/** The stand-in for a figure the venue has not recorded. Never a zero. */
export const UNKNOWN_VALUE = 'to be confirmed'

/**
 * Cents to a currency string, in the venue's own currency. Null comes back
 * as the stand-in rather than as "$0.00", which would be a different and
 * much worse claim.
 */
export function formatMoney(cents: number | null | undefined, currency: string): string {
  if (cents == null || !Number.isFinite(cents)) return UNKNOWN_VALUE
  const amount = cents / 100
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)
  } catch {
    // An unrecognised currency code should not lose the number.
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** ISO date to "Saturday, 12 June 2027". */
export function formatContractDate(iso: string | null | undefined): string {
  if (!iso) return UNKNOWN_VALUE
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return UNKNOWN_VALUE
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * What is left to pay. Null when the total is unknown, because a balance
 * computed off a missing total is a guess with a dollar sign on it.
 */
export function balanceCents(s: ContractPackageSnapshot): number | null {
  if (s.totalCents == null || !Number.isFinite(s.totalCents)) return null
  const paid = Number.isFinite(s.paidCents ?? NaN) ? (s.paidCents as number) : 0
  return Math.max(0, s.totalCents - paid)
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * The tokens a venue may use in their template. Listed so the settings
 * page can show them and so an unknown one can be told apart from a
 * known-but-empty one.
 */
export const CONTRACT_TOKENS = [
  'couple_names',
  'venue_name',
  'wedding_date',
  'event_code',
  'guest_count',
  'package_name',
  'total',
  'deposit',
  'paid',
  'balance',
  'check_in',
  'check_out',
  'wedding_hours',
  'rehearsal_hours',
  'max_wedding',
  'max_rehearsal',
  'overnights',
  'coordinator_name',
  'coordinator_email',
  'coordinator_phone',
  'coordinator_phone_suffix',
  'generated_on',
] as const

export type ContractToken = (typeof CONTRACT_TOKENS)[number]

function num(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? UNKNOWN_VALUE : String(v)
}

function text(v: string | null | undefined): string {
  const t = v?.trim()
  return t ? t : UNKNOWN_VALUE
}

/** Build the token table for one snapshot. */
export function tokenValues(
  s: ContractPackageSnapshot,
): Record<ContractToken, string> {
  const phone = s.coordinatorPhone?.trim()
  return {
    couple_names: text(s.coupleNames),
    venue_name: text(s.venueName),
    wedding_date: formatContractDate(s.weddingDate),
    event_code: text(s.eventCode),
    guest_count: num(s.guestCount),
    package_name: text(s.packageName),
    total: formatMoney(s.totalCents, s.currency),
    deposit: formatMoney(s.depositCents, s.currency),
    paid: formatMoney(s.paidCents, s.currency),
    balance: formatMoney(balanceCents(s), s.currency),
    check_in: text(s.checkIn),
    check_out: text(s.checkOut),
    wedding_hours: text(s.weddingHours),
    rehearsal_hours: text(s.rehearsalHours),
    max_wedding: num(s.maxWeddingGuests),
    max_rehearsal: num(s.maxRehearsalGuests),
    overnights: num(s.overnights),
    coordinator_name: text(s.coordinatorName),
    coordinator_email: text(s.coordinatorEmail),
    coordinator_phone: text(s.coordinatorPhone),
    // Lets the closing line read "at x@y.com, or on 555 1234." without a
    // dangling "or on to be confirmed" when there is no phone number.
    coordinator_phone_suffix: phone ? `, or on ${phone}` : '',
    generated_on: formatContractDate(s.generatedAt.slice(0, 10)),
  }
}

const TOKEN_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g

/**
 * Substitute tokens in one string.
 *
 * A known token with nothing behind it renders "to be confirmed". An
 * UNKNOWN token is left exactly as it was typed, braces and all, so a
 * venue who writes {{deposti}} sees their typo in the preview instead of
 * a silently vanished clause.
 */
export function fillTokens(
  input: string,
  values: Record<string, string>,
): string {
  return input.replace(TOKEN_PATTERN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole,
  )
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderedSection {
  heading: string
  /** Already token-filled, one entry per line of the body. */
  lines: string[]
}

export interface RenderedContract {
  title: string
  /** Intro paragraph, token-filled. */
  intro: string
  sections: RenderedSection[]
  closing: string
  signaturePrompt: string
}

/** Fill the whole template. The one place a snapshot becomes a document. */
export function renderContract(
  template: ContractTemplate,
  snapshot: ContractPackageSnapshot,
): RenderedContract {
  const values = tokenValues(snapshot)
  return {
    title: fillTokens(template.title, values),
    intro: fillTokens(template.intro, values),
    sections: template.clauses.map((c, i) => ({
      heading: `${i + 1}. ${fillTokens(c.heading, values)}`,
      lines: fillTokens(c.body, values).split('\n').map((l) => l.trimEnd()),
    })),
    closing: fillTokens(template.closing, values),
    signaturePrompt: fillTokens(template.signaturePrompt, values),
  }
}

/** Escape for HTML. Templates are plain text, so everything is escaped. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The document as HTML, for the signing page and the preview. Inline
 * styles only: this same markup is what a couple sees on a page with no
 * stylesheet of the venue's, and email clients strip stylesheets anyway.
 */
export function renderContractHtml(doc: RenderedContract): string {
  const sections = doc.sections
    .map(
      (s) =>
        `<section style="margin:0 0 22px;">` +
        `<h3 style="margin:0 0 6px;font-size:15px;font-weight:600;color:#2D2D2D;">${escapeHtml(s.heading)}</h3>` +
        s.lines
          .filter((l) => l.trim() !== '')
          .map(
            (l) =>
              `<p style="margin:0 0 6px;font-size:14px;line-height:1.6;color:#3F3F46;">${escapeHtml(l)}</p>`,
          )
          .join('') +
        `</section>`,
    )
    .join('')

  return (
    `<article style="font-family:Georgia,'Times New Roman',serif;max-width:680px;">` +
    `<h2 style="margin:0 0 14px;font-size:22px;font-weight:600;color:#2D2D2D;">${escapeHtml(doc.title)}</h2>` +
    `<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#3F3F46;">${escapeHtml(doc.intro)}</p>` +
    sections +
    `<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6B7280;">${escapeHtml(doc.closing)}</p>` +
    `</article>`
  )
}

/**
 * The document as plain text. Two jobs: it is the PDF's content, and it
 * goes into `contracts.extracted_text` so the search on both contract
 * surfaces and the assistant's contract library find a generated contract
 * the same way they find an uploaded one.
 */
export function renderContractText(doc: RenderedContract): string {
  const out: string[] = [doc.title, '', doc.intro, '']
  for (const s of doc.sections) {
    out.push(s.heading)
    for (const line of s.lines) out.push(line)
    out.push('')
  }
  out.push(doc.closing)
  return out.join('\n')
}
