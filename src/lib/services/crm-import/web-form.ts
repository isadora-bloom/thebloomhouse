/**
 * Web-form intake adapter (T5-Rixey-HH).
 *
 * Generic, NOT Rixey-specific. Most coordinators have SOME web form
 * (Typeform, Jotform, Google Forms, custom HTML, vendor-platform forms,
 * Rixey's pricing calculator). The shape varies wildly venue to venue
 * — the only constants are: (1) one row per submission, (2) some
 * subset of contact / partner / date / guest-count fields, (3) lots
 * of provider-specific custom columns.
 *
 * Design choices:
 *
 * - The adapter ships a small registry of provider HINTS — a hint is a
 *   pre-built FormHint config that knows the provider's typical column
 *   names. Coordinators pick a hint to skip the column-mapping
 *   ceremony. 'custom' hint = generic-csv-style mapping JSON.
 *
 * - Hint coverage at v1:
 *     rixey_calculator   — fully-mapped (Rixey's actual export)
 *     typeform           — column-detection scaffolding for Typeform exports
 *     jotform            — column-detection scaffolding for Jotform exports
 *     google_forms       — column-detection scaffolding for Google Forms exports
 *     custom             — coordinator supplies columnMapping JSON
 *
 * - Per-row writes (SUPERSET of the standard CRM-import three-table
 *   write):
 *     * weddings           — confidence_flag='imported_high' (first-party
 *                            data > third-party CRM), source NULL (per
 *                            T5-Rixey-TT adapter-as-facts contract),
 *                            source_provenance='web_form_import',
 *                            crm_source='web_form'. lead_source resolves
 *                            via the derivation chain reading the per-
 *                            row interaction's extracted_identity.
 *     * interactions       — direction='inbound', type='web_form',
 *                            body = readable concatenation of the
 *                            relevant filled-in form fields + free-text
 *                            notes, occurred_at = submission timestamp.
 *     * tangential_signals — source_platform='website_form' (or
 *                            'website_<provider>'), signal_type=
 *                            'form_submission', payload = full form data.
 *                            Powers funnel + timing analytics.
 *
 *   This is on top of the standard people insert that
 *   commitNormalisedRows() handles.
 *
 * - Canonical-packages extraction (separate one-time path) — the form
 *   often encodes the venue's pricing structure. The Rixey form has
 *   "Wedding Season" (Spring/Summer/Fall/Winter tiers), "Upgrades"
 *   (rehearsal dinner, extra hour), "Discounts" (military, vendor-
 *   recommended). extractPackagesFromFormSchema() walks the form's
 *   columns + values and proposes packages rows for the coordinator
 *   to confirm via /onboarding/extract-packages. See
 *   web-form-packages.ts.
 *
 * - The adapter is INDEPENDENT of the CRM adapter. A venue might have
 *   BOTH (Rixey calculator + HoneyBook). They're complementary
 *   sources, not alternatives. Stream KK does post-import dedup.
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
  CrmSource,
} from './index'
// Dynamic import below at call site — see commitWebForm(). Importing
// commitNormalisedRows statically here creates a load-time cycle with
// ./index (index.ts imports webFormAdapter; web-form imports
// commitNormalisedRows). Webpack tolerated the cycle; Turbopack throws
// "Cannot access 'p' before initialization" during page-data collection
// for /api/onboarding/extract-packages because the cycle resolves to an
// uninitialized binding at module-eval time. Dynamic import defers the
// resolution to call time, after both modules have finished evaluating.
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'
import { type Cents, asDollars, dollarsToCents } from '@/lib/types/monetary'
import {
  splitConcatenatedCoupleName,
  looksLikeConcatenatedCoupleName,
} from './primitives/couple-parser'

// ---------------------------------------------------------------------------
// Provider hint shape — a config the adapter consumes to know which
// columns mean what. Coordinators pick a hint via the UI; hint defaults
// can be overridden by AdapterConfig.columnMapping.
// ---------------------------------------------------------------------------

export interface FormHint {
  provider: string
  label: string
  description: string

  /** Column header (case-insensitive substring or regex string) for the
   *  submission timestamp. */
  dateColumn?: string

  /** Reference / submission ID column. */
  referenceColumn?: string

  /** Contact identity columns. */
  contactNameColumn?: string
  contactEmailColumn?: string
  contactPhoneColumn?: string
  partnerNameColumn?: string
  partnerEmailColumn?: string
  partnerPhoneColumn?: string

  /** Event / wedding details. */
  weddingDateColumn?: string         // free-text date column ("June 20, 2026")
  guestCountColumn?: string          // numeric or labeled tier ("100-150")
  notesColumn?: string               // free-text "anything else?" column

  /** Pricing-related columns — these double as canonical-packages
   *  extraction sources. */
  packageColumns?: string[]          // tier columns ("Wedding Season")
  upgradeColumns?: string[]          // upgrade columns ("Upgrades")
  discountColumns?: string[]         // discount columns ("Discounts 5%")
  calculatedTotalColumn?: string     // final-total column
  preTaxTotalColumn?: string         // pre-tax / pre-discount total

  /** Free-text lead-intent column ("Would you like to..."). */
  intentColumn?: string

  /** Stream WWW: optional column carrying the referrer URL (full URL,
   *  may include UTM parameters in its query string). When present,
   *  parseUtmFromRow() extracts UTM keys from the URL's query string
   *  in addition to direct utm_* columns. */
  referrerColumn?: string

  /** Columns that should be excluded from the readable interaction body
   *  (purely numeric helpers, calculated subtotals, etc.). */
  ignoreColumns?: string[]
}

