/**
 * The Knot (theknot.com) CSV adapter.
 *
 * Knot is a wedding-marketplace storefront — couples discover the venue
 * on theknot.com, click "Request Info", and Knot relays the inquiry into
 * the venue's Knot Pro inbox. Coordinators export their inbox as a CSV
 * (Storefront → Leads → Export) to backfill historical inquiries into
 * Bloom on Day-3 of the onboarding-project flow.
 *
 * Per [[bloom-storefront-ingestion]]: Knot has NO API. Operator-driven
 * CSV upload is the only ingestion path. Per the recurring-CSV import
 * doctrine (memory/bloom-recurring-csv-import-doctrine.md), every row
 * goes through the crm_import_rows dedup ledger (migration 335) BEFORE
 * minting a wedding — so re-uploading the same export weekly is a no-op
 * short-circuit.
 *
 * Knot CSV column shape (Q2 2026 export — case-insensitive matching,
 * common variants accepted):
 *
 *   Inquiry Date          → inquiry_date (variants: Created Date,
 *                           Submitted Date, Date Submitted, Date)
 *   Inquiry ID            → external_id (natural per-row stable key
 *                           used for crm_import_rows dedup)
 *                           (variants: Lead ID, Storefront Lead ID)
 *   Couple Name           → split into partner1 + (optional) partner2
 *                           OR First Name / Last Name pair → partner1
 *   First Name / Last Name → partner1_first_name / partner1_last_name
 *   Email Address         → partner1_email
 *                           (variants: Email, Couple Email)
 *   Phone Number          → partner1_phone
 *                           (variants: Phone, Couple Phone)
 *   Wedding Date          → wedding_date
 *                           (variants: Event Date, Estimated Wedding Date)
 *   Guest Count           → guest_count_estimate
 *                           (variants: Number of Guests, Estimated Guests,
 *                            Guests, Headcount)
 *   Budget                → booking_value (Cents; midpoint of range)
 *                           (variants: Budget Range, Estimated Budget,
 *                            Wedding Budget)
 *   Status                → mapped via STATUS_MAP (variants: Inquiry Status,
 *                           Lead Status)
 *   Message               → concatenated into notes
 *                           (variants: Couple Message, Inquiry Message,
 *                            Couple's Message)
 *
 * Source attribution (Stream-TT adapter-as-facts contract)
 * --------------------------------------------------------
 * Knot IS an acquisition channel — a Knot-storefront inquiry literally
 * means "couple found us via theknot.com". But this adapter still
 * writes weddings.source = NULL: the lead-source-derivation cron is
 * the single decider. Instead, every row produces a synthetic
 * interaction with:
 *   - extracted_identity.hear_source = 'the_knot'
 *   - signal_class = 'source'
 * so the derivation Priority-2 picks it up. This keeps the doctrine
 * consistent: adapters write facts, the cron decides the canonical
 * channel. The Knot-came-from-Knot fact is the strongest possible
 * Priority-2 signal so derivation will almost always land on the_knot.
 *
 * Confidence + provenance
 * -----------------------
 * Every wedding/person/lost_deal we insert is tagged
 *   confidence_flag = 'imported_medium'
 *   crm_source      = 'generic_csv'  (no dedicated 'knot' enum value
 *                                     yet — defer the migration; the
 *                                     real per-row source identifier
 *                                     lives in crm_import_rows.source
 *                                     = 'knot' for the dedup ledger,
 *                                     and in interactions.full_body
 *                                     prefix "provider:knot\n…")
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  NormalisedInteractionRow,
  CommitResult,
  NormalisedLostDealRow,
} from './index'
import { commitNormalisedRows } from './index'
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'
import { type Cents, asDollars, dollarsToCents } from '@/lib/types/monetary'

// ---------------------------------------------------------------------------
// Column-name detection (case-insensitive, accepts common variants)
// ---------------------------------------------------------------------------

interface ColumnSpec {
  key: string
  variants: RegExp[]
  required?: boolean
}

const COLUMNS: ColumnSpec[] = [
  { key: 'inquiry_date',  variants: [/^inquiry\s*date$/i, /^created\s*date$/i, /^submitted\s*date$/i, /^date\s*submitted$/i, /^date$/i] },
  { key: 'inquiry_id',    variants: [/^inquiry\s*id$/i, /^lead\s*id$/i, /^storefront\s*lead\s*id$/i, /^id$/i] },
  { key: 'couple_name',   variants: [/^couple\s*name$/i, /^name$/i, /^full\s*name$/i] },
  { key: 'first_name',    variants: [/^first\s*name$/i, /^couple\s*first\s*name$/i] },
  { key: 'last_name',     variants: [/^last\s*name$/i, /^couple\s*last\s*name$/i, /^surname$/i] },
  { key: 'email',         variants: [/^email\s*address$/i, /^email$/i, /^couple\s*email$/i] },
  { key: 'phone',         variants: [/^phone\s*number$/i, /^phone$/i, /^couple\s*phone$/i, /^contact\s*number$/i] },
  { key: 'wedding_date',  variants: [/^wedding\s*date$/i, /^event\s*date$/i, /^estimated\s*wedding\s*date$/i] },
  { key: 'guest_count',   variants: [/^guest\s*count$/i, /^number\s*of\s*guests$/i, /^estimated\s*guests$/i, /^guests$/i, /^headcount$/i] },
  { key: 'budget',        variants: [/^budget$/i, /^budget\s*range$/i, /^estimated\s*budget$/i, /^wedding\s*budget$/i] },
  { key: 'status',        variants: [/^status$/i, /^inquiry\s*status$/i, /^lead\s*status$/i] },
  { key: 'message',       variants: [/^message$/i, /^couple\s*message$/i, /^inquiry\s*message$/i, /^couple'?s\s*message$/i, /^notes$/i] },
]

interface ColumnIndex {
  byKey: Record<string, number>
  /** at least one of (inquiry_date, email, couple_name/first_name) must be present */
  hasAnyAnchor: boolean
}

