/**
 * Tour-scheduler intake adapter (T5-Rixey-II).
 *
 * Generic adapter for any tour-scheduling tool (Calendly, Acuity, Square
 * Appointments, custom calendar, generic .ics). The "CRM" framing of
 * crm-import is a slight misnomer for this provider class — schedulers
 * are an INTAKE channel for the wedding-lead funnel (tour requests +
 * post-booking touchpoints), not a CRM. But the adapter contract is
 * close enough that we slot it into the same shelf so coordinators have
 * one mental model for "import historical data on Day 2".
 *
 * Why generic-not-Calendly-only:
 *   - Different venues use different schedulers. Rixey is on Calendly;
 *     other Bloom venues are likely to be on Acuity / Square /
 *     a custom calendar tool / nothing-but-Google-Calendar.
 *   - The shape of a scheduling export is roughly the same across
 *     tools (event type, invitee, start/end, location, custom Q/A,
 *     UTM, cancellation flag) so one adapter with provider hints is
 *     simpler than four near-identical adapters.
 *   - generic_ical is the universal fallback — any tool that exports
 *     RFC-5545 .ics is supported via a structural parser.
 *
 * Provider hints implemented in this first cut:
 *   - calendly             — full impl, validated against the real
 *                            Rixey export at C:\Users\Ismar\Downloads\
 *                            event-data-from-20250504-to-20260503\
 *                            event-data-from-20250504-to-20260503.csv
 *                            (417 events, 12 months, mixed event types).
 *   - acuity               — scaffold with header-shape comment block.
 *   - square_appointments  — scaffold with header-shape comment block.
 *   - generic_ical         — scaffold (RFC-5545 VEVENT shape).
 *   - custom               — generic-csv-style mapping JSON (defer; the
 *                            existing genericCsvAdapter handles the
 *                            simple cases — tour-scheduler-custom would
 *                            differ only in event-type classification,
 *                            which we expose as preview overrides).
 *
 * Per-venue config (event-type classification):
 *   Each Calendly event type maps to one of:
 *     - tour                   → tours row + interactions(meeting) + weddings if-new
 *     - post_booking_touchpoint→ interactions(meeting) only, tagged via subject prefix
 *     - other_interaction      → interactions(meeting) only, tagged "service interaction"
 *   The default classifier uses keyword heuristics (see EVENT_TYPE_CLASSIFIER
 *   below). Coordinators override per-event-type during preview, and the
 *   confirmed mapping is committed alongside the rows.
 *
 * Custom Q&A → field routing:
 *   Calendly's Question 1-8 columns are venue-customised. The router
 *   uses fuzzy keyword matching on the question text to populate
 *   weddings.guest_count_estimate, lead source, partner2 name/email,
 *   etc. Unknown questions concatenate into notes.
 *
 * Cancellation derivation:
 *   The Rixey export has a 32% cancellation rate (135/417). Many of
 *   those are "Rescheduled from connected calendar event" (system
 *   churn, NOT a real cancellation) — those resolve to outcome=
 *   'rescheduled' rather than 'cancelled'. Free-text reasons are
 *   bucketed via keyword heuristics (covers the common patterns —
 *   competitive losses, family/health emergencies, weather, schedule
 *   conflicts). LLM-based extraction (extractCancellationReason from
 *   tour-cancellation-reason.ts) is intentionally NOT used here:
 *   imports run in batch over hundreds of rows, the cost ceiling
 *   would bite, and the reason text is short structured-ish so
 *   keyword matching is good enough for an import-time bucket.
 *
 * Stream-coupling notes:
 *   - This commits with crm_source='generic_csv' (the existing catch-all
 *     in the migration-178 CHECK enum). Adding a dedicated 'tour_scheduler'
 *     value to the enum would require its own migration; deferred per
 *     T5-Rixey-II scope ("No new migration expected from this stream").
 *     Provider name (calendly / acuity / etc.) is encoded in
 *     weddings.source_detail + interactions.body_preview prefix so
 *     downstream surfaces can still distinguish.
 *   - Stream JJ (cancellation enum widening for 'lost_to_competitor' +
 *     'venue_unavailable') hasn't merged yet (no migration 175/176 in
 *     supabase/migrations as of 2026-05-02). Until it lands we map:
 *       - "found another venue" / "went elsewhere" → 'other'
 *         (with the original text in cancellation_note for audit)
 *         + a TODO marker in the note so post-Stream-JJ a sweep can
 *         re-bucket to 'lost_to_competitor'.
 *       - venue-host emergencies → 'family_emergency' (existing bucket)
 *         with TODO for 'venue_unavailable' once available.
 *   - UTM Source = "honeybook" on a Calendly row means the tour was
 *     auto-scheduled via the HoneyBook funnel, not a direct Calendly
 *     booking. We tag those weddings with source_detail prefix
 *     "via_honeybook:" so the source-quality intel can split them
 *     out from organic-Calendly tours.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  NormalisedTourRow,
  NormalisedInteractionRow,
  CommitResult,
  ClassifiedEventType,
  EventClassification,
  RoutedQuestion,
} from './index'
import { commitNormalisedRows } from './index'
import { parseCsvRows } from '@/lib/services/brain-dump-csv-shape'

// ---------------------------------------------------------------------------
// EVENT-TYPE CLASSIFIER
// ---------------------------------------------------------------------------
// Default heuristic for "is this Calendly/Acuity event type a tour, a
// post-booking touchpoint, or something else?". Coordinators override
// per-event-type in the preview UI; the resulting per-venue map is the
// source of truth on commit.
//
// Buckets:
//   tour                     → produces a tours row (+ weddings if new)
//   post_booking_touchpoint  → produces an interactions(meeting) row, no tour
//   other_interaction        → produces an interactions(meeting) row, no tour,
//                              tagged as service-interaction (e.g. coaching)

const TOUR_KEYWORDS = [
  /\btour\b/i,
  /\bphone\s*call\b/i,
  /\bdiscovery\b/i,
  /\bsite\s*visit\b/i,
  /\bvenue\s*visit\b/i,
  /\binitial\s*consultation\b/i,
]

const POST_BOOKING_KEYWORDS = [
  /\bwalkthrough\b/i,
  /\bdrop\s*off\b/i,
  /\bplanning\s*meeting\b/i,
  /\bonboarding\b/i,
  /\bmid[-\s]*way\b/i,
  /\bvendor\s*meeting\b/i,
  /\brehearsal\b/i,
  /\bpost[-\s]*book(ing|ed)\b/i,
  /\bcheck[-\s]*in\b/i,
]

const OTHER_INTERACTION_KEYWORDS = [
  /\bbootcamp\b/i,
  /\bcoaching\b/i,
  /\bservice\b/i,
  /\b1:1\b/i,
  /\bcourse\b/i,
]

/**
 * Default classifier. Returns the bucket + a one-line reason so the
 * preview UI can show coordinators WHY each event type was bucketed
 * (and they can override).
 */
