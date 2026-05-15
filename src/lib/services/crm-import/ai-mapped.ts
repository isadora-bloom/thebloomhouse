/**
 * AI-mapped CSV adapter - the universal fall-through importer.
 *
 * The existing generic-csv adapter handles ANY CSV, but only if the
 * coordinator hand-writes a column-mapping JSON. A venue with an
 * unfamiliar export shape who does not know Bloom's field names is
 * stuck. This adapter removes that wall: when a file's headers match
 * no known provider adapter, it sends the header row plus three
 * sample data rows to callAIJson and gets back a proposed mapping of
 * CSV-column to Bloom field.
 *
 * Flow:
 *   1. parse() runs proposeColumnMapping() (one Haiku call) UNLESS the
 *      caller already supplied a confirmed columnMapping (the
 *      coordinator corrected the AI proposal in the UI and re-submitted).
 *   2. The proposed mapping + per-column confidence + reasoning is
 *      attached to the ParseResult so the UI can render a confirm /
 *      correct table BEFORE any commit.
 *   3. Once the coordinator confirms, the route re-submits with the
 *      (possibly edited) columnMapping and parse() skips the AI call,
 *      builds NormalisedLeadRow[] deterministically, and commit()
 *      funnels through commitNormalisedRows like every other adapter.
 *
 * The full untouched source row is always preserved in raw_row ->
 * weddings.raw_import_row so nothing the venue exported is dropped,
 * even columns the AI could not map.
 *
 * Cost: one Haiku callAIJson per file (header + 3 rows only, never
 * the full data set). Cost-logged via api_costs like every callAI.
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
import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// The Bloom fields the AI is allowed to target. These are the typed keys
// of NormalisedLeadRow that map cleanly from a single CSV column. Kept in
// sync with generic-csv.ts SUPPORTED_FIELDS - anything outside this set is
// preserved in raw_row but never assigned a typed slot.
// ---------------------------------------------------------------------------

export const AI_MAPPABLE_FIELDS = [
  'partner1_first_name',
  'partner1_last_name',
  'partner1_email',
  'partner1_phone',
  'partner2_first_name',
  'partner2_last_name',
  'partner2_email',
  'partner2_phone',
  'wedding_date',
  'guest_count_estimate',
  'booking_value',
  'amount_paid',
  'deposit_amount',
  'tax_amount',
  'gratuity_amount',
  'refunded_amount',
  'package_name',
  'status',
  'source',
  'source_detail',
  'inquiry_date',
  'booked_at',
  'lost_at',
  'lost_reason',
  'notes',
] as const

export type AiMappableField = (typeof AI_MAPPABLE_FIELDS)[number]

/** Human-readable hint per field so the LLM proposes sensible columns. */
const FIELD_DESCRIPTIONS: Record<AiMappableField, string> = {
  partner1_first_name: "primary contact / first partner's first name",
  partner1_last_name: "primary contact / first partner's last name (or shared surname)",
  partner1_email: "primary contact email address",
  partner1_phone: 'primary contact phone number',
  partner2_first_name: "second partner / fiance's first name",
  partner2_last_name: "second partner's last name",
  partner2_email: "second partner's email address",
  partner2_phone: "second partner's phone number",
  wedding_date: 'the event / wedding date',
  guest_count_estimate: 'estimated number of guests / headcount',
  booking_value: 'total contract value / booking total / quoted price',
  amount_paid: 'amount the couple has paid so far',
  deposit_amount: 'deposit / retainer amount',
  tax_amount: 'tax charged',
  gratuity_amount: 'gratuity / service charge',
  refunded_amount: 'amount refunded',
  package_name: 'name of the package / collection / tier booked',
  status: 'lead / project status (inquiry, booked, lost, etc.)',
  source: 'how the couple found the venue / lead source channel',
  source_detail: 'free-text detail about the source',
  inquiry_date: 'date the couple first inquired / lead created date',
  booked_at: 'date the couple booked / signed the contract',
  lost_at: 'date the lead was lost / closed-lost',
  lost_reason: 'why the lead was lost',
  notes: 'free-text notes / comments / message from the couple',
}

// ---------------------------------------------------------------------------
// Proposed-mapping shape - surfaced to the UI so the coordinator can
// confirm or correct each column before committing.
// ---------------------------------------------------------------------------