function indexColumns(header: string[]): ColumnIndex {
  const byKey: Record<string, number> = {}
  for (const spec of COLUMNS) {
    let foundAt = -1
    for (let i = 0; i < header.length; i++) {
      const h = (header[i] ?? '').trim()
      if (spec.variants.some((re) => re.test(h))) {
        foundAt = i
        break
      }
    }
    byKey[spec.key] = foundAt
  }
  const hasAnyAnchor =
    byKey.inquiry_date >= 0 ||
    byKey.email >= 0 ||
    byKey.couple_name >= 0 ||
    byKey.first_name >= 0
  return { byKey, hasAnyAnchor }
}

// ---------------------------------------------------------------------------
// Status enum mapping. Knot's Inquiry Status field is venue-managed inside
// Knot Pro and varies in spelling; we accept the common variants.
// ---------------------------------------------------------------------------

type WeddingStatus = NormalisedLeadRow['status']

const STATUS_MAP: Record<string, WeddingStatus> = {
  'new': 'inquiry',
  'new inquiry': 'inquiry',
  'inquiry': 'inquiry',
  'open': 'inquiry',
  'tour scheduled': 'tour_scheduled',
  'tour_scheduled': 'tour_scheduled',
  'tour booked': 'tour_scheduled',
  'tour completed': 'tour_completed',
  'tour_completed': 'tour_completed',
  'proposal sent': 'proposal_sent',
  'proposal_sent': 'proposal_sent',
  'booked': 'booked',
  'won': 'booked',
  'closed won': 'booked',
  'completed': 'completed',
  'lost': 'lost',
  'closed lost': 'lost',
  'no response': 'lost',
  'unresponsive': 'lost',
  'archived': 'lost',
  'cancelled': 'cancelled',
  'canceled': 'cancelled',
}

function mapStatus(raw: string | null | undefined): WeddingStatus {
  if (!raw) return 'inquiry'
  const key = raw.trim().toLowerCase()
  return STATUS_MAP[key] ?? null
}

// ---------------------------------------------------------------------------
// Money + guests + date helpers
// ---------------------------------------------------------------------------

/**
 * Knot's Budget field is usually a free-text range ("$10,000 - $20,000",
 * "Under $5,000", "$25k+", "TBD"). Convert to Cents at the midpoint of
 * any numeric range; return null on fuzzy / unparseable values.
 */
