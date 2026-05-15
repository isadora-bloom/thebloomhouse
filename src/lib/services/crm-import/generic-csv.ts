/**
 * Generic CSV adapter (T5-followup-Y / Pattern I closure).
 *
 * The fall-through adapter — handles any CSV export by accepting a
 * column-mapping JSON from the coordinator. The mapping is
 *   bloom_field → csv_header_name
 * e.g.
 *   {
 *     "partner1_first_name": "First Name",
 *     "partner1_last_name":  "Last Name",
 *     "partner1_email":      "Email",
 *     "wedding_date":        "Event Date",
 *     "status":              "Lead Status",
 *     "booking_value":       "Booking Total",
 *   }
 *
 * Unmapped CSV columns are dropped silently (no schema churn). Bloom
 * fields not in the mapping default to null.
 *
 * Supported bloom_field keys (anything in NormalisedLeadRow shape):
 *   source_id, partner1_first_name, partner1_last_name, partner1_email,
 *   partner1_phone, partner2_first_name, partner2_last_name,
 *   wedding_date, guest_count_estimate, booking_value, amount_paid,
 *   deposit_amount, tax_amount, gratuity_amount, refunded_amount,
 *   package_name, status, source, source_detail, inquiry_date,
 *   booked_at, lost_at, lost_reason, notes
 *
 * Status values are coerced to Bloom's enum via STATUS_ALIASES below.
 */

import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  CommitResult,
} from './index'
import { commitNormalisedRows } from './index'
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'
import { type Cents, asDollars, dollarsToCents } from '@/lib/types/monetary'

const SUPPORTED_FIELDS = new Set([
  'source_id',
  'partner1_first_name', 'partner1_last_name', 'partner1_email', 'partner1_phone',
  'partner2_first_name', 'partner2_last_name',
  'wedding_date', 'guest_count_estimate', 'booking_value',
  // Commercial detail (migration 175 + 351) — a booked-couple export
  // carries these and they must not silently drop.
  'amount_paid', 'deposit_amount', 'tax_amount', 'gratuity_amount',
  'refunded_amount', 'package_name',
  'status', 'source', 'source_detail',
  'inquiry_date', 'booked_at', 'lost_at', 'lost_reason',
  'notes',
])

const STATUS_ALIASES: Record<string, NormalisedLeadRow['status']> = {
  'inquiry': 'inquiry',
  'lead': 'inquiry',
  'new': 'inquiry',
  'tour scheduled': 'tour_scheduled',
  'tour_scheduled': 'tour_scheduled',
  'tour completed': 'tour_completed',
  'tour_completed': 'tour_completed',
  'proposal': 'proposal_sent',
  'proposal sent': 'proposal_sent',
  'proposal_sent': 'proposal_sent',
  'booked': 'booked',
  'won': 'booked',
  'closed-won': 'booked',
  'closed_won': 'booked',
  'completed': 'completed',
  'lost': 'lost',
  'closed-lost': 'lost',
  'closed_lost': 'lost',
  'cancelled': 'cancelled',
  'canceled': 'cancelled',
}

function coerceStatus(raw: string | null | undefined): NormalisedLeadRow['status'] {
  if (!raw) return 'inquiry'
  const key = raw.trim().toLowerCase()
  return STATUS_ALIASES[key] ?? null
}

function coerceNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const cleaned = raw.replace(/[$,\s]/g, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Currency coercion for booking_value. Per Bloom convention
 * (T5-Rixey-NN bug #8), weddings.booking_value is integer cents.
 * Coordinator-supplied CSV values come in as raw dollars
 * ("$4,500" / "4500.00" / "4500"), so multiply by 100.
 *
 * T5-Rixey-RR fix #5: typed return surfaces the unit at the writer
 * call site so a future refactor can't drop the *100.
 */
function coerceMoneyToCents(raw: string | null | undefined): Cents | null {
  const dollars = coerceNumber(raw)
  if (dollars == null || dollars < 0) return null
  return dollarsToCents(asDollars(dollars))
}

function coerceDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  // For wedding_date we want yyyy-mm-dd; for timestamps we want ISO.
  return d.toISOString()
}

function coerceWeddingDate(raw: string | null | undefined): string | null {
  const iso = coerceDate(raw)
  if (!iso) return null
  return iso.slice(0, 10)
}

async function parseGenericCsv(config: AdapterConfig): Promise<ParseResult> {
  const errors: string[] = []
  const warnings: string[] = []

  if (!config.csvText || !config.csvText.trim()) {
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings }
  }
  const mapping = config.columnMapping ?? {}
  if (Object.keys(mapping).length === 0) {
    return {
      ok: false,
      rows: [],
      errors: ['column-mapping is required (bloom_field → csv_header)'],
      warnings,
    }
  }

  // Validate mapping keys are real Bloom fields.
  for (const key of Object.keys(mapping)) {
    if (!SUPPORTED_FIELDS.has(key)) {
      warnings.push(`mapping key '${key}' is not a supported Bloom field — ignored`)
    }
  }

  const csvRows = parseCsvRows(config.csvText)
  if (csvRows.length < 2) {
    return { ok: false, rows: [], errors: ['csv must have a header row and at least one data row'], warnings }
  }
  const header = csvRows[0].map((h) => h.trim())
  const headerIdx = new Map<string, number>()
  header.forEach((h, i) => headerIdx.set(h, i))

  // Resolve each mapping to a column index.
  const fieldIdx: Record<string, number> = {}
  for (const [bloomField, csvHeader] of Object.entries(mapping)) {
    if (!SUPPORTED_FIELDS.has(bloomField)) continue
    const idx = headerIdx.get(csvHeader)
    if (idx == null) {
      errors.push(`csv header '${csvHeader}' (mapped to '${bloomField}') not found`)
      continue
    }
    fieldIdx[bloomField] = idx
  }
  if (Object.keys(fieldIdx).length === 0) {
    return { ok: false, rows: [], errors: ['no mappable fields resolved against the csv header'], warnings }
  }

  // Wave 2B: lift the chokepoint import out of the row loop. Used by the
  // double-name detector below ("Mary and Mendy Pratt").
  const { detectDoubleNameString } = await import(
    '@/lib/services/identity/name-capture'
  )

  const rows: NormalisedLeadRow[] = []
  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]
    const get = (field: string): string | null => {
      const idx = fieldIdx[field]
      if (idx == null) return null
      return (data[idx] ?? '').trim() || null
    }

    const status = coerceStatus(get('status'))
    if (get('status') && !status) {
      warnings.push(`row ${r}: unknown status '${get('status')}' — defaulting to 'inquiry'`)
    }

    // Wave 2B: detect "Mary and Mendy Pratt" / "Mary & Mendy Pratt" /
    // "Mary y Mendy Pratt" jammed into a single partner1 cell. When
    // detected, split into proper partner1 + partner2 rows with shared
    // last name. The legacy splitName took the first whitespace token
    // as first_name and the rest as last_name → "Mary" + "and Mendy
    // Pratt". Every downstream surface that joined on last_name broke.
    let p1First = get('partner1_first_name')
    let p1Last = get('partner1_last_name')
    let p2First = get('partner2_first_name')
    let p2Last = get('partner2_last_name')
    if (p1First && !p1Last && !p2First) {
      // Only fire the split when partner1_last_name is empty (the typical
      // shape of the failure) AND partner2 is empty (don't clobber a
      // coordinator-supplied partner2 cell). Try the detector against
      // the raw single-cell string the coordinator pasted.
      const cell = p1First.trim()
      const dbl = detectDoubleNameString(cell)
      if (dbl) {
        p1First = dbl.first1
        p1Last = dbl.last
        p2First = dbl.first2
        p2Last = dbl.last
        warnings.push(
          `row ${r}: detected double-name string "${cell}" — split into ` +
          `partner1 ${dbl.first1} ${dbl.last} + partner2 ${dbl.first2} ${dbl.last}`
        )
      }
    }

    const row: NormalisedLeadRow = {
      source_id: get('source_id'),
      partner1_first_name: p1First,
      partner1_last_name: p1Last,
      partner1_email: get('partner1_email'),
      partner1_phone: get('partner1_phone'),
      partner2_first_name: p2First,
      partner2_last_name: p2Last,
      wedding_date: coerceWeddingDate(get('wedding_date')),
      guest_count_estimate: coerceNumber(get('guest_count_estimate')),
      booking_value: coerceMoneyToCents(get('booking_value')),
      amount_paid: coerceMoneyToCents(get('amount_paid')),
      deposit_amount: coerceMoneyToCents(get('deposit_amount')),
      tax_amount: coerceMoneyToCents(get('tax_amount')),
      gratuity_amount: coerceMoneyToCents(get('gratuity_amount')),
      refunded_amount: coerceMoneyToCents(get('refunded_amount')),
      package_name: get('package_name'),
      status: status ?? 'inquiry',
      // adapter-source-justified: generic-csv ONLY writes weddings.source
      //   when the coordinator EXPLICITLY mapped a CSV column to the
      //   `source` Bloom field via columnMapping. That's a deliberate,
      //   hand-curated act — the coordinator is asserting "this column
      //   IS the first-touch attribution." If they don't map it, the
      //   value stays null and the lead-source-derivation chain runs.
      source: get('source'),
      source_detail: get('source_detail'),
      inquiry_date: coerceDate(get('inquiry_date')),
      booked_at: coerceDate(get('booked_at')),
      lost_at: coerceDate(get('lost_at')),
      lost_reason: get('lost_reason'),
      notes: get('notes'),
      interactions: [],
      tours: [],
      lost_deal: null,
    }

    // Skip rows where every identity field is empty — likely a trailing
    // blank line or footer summary row.
    const hasIdentity = Boolean(
      row.partner1_first_name || row.partner1_last_name ||
      row.partner1_email || row.partner1_phone ||
      row.partner2_first_name || row.partner2_last_name,
    )
    if (!hasIdentity) {
      warnings.push(`row ${r}: skipped — no identity fields`)
      continue
    }
    rows.push(row)
  }

  return { ok: errors.length === 0, rows, errors, warnings }
}

function previewGenericCsv(rows: NormalisedLeadRow[]): PreviewResult {
  return {
    rows: rows.slice(0, 50),
    total: rows.length,
    errors: [],
    warnings: rows.length > 50 ? [`only first 50 of ${rows.length} rows shown`] : [],
  }
}

export const genericCsvAdapter: CrmAdapter = {
  name: 'generic_csv',
  label: 'Generic CSV (any provider)',
  description: 'Upload any CSV export. Provide a column-mapping JSON ({ "bloom_field": "Your CSV Header" }) so Bloom knows which columns map to which fields.',
  ready: true,
  parse: parseGenericCsv,
  preview: previewGenericCsv,
  async commit(args): Promise<CommitResult> {
    // T5-Rixey-BBB: generic-csv adapter has no idea what kind of
    // signal each row represents — coordinator-supplied column
    // mapping describes shape, not class. Default to 'unclassified';
    // the cluster-compute will use other signals (from-domain,
    // hear_source, etc.) to credit attribution.
    return commitNormalisedRows({
      ...args,
      crmSource: 'generic_csv',
      defaultInteractionSignalClass: 'unclassified',
    })
  },
}