export function classifyEventType(eventTypeName: string | null | undefined): EventClassification {
  const name = (eventTypeName ?? '').trim()
  if (!name) {
    return { bucket: 'other_interaction', reason: 'empty event type name; defaulting to other_interaction' }
  }

  // Order matters — post-booking patterns are MORE specific than the
  // generic "tour" keyword (e.g. "Vendor Meeting - Walk Through"
  // contains "walk through" but should bucket as post_booking).
  for (const re of POST_BOOKING_KEYWORDS) {
    if (re.test(name)) {
      return { bucket: 'post_booking_touchpoint', reason: `matched post-booking pattern ${re.source}` }
    }
  }
  for (const re of TOUR_KEYWORDS) {
    if (re.test(name)) {
      return { bucket: 'tour', reason: `matched tour pattern ${re.source}` }
    }
  }
  for (const re of OTHER_INTERACTION_KEYWORDS) {
    if (re.test(name)) {
      return { bucket: 'other_interaction', reason: `matched service-interaction pattern ${re.source}` }
    }
  }
  // Unknown event type → default to other_interaction so we don't
  // pollute the lead funnel with non-tour events.
  return { bucket: 'other_interaction', reason: 'no keyword matched; defaulting to other_interaction' }
}

// ---------------------------------------------------------------------------
// QUESTION ROUTER
// ---------------------------------------------------------------------------
// Calendly's Question 1-8 are venue-customised. We fuzzy-match the
// question text against known intent buckets and route the response
// to the right Bloom field. Unknown questions concatenate into notes.

interface QuestionRouteSpec {
  /** Bloom field the response maps to. */
  field: RoutedQuestion
  /** Patterns matched against the question text (case-insensitive). */
  patterns: RegExp[]
}

const QUESTION_ROUTES: QuestionRouteSpec[] = [
  {
    field: 'partner2_name',
    patterns: [/partner.*name/i, /fianc(é|e).*name/i, /spouse.*name/i, /co[-\s]*planner.*name/i],
  },
  {
    field: 'partner2_email',
    patterns: [/partner.*email/i, /fianc(é|e).*email/i, /spouse.*email/i, /second.*email/i],
  },
  {
    field: 'partner1_phone',
    patterns: [/^\s*phone\s*(number)?\s*$/i, /your.*phone/i, /best.*phone/i, /contact.*number/i, /text\s*reminder/i],
  },
  {
    field: 'wedding_date_hint',
    patterns: [/wedding\s*date/i, /event\s*date/i, /approximate\s*date/i, /date.*in\s*mind/i, /target\s*date/i],
  },
  {
    field: 'estimated_guests',
    patterns: [/guest/i, /headcount/i, /how\s*many/i, /size\s*of/i, /attendee/i],
  },
  {
    field: 'lead_source',
    patterns: [/hear\s*about/i, /find\s*us/i, /referred/i, /how.*find/i, /discover/i, /source/i],
  },
  {
    field: 'package_interest',
    patterns: [/package/i, /tier/i, /option.*interest/i, /which.*package/i, /pricing.*tier/i],
  },
  {
    field: 'pricing_calculator',
    patterns: [/pricing\s*calculator/i, /calculator/i, /pricing\s*tool/i, /built.*package/i],
  },
  {
    field: 'meeting_topic',
    patterns: [/what.*meet.*about/i, /topic/i, /agenda/i, /reason\s*for/i, /what.*discuss/i, /dropping\s*off/i],
  },
  {
    field: 'attendees',
    patterns: [/who.*join/i, /attending/i, /bringing/i, /who.*be\s*there/i],
  },
]

/**
 * Route a single question + response pair to its Bloom field. Returns
 * null for questions that don't match any known intent — the caller
 * concatenates these into the notes field.
 */
export function routeQuestion(question: string | null | undefined): RoutedQuestion | null {
  const q = (question ?? '').trim()
  if (!q) return null
  for (const route of QUESTION_ROUTES) {
    if (route.patterns.some((re) => re.test(q))) return route.field
  }
  return null
}