function parseBudgetToCents(raw: string | null | undefined): Cents | null {
  if (raw == null) return null
  const text = raw.trim()
  if (!text) return null
  // Pull dollar-prefixed numbers (with optional k/K suffix for thousands).
  const numbers: number[] = []
  const re = /\$?\s*([\d,]+(?:\.\d+)?)\s*(k|K)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw1 = m[1].replace(/,/g, '')
    const n = Number(raw1)
    if (!Number.isFinite(n) || n <= 0) continue
    const scaled = m[2] ? n * 1000 : n
    if (scaled >= 100 && scaled <= 10_000_000) numbers.push(scaled)
  }
  if (numbers.length === 0) return null
  // Range → midpoint; single value → use directly; >2 values → average.
  let dollars: number
  if (numbers.length === 1) dollars = numbers[0]
  else if (numbers.length === 2) dollars = Math.round((numbers[0] + numbers[1]) / 2)
  else dollars = Math.round(numbers.reduce((a, b) => a + b, 0) / numbers.length)
  if (!Number.isFinite(dollars) || dollars <= 0) return null
  return dollarsToCents(asDollars(dollars))
}

/** "120-150" → 135 (midpoint). "Under 50" → 50. "200+" → 200. */
function parseGuestCount(raw: string | null | undefined): number | null {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null
  // Single number
  const single = text.match(/^\s*(\d+)\s*\+?\s*$/)
  if (single) {
    const n = Number(single[1])
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return n
  }
  // Range "120-150" → midpoint 135.
  const range = text.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (range) {
    const lo = Number(range[1])
    const hi = Number(range[2])
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
      const mid = Math.round((lo + hi) / 2)
      if (mid >= 1 && mid <= 1000) return mid
    }
  }
  // "Under N" / "less than N" → N
  const under = text.match(/(?:under|less\s*than|<)\s*(\d+)/i)
  if (under) {
    const n = Number(under[1])
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return n
  }
  // "N+" / "over N" / "more than N" → N
  const over = text.match(/(?:over|more\s*than|>)\s*(\d+)|^(\d+)\s*\+\s*$/i)
  if (over) {
    const n = Number(over[1] ?? over[2])
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return n
  }
  return null
}

function parseDateIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function parseDateYmd(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null
  // Reject obviously fuzzy answers ("Summer 2026", "TBD", "Spring").
  if (/sometime|maybe|flexible|spring|summer|fall|winter|tbd|unsure|tba|not\s*sure/i.test(text)
      && !/\b\d{4}\b/.test(text)) {
    return null
  }
  const iso = parseDateIso(text.slice(0, 64))
  if (!iso) return null
  // Sanity-check year range so a date like "0024-01-01" doesn't slip in.
  const yr = Number(iso.slice(0, 4))
  if (yr < 2000 || yr > 2100) return null
  return iso.slice(0, 10)
}

// ---------------------------------------------------------------------------
// Name parsing
// ---------------------------------------------------------------------------

interface ParsedNames {
  partner1_first: string | null
  partner1_last: string | null
  partner2_first: string | null
  partner2_last: string | null
}

function emptyNames(): ParsedNames {
  return {
    partner1_first: null, partner1_last: null,
    partner2_first: null, partner2_last: null,
  }
}

/** "Sarah Chen" → ["Sarah", "Chen"]. */
function splitFullName(raw: string | null | undefined): { first: string | null; last: string | null } {
  if (!raw) return { first: null, last: null }
  const t = raw.trim().split(/\s+/).filter(Boolean)
  if (t.length === 0) return { first: null, last: null }
  if (t.length === 1) return { first: t[0] ?? null, last: null }
  return { first: t[0] ?? null, last: t.slice(1).join(' ') }
}

/**
 * Knot's "Couple Name" field sometimes carries both partners
 * ("Sarah & Mike Chen", "Sarah and Mike Chen"). Mirror the HoneyBook
 * adapter's project-name parser shape so partner2 lands on its own row.
 */
function parseCoupleName(raw: string | null): ParsedNames {
  const empty = emptyNames()
  if (!raw) return empty
  const stripped = raw.trim()
  if (!stripped) return empty

  // Two partners?
  const splitMatch = stripped.split(/\s+(?:&|and|\+)\s+/i)
  if (splitMatch.length === 2) {
    const [left, right] = splitMatch
    const leftTokens = left.trim().split(/\s+/).filter(Boolean)
    const rightTokens = right.trim().split(/\s+/).filter(Boolean)
    const result: ParsedNames = { ...empty }
    if (leftTokens.length === 1 && rightTokens.length >= 2) {
      // "Sarah & Mike Chen" → partner1 inherits the shared last name
      result.partner1_first = leftTokens[0] ?? null
      result.partner2_first = rightTokens[0] ?? null
      result.partner2_last  = rightTokens.slice(1).join(' ')
      result.partner1_last  = result.partner2_last
    } else {
      result.partner1_first = leftTokens[0] ?? null
      if (leftTokens.length > 1) result.partner1_last = leftTokens.slice(1).join(' ')
      result.partner2_first = rightTokens[0] ?? null
      if (rightTokens.length > 1) result.partner2_last = rightTokens.slice(1).join(' ')
    }
    return result
  }

  // Single partner
  const tokens = stripped.split(/\s+/).filter(Boolean)
  if (tokens.length === 1) return { ...empty, partner1_first: tokens[0] ?? null }
  return {
    ...empty,
    partner1_first: tokens[0] ?? null,
    partner1_last: tokens.slice(1).join(' '),
  }
}