export interface ProposedColumnMapping {
  /** bloom_field -> csv_header_name. Only fields the AI matched. */
  mapping: Record<string, string>
  /** Per-bloom-field confidence 0-100 and a one-line reason. */
  detail: Array<{
    bloom_field: string
    csv_header: string
    confidence: number
    reason: string
  }>
  /** CSV headers the AI could not confidently map to any Bloom field.
   *  These still survive into raw_import_row - they are just not given
   *  a typed slot. Surfaced so the coordinator knows what was left. */
  unmapped_headers: string[]
}

// ---------------------------------------------------------------------------
// Coercion helpers - identical semantics to generic-csv.ts so a row
// committed via the AI path behaves the same as a hand-mapped one.
// ---------------------------------------------------------------------------

const STATUS_ALIASES: Record<string, NormalisedLeadRow['status']> = {
  inquiry: 'inquiry',
  lead: 'inquiry',
  new: 'inquiry',
  open: 'inquiry',
  'new inquiry': 'inquiry',
  'tour scheduled': 'tour_scheduled',
  tour_scheduled: 'tour_scheduled',
  'tour booked': 'tour_scheduled',
  'tour completed': 'tour_completed',
  tour_completed: 'tour_completed',
  proposal: 'proposal_sent',
  'proposal sent': 'proposal_sent',
  proposal_sent: 'proposal_sent',
  quoted: 'proposal_sent',
  booked: 'booked',
  won: 'booked',
  'closed-won': 'booked',
  closed_won: 'booked',
  'closed won': 'booked',
  confirmed: 'booked',
  completed: 'completed',
  done: 'completed',
  lost: 'lost',
  'closed-lost': 'lost',
  closed_lost: 'lost',
  'closed lost': 'lost',
  'no response': 'lost',
  unresponsive: 'lost',
  archived: 'lost',
  cancelled: 'cancelled',
  canceled: 'cancelled',
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
  return d.toISOString()
}

function coerceWeddingDate(raw: string | null | undefined): string | null {
  const iso = coerceDate(raw)
  return iso ? iso.slice(0, 10) : null
}

// ---------------------------------------------------------------------------
// LLM column-mapping proposal.
//
// Sends the header row + up to 3 sample data rows to Haiku and asks for
// a column -> Bloom-field mapping. Bounded-schema structured extraction
// is exactly the Haiku tier per the model-tier guidance.
// ---------------------------------------------------------------------------

export const AI_MAPPED_PROMPT_VERSION = 'crm-import.ai-mapped.prompt.v1.0'

interface RawAiMappingResponse {
  mappings?: Array<{
    csv_header?: unknown
    bloom_field?: unknown
    confidence?: unknown
    reason?: unknown
  }>
}

/**
 * Ask the LLM to map this CSV's columns to Bloom fields. One Haiku call.
 * Returns a ProposedColumnMapping the UI renders for confirm/correct.
 */