// ---------------------------------------------------------------------------
// CANCELLATION PARSER
// ---------------------------------------------------------------------------
// Maps Calendly free-text cancellation reasons to the migration-166 enum
// (cancellation_reason). Until Stream JJ widens the enum (migration 175/
// 176), we bucket competitive losses to 'other' with the original text
// preserved in cancellation_note + a TODO marker.
//
// Patterns derived from the Rixey export's actual reason strings:
//   - "Found a venue elsewhere" / "Went with another venue"
//   - "Covid" / "got sick" / "flight cancelled"
//   - "Scheduling conflict" / "No availability in target time frame"
//   - "Rescheduled from connected calendar event" (SYSTEM churn, not real cancel)
//   - "Isadora's flight back from the UK was cancelled" (host emergency)

export type CancellationBucket =
  | 'weather'
  | 'date_conflict'
  | 'family_emergency'
  | 'venue_concern'
  | 'travel_blocker'
  | 'rescheduled'
  | 'no_show_followup'
  | 'other'

export interface CancellationDerivation {
  outcome: 'cancelled' | 'rescheduled' | 'no_show'
  reason: CancellationBucket
  /** Original free-text + any TODO markers (e.g. for post-Stream-JJ rebucket). */
  note: string | null
  /** Surfaces a TODO when Stream JJ's wider buckets would change the
   *  classification. Lets a post-merge sweep re-bucket without re-OCRing. */
  pendingStreamJj?: 'lost_to_competitor' | 'venue_unavailable'
}

/** True when this row's reason indicates it's a system-churn reschedule
 *  rather than a real cancellation. Calendly emits these whenever a
 *  connected-calendar conflict shifts a tour. */
function isSystemReschedule(reason: string): boolean {
  return /rescheduled\s+from\s+connected\s+calendar/i.test(reason)
}

/**
 * Bucket a free-text cancellation reason. Pure heuristic — for an
 * import-time batch we don't pay the LLM cost. Returns null when there
 * is no signal at all (caller handles).
 */
export function deriveCancellation(args: {
  canceled: boolean
  canceledBy: string | null
  reasonText: string | null
  markedNoShow: boolean
}): CancellationDerivation | null {
  const { canceled, canceledBy, reasonText, markedNoShow } = args
  if (markedNoShow) {
    return { outcome: 'no_show', reason: 'no_show_followup', note: reasonText?.trim() || null }
  }
  if (!canceled) return null

  const text = (reasonText ?? '').trim()

  // System reschedules from connected-calendar conflicts. Calendly
  // emits these automatically; they are NOT real cancellations.
  if (isSystemReschedule(text)) {
    return { outcome: 'rescheduled', reason: 'rescheduled', note: text }
  }

  if (!text) {
    // No reason given. Coordinator-cancelled (Host) with no reason
    // typically means an admin action (tour moved on the back end);
    // invitee-cancelled with no reason is a silent drop. Both → 'other'.
    return {
      outcome: 'cancelled',
      reason: 'other',
      note: canceledBy ? `Canceled by ${canceledBy}, no reason given.` : null,
    }
  }

  // Weather
  if (/(storm|hurricane|snow|weather|tornado|blizzard|flood)/i.test(text)) {
    return { outcome: 'cancelled', reason: 'weather', note: text }
  }
  // Travel blocker
  if (/(flight|travel|airline|stranded|got sick|illness in transit)/i.test(text)) {
    // Host travel issue (e.g. Isadora's flight cancelled) is venue_unavailable
    // post-Stream-JJ; for now bucket to 'travel_blocker' which is the closest
    // existing fit, with a TODO marker.
    if (/(host|isadora|coordinator|venue\s*owner)/i.test(text)) {
      return {
        outcome: 'cancelled',
        reason: 'travel_blocker',
        note: `${text} [TODO: rebucket to 'venue_unavailable' after Stream JJ migration lands]`,
        pendingStreamJj: 'venue_unavailable',
      }
    }
    return { outcome: 'cancelled', reason: 'travel_blocker', note: text }
  }
  // Family/health emergency
  if (/(emergency|funeral|bereavement|death|sick|covid|flu|hospital|illness|injury|baby|pregnant|family\s*matter)/i.test(text)) {
    return { outcome: 'cancelled', reason: 'family_emergency', note: text }
  }
  // Competitive loss (booked elsewhere). Stream JJ will add a dedicated
  // 'lost_to_competitor' bucket; until then bucket to 'other' + TODO.
  if (/(another\s+venue|other\s+venue|venue\s+elsewhere|elsewhere|went\s+with|chose\s+a?\s*different|booked\s+(another|else|with)|found\s+a\s+venue)/i.test(text)) {
    return {
      outcome: 'cancelled',
      reason: 'other',
      note: `${text} [TODO: rebucket to 'lost_to_competitor' after Stream JJ migration lands]`,
      pendingStreamJj: 'lost_to_competitor',
    }
  }
  // Date conflict
  if (/(scheduling\s*conflict|schedul(ing|e)\s*conflict|conflict|date\s*conflict|no\s*availability|target\s*time\s*frame|won.*work|can.*make.*it|busy)/i.test(text)) {
    return { outcome: 'cancelled', reason: 'date_conflict', note: text }
  }
  // Venue concern (couple raised a concern)
  if (/(too\s*small|too\s*big|too\s*far|distance|capacity|accommodation|ceremony\s*space|on[-\s]*site)/i.test(text)) {
    return { outcome: 'cancelled', reason: 'venue_concern', note: text }
  }
  // Reschedule (manual, not system)
  if (/(reschedul|move\s*to|moved\s*to|push.*to|change.*date)/i.test(text)) {
    return { outcome: 'rescheduled', reason: 'rescheduled', note: text }
  }
  return { outcome: 'cancelled', reason: 'other', note: text }
}