// ---------------------------------------------------------------------------
// parse() — CSV → NormalisedLeadRow[]
// ---------------------------------------------------------------------------

async function parseKnot(config: AdapterConfig): Promise<ParseResult> {
  const errors: string[] = []
  const warnings: string[] = []

  if (!config.csvText || !config.csvText.trim()) {
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings }
  }

  const csvRows = parseCsvRows(config.csvText)
  if (csvRows.length < 2) {
    return {
      ok: false, rows: [], warnings,
      errors: ['csv must have a header row and at least one data row'],
    }
  }

  const header = csvRows[0]
  const idx = indexColumns(header)
  if (!idx.hasAnyAnchor) {
    return {
      ok: false, rows: [], warnings,
      errors: [
        `Knot export is missing identity column(s): need at least one of ` +
        `Inquiry Date, Email Address, Couple Name, or First Name. ` +
        `Re-export from Knot Pro (Storefront → Leads → Export to CSV) ` +
        `and ensure the default columns are included.`,
      ],
    }
  }

  const rows: NormalisedLeadRow[] = []
  const get = (data: string[], key: string): string | null => {
    const i = idx.byKey[key]
    if (i == null || i < 0) return null
    return (data[i] ?? '').trim() || null
  }

  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]

    const inquiryRaw  = get(data, 'inquiry_date')
    const inquiryId   = get(data, 'inquiry_id')
    const coupleName  = get(data, 'couple_name')
    const firstName   = get(data, 'first_name')
    const lastName    = get(data, 'last_name')
    const email       = get(data, 'email')
    const phone       = get(data, 'phone')
    const weddingRaw  = get(data, 'wedding_date')
    const guestRaw    = get(data, 'guest_count')
    const budgetRaw   = get(data, 'budget')
    const statusRaw   = get(data, 'status')
    const message     = get(data, 'message')

    if (!email && !coupleName && !firstName) {
      warnings.push(`row ${r}: skipped — no email, couple name, or first name`)
      continue
    }
    if (!email) {
      warnings.push(`row ${r}: missing Email Address — row imported without primary contact email`)
    }

    // Identity: prefer explicit First/Last Name columns; fall back to
    // parsing Couple Name. Always run couple-name parsing so partner2
    // gets populated when present.
    let names: ParsedNames
    if (firstName || lastName) {
      names = { ...emptyNames(), partner1_first: firstName, partner1_last: lastName }
      // Still try to extract partner2 from couple_name if a "&" is present.
      if (coupleName && /\s+(?:&|and|\+)\s+/i.test(coupleName)) {
        const fromCouple = parseCoupleName(coupleName)
        names.partner2_first = fromCouple.partner2_first
        names.partner2_last = fromCouple.partner2_last
      }
    } else {
      names = parseCoupleName(coupleName)
    }

    const status = mapStatus(statusRaw)
    if (status == null && statusRaw) {
      warnings.push(
        `row ${r}: unknown Knot status '${statusRaw}' — defaulting to 'inquiry'`,
      )
    }

    const inquiryIso = parseDateIso(inquiryRaw)
    const weddingYmd = parseDateYmd(weddingRaw)

    // Build the synthetic per-row interaction. Knot is an acquisition
    // channel — every row attests "couple found us via theknot.com",
    // so hear_source is hard-coded to 'the_knot' and signal_class is
    // 'source'. The lead-source-derivation cron Priority-2 reads this.
    const occurredAt = inquiryIso ?? new Date().toISOString()
    const partner1FullName = [names.partner1_first, names.partner1_last]
      .filter(Boolean).join(' ').trim() || null

    const bodyLines: string[] = []
    bodyLines.push(`provider:knot`)
    bodyLines.push(`lead_source:knot`)
    bodyLines.push(`hear_source:the_knot`)
    bodyLines.push(`inquiry_date:${inquiryIso ?? '(unknown)'}`)
    if (inquiryId) bodyLines.push(`inquiry_id:${inquiryId}`)
    if (partner1FullName) bodyLines.push(`partner1_name:${partner1FullName}`)
    if (email) bodyLines.push(`partner1_email:${email}`)
    if (phone) bodyLines.push(`partner1_phone:${phone}`)
    if (weddingYmd) bodyLines.push(`wedding_date:${weddingYmd}`)
    if (guestRaw) bodyLines.push(`guest_count_raw:${guestRaw}`)
    if (budgetRaw) bodyLines.push(`budget_raw:${budgetRaw}`)
    if (statusRaw) bodyLines.push(`status_raw:${statusRaw}`)
    if (message) bodyLines.push(`message:${message.replace(/\n/g, ' / ')}`)
    const body = bodyLines.join('\n')

    // Stamp the per-row extracted_identity so coordinator UIs +
    // retroactive linkage scripts have the data without re-parsing
    // the synth body (same pattern as Calendly / HoneyBook).
    const rowExtractedIdentity: Record<string, unknown> = {
      provider: 'knot',
      hear_source: 'the_knot',
      hear_source_raw: 'theknot.com',
    }
    if (names.partner1_first) rowExtractedIdentity.partner1_first_name = names.partner1_first
    if (names.partner1_last) rowExtractedIdentity.partner1_last_name = names.partner1_last
    if (email) rowExtractedIdentity.partner1_email = email
    if (phone) rowExtractedIdentity.partner1_phone = phone
    if (inquiryId) rowExtractedIdentity.knot_inquiry_id = inquiryId

    // Fingerprint formula for crm_import_rows dedup (migration 335):
    //   1. Inquiry ID → externalId on the interaction (strongest)
    //   2. Fallback composite "{email}|{inquiryDate}" — same shape the
    //      classifyImportRow priority chain uses anyway, but we make
    //      it explicit here so adapters without a Knot inquiry ID still
    //      get stable dedup on weekly re-uploads.
    const externalId = inquiryId
      ?? (email && inquiryIso
        ? `knot:${email.toLowerCase()}|${inquiryIso.slice(0, 10)}`
        : null)

    const adapterInteractions: NormalisedInteractionRow[] = [
      {
        occurred_at: occurredAt,
        direction: 'inbound',
        // Knot inquiries arrive as a web form Knot relays into the
        // venue's Pro inbox. 'web_form' (migration 178) is the right
        // type — interactions.type CHECK includes it.
        type: 'web_form',
        subject: 'Knot storefront inquiry',
        body,
        extracted_identity: rowExtractedIdentity,
        // signal-class-justified: Knot storefront inquiry IS the acquisition channel
        signal_class: 'source',
        // Synthetic provenance row (body starts with "provider:knot");
        // keep it off /agent/inbox — appears on the lead-detail timeline
        // via the surface-agnostic thread loader.
        surface: 'crm_attribution',
        // 2026-05-13 (mig 335) recurring-CSV dedup ledger. Inquiry ID
        // (when present) is the natural stable key for a Knot row;
        // composite email+date fallback when Knot didn't emit one.
        external_id: externalId,
      },
    ]

    // Lost-deals stub when the row is in a lost / cancelled status.
    const lostAtIso =
      status === 'lost' || status === 'cancelled'
        ? (inquiryIso ?? new Date().toISOString())
        : null
    const lostDeal: NormalisedLostDealRow | null =
      status === 'lost' || status === 'cancelled'
        ? {
            lost_at: lostAtIso ?? new Date().toISOString(),
            lost_at_stage: 'inquiry',
            reason_category: 'other',
            reason_detail: 'Imported from Knot (no detail available).',
            competitor_name: null,
          }
        : null

    rows.push({
      source_id: inquiryId ?? email ?? partner1FullName,
      partner1_first_name: names.partner1_first,
      partner1_last_name: names.partner1_last,
      partner1_email: email,
      partner1_phone: phone,
      partner2_first_name: names.partner2_first,
      partner2_last_name: names.partner2_last,
      wedding_date: weddingYmd,
      guest_count_estimate: parseGuestCount(guestRaw),
      booking_value: parseBudgetToCents(budgetRaw),
      status: status ?? 'inquiry',
      // Stream-TT adapter-as-facts: Knot is an acquisition channel but
      // we still leave weddings.source NULL — the synthetic interaction
      // above carries the_knot signal and lead-source-derivation
      // Priority-2 decides the canonical first-touch.
      source: null,
      // source_detail records that this row arrived via the Knot
      // storefront so coordinator UIs surface provenance without
      // reading the synth-interaction body.
      source_detail: 'knot_storefront',
      inquiry_date: inquiryIso,
      booked_at: null,
      lost_at: lostAtIso,
      lost_reason: status === 'lost' || status === 'cancelled' ? 'other' : null,
      notes: message,
      interactions: adapterInteractions,
      tours: [],
      lost_deal: lostDeal,
    })
  }

  return { ok: errors.length === 0, rows, errors, warnings }
}

