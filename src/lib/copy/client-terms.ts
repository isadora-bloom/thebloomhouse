/**
 * Client words for internal terms.
 *
 * The spine, the readers in `src/lib/intel/canonical.ts` and the database
 * all speak the vocabulary of the people who built them: touchpoint,
 * lifecycle state, heat, first-touch, cascade, decay, cohort. A venue
 * owner or coordinator uses none of those words and should never have to
 * learn them to run their week.
 *
 * WHEN TO USE THIS MODULE
 *
 *   Use it on every surface a venue owner or coordinator opens as part of
 *   the job: `/today`, the inbox, lead lists, couple pages, digest email
 *   bodies, notification titles, empty states, tooltips. If the reader is
 *   someone who books weddings, translate.
 *
 *   Do NOT use it on engineering surfaces: `/admin/**`, `/super-admin/**`,
 *   the identity audits, the canonical reader endpoints under
 *   `/api/admin/intel/canonical/**`. Those are read by people who need the
 *   exact internal term, and translating there makes debugging slower.
 *
 *   Do NOT translate anything that is not on a screen. Column names, API
 *   field names, log lines, error strings and event types stay internal.
 *   Only the words a person reads change. `lifecycle_state` remains
 *   `lifecycle_state` on the wire; it reads as "in conversation" in the UI.
 *
 * HOUSE RULES THIS ENCODES
 *
 *   1. A state is described as a situation, not a status code. "Gone
 *      quiet", not "ghost".
 *   2. A number never appears alone. `sampleNote()` gives it its sample
 *      size, and `honestNumber()` swaps the number for a reason when the
 *      reader says there is not enough behind it.
 *   3. Nothing is framed as the coordinator's failure. "Not enough to say
 *      yet" counts up towards a threshold; it does not scold.
 */

// ─────────────────────────────────────────────────────────────────────
// The mapping
// ─────────────────────────────────────────────────────────────────────

/**
 * Internal term (lower case, as it appears in code, columns or docs) →
 * the words a venue coordinator uses. Keys are matched case-insensitively
 * and with `_`, `-` and spaces treated as the same separator, so
 * `heat_score`, `heat-score` and `Heat Score` all resolve.
 */
export const CLIENT_TERMS: Readonly<Record<string, string>> = {
  // — the record itself —
  touchpoint: 'message',
  touchpoints: 'messages',
  interaction: 'message',
  interactions: 'messages',
  spine: 'record',
  'spine row': 'record',
  cascade: 'matching',
  'cascade stage': 'how we matched it',
  'cascade reason': 'why we matched it',
  ribbon: 'history',
  progression: 'moving forward',
  'progression event': 'step forward',
  'signal tier': 'how strong the signal is',
  'intent class': 'what they asked about',
  'lifecycle folder': 'which list they sit in',
  folder: 'list',

  // — where a couple stands —
  'lifecycle state': 'where they are with you',
  lifecycle: 'where they are with you',
  channel_scoped: 'new enquiry',
  resolved: 'in conversation',
  booked: 'booked',
  completed: 'wedding done',
  ghost: 'gone quiet',
  agent: 'not a couple',

  // — interest —
  heat: 'interest',
  'heat score': 'interest',
  'heat tier': 'how interested they look',
  'heat bucket': 'how interested they look',
  hot: 'very interested',
  warm: 'interested',
  cool: 'quiet',
  frozen: 'gone quiet',
  'high intent': 'looks ready to book',

  // — where they came from —
  attribution: 'where bookings come from',
  'first touch': 'where they found you',
  first_touch: 'where they found you',
  'last touch': 'their most recent step',
  last_touch: 'their most recent step',
  linear: 'credit shared across every step',
  time_decay: 'credit weighted towards recent steps',
  channel: 'where they found you',
  'discovery source': 'where they found you',

  // — going quiet —
  decay: 'going quiet',
  'decay window': 'how long before we call it quiet',
  'decay sweep': 'the quiet check',
  'going cold': 'going quiet',
  'ghost risk': 'likely to go quiet',

  // — analysis —
  cohort: 'group of couples',
  funnel: 'the path from enquiry to booking',
  'conversion curve': 'how the booking rate changes',
  conversion: 'how many go on to book',
  knee: 'the point where it drops off',
  cac: 'cost per booking',
  'revenue per dollar': 'return on what you spend',
  'lead time': 'how far ahead they enquire',
  'response time': 'how fast you reply',
  distribution: 'the spread',
  'sample size': 'how many this is based on',
  n: 'how many this is based on',
  enoughdata: 'enough to say',
  nlq: 'ask a question',
  'natural language query': 'ask a question',
  operator: 'coordinator',
  'operator axis': 'by coordinator',
  venue_id: 'venue',
  'merged into': 'joined up with',
}