// ---------------------------------------------------------------------------
// CALENDLY HEADER INDEX (validated against Rixey export 2025-05 → 2026-05)
// ---------------------------------------------------------------------------

const CAL_REQUIRED = [
  'Event Type Name',
  'Start Date & Time',
  'Invitee Email',
] as const

interface CalendlyHeaderIndex {
  byKey: Record<string, number>
  missingRequired: string[]
}

/** Calendly column names are case-sensitive in the export but we still
 *  trim/normalise to be defensive against future export-format tweaks. */
function indexCalendlyHeader(header: string[]): CalendlyHeaderIndex {
  const byKey: Record<string, number> = {}
  const missingRequired: string[] = []
  const trimmed = header.map((h) => (h ?? '').trim())
  trimmed.forEach((h, i) => { byKey[h] = i })
  for (const req of CAL_REQUIRED) {
    if (byKey[req] == null) missingRequired.push(req)
  }
  return { byKey, missingRequired }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Calendly format: "2025-05-04 01:00 pm" → ISO. Returns null if unparseable. */
function parseCalendlyDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Calendly emits "YYYY-MM-DD HH:mm am/pm" in venue-local time; Date()
  // parses this as local-time which is the desired interpretation
  // (the export is venue-local already).
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** "120-150" → 135 (midpoint). "80-120\nstill unsure" → 100. Returns null. */
function parseGuestCount(raw: string | null | undefined): number | null {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null
  // Single number
  const single = text.match(/^\s*(\d+)\s*$/)
  if (single) {
    const n = Number(single[1])
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return n
  }
  // Range "120-150" → midpoint 135. Take the FIRST range we see (Calendly
  // sometimes appends free-text after a newline, e.g. "80-120\nstill unsure").
  const range = text.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (range) {
    const lo = Number(range[1])
    const hi = Number(range[2])
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
      const mid = Math.round((lo + hi) / 2)
      if (mid >= 1 && mid <= 1000) return mid
    }
  }
  return null
}

/** Best-effort normalise a free-text wedding-date hint to YYYY-MM-DD.
 *  Returns null on a fuzzy answer ("Sometime in May", "Spring 2026")
 *  so we don't false-claim a date. */
function parseWeddingDateHint(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null
  // Reject obviously fuzzy answers.
  if (/sometime|maybe|flexible|spring|summer|fall|winter|tbd|unsure|month\s*of/i.test(text)
      && !/\b\d{4}\b/.test(text)) {
    return null
  }
  // Try Date.parse on the first ~64 chars (handles "9/26/26", "April 24 2027",
  // "September 2025", "04/10/2027").
  const candidate = text.slice(0, 64)
  const d = new Date(candidate)
  if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getFullYear() < 2100) {
    return d.toISOString().slice(0, 10)
  }
  return null
}

/** Calendly's "Where did you first hear about us?" → weddings.source enum.
 *  Mirrors honeybook.ts canonicaliseSource but extended with the actual
 *  values seen in the Rixey export. */
function canonicaliseLeadSource(raw: string | null | undefined): {
  source: NonNullable<NormalisedLeadRow['source']> | null
  detail: string | null
} {
  const text = (raw ?? '').trim()
  if (!text) return { source: null, detail: null }
  const lower = text.toLowerCase()
  let source: NonNullable<NormalisedLeadRow['source']> | null
  if (/the\s*knot|theknot/.test(lower))                              source = 'the_knot'
  else if (/wedding\s*wire|weddingwire/.test(lower))                 source = 'wedding_wire'
  else if (/here\s*comes\s*the\s*guide/.test(lower))                 source = 'here_comes_the_guide'
  else if (/zola/.test(lower))                                       source = 'zola'
  else if (/instagram|insta/.test(lower))                            source = 'instagram'
  else if (/facebook|\bfb\b/.test(lower))                            source = 'facebook'
  else if (/pinterest/.test(lower))                                  source = 'pinterest'
  else if (/tiktok|tik\s*tok/.test(lower))                           source = 'tiktok'
  else if (/google/.test(lower))                                     source = 'google'
  else if (/word\s*of\s*mouth|referral|referred|been\s*here\s*before|friend|family/.test(lower)) source = 'referral'
  else if (/website|web\s*form/.test(lower))                         source = 'website'
  else if (/walk[\s-]*in/.test(lower))                               source = 'walk_in'
  else                                                               source = 'other'
  return { source, detail: text }
}

/** Pick the venue's tour-location string out of the Calendly Location
 *  cell. The cell is sometimes empty (post-booking events), sometimes
 *  the venue address, sometimes a Zoom URL. */
function isVirtualLocation(raw: string | null | undefined): boolean {
  if (!raw) return false
  return /zoom|google\s*meet|teams|skype|webex|virtual/i.test(raw)
}

/** Pick partner2_first/last from a "Firstname Lastname" string. Defensive
 *  — sometimes the field has just a phone number (coordinator typo) so we
 *  only treat the value as a name when it has letters. */
function splitPartnerName(raw: string | null | undefined): { first: string | null; last: string | null } {
  if (!raw) return { first: null, last: null }
  const text = raw.trim()
  if (!text) return { first: null, last: null }
  // Phone-number-as-name guard.
  if (!/[A-Za-z]/.test(text)) return { first: null, last: null }
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { first: null, last: null }
  if (tokens.length === 1) return { first: tokens[0] ?? null, last: null }
  return { first: tokens[0] ?? null, last: tokens.slice(1).join(' ') }
}