// ---------------------------------------------------------------------------
// preview() — summary plus first 50 rows
// ---------------------------------------------------------------------------

function previewKnot(rows: NormalisedLeadRow[]): PreviewResult {
  const warnings: string[] = []
  if (rows.length > 50) warnings.push(`only first 50 of ${rows.length} rows shown`)

  const byStatus = new Map<string, number>()
  let earliest: string | null = null
  let latest: string | null = null
  let withEmail = 0
  let withPhone = 0
  let withBudget = 0
  for (const r of rows) {
    byStatus.set(r.status ?? 'inquiry', (byStatus.get(r.status ?? 'inquiry') ?? 0) + 1)
    if (r.wedding_date) {
      if (!earliest || r.wedding_date < earliest) earliest = r.wedding_date
      if (!latest   || r.wedding_date > latest)   latest   = r.wedding_date
    }
    if (r.partner1_email) withEmail += 1
    if (r.partner1_phone) withPhone += 1
    if (r.booking_value != null) withBudget += 1
  }
  if (rows.length > 0) {
    const parts = Array.from(byStatus.entries()).map(([k, v]) => `${k}=${v}`).join(', ')
    warnings.push(`Summary — ${rows.length} Knot inquiries (${parts})`)
    if (earliest && latest) warnings.push(`Wedding-date range: ${earliest} → ${latest}`)
    warnings.push(`Coverage — email:${withEmail} phone:${withPhone} budget:${withBudget}`)
  }

  return {
    rows: rows.slice(0, 50),
    total: rows.length,
    errors: [],
    warnings,
  }
}