/** Normalise a term for lookup: lower case, separators flattened. */
function normaliseTerm(term: string): string {
  return term.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

/**
 * Translate one internal term. Falls back to the term unchanged, so an
 * unmapped word degrades to the internal wording rather than to an empty
 * string. Add a mapping rather than special-casing at the call site.
 */
export function clientTerm(internal: string | null | undefined): string {
  if (!internal) return ''
  const key = normaliseTerm(internal)
  return CLIENT_TERMS[key] ?? internal
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────

/** The six `couples.lifecycle_state` values, in the order a coordinator
 *  thinks about them: newest first, finished last. */
export const LIFECYCLE_ORDER = [
  'channel_scoped',
  'resolved',
  'booked',
  'completed',
  'ghost',
  'agent',
] as const

export type LifecycleKey = (typeof LIFECYCLE_ORDER)[number]

const LIFECYCLE_LABEL: Record<LifecycleKey, string> = {
  channel_scoped: 'new enquiry',
  resolved: 'in conversation',
  booked: 'booked',
  completed: 'wedding done',
  ghost: 'gone quiet',
  agent: 'not a couple',
}

/** Plural form for a count sentence: "12 couples in conversation". */
const LIFECYCLE_PHRASE: Record<LifecycleKey, string> = {
  channel_scoped: 'new enquiries',
  resolved: 'in conversation',
  booked: 'booked',
  completed: 'weddings done',
  ghost: 'gone quiet',
  agent: 'not couples',
}

/** One lifecycle value as words. Unknown values pass through `clientTerm`. */
export function lifecycleLabel(state: string | null | undefined): string {
  if (!state) return 'not placed yet'
  const key = normaliseTerm(state).replace(/ /g, '_') as LifecycleKey
  return LIFECYCLE_LABEL[key] ?? clientTerm(state)
}

/** A lifecycle count as a phrase: `lifecycleCount('resolved', 12)` →
 *  "12 in conversation". Used to build the one-sentence briefing. */
export function lifecycleCount(state: string, n: number): string {
  const key = normaliseTerm(state).replace(/ /g, '_') as LifecycleKey
  return `${n} ${LIFECYCLE_PHRASE[key] ?? clientTerm(state)}`
}

// ─────────────────────────────────────────────────────────────────────
// Honest numbers
// ─────────────────────────────────────────────────────────────────────

/** The honesty primitive from the canonical readers, restated locally so
 *  this module has no import from the intel layer. Structurally identical
 *  to `Distribution` in `src/lib/intel/canonical.ts`. */
export interface HonestValue {
  value: number | null
  n: number
  enoughData: boolean
  reason?: 'insufficient_sample' | 'no_data' | 'zero_denominator' | string
}

const REASON_COPY: Record<string, string> = {
  insufficient_sample: 'not enough to say yet',
  no_data: 'nothing recorded yet',
  zero_denominator: 'nothing to measure against yet',
}

/** Plain-English version of a `Distribution.reason`. Always returns
 *  something; an unmapped reason falls back to the house phrase. */
export function notEnoughReason(reason?: string | null): string {
  if (!reason) return 'not enough to say yet'
  return REASON_COPY[reason] ?? 'not enough to say yet'
}

export interface HonestNumberResult {
  /** What to put where the number goes. Either the formatted number or
   *  the reason there isn't one. Never an empty string, never a fake 0. */
  text: string
  /** True when `text` is a real measured number. */
  isNumber: boolean
  /** "based on 12 couples", or '' when n is 0. */
  sample: string
}

/**
 * The rule from INTEL-CANONICAL-API.md §3, in one call: show the number
 * with its sample size, or show why there isn't a number. Never a bare
 * figure, never a 0 standing in for "we don't know".
 *
 *   honestNumber({ value: 0.42, n: 312, enoughData: true },
 *                { format: v => `${Math.round(v * 100)}%`, noun: 'couple' })
 *     → { text: '42%', isNumber: true, sample: 'based on 312 couples' }
 *
 *   honestNumber({ value: null, n: 0, enoughData: false, reason: 'no_data' })
 *     → { text: 'nothing recorded yet', isNumber: false, sample: '' }
 */
export function honestNumber(
  d: HonestValue,
  opts: { format?: (v: number) => string; noun?: string } = {},
): HonestNumberResult {
  const format = opts.format ?? ((v: number) => String(v))
  const noun = opts.noun ?? 'couple'
  if (d.value === null || !d.enoughData) {
    return { text: notEnoughReason(d.reason), isNumber: false, sample: sampleNote(d.n, noun) }
  }
  return { text: format(d.value), isNumber: true, sample: sampleNote(d.n, noun) }
}

/** "based on 12 couples". Empty string at n = 0, because "based on 0
 *  couples" reads as a bug rather than as honesty. */
export function sampleNote(n: number, noun = 'couple'): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return `based on ${n} ${pluralise(n, noun)}`
}

/** Naive English pluralisation, good enough for the nouns this app uses
 *  (couple, message, tour, enquiry, day, week). Pass `plural` for
 *  anything irregular. */
export function pluralise(n: number, singular: string, plural?: string): string {
  if (n === 1) return singular
  if (plural) return plural
  if (/(s|x|z|ch|sh)$/.test(singular)) return `${singular}es`
  if (/[^aeiou]y$/.test(singular)) return `${singular.slice(0, -1)}ies`
  return `${singular}s`
}

/** "1 couple" / "4 couples". */
export function countPhrase(n: number, singular: string, plural?: string): string {
  return `${n} ${pluralise(n, singular, plural)}`
}

// ─────────────────────────────────────────────────────────────────────
// Plain-English time
// ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

/** Whole days between two instants, floored. Negative when `iso` is in
 *  the future. Returns null for anything unparseable. */
export function daysBetween(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.floor((now - t) / DAY_MS)
}

/**
 * How long ago, said the way a person says it. "today", "yesterday",
 * "3 days ago", "2 weeks ago", "5 months ago". Null when the timestamp
 * is missing or unreadable, so callers can drop the clause rather than
 * print "unknown".
 */
export function agoPhrase(iso: string | null | undefined, now: number = Date.now()): string | null {
  const days = daysBetween(iso, now)
  if (days === null) return null
  if (days < 0) return null
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.round(days / 7)} weeks ago`
  return `${Math.round(days / 30)} months ago`
}

/**
 * Every date and time below is rendered in a NAMED timezone, never in the
 * server's. A Vercel function runs in UTC, so `new Date(iso).getHours()`
 * on a server component would tell a Virginia coordinator that their 8pm
 * Friday tour is on Saturday. Pass the venue's `venues.timezone`.
 *
 * The wording is built from the tables below rather than handed to
 * `toLocaleDateString`, because ICU changes its mind across Node versions
 * ("Sep" became "Sept" in en-GB) and a date label should not drift under
 * a runtime upgrade.
 */
export const DEFAULT_TIME_ZONE = 'America/New_York'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface ZonedParts {
  year: number
  /** 1-12. */
  month: number
  day: number
  /** 0-23. */
  hour: number
  minute: number
}

/** Split an instant into calendar parts in a named timezone. Returns null
 *  for an unparseable timestamp or an unknown zone. */
function zonedParts(iso: string, timeZone: string): ZonedParts | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(t))
  } catch {
    return null
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = get('hour') % 24
  const minute = get('minute')
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null
  return { year, month, day, hour, minute }
}

/** Weekday index for a calendar date, computed rather than formatted so
 *  it cannot drift with the locale data. */
function weekdayIndex(p: ZonedParts): number {
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/** "Sat 21 Sep" — the way a tour date gets written on a whiteboard. */
export function dayLabel(
  iso: string | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string | null {
  if (!iso) return null
  const p = zonedParts(iso, timeZone)
  if (!p) return null
  return `${WEEKDAYS[weekdayIndex(p)]} ${p.day} ${MONTHS[p.month - 1]}`
}

/** "2:00pm", or null at exactly midnight, which in this data almost
 *  always means "date only, no time was set". */
export function timeLabel(
  iso: string | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string | null {
  if (!iso) return null
  const p = zonedParts(iso, timeZone)
  if (!p) return null
  if (p.hour === 0 && p.minute === 0) return null
  const suffix = p.hour < 12 ? 'am' : 'pm'
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12
  return `${h12}:${String(p.minute).padStart(2, '0')}${suffix}`
}

/** "Sat 21 Sep, 2:00pm", or just the date when no time was set. */
export function dayTimeLabel(
  iso: string | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string | null {
  const day = dayLabel(iso, timeZone)
  if (!day) return null
  const time = timeLabel(iso, timeZone)
  return time ? `${day}, ${time}` : day
}

/** "today", "tomorrow", or "Sat 21 Sep" for anything further out. Both
 *  instants are compared as calendar days in the venue's timezone. */
export function whenLabel(
  iso: string | null | undefined,
  now: number = Date.now(),
  timeZone: string = DEFAULT_TIME_ZONE,
): string | null {
  if (!iso) return null
  const target = zonedParts(iso, timeZone)
  const today = zonedParts(new Date(now).toISOString(), timeZone)
  if (!target || !today) return null
  const targetDay = Date.UTC(target.year, target.month - 1, target.day)
  const todayDay = Date.UTC(today.year, today.month - 1, today.day)
  const daysAhead = Math.round((targetDay - todayDay) / DAY_MS)
  if (daysAhead === 0) return 'today'
  if (daysAhead === 1) return 'tomorrow'
  return dayLabel(iso, timeZone)
}

/** Where a message arrived from, in the words on the coordinator's own
 *  invoices. Unmapped channels get title case rather than a raw slug. */
const CHANNEL_LABEL: Record<string, string> = {
  gmail: 'email',
  email: 'email',
  knot: 'The Knot',
  weddingwire: 'WeddingWire',
  zola: 'Zola',
  calendly: 'your booking calendar',
  honeybook: 'HoneyBook',
  portal: 'their planning portal',
  website: 'your website',
  sms: 'text message',
  phone: 'a phone call',
  instagram: 'Instagram',
  facebook: 'Facebook',
}

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return 'a message'
  const key = normaliseTerm(channel)
  if (CHANNEL_LABEL[key]) return CHANNEL_LABEL[key]
  return channel.charAt(0).toUpperCase() + channel.slice(1)
}