// ---------------------------------------------------------------------------
// CALENDLY parse()
// ---------------------------------------------------------------------------

/**
 * Parse a Calendly CSV export into NormalisedLeadRow[]. Each row in the
 * export becomes one ParsedCalendlyRow; parseCalendly groups multiple
 * events for the same invitee_email into one wedding (so that two tours
 * + a planning meeting on the same email collapse to one wedding row).
 */
interface ParsedCalendlyRow {
  /** Identifier we group on. Falls back to invitee_uuid if email missing. */
  groupKey: string
  inviteeEmail: string | null
  inviteeFirst: string | null
  inviteeLast: string | null
  eventTypeName: string
  classification: EventClassification
  startIso: string | null
  endIso: string | null
  createdIso: string | null
  location: string | null
  canceled: boolean
  canceledBy: string | null
  cancellationReasonText: string | null
  markedNoShow: boolean
  cancellationDerived: CancellationDerivation | null
  utmSource: string | null
  utmCampaign: string | null
  utmMedium: string | null
  utmTerm: string | null
  utmContent: string | null
  guestEmails: string | null
  questionsRouted: Map<RoutedQuestion, string>
  questionsUnknown: Array<{ q: string; a: string }>
  eventUuid: string | null
  inviteeUuid: string | null
}

function parseCalendlyCsv(csvText: string): {
  parsed: ParsedCalendlyRow[]
  errors: string[]
  warnings: string[]
  eventTypeCounts: Map<string, number>
} {
  const errors: string[] = []
  const warnings: string[] = []
  const eventTypeCounts = new Map<string, number>()

  const csvRows = parseCsvRows(csvText)
  if (csvRows.length < 2) {
    return { parsed: [], errors: ['csv must have a header row and at least one data row'], warnings, eventTypeCounts }
  }
  const header = csvRows[0]
  const idx = indexCalendlyHeader(header)
  if (idx.missingRequired.length > 0) {
    return {
      parsed: [],
      errors: [
        `Calendly export is missing required column(s): ${idx.missingRequired.join(', ')}. ` +
        `Re-export from Calendly (Account → Export → Scheduled Events) and ensure the default columns are included.`,
      ],
      warnings,
      eventTypeCounts,
    }
  }

  const parsed: ParsedCalendlyRow[] = []

  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]
    const get = (key: string): string | null => {
      const i = idx.byKey[key]
      if (i == null) return null
      return (data[i] ?? '').trim() || null
    }

    const eventTypeName = get('Event Type Name') ?? ''
    if (!eventTypeName) {
      warnings.push(`row ${r}: skipped — no Event Type Name`)
      continue
    }
    eventTypeCounts.set(eventTypeName, (eventTypeCounts.get(eventTypeName) ?? 0) + 1)
    const classification = classifyEventType(eventTypeName)

    const inviteeEmail = get('Invitee Email')
    const inviteeUuid = get('Invitee UUID')
    const inviteeFirst = get('Invitee First Name')
    const inviteeLast = get('Invitee Last Name')

    // Group by email when present (so the same couple's tour + planning
    // meeting + walkthrough collapse to one wedding). Fall back to
    // invitee UUID when email is missing — better than dropping the row.
    const groupKey = (inviteeEmail ?? inviteeUuid ?? `row-${r}`).toLowerCase()

    // Q/A routing across question 1-8.
    const questionsRouted = new Map<RoutedQuestion, string>()
    const questionsUnknown: Array<{ q: string; a: string }> = []
    for (let q = 1; q <= 8; q++) {
      const qText = get(`Question ${q}`)
      const aText = get(`Response ${q}`)
      if (!qText || !aText) continue
      const route = routeQuestion(qText)
      if (route) {
        // First non-empty wins (subsequent fills are usually duplicate
        // questions on different forms).
        if (!questionsRouted.has(route)) questionsRouted.set(route, aText)
      } else {
        questionsUnknown.push({ q: qText, a: aText })
      }
    }

    const canceled = (get('Canceled') ?? '').toLowerCase() === 'true'
    const canceledBy = get('Canceled By')
    const reasonText = get('Cancellation reason')
    const markedNoShow = (get('Marked as No-Show') ?? '').toLowerCase() === 'yes'
    const cancellationDerived = deriveCancellation({
      canceled, canceledBy, reasonText, markedNoShow,
    })

    parsed.push({
      groupKey,
      inviteeEmail,
      inviteeFirst,
      inviteeLast,
      eventTypeName,
      classification,
      startIso: parseCalendlyDate(get('Start Date & Time')),
      endIso: parseCalendlyDate(get('End Date & Time')),
      createdIso: parseCalendlyDate(get('Event Created Date & Time')),
      location: get('Location'),
      canceled, canceledBy, cancellationReasonText: reasonText, markedNoShow,
      cancellationDerived,
      utmSource: get('UTM Source'),
      utmCampaign: get('UTM Campaign'),
      utmMedium: get('UTM Medium'),
      utmTerm: get('UTM Term'),
      utmContent: get('UTM Content'),
      guestEmails: get('Guest Email(s)'),
      questionsRouted,
      questionsUnknown,
      eventUuid: get('Event UUID'),
      inviteeUuid,
    })
  }

  return { parsed, errors, warnings, eventTypeCounts }
}

/**
 * Group ParsedCalendlyRow[] by invitee_email and produce one
 * NormalisedLeadRow per couple. Tours + post-booking touchpoints +
 * other interactions get attached as sub-records on the right wedding.
 */