// ---------------------------------------------------------------------------
// Built-in hints. rixey_calculator is fully-mapped from the actual export
// at C:\Users\Ismar\Downloads\Rixey Manor Pricing Entries (3).csv.
// The other three are scaffolds covering the typical export shape but
// will need coordinator confirmation per-tenant.
// ---------------------------------------------------------------------------

export const RIXEY_CALCULATOR_HINT: FormHint = {
  provider: 'rixey_calculator',
  label: 'Rixey Manor pricing calculator',
  description:
    'Pre-configured for the Rixey Manor pricing-calculator export. Maps Partner One/Two name+email+phone, '
    + 'wedding-season tier, guest count, overnight stay, upgrades, discounts, and the calculated total.',
  dateColumn: 'Received',
  referenceColumn: 'Reference Number',
  contactNameColumn: 'Partner One Name',
  contactEmailColumn: 'Partner One Email',
  contactPhoneColumn: 'Partner One Phone Number (required to request contract)',
  partnerNameColumn: 'Partner Two Name',
  partnerEmailColumn: 'Partner Two Email',
  partnerPhoneColumn: 'Partner Two Phone Number',
  weddingDateColumn: 'Do you have a Specific Date in Mind?',
  guestCountColumn: 'How Many Guests (guests over aprox 100 will need a tent on the patio rented separately)',
  notesColumn: 'Is there anything else you would like to share with us?',
  packageColumns: ['Wedding Season (2026/2027)', 'Wedding Season 2025'],
  upgradeColumns: ['Upgrades', 'How Many Nights Stay (we sleep up to 14 people comfortably)', 'Hourly Events'],
  discountColumns: [
    'Discounts 5%',
    'Discounts 10%',
    'Percentage 5% Discount',
    'Percentage 10% Discount',
    'Overnight Stays in Lieu of Discounts',
  ],
  calculatedTotalColumn: 'After Tax',
  preTaxTotalColumn: 'Total Before Discounts',
  intentColumn: 'Would you like to...',
  ignoreColumns: [
    ' ', // first column is a blank checkbox-style col
    'Wedding Season Total',
    'Extra Guests',
    'How Many Nights Stay Total',
    'Total After Discounts',
    'Each Payment',
    'Discounts Total',
    'How Many Guests Total',
    'Upgrades Total',
    'Included With All Our Weddings',
  ],
}

export const TYPEFORM_HINT: FormHint = {
  provider: 'typeform',
  label: 'Typeform',
  description:
    'Scaffold for typical Typeform exports. Typeform exports include "Submitted At" + "Network ID" + one column '
    + 'per question. Confirm column mappings on first import — column names are user-defined per form.',
  dateColumn: 'Submitted At',
  referenceColumn: 'Network ID',
  contactNameColumn: 'Name',
  contactEmailColumn: 'Email',
  contactPhoneColumn: 'Phone',
  partnerNameColumn: "Partner's Name",
  partnerEmailColumn: "Partner's Email",
  weddingDateColumn: 'Wedding Date',
  guestCountColumn: 'Guest Count',
  notesColumn: 'Anything else?',
  packageColumns: ['Package'],
  upgradeColumns: ['Add-Ons'],
  discountColumns: ['Discount Code'],
}

export const JOTFORM_HINT: FormHint = {
  provider: 'jotform',
  label: 'Jotform',
  description:
    'Scaffold for typical Jotform exports. Jotform exports include "Submission Date" + "Submission ID" + '
    + 'one column per question. Confirm column mappings on first import.',
  dateColumn: 'Submission Date',
  referenceColumn: 'Submission ID',
  contactNameColumn: 'Name',
  contactEmailColumn: 'Email',
  contactPhoneColumn: 'Phone Number',
  partnerNameColumn: 'Partner Name',
  partnerEmailColumn: 'Partner Email',
  weddingDateColumn: 'Event Date',
  guestCountColumn: 'Number of Guests',
  notesColumn: 'Additional Information',
  packageColumns: ['Package Selection'],
  upgradeColumns: ['Upgrades'],
  discountColumns: ['Discounts'],
}