// ---------------------------------------------------------------------------
// commit() — funnel through commitNormalisedRows so all adapters share the
// same row → DB shape.
// ---------------------------------------------------------------------------

async function commitKnot(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
}): Promise<CommitResult> {
  // crmSource = 'generic_csv' per the catch-all in the migration-178
  // CHECK enum. Adding a dedicated 'knot' enum value to weddings.crm_source
  // would require its own migration; deferred. The recurring-CSV dedup
  // ledger (crm_import_rows.source) does carry 'knot' as a distinct
  // value already, so per-row identity is correctly partitioned at the
  // dedup layer. provider name is also encoded in
  // interactions.full_body prefix "provider:knot\n…" and source_detail
  // = 'knot_storefront'.
  //
  // defaultInteractionSignalClass = 'crm' — the synthetic per-row
  // interaction parseKnot produces overrides to 'source' on its own
  // row (it IS the acquisition channel). Any future adapter-written
  // interaction without an explicit class falls back to 'crm'.
  //
  // chokepointNameSource = 'csv_import' (65 confidence) — standard
  // CSV-export confidence. Per Wave 2B map.
  return commitNormalisedRows({
    ...args,
    crmSource: 'generic_csv',
    defaultInteractionSignalClass: 'crm',
    chokepointNameSource: 'csv_import',
  })
}

export const knotAdapter: CrmAdapter = {
  name: 'knot',
  label: 'The Knot (CSV export)',
  description:
    'Import a storefront leads CSV exported from Knot Pro (Storefront → Leads → Export). ' +
    'Inquiry Date, Email Address, Couple Name (or First Name + Last Name), Phone Number, ' +
    'Wedding Date, Guest Count, Budget, Status, and Message columns are mapped. ' +
    'Every row is fingerprinted by Inquiry ID (or email+date fallback) so weekly re-uploads ' +
    'are idempotent — only new or state-changed rows mint touchpoints.',
  ready: true,
  parse: parseKnot,
  preview: previewKnot,
  commit: commitKnot,
}