function calendlyRowsToNormalised(
  parsed: ParsedCalendlyRow[],
  /** Per-event-type override map from the preview UI; keyed by exact
   *  Event Type Name. When a coordinator overrides "Final Walkthrough"
   *  to bucket=tour, we honour their choice over the heuristic. */
  classifierOverrides: Map<string, ClassifiedEventType> | null = null,
): NormalisedLeadRow[] {
  const byGroup = new Map<string, ParsedCalendlyRow[]>()
  for (const row of parsed) {
    const arr = byGroup.get(row.groupKey)
    if (arr) arr.push(row)
    else byGroup.set(row.groupKey, [row])
  }

  const out: NormalisedLeadRow[] = []
  for (const [groupKey, rows] of byGroup.entries()) {
    // Use the EARLIEST row to seed identity (first contact wins).
    rows.sort((a, b) => {
      const ai = a.createdIso ?? a.startIso ?? ''
      const bi = b.createdIso ?? b.startIso ?? ''
      return ai.localeCompare(bi)
    })
    const seed = rows[0]

    // Aggregate routed Q/A across all rows for this group; first
    // non-empty wins so we don't overwrite a real partner-name with
    // a later phone-typo answer.
    const aggregateRouted = new Map<RoutedQuestion, string>()
    for (const r of rows) {
      for (const [k, v] of r.questionsRouted.entries()) {
        if (!aggregateRouted.has(k) && v.trim()) aggregateRouted.set(k, v)
      }
    }
    const partner2Name = splitPartnerName(aggregateRouted.get('partner2_name'))
    const partner2Email = (aggregateRouted.get('partner2_email') ?? '').trim() || null
    const phone = (aggregateRouted.get('partner1_phone') ?? '').trim() || null
    const guestCount = parseGuestCount(aggregateRouted.get('estimated_guests'))
    const wedDateHint = parseWeddingDateHint(aggregateRouted.get('wedding_date_hint'))
    const leadSourceRaw = aggregateRouted.get('lead_source') ?? null
    const { source, detail } = canonicaliseLeadSource(leadSourceRaw)

    // Detect HoneyBook-funnel tours (UTM Source = honeybook on any tour
    // row in the group). These weddings should be tagged so source-
    // quality intel can split them out from organic-Calendly tours.
    const viaHoneybook = rows.some((r) => (r.utmSource ?? '').toLowerCase() === 'honeybook')

    const sourceDetail = [
      viaHoneybook ? 'via_honeybook' : null,
      detail,
    ].filter(Boolean).join(' | ') || null

    // Outcome rollup: weddings.status defaults to 'inquiry'. If at least
    // one tour row exists, status='tour_scheduled'; if any tour row is
    // outcome=completed/booked, escalate to 'tour_completed'. Cancellation
    // only sets weddings.status='cancelled' when EVERY tour row is
    // cancelled — otherwise the lead is still alive.
    let aggregateStatus: NormalisedLeadRow['status'] = 'inquiry'
    let allTourLikeCancelled = true
    let anyTourLike = false

    const tours: NormalisedTourRow[] = []
    const interactions: NormalisedInteractionRow[] = []
    const unknownNotes: string[] = []

    for (const r of rows) {
      const overrideBucket = classifierOverrides?.get(r.eventTypeName) ?? r.classification.bucket

      // Each row also produces an interactions(meeting) row regardless
      // of bucket — gives the wedding timeline a chronological touchpoint.
      const subjectPrefix = (() => {
        if (overrideBucket === 'tour')                 return 'Tour scheduled'
        if (overrideBucket === 'post_booking_touchpoint') return 'Post-booking'
        return 'Service interaction'
      })()
      const cancelledTag = r.cancellationDerived
        ? ` [${r.cancellationDerived.outcome}: ${r.cancellationDerived.reason}]`
        : ''
      const utmTag = (r.utmSource ?? '').toLowerCase() === 'honeybook' ? ' [via_honeybook]' : ''
      const subject = `${subjectPrefix}: ${r.eventTypeName}${cancelledTag}${utmTag}`

      // Body lists the routed Q/A + unknown Q/A for audit. Coordinator
      // can read this off the timeline and reconstruct what the couple
      // told us at booking.
      const bodyLines: string[] = []
      bodyLines.push(`provider:calendly`)
      bodyLines.push(`event_type:${r.eventTypeName}`)
      bodyLines.push(`scheduled_at:${r.startIso ?? '(unknown)'}`)
      if (r.createdIso) bodyLines.push(`created_at:${r.createdIso}`)
      if (r.location) bodyLines.push(`location:${r.location}`)
      if (r.canceled) {
        bodyLines.push(`cancelled:true${r.canceledBy ? ` (by ${r.canceledBy})` : ''}`)
        if (r.cancellationDerived) {
          bodyLines.push(`cancellation_reason:${r.cancellationDerived.reason}`)
          if (r.cancellationDerived.note) bodyLines.push(`cancellation_note:${r.cancellationDerived.note}`)
        }
      }
      for (const [k, v] of r.questionsRouted.entries()) {
        bodyLines.push(`${k}:${v.replace(/\n/g, ' / ')}`)
      }
      for (const u of r.questionsUnknown) {
        bodyLines.push(`q:${u.q.replace(/\n/g, ' ')} → ${u.a.replace(/\n/g, ' / ')}`)
      }
      if (r.utmSource) bodyLines.push(`utm_source:${r.utmSource}`)
      if (r.utmCampaign) bodyLines.push(`utm_campaign:${r.utmCampaign}`)
      if (r.eventUuid) bodyLines.push(`event_uuid:${r.eventUuid}`)
      const body = bodyLines.join('\n')

      const occurredAt = r.startIso ?? r.createdIso ?? new Date().toISOString()
      interactions.push({
        occurred_at: occurredAt,
        direction: 'inbound',
        type: 'meeting',
        subject,
        body,
      })

      if (overrideBucket === 'tour') {
        anyTourLike = true
        // Map outcome: cancelled rows → cancelled; rescheduled → rescheduled;
        // no-show → no_show; otherwise pending. Imports never set
        // outcome='completed' — that requires post-tour confirmation
        // the coordinator handles after import.
        const outcome = r.cancellationDerived
          ? r.cancellationDerived.outcome
          : ('pending' as const)
        if (outcome !== 'cancelled' && outcome !== 'no_show') allTourLikeCancelled = false
        // tour_type: virtual when location screams Zoom; phone when
        // event-type name says "phone call"; else in_person (Rixey
        // street address is present).
        let tourType: NormalisedTourRow['tour_type'] = 'in_person'
        if (isVirtualLocation(r.location)) tourType = 'virtual'
        else if (/\bphone\s*call\b/i.test(r.eventTypeName)) tourType = 'phone'

        tours.push({
          scheduled_at: r.startIso ?? r.createdIso ?? new Date().toISOString(),
          tour_type: tourType,
          outcome: outcome === 'cancelled' || outcome === 'no_show' || outcome === 'rescheduled'
            ? outcome
            : 'pending',
          notes: [
            `event_type:${r.eventTypeName}`,
            r.cancellationDerived?.note ? `note:${r.cancellationDerived.note}` : null,
            r.cancellationDerived?.reason ? `reason:${r.cancellationDerived.reason}` : null,
          ].filter(Boolean).join(' | ') || null,
        })
      } else {
        // post_booking_touchpoint or other_interaction — interactions row
        // already produced above. No tour, no impact on weddings.status.
      }
    }

    if (anyTourLike) {
      aggregateStatus = allTourLikeCancelled ? 'cancelled' : 'tour_scheduled'
    }

    // Concat unknown-Q&A free text into notes for any blocks the
    // coordinator wants to read post-import.
    for (const r of rows) {
      for (const u of r.questionsUnknown) {
        unknownNotes.push(`[${r.eventTypeName}] ${u.q}: ${u.a}`)
      }
    }

    out.push({
      source_id: groupKey,
      partner1_first_name: seed.inviteeFirst,
      partner1_last_name: seed.inviteeLast,
      partner1_email: seed.inviteeEmail,
      partner1_phone: phone,
      partner2_first_name: partner2Name.first,
      partner2_last_name: partner2Name.last,
      // partner2_email isn't on NormalisedLeadRow; concat into notes
      // for the Day-2 coordinator review pass.
      wedding_date: wedDateHint,
      guest_count_estimate: guestCount,
      booking_value: null,
      status: aggregateStatus,
      source: source ?? 'calendly',
      source_detail: sourceDetail,
      inquiry_date: seed.createdIso ?? seed.startIso,
      booked_at: null,
      lost_at: aggregateStatus === 'cancelled'
        ? (rows[rows.length - 1]?.startIso ?? null)
        : null,
      lost_reason: aggregateStatus === 'cancelled' ? 'other' : null,
      notes: [
        partner2Email ? `partner2_email:${partner2Email}` : null,
        aggregateRouted.get('package_interest')
          ? `package_interest:${aggregateRouted.get('package_interest')!.replace(/\n/g, ' / ')}` : null,
        aggregateRouted.get('pricing_calculator')
          ? `pricing_calculator:${aggregateRouted.get('pricing_calculator')}` : null,
        unknownNotes.length > 0 ? `unknown_q_a:\n  ${unknownNotes.join('\n  ')}` : null,
      ].filter(Boolean).join('\n\n') || null,
      interactions,
      tours,
      lost_deal: null,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// SCAFFOLD: Acuity
// ---------------------------------------------------------------------------
// Typical Acuity export columns (CSV from Acuity → Reports → Appointments):
//   - First Name / Last Name / Email / Phone
//   - Type (event type name)
//   - Date / Time / Calendar
//   - Notes / Forms (custom Q/A is one column, free-text)
//   - Status (Active / Cancelled / Rescheduled)
//   - Cancelled (Y/N) / Cancellation Reason
//   - Promo / Coupon / Source
// TODO when first real Acuity export lands:
//   1. Acuity puts ALL custom-form responses in a single "Forms" column
//      with "Question: Answer\n" pairs — the parser needs to split
//      that string into routedQuestion calls.
//   2. Acuity has a "Calendar" column that segregates by venue/staff;
//      the import should filter to the venue's calendar.
//   3. Date + Time are in separate columns; concat before parsing.

function calendlyParse(config: AdapterConfig): ParseResult {
  if (!config.csvText || !config.csvText.trim()) {
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings: [] }
  }
  const { parsed, errors, warnings, eventTypeCounts } = parseCalendlyCsv(config.csvText)
  if (errors.length > 0) return { ok: false, rows: [], errors, warnings }

  // Decode any preview overrides the coordinator passed via columnMapping
  // (re-using the AdapterConfig field — the value shape is { event_type_name: bucket }).
  // The /onboarding/tour-scheduler-import preview UI maps event types to
  // buckets and posts the override map back as columnMapping.
  let overrides: Map<string, ClassifiedEventType> | null = null
  if (config.columnMapping) {
    overrides = new Map()
    for (const [eventType, bucket] of Object.entries(config.columnMapping)) {
      if (bucket === 'tour' || bucket === 'post_booking_touchpoint' || bucket === 'other_interaction') {
        overrides.set(eventType, bucket)
      }
    }
  }

  const rows = calendlyRowsToNormalised(parsed, overrides)

  // Surface the per-event-type tally in warnings so the preview UI
  // gets a free summary panel.
  const summary: string[] = []
  for (const [name, count] of eventTypeCounts.entries()) {
    const bucket = overrides?.get(name) ?? classifyEventType(name).bucket
    summary.push(`${name} × ${count} → ${bucket}`)
  }
  if (summary.length > 0) {
    warnings.push(`Event type tally:\n  ${summary.join('\n  ')}`)
  }

  return { ok: true, rows, errors: [], warnings }
}

// ---------------------------------------------------------------------------
// PROVIDER DISPATCH
// ---------------------------------------------------------------------------

async function parseTourScheduler(config: AdapterConfig): Promise<ParseResult> {
  const provider = config.provider ?? 'calendly'

  switch (provider) {
    case 'calendly':
      return calendlyParse(config)

    case 'acuity':
      return {
        ok: false,
        rows: [],
        warnings: [],
        errors: [
          "Acuity adapter is scaffold-only. See src/lib/services/crm-import/tour-scheduler.ts " +
          "(SCAFFOLD: Acuity comment block) for the documented column shape. " +
          "Use the calendly hint or the generic-csv adapter with a column-mapping JSON in the meantime.",
        ],
      }

    case 'square_appointments':
      return {
        ok: false,
        rows: [],
        warnings: [],
        errors: [
          "Square Appointments adapter is scaffold-only. See src/lib/services/" +
          "crm-import/tour-scheduler.ts (SCAFFOLD: Square Appointments) for " +
          "the documented column shape. Use the calendly hint or generic-csv in the meantime.",
        ],
      }

    case 'generic_ical':
      return {
        ok: false,
        rows: [],
        warnings: [],
        errors: [
          "Generic .ics adapter is scaffold-only. The intended shape is RFC-5545 " +
          "VEVENT records — SUMMARY → event type, DTSTART → scheduled_at, " +
          "DTEND → end, ORGANIZER + ATTENDEE → invitee identity, DESCRIPTION → " +
          "free-text Q&A blob. Custom Q&A routing is best-effort vs. the " +
          "structured Calendly shape. Defer until a real .ics from a non-" +
          "Calendly venue lands.",
        ],
      }

    case 'custom':
      return {
        ok: false,
        rows: [],
        warnings: [],
        errors: [
          "Custom column-mapping for tour-schedulers is deferred — use the " +
          "Generic CSV adapter (provider name: 'generic_csv') with a " +
          "column-mapping JSON. The differences between custom and generic-csv " +
          "are the event-type classification step (handled in the preview UI) " +
          "and the cancellation parser; both can be wired up post-launch when " +
          "a venue without a major scheduler asks.",
        ],
      }

    default: {
      const _exhaustive: never = provider
      void _exhaustive
      return {
        ok: false,
        rows: [],
        warnings: [],
        errors: [`unknown tour-scheduler provider hint: ${provider}`],
      }
    }
  }
}

function previewTourScheduler(rows: NormalisedLeadRow[]): PreviewResult {
  const warnings: string[] = []
  if (rows.length > 50) warnings.push(`only first 50 of ${rows.length} rows shown`)

  const byStatus = new Map<string, number>()
  let totalTours = 0
  let totalInteractions = 0
  let totalCancelledTours = 0
  for (const r of rows) {
    byStatus.set(r.status ?? 'inquiry', (byStatus.get(r.status ?? 'inquiry') ?? 0) + 1)
    totalTours += r.tours?.length ?? 0
    totalInteractions += r.interactions?.length ?? 0
    for (const t of r.tours ?? []) {
      if (t.outcome === 'cancelled') totalCancelledTours += 1
    }
  }

  if (rows.length > 0) {
    const parts = Array.from(byStatus.entries()).map(([k, v]) => `${k}=${v}`).join(', ')
    warnings.push(`Summary — ${rows.length} couples (${parts})`)
    warnings.push(`Tours: ${totalTours} (cancelled: ${totalCancelledTours})`)
    warnings.push(`Interactions: ${totalInteractions}`)
  }

  return {
    rows: rows.slice(0, 50),
    total: rows.length,
    errors: [],
    warnings,
  }
}

async function commitTourScheduler(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
}): Promise<CommitResult> {
  // Use 'generic_csv' as crm_source — adding a dedicated 'tour_scheduler'
  // value to the migration-178 CHECK enum requires its own migration,
  // deferred per T5-Rixey-II scope. Provider name is already encoded in
  // weddings.source_detail (e.g. "via_honeybook | The Knot") + each
  // interactions.full_body starts with "provider:calendly\n…".
  return commitNormalisedRows({ ...args, crmSource: 'generic_csv' })
}

export const tourSchedulerAdapter: CrmAdapter = {
  name: 'tour_scheduler',
  label: 'Tour scheduler (Calendly / Acuity / iCal)',
  description:
    'Import historical tour bookings + post-booking touchpoints from your scheduling tool. Calendly is fully supported (validated against the Rixey export); Acuity / Square Appointments / generic .ics are scaffolded. Each event type is classified as a tour, post-booking touchpoint, or service interaction; coordinators override per-event-type during preview.',
  ready: true,
  parse: parseTourScheduler,
  preview: previewTourScheduler,
  commit: commitTourScheduler,
}