export const GOOGLE_FORMS_HINT: FormHint = {
  provider: 'google_forms',
  label: 'Google Forms',
  description:
    'Scaffold for Google Forms responses exported to CSV (or via Sheets). Always includes "Timestamp"; '
    + 'other columns are the literal question prompts. Confirm column mappings on first import.',
  dateColumn: 'Timestamp',
  contactNameColumn: 'Your Name',
  contactEmailColumn: 'Email Address',
  contactPhoneColumn: 'Phone Number',
  partnerNameColumn: "Partner's Name",
  partnerEmailColumn: "Partner's Email",
  weddingDateColumn: 'Wedding Date',
  guestCountColumn: 'Estimated Guest Count',
  notesColumn: 'Anything else you would like to share?',
}

export const CUSTOM_HINT: FormHint = {
  provider: 'custom',
  label: 'Custom (provide column mapping)',
  description:
    'For any form not covered by the pre-built hints. Supply a columnMapping JSON like { "contactEmailColumn": '
    + '"Your CSV Header" } — the keys are FormHint fields, values are the literal CSV header names.',
}

export const FORM_HINTS: ReadonlyArray<FormHint> = [
  RIXEY_CALCULATOR_HINT,
  TYPEFORM_HINT,
  JOTFORM_HINT,
  GOOGLE_FORMS_HINT,
  CUSTOM_HINT,
]

export function findHint(provider: string | null | undefined): FormHint | null {
  if (!provider) return null
  return FORM_HINTS.find((h) => h.provider === provider) ?? null
}

// ---------------------------------------------------------------------------
// Coercion helpers (deliberately tolerant — form data is messy).
// ---------------------------------------------------------------------------

/** "$17,119" / "17,119" / "17,119.00" → 1711900 (cents).
 *  T5-Rixey-RR fix #5: typed return surfaces the unit at every call site. */
function parseMoneyToCents(raw: string | null | undefined): Cents | null {
  if (raw == null) return null
  const cleaned = String(raw).replace(/[$,\s]/g, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return dollarsToCents(asDollars(n))
}

/** "1 month ago 2026-03-23" / "2026-03-23" / "March 23, 2026" → ISO timestamp. */
function parseDateIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  // Strip leading "X months ago " / "1 year ago " prefixes Rixey ships.
  const stripped = trimmed.replace(/^\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\s+/i, '').trim()
  if (!stripped) return null
  // Try the stripped form first, then the original (in case stripping
  // ate something legitimate).
  for (const candidate of [stripped, trimmed]) {
    const d = new Date(candidate)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return null
}

function parseDateYmd(raw: string | null | undefined): string | null {
  const iso = parseDateIso(raw)
  return iso ? iso.slice(0, 10) : null
}

/** "100-150: $1000" → 125 (midpoint). "100-150" → 125. "100" → 100. "100+" → 100.
 *  "50-100 guests" → 75. */
function parseGuestCount(raw: string | null | undefined): number | null {
  if (!raw) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  // Split off any trailing ": $X" pricing tag.
  const beforeColon = trimmed.split(':')[0].trim()
  // Range: "100-150"
  const range = beforeColon.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (range) {
    const lo = Number(range[1])
    const hi = Number(range[2])
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return Math.round((lo + hi) / 2)
    }
  }
  // Single: "100" or "100+"
  const single = beforeColon.match(/^(\d+)/)
  if (single) {
    const n = Number(single[1])
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Lightweight phone normalizer. The Rixey export ships phone numbers as
 *  "2,405,861,345" — Excel comma-grouping of a 10-digit number.
 *  Strip non-digits, return null for empty / obviously-bogus values. */
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (!digits) return null
  if (digits.length < 7 || digits.length > 15) return null  // sanity range
  return digits
}

/** Best-effort parse of "First Last" → { first, last }. Single-token
 *  becomes first only. */
function splitFullName(raw: string | null | undefined): { first: string | null; last: string | null } {
  if (!raw) return { first: null, last: null }
  const tokens = String(raw).trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { first: null, last: null }
  if (tokens.length === 1) return { first: tokens[0] ?? null, last: null }
  return { first: tokens[0] ?? null, last: tokens.slice(1).join(' ') }
}

// ---------------------------------------------------------------------------
// Stream WWW: UTM extraction.
//
// Forms ship UTM either as direct columns (utm_source / utm_medium / etc.,
// case-insensitive — Typeform / Jotform export them lower-case, Google
// Forms preserves the question prompt) or embedded in a referrer URL's
// query string (e.g. "https://venue.com/inquire?utm_source=knot").
//
// extractUtmFromRow walks BOTH paths:
//   1. Find any header that looks like utm_<key> (case-insensitive,
//      with optional whitespace).
//   2. If a referrer column is configured AND has a value, parse its
//      query string and pull utm_* keys from there too. Direct columns
//      win over referrer-URL extraction (the form had a dedicated field
//      for it, so it's more reliable).
//
// Returns { utm_source, utm_medium, utm_campaign, utm_term, utm_content }
// — any subset that was actually present. Empty result = no UTM in this row.
// ---------------------------------------------------------------------------

export interface UtmFields {
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_term?: string | null
  utm_content?: string | null
}

const UTM_KEYS: ReadonlyArray<keyof UtmFields> = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
]