export async function proposeColumnMapping(args: {
  headers: string[]
  sampleRows: string[][]
  venueId?: string
}): Promise<ProposedColumnMapping> {
  const { headers, sampleRows, venueId } = args

  const fieldList = AI_MAPPABLE_FIELDS.map(
    (f) => `  - ${f}: ${FIELD_DESCRIPTIONS[f]}`,
  ).join('\n')

  // Build a compact table the model can read: header + sample values.
  const sampleTable = headers
    .map((h, i) => {
      const samples = sampleRows
        .map((r) => (r[i] ?? '').trim())
        .filter((v) => v.length > 0)
        .slice(0, 3)
      return `  "${h}" -> sample values: ${
        samples.length ? samples.map((s) => JSON.stringify(s)).join(', ') : '(all empty)'
      }`
    })
    .join('\n')

  const systemPrompt =
    'You are a data-import assistant for a wedding-venue CRM. You are given the ' +
    'column headers and a few sample rows from a venue\'s spreadsheet export. ' +
    'Your job is to map each spreadsheet column to the correct Bloom field, ' +
    'when there is a clear match.\n\n' +
    'Bloom fields you may map to:\n' +
    fieldList +
    '\n\nRules:\n' +
    '- Only map a column when you are reasonably confident. It is better to ' +
    'leave a column unmapped than to map it wrong.\n' +
    '- Map at most one CSV column to each Bloom field. If two columns could ' +
    'both be partner1_email, pick the better one.\n' +
    '- A single "Couple Name" or "Full Name" column should map to ' +
    'partner1_first_name only IF the values look like a single first name; ' +
    'if the values clearly contain a full name or both partners, still map ' +
    'it to partner1_first_name and the importer will split it.\n' +
    '- Use the sample values, not just the header text, to decide.\n' +
    '- confidence is an integer 0-100.'

  const userPrompt =
    `Here are the columns and sample values from the export:\n\n${sampleTable}\n\n` +
    'Return JSON of the shape: ' +
    '{ "mappings": [ { "csv_header": "<exact header text>", ' +
    '"bloom_field": "<one of the Bloom fields above>", ' +
    '"confidence": <0-100>, "reason": "<short reason>" } ] }. ' +
    'Include only columns you are mapping. Omit columns you cannot map.'

  let raw: RawAiMappingResponse
  try {
    raw = await callAIJson<RawAiMappingResponse>({
      systemPrompt,
      userPrompt,
      tier: 'haiku',
      maxTokens: 1200,
      temperature: 0,
      venueId,
      taskType: 'crm_import.ai_column_mapping',
      promptVersion: AI_MAPPED_PROMPT_VERSION,
      // Header + sample values can carry couple PII (names/emails in the
      // sample rows). Default tier 2 is correct; tag explicitly.
      contentTier: 2,
    })
  } catch (err) {
    // AI failure is not fatal - the coordinator can still hand-build a
    // mapping. Return an empty proposal; parse() surfaces the error.
    throw new Error(
      `AI column-mapping failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    )
  }

  const validFields = new Set<string>(AI_MAPPABLE_FIELDS)
  const headerSet = new Set(headers.map((h) => h.trim()))
  const mapping: Record<string, string> = {}
  const detail: ProposedColumnMapping['detail'] = []
  const usedFields = new Set<string>()

  for (const m of raw.mappings ?? []) {
    const csvHeader = typeof m.csv_header === 'string' ? m.csv_header.trim() : ''
    const bloomField = typeof m.bloom_field === 'string' ? m.bloom_field.trim() : ''
    const confidence =
      typeof m.confidence === 'number' && Number.isFinite(m.confidence)
        ? Math.max(0, Math.min(100, Math.round(m.confidence)))
        : 50
    const reason = typeof m.reason === 'string' ? m.reason.trim() : ''

    // Drop hallucinated headers / fields, and refuse to map a field twice.
    if (!validFields.has(bloomField)) continue
    if (!headerSet.has(csvHeader)) continue
    if (usedFields.has(bloomField)) continue

    usedFields.add(bloomField)
    mapping[bloomField] = csvHeader
    detail.push({ bloom_field: bloomField, csv_header: csvHeader, confidence, reason })
  }

  const mappedHeaders = new Set(Object.values(mapping))
  const unmapped_headers = headers
    .map((h) => h.trim())
    .filter((h) => h.length > 0 && !mappedHeaders.has(h))

  return { mapping, detail, unmapped_headers }
}

// ---------------------------------------------------------------------------
// AdapterConfig extension - the route passes a confirmed mapping back in
// after the coordinator reviews the AI proposal.
// ---------------------------------------------------------------------------

interface AiMappedAdapterConfig extends AdapterConfig {
  /** When set, parse() skips the AI call and uses this mapping directly.
   *  This is the coordinator-confirmed (and possibly corrected) mapping
   *  re-submitted from the UI. Standard AdapterConfig.columnMapping is
   *  also honoured for backward compatibility. */
  confirmedMapping?: Record<string, string>
  /** Venue id, threaded through for api_costs attribution on the AI call. */
  venueId?: string
}

/**
 * ParseResult extension for the AI-mapped adapter. The proposed mapping
 * rides alongside rows so the route can hand it to the UI. When
 * proposalOnly is true, rows is empty and the UI must render the
 * confirm-mapping step before anything commits.
 */
export interface AiMappedParseResult extends ParseResult {
  proposedMapping?: ProposedColumnMapping
  proposalOnly?: boolean
}

// ---------------------------------------------------------------------------
// Row builder - shared by the proposal-preview and the confirmed-commit
// paths. Deterministic, no AI.
// ---------------------------------------------------------------------------

function buildRows(args: {
  header: string[]
  dataRows: string[][]
  mapping: Record<string, string>
  warnings: string[]
}): NormalisedLeadRow[] {
  const { header, dataRows, mapping, warnings } = args
  const headerIdx = new Map<string, number>()
  header.forEach((h, i) => headerIdx.set(h.trim(), i))

  // Resolve mapping -> column index, dropping fields whose header is gone.
  const fieldIdx: Record<string, number> = {}
  for (const [bloomField, csvHeader] of Object.entries(mapping)) {
    if (!AI_MAPPABLE_FIELDS.includes(bloomField as AiMappableField)) {
      warnings.push(`mapping field '${bloomField}' is not a supported Bloom field - ignored`)
      continue
    }
    const idx = headerIdx.get(csvHeader.trim())
    if (idx == null) {
      warnings.push(`csv header '${csvHeader}' (mapped to '${bloomField}') not found - skipped`)
      continue
    }
    fieldIdx[bloomField] = idx
  }

  const rows: NormalisedLeadRow[] = []
  for (let r = 0; r < dataRows.length; r++) {
    const data = dataRows[r]
    const get = (field: string): string | null => {
      const idx = fieldIdx[field]
      if (idx == null) return null
      return (data[idx] ?? '').trim() || null
    }

    const status = coerceStatus(get('status'))
    if (get('status') && !status) {
      warnings.push(`row ${r + 1}: unknown status '${get('status')}' - defaulting to 'inquiry'`)
    }

    // A single mapped name column ("Couple Name") may carry "First Last"
    // or both partners. If partner1_first_name carries a multi-token
    // value and no last name was mapped, split first/last tokens.
    let p1First = get('partner1_first_name')
    let p1Last = get('partner1_last_name')
    if (p1First && !p1Last && !fieldIdx['partner1_last_name']) {
      const tokens = p1First.trim().split(/\s+/).filter(Boolean)
      if (tokens.length >= 2) {
        p1First = tokens[0] ?? null
        p1Last = tokens.slice(1).join(' ')
      }
    }

    const row: NormalisedLeadRow = {
      source_id: get('partner1_email') ?? get('partner1_phone'),
      partner1_first_name: p1First,
      partner1_last_name: p1Last,
      partner1_email: get('partner1_email'),
      partner1_phone: get('partner1_phone'),
      partner2_first_name: get('partner2_first_name'),
      partner2_last_name: get('partner2_last_name'),
      partner2_email: get('partner2_email'),
      partner2_phone: get('partner2_phone'),
      wedding_date: coerceWeddingDate(get('wedding_date')),
      guest_count_estimate: coerceNumber(get('guest_count_estimate')),
      booking_value: coerceMoneyToCents(get('booking_value')),
      amount_paid: coerceMoneyToCents(get('amount_paid')),
      deposit_amount: coerceMoneyToCents(get('deposit_amount')),
      tax_amount: coerceMoneyToCents(get('tax_amount')),
      gratuity_amount: coerceMoneyToCents(get('gratuity_amount')),
      refunded_amount: coerceMoneyToCents(get('refunded_amount')),
      package_name: get('package_name'),
      // Full untouched source row, header-keyed - nothing is dropped,
      // including columns the AI could not map (weddings.raw_import_row).
      raw_row: Object.fromEntries(
        header.map((h, i) => [h.trim() || `col_${i}`, (data[i] ?? '').trim()]),
      ),
      status: status ?? 'inquiry',
      // adapter-source-justified: ai-mapped only writes weddings.source
      //   when the coordinator confirmed a column mapped to the `source`
      //   field. That is a deliberate, reviewed assertion. Unmapped =
      //   null and lead-source-derivation runs.
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

    const hasIdentity = Boolean(
      row.partner1_first_name || row.partner1_last_name ||
      row.partner1_email || row.partner1_phone ||
      row.partner2_first_name || row.partner2_last_name,
    )
    if (!hasIdentity) {
      warnings.push(`row ${r + 1}: skipped - no identity fields`)
      continue
    }
    rows.push(row)
  }
  return rows
}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

async function parseAiMapped(config: AdapterConfig): Promise<AiMappedParseResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const cfg = config as AiMappedAdapterConfig

  if (!cfg.csvText || !cfg.csvText.trim()) {
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings }
  }

  const csvRows = parseCsvRows(cfg.csvText)
  if (csvRows.length < 2) {
    return {
      ok: false,
      rows: [],
      errors: ['csv must have a header row and at least one data row'],
      warnings,
    }
  }
  const header = csvRows[0].map((h) => h.trim())
  const dataRows = csvRows.slice(1)

  // A confirmed mapping (coordinator reviewed the AI proposal, possibly
  // corrected it, and re-submitted) skips the AI call entirely. Standard
  // columnMapping is also accepted for callers that already have one.
  const confirmed = cfg.confirmedMapping ?? cfg.columnMapping
  if (confirmed && Object.keys(confirmed).length > 0) {
    const rows = buildRows({ header, dataRows, mapping: confirmed, warnings })
    if (rows.length === 0) {
      errors.push('no rows had any identity field after applying the mapping')
    }
    return { ok: errors.length === 0, rows, errors, warnings }
  }

  // No mapping yet - propose one with the LLM and return proposalOnly.
  // The UI renders the confirm/correct step; nothing commits until the
  // coordinator re-submits with a confirmedMapping.
  let proposal: ProposedColumnMapping
  try {
    proposal = await proposeColumnMapping({
      headers: header,
      sampleRows: dataRows.slice(0, 3),
      venueId: cfg.venueId,
    })
  } catch (err) {
    return {
      ok: false,
      rows: [],
      errors: [
        err instanceof Error ? err.message : 'AI column-mapping failed',
        'You can still import this file: switch to the Generic CSV adapter and supply a column mapping by hand.',
      ],
      warnings,
    }
  }

  if (Object.keys(proposal.mapping).length === 0) {
    return {
      ok: false,
      rows: [],
      errors: [
        'The AI could not confidently map any column in this file to a Bloom field.',
        'Switch to the Generic CSV adapter and supply a column mapping by hand.',
      ],
      warnings,
      proposedMapping: proposal,
      proposalOnly: true,
    }
  }

  // Build a preview row set off the proposed mapping so the coordinator
  // sees both the mapping AND what the parsed rows look like.
  const previewRows = buildRows({
    header,
    dataRows: dataRows.slice(0, 50),
    mapping: proposal.mapping,
    warnings,
  })

  return {
    ok: true,
    rows: previewRows,
    errors,
    warnings,
    proposedMapping: proposal,
    proposalOnly: true,
  }
}

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

function previewAiMapped(rows: NormalisedLeadRow[]): PreviewResult {
  return {
    rows: rows.slice(0, 50),
    total: rows.length,
    errors: [],
    warnings: rows.length > 50 ? [`only first 50 of ${rows.length} rows shown`] : [],
  }
}

// ---------------------------------------------------------------------------
// commit() - funnel through the shared commit helper. Class is
// 'unclassified' (same reasoning as generic-csv: a mapped column
// describes shape, not the signal's role in the journey).
// ---------------------------------------------------------------------------

export const aiMappedAdapter: CrmAdapter = {
  // Registry-name 'ai_mapped'. Commits with crm_source='generic_csv'
  // (no dedicated enum value - adding one needs a migration on the
  // weddings.crm_source CHECK; deferred, same as 'tour_scheduler' /
  // 'knot'). The AdapterName union carries 'ai_mapped' as an alias.
  name: 'ai_mapped',
  label: 'Smart import (AI column mapping)',
  description:
    'Upload ANY CSV export - Bloom uses AI to propose which columns map to which fields. ' +
    'You review and correct the proposed mapping before anything is imported. ' +
    'Use this when your export does not match a known provider.',
  ready: true,
  parse: parseAiMapped,
  preview: previewAiMapped,
  async commit(args): Promise<CommitResult> {
    return commitNormalisedRows({
      ...args,
      crmSource: 'generic_csv',
      defaultInteractionSignalClass: 'unclassified',
    })
  },
}