function parseUtmFromUrl(rawUrl: string | null | undefined): UtmFields {
  if (!rawUrl) return {}
  try {
    // The URL constructor accepts both absolute URLs and ?-prefixed
    // query strings via a base. Try absolute first; fall back to
    // base + path-relative for raw query strings like "?utm_source=knot".
    let url: URL
    try {
      url = new URL(String(rawUrl).trim())
    } catch {
      url = new URL(String(rawUrl).trim(), 'https://placeholder.invalid')
    }
    const out: UtmFields = {}
    for (const key of UTM_KEYS) {
      // searchParams keys are case-sensitive, but UTM keys are
      // canonically lowercase. Walk every entry once and lowercase
      // for the match so "Utm_Source" / "UTM_SOURCE" both land.
      for (const [k, v] of url.searchParams.entries()) {
        if (k.toLowerCase() === key && v) {
          out[key] = v
          break
        }
      }
    }
    return out
  } catch {
    // Malformed URL — degrade gracefully, no UTM.
    return {}
  }
}

function extractUtmFromRow(args: {
  hdr: HeaderIndex
  row: string[]
  referrerColumnIdx: number
}): UtmFields {
  const { hdr, row, referrerColumnIdx } = args
  const out: UtmFields = {}

  // Path 1: scan headers for case-insensitive utm_<key> matches.
  // Walk every header so "Utm_Source", "UTM Source", "utm_source"
  // all land. Match against the canonical lowercase key set.
  for (let i = 0; i < hdr.raw.length; i++) {
    const headerNorm = hdr.raw[i].trim().toLowerCase().replace(/\s+/g, '_')
    for (const key of UTM_KEYS) {
      if (headerNorm === key && !out[key]) {
        const v = (row[i] ?? '').trim()
        if (v && v !== '...') out[key] = v
      }
    }
  }

  // Path 2: if a referrer URL column is configured AND has a value,
  // parse query string. Direct columns win — only fill in keys that
  // path 1 didn't already populate.
  if (referrerColumnIdx >= 0) {
    const referrerRaw = (row[referrerColumnIdx] ?? '').trim()
    if (referrerRaw) {
      const fromUrl = parseUtmFromUrl(referrerRaw)
      for (const key of UTM_KEYS) {
        if (!out[key] && fromUrl[key]) out[key] = fromUrl[key]
      }
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Header indexing — case-insensitive, exact-match-first, then substring.
// ---------------------------------------------------------------------------

interface HeaderIndex {
  raw: string[]                                  // original headers, preserved
  byLowerExact: Map<string, number>              // lowercased header → idx
  byTrimmedLowerExact: Map<string, number>       // trimmed + lowercased
}

function buildHeaderIndex(headers: string[]): HeaderIndex {
  const byLowerExact = new Map<string, number>()
  const byTrimmedLowerExact = new Map<string, number>()
  headers.forEach((h, i) => {
    byLowerExact.set(h.toLowerCase(), i)
    byTrimmedLowerExact.set(h.trim().toLowerCase(), i)
  })
  return { raw: headers, byLowerExact, byTrimmedLowerExact }
}

/** Resolve a hint-supplied column name to an index in the header. Tries
 *  exact (case-insensitive), trimmed exact, and substring (lower-case). */
function findColumn(hdr: HeaderIndex, name: string | undefined): number {
  if (!name) return -1
  const ll = name.toLowerCase()
  const exact = hdr.byLowerExact.get(ll)
  if (exact != null) return exact
  const trimmed = hdr.byTrimmedLowerExact.get(name.trim().toLowerCase())
  if (trimmed != null) return trimmed
  // Substring match — last resort, returns first hit.
  for (let i = 0; i < hdr.raw.length; i++) {
    if (hdr.raw[i].trim().toLowerCase().includes(ll)) return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Build the readable interaction body. Concatenates the filled-in form
// fields (skipping ignore-listed and empty values) into a markdown-ish
// "Field: value" block. Free-text notes get their own paragraph at the end.
// ---------------------------------------------------------------------------

function buildInteractionBody(args: {
  hint: FormHint
  hdr: HeaderIndex
  row: string[]
  notes: string | null
}): string {
  const { hint, hdr, row, notes } = args
  const ignore = new Set((hint.ignoreColumns ?? []).map((c) => c.trim().toLowerCase()))
  // Collect all non-empty cells whose header isn't on the ignore list.
  const lines: string[] = []
  for (let i = 0; i < hdr.raw.length; i++) {
    const header = hdr.raw[i]
    const trimmedLower = header.trim().toLowerCase()
    if (ignore.has(trimmedLower)) continue
    if (!header || !header.trim()) continue            // skip blank-header columns
    const value = (row[i] ?? '').trim()
    if (!value || value === '0' || value === '...') continue
    // Don't echo the notes column here — we render it separately below.
    if (hint.notesColumn && header.toLowerCase() === hint.notesColumn.toLowerCase()) continue
    lines.push(`${header.trim()}: ${value}`)
  }
  const main = lines.join('\n')
  if (notes && notes.trim()) {
    return `${main}\n\nNotes from couple:\n${notes.trim()}`
  }
  return main
}

// ---------------------------------------------------------------------------
// parse() — CSV → NormalisedLeadRow[]
// ---------------------------------------------------------------------------

interface WebFormAdapterConfig extends AdapterConfig {
  /** Provider hint key — picks one of FORM_HINTS. */
  formProvider?: string
  /** Override fields on the resolved hint. Useful for the 'custom' hint
   *  or for tweaking a built-in. Keys mirror FormHint field names. */
  hintOverrides?: Partial<FormHint>
}

async function parseWebForm(config: AdapterConfig): Promise<ParseResult> {
  const errors: string[] = []
  const warnings: string[] = []

  const cfg = config as WebFormAdapterConfig
  if (!cfg.csvText || !cfg.csvText.trim()) {
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings }
  }

  // Resolve the hint. 'custom' provider requires hintOverrides or columnMapping
  // to actually mean anything.
  const baseHint = findHint(cfg.formProvider) ?? CUSTOM_HINT
  const hint: FormHint = {
    ...baseHint,
    ...(cfg.hintOverrides ?? {}),
  }

  // Allow legacy columnMapping (the generic-csv style) to populate the
  // hint's contact fields. This is how the 'custom' hint gets configured
  // when a coordinator uses the existing generic UI.
  if (cfg.columnMapping) {
    const m = cfg.columnMapping
    if (m.contactNameColumn) hint.contactNameColumn = m.contactNameColumn
    if (m.contactEmailColumn) hint.contactEmailColumn = m.contactEmailColumn
    if (m.contactPhoneColumn) hint.contactPhoneColumn = m.contactPhoneColumn
    if (m.partnerNameColumn) hint.partnerNameColumn = m.partnerNameColumn
    if (m.partnerEmailColumn) hint.partnerEmailColumn = m.partnerEmailColumn
    if (m.dateColumn) hint.dateColumn = m.dateColumn
    if (m.weddingDateColumn) hint.weddingDateColumn = m.weddingDateColumn
    if (m.guestCountColumn) hint.guestCountColumn = m.guestCountColumn
    if (m.notesColumn) hint.notesColumn = m.notesColumn
  }

  const csvRows = parseCsvRows(cfg.csvText)
  if (csvRows.length < 2) {
    return {
      ok: false, rows: [], warnings,
      errors: ['csv must have a header row and at least one data row'],
    }
  }

  const hdr = buildHeaderIndex(csvRows[0])

  // Resolve every interesting column. -1 means "absent in this CSV".
  const idxDate          = findColumn(hdr, hint.dateColumn)
  const idxRef           = findColumn(hdr, hint.referenceColumn)
  const idxContactName   = findColumn(hdr, hint.contactNameColumn)
  const idxContactEmail  = findColumn(hdr, hint.contactEmailColumn)
  const idxContactPhone  = findColumn(hdr, hint.contactPhoneColumn)
  const idxPartnerName   = findColumn(hdr, hint.partnerNameColumn)
  const idxPartnerEmail  = findColumn(hdr, hint.partnerEmailColumn)
  const idxPartnerPhone  = findColumn(hdr, hint.partnerPhoneColumn)
  const idxWeddingDate   = findColumn(hdr, hint.weddingDateColumn)
  const idxGuestCount    = findColumn(hdr, hint.guestCountColumn)
  const idxNotes         = findColumn(hdr, hint.notesColumn)
  const idxTotal         = findColumn(hdr, hint.calculatedTotalColumn)
  const idxIntent        = findColumn(hdr, hint.intentColumn)
  // Stream WWW: optional referrer URL column for UTM extraction.
  // Direct utm_<key> headers are detected scan-style in
  // extractUtmFromRow and don't need an upfront resolve.
  const idxReferrer      = findColumn(hdr, hint.referrerColumn)

  if (idxContactEmail < 0 && idxContactName < 0) {
    return {
      ok: false, rows: [], warnings,
      errors: [
        `Could not locate a contact column. Looked for email='${hint.contactEmailColumn ?? '(unset)'}', `
        + `name='${hint.contactNameColumn ?? '(unset)'}'. Pick a different provider hint or supply hintOverrides.`,
      ],
    }
  }

  const rows: NormalisedLeadRow[] = []
  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]
    const get = (i: number): string | null => {
      if (i < 0) return null
      const v = (data[i] ?? '').trim()
      return v && v !== '...' ? v : null
    }

    const contactName  = get(idxContactName)
    const contactEmail = get(idxContactEmail)
    const contactPhone = get(idxContactPhone)
    const partnerName  = get(idxPartnerName)
    const partnerEmail = get(idxPartnerEmail)
    const partnerPhone = get(idxPartnerPhone)
    const submissionDt = get(idxDate)
    const weddingDate  = get(idxWeddingDate)
    const guestCount   = get(idxGuestCount)
    const notes        = get(idxNotes)
    const totalRaw     = get(idxTotal)
    const intentRaw    = get(idxIntent)
    const refRaw       = get(idxRef)

    // Skip rows with no identity at all.
    if (!contactName && !contactEmail && !partnerName && !partnerEmail) {
      warnings.push(`row ${r}: skipped — no contact identity`)
      continue
    }

    const p1 = splitFullName(contactName)
    const p2 = splitFullName(partnerName)

    // T5-Rixey-UU Bug G: web-form contactName is often a single
    // concatenated string when the source form had one "name" field
    // and the user typed both partners without spaces (e.g.
    // "Megandcooperrosenberg"). When the splitter is confident, we
    // promote the split into p1 + p2; when it's not, we leave the
    // name as-is and emit a warning so the coordinator can fix it
    // manually via the lead detail.
    const importWarnings: Array<{ field: string; issue: string; value?: string | null }> = []

    // Only run the splitter when:
    //   - p1 looks like a concat candidate (no space, ≥ 12 chars,
    //     mixed case or all-lowercase), AND
    //   - p2 has no first name (no separate partnerName column was
    //     filled — otherwise we'd be overwriting real data).
    const p1FullForCheck = [p1.first, p1.last].filter(Boolean).join('') || p1.first
    if (
      !p2.first &&
      !partnerName &&
      looksLikeConcatenatedCoupleName(p1FullForCheck)
    ) {
      const splitResult = splitConcatenatedCoupleName(p1FullForCheck)
      if (splitResult.confidence === 'confident' && splitResult.partner1 && splitResult.partner2) {
        // Promote — partner2 inherits the surname (if any).
        p1.first = splitResult.partner1
        p1.last = splitResult.surname
        p2.first = splitResult.partner2
        p2.last = splitResult.surname
        warnings.push(`row ${r}: split concatenated couple-name "${contactName}" → "${splitResult.partner1}" / "${splitResult.partner2}${splitResult.surname ? ' ' + splitResult.surname : ''}" (${splitResult.reason})`)
      } else {
        // Leave as-is, flag for coordinator review. The original
        // string survives in p1.first so they can see what came in.
        importWarnings.push({
          field: 'couple_name',
          issue: 'unparseable_concat',
          value: contactName ?? null,
        })
        warnings.push(`row ${r}: couldn't confidently split concatenated name "${contactName}" — flagged for review (${splitResult.reason})`)
      }
    }

    const submissionIso = parseDateIso(submissionDt) ?? new Date().toISOString()

    // Build the human-readable interaction body — a "fields filled in"
    // dump that Sage's draft-context loader + the wedding timeline can
    // surface inline.
    const body = buildInteractionBody({ hint, hdr, row: data, notes })

    const interaction: NormalisedInteractionRow = {
      occurred_at: submissionIso,
      direction: 'inbound',
      type: 'web_form' as NormalisedInteractionRow['type'],  // migration 178 widens the CHECK
      subject: refRaw ? `Web form submission #${refRaw}` : 'Web form submission',
      body,
      // T5-Rixey-TT: tee the form-provider hint into extracted_identity
      // so the lead-source-derivation chain can distinguish first-party
      // calculator submissions ("website") from a generic third-party
      // form (still "website" but lower confidence).
      extracted_identity: {
        provider: hint.provider,
        is_first_party: hint.provider === 'rixey_calculator',
        // hear_source feeds Priority-2 directly. 'website' is the
        // structural answer for calculator submissions.
        hear_source: 'website',
      },
      // T5-Rixey-BBB: form submissions are touchpoint class. The
      // lead used the calculator AFTER discovering the venue — the
      // upstream source (the_knot / google / referral / etc.) is
      // recovered via the cluster walk against tangential_signals
      // (Knot view, IG follow) or earlier interactions on the same
      // person identity.
      // signal-class-justified: web-form submissions are touchpoint, not source
      signal_class: 'touchpoint',
      // Wave 28 (mig 294): the form submission IS the event, not an
      // email about it. Keep it off /agent/inbox; lead-detail timelines
      // aggregate every surface.
      surface: 'integration_event',
    }

    // Compose a notes blob for the wedding (intent + free-text + total).
    const weddingNotesParts: string[] = []
    if (intentRaw) weddingNotesParts.push(`Intent: ${intentRaw}`)
    if (notes) weddingNotesParts.push(`Notes: ${notes}`)
    if (totalRaw) weddingNotesParts.push(`Calculated total: ${totalRaw}`)
    const weddingNotes = weddingNotesParts.join('\n') || null

    // Stream WWW: extract UTM parameters per row. Walks both direct
    // utm_<key> headers (case-insensitive) and the optional referrer-
    // URL column's query string. Direct columns win when both are
    // present. Empty result {} means no UTM in this submission —
    // wedding row lands with utm_source NULL, attribution falls back
    // to the existing derivation chain.
    const utm = extractUtmFromRow({ hdr, row: data, referrerColumnIdx: idxReferrer })

    // T5-Rixey-TT adapter-as-facts: web-form intake leaves
    // weddings.source NULL. The factual provenance lives in
    // crm_source='web_form' + source_detail (provider name) + the
    // tangential_signals row written in commit(). Lead-source-
    // derivation Priority-3 reads the form-submission interaction
    // and stamps lead_source='website' from the structural signal,
    // which is the right path because:
    //   (a) it goes through the same chain as every other source,
    //       so coordinator overrides + audit logging work uniformly
    //   (b) it leaves room for upstream attribution (Calendly Q7,
    //       UTM tags, email-domain) to override 'website' with the
    //       channel that drove the calculator submission, when the
    //       cluster matching catches that.
    // The interaction's extracted_identity carries the form-provider
    // hint so Priority-3 can distinguish "first-party calculator" from
    // a generic web form.
    rows.push({
      source_id: refRaw,
      partner1_first_name: p1.first,
      partner1_last_name: p1.last,
      partner1_email: contactEmail,
      partner1_phone: normalizePhone(contactPhone),
      partner2_first_name: p2.first,
      partner2_last_name: p2.last,
      partner2_email: partnerEmail,
      partner2_phone: normalizePhone(partnerPhone),
      wedding_date: parseDateYmd(weddingDate),
      guest_count_estimate: parseGuestCount(guestCount),
      booking_value: parseMoneyToCents(totalRaw),
      // status — web-form submission is a brand-new inquiry. Coordinator
      // can flip it later via the lead detail UI.
      status: 'inquiry',
      // T5-Rixey-TT (adapter-as-facts): adapters write FACTS, not attribution.
      // Web-form is a factual touchpoint via the website; the actual lead
      // source (the_knot, google, referral) belongs in lead_source via the
      // derivation chain reading interactions.extracted_identity. Set
      // source NULL here; back-trace + Q7/UTM/email-domain decide attribution.
      source: null,
      // T5-Rixey-UU Bug G: per-row import-time warnings flow through
      // to weddings.import_warnings via commitNormalisedRows.
      import_warnings: importWarnings.length > 0 ? importWarnings : null,
      source_detail: hint.provider === 'rixey_calculator'
        ? 'Rixey pricing calculator'
        : `web_form_${hint.provider}`,
      inquiry_date: submissionIso,
      booked_at: null,
      lost_at: null,
      lost_reason: null,
      notes: weddingNotes,
      // Stream WWW: thread UTM into NormalisedLeadRow. The shared
      // commitNormalisedRows helper writes these to weddings.utm_*
      // and stamps utm_first_seen_at = submissionIso when any UTM
      // is present.
      utm_source: utm.utm_source ?? null,
      utm_medium: utm.utm_medium ?? null,
      utm_campaign: utm.utm_campaign ?? null,
      utm_term: utm.utm_term ?? null,
      utm_content: utm.utm_content ?? null,
      interactions: [interaction],
      tours: [],
      lost_deal: null,
    })
  }

  return { ok: errors.length === 0, rows, errors, warnings }
}

// ---------------------------------------------------------------------------
// preview() — summary header + first 50 rows
// ---------------------------------------------------------------------------

function previewWebForm(rows: NormalisedLeadRow[]): PreviewResult {
  const warnings: string[] = []
  if (rows.length > 50) warnings.push(`only first 50 of ${rows.length} rows shown`)
  if (rows.length > 0) {
    const withEmail = rows.filter((r) => r.partner1_email).length
    const withDate  = rows.filter((r) => r.wedding_date).length
    const withGuest = rows.filter((r) => r.guest_count_estimate).length
    const withTotal = rows.filter((r) => r.booking_value != null).length
    warnings.push(
      `Summary — ${rows.length} submissions; `
      + `${withEmail} with contact email, ${withDate} with wedding date, `
      + `${withGuest} with guest count, ${withTotal} with calculated total.`,
    )
  }
  return {
    rows: rows.slice(0, 50),
    total: rows.length,
    errors: [],
    warnings,
  }
}

// ---------------------------------------------------------------------------
// commit() — funnel through commitNormalisedRows for the standard
// weddings + people + interactions writes, then add the web-form-specific
// extras (tangential_signals row + source_provenance stamp).
// ---------------------------------------------------------------------------

async function commitWebForm(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
}): Promise<CommitResult> {
  const { supabase, venueId, rows } = args

  // Pre-stamp source_provenance on each row's notes side-channel by
  // patching weddings post-insert. commitNormalisedRows() doesn't know
  // about source_provenance — easiest path is to patch after the fact.
  // We collect the inserted wedding ids by pulling rows that were just
  // tagged crm_source='web_form' since the call.
  const { commitNormalisedRows } = await import('./index')
  const baseResult = await commitNormalisedRows({
    ...args,
    crmSource: 'web_form',
    confidenceFlag: 'imported_high',
    sourceProvenance: 'web_form_import',
    // T5-Rixey-BBB: every web-form interaction is a touchpoint by
    // default. Per-row overrides (the synthetic interaction above
    // already declares 'touchpoint' explicitly) take precedence.
    defaultInteractionSignalClass: 'touchpoint',
    // Wave 2B: calculator-form fields are coordinator-shaped + structured.
    // Highest non-coordinator NameSource (95) — the picker should beat
    // anything but a contract signer or coordinator override.
    chokepointNameSource: 'calculator_form',
  })

  if (!baseResult.ok) return baseResult

  // Write one tangential_signals row per submission. We don't need to
  // join back to the inserted wedding — the per-row identity payload is
  // enough for the funnel + timing analytics that read this table.
  const tangentialRows = rows.map((r) => ({
    venue_id: venueId,
    signal_type: 'form_submission',
    source_platform: 'website_form',
    action_class: 'inquiry',
    extracted_identity: {
      first_name: r.partner1_first_name ?? null,
      last_name: r.partner1_last_name ?? null,
      email: r.partner1_email ?? null,
      phone: r.partner1_phone ?? null,
      partner_first_name: r.partner2_first_name ?? null,
      partner_last_name: r.partner2_last_name ?? null,
      guest_count: r.guest_count_estimate ?? null,
      wedding_date: r.wedding_date ?? null,
      reference: r.source_id ?? null,
    },
    source_context: r.source_detail ?? 'web_form_import',
    signal_date: r.inquiry_date ?? new Date().toISOString(),
    // C-INGEST-5 Finding 2 fix (2026-05-08): was writing confirmed_match
    // with matched_person_id=null + confidence=1.0, which inflated the
    // confirmed-match rate on /intel/sources/parity and blocked FK
    // joins from finding the person. Writes unmatched instead;
    // phase_b_sweep promotes when the inquiry's person row arrives.
    match_status: 'unmatched',
    matched_person_id: null,
    confidence_score: null,
    // T5-Rixey-BBB: form-submission tangentials are touchpoint
    // class — the lead's interaction tool, not the discovery channel.
    // signal-class-justified: form_submission is a touchpoint signal_type
    signal_class: 'touchpoint' as const,
  }))

  if (tangentialRows.length > 0) {
    const { error: tangErr } = await supabase.from('tangential_signals').insert(tangentialRows)
    if (tangErr) {
      baseResult.errors.push(`web_form tangential_signals write failed: ${tangErr.message}`)
      // Don't flip ok=false — the core inserts succeeded; the tangential
      // is auxiliary funnel-analytics data, not lead state.
    }
  }

  return baseResult
}

// ---------------------------------------------------------------------------
// Adapter export. Note: we register under name 'web_form' — but it's
// not in the CrmSource union (kept narrow per the existing adapter
// contract). Migration 178 widens the CHECK to accept 'web_form' on
// the wire so commitNormalisedRows passing it through is safe.
// ---------------------------------------------------------------------------

export const webFormAdapter: CrmAdapter = {
  name: 'web_form',
  label: 'Web form (Rixey calculator, Typeform, Jotform, Google Forms, custom)',
  description:
    'Import submissions from your own pricing calculator or web form. Pre-built hints for Rixey, '
    + 'Typeform, Jotform, and Google Forms; supply a column-mapping JSON for any other form. '
    + 'Each submission becomes weddings + interactions(type=web_form) + tangential_signals(form_submission). '
    + 'Tagged confidence_flag=imported_high (first-party) and source_provenance=web_form_import.',
  ready: true,
  parse: parseWebForm,
  preview: previewWebForm,
  commit: commitWebForm,
}
