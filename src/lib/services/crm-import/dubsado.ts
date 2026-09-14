/**
 * Dubsado adapter (T5-followup-Y / Pattern I closure; promoted from
 * scaffold by W53, NOVEMBER-PLAN.md wave 8).
 *
 * Real implementation. Dubsado's own export tool is Reports -> Project
 * Reports -> "Export All", which is the report shape used here: one
 * row per project, with the client's contact fields already joined
 * onto it (a coordinator does not need to cross-reference a separate
 * Clients export to get an email address).
 *
 * Column signature
 * -----------------
 * This adapter's required/optional columns mirror the Dubsado
 * detector already built into `src/lib/services/brain-dump/csv-shape.ts`
 * (Wave 4 Phase 4c) so a Dubsado file routed through that detector and
 * one pasted directly into this adapter via the onboarding picker
 * parse identically:
 *
 *   Project Name        -> source_id, and (with the client's first
 *                           name) the partner-2 name when the project
 *                           was named after both partners
 *   Client First Name    -> partner1_first_name (REQUIRED, split-name
 *                           accounts only -- see below)
 *   Client Last Name     -> partner1_last_name  (REQUIRED)
 *   Client Name           -> fallback single-column identity for the
 *                           (less common) account that never split the
 *                           name field. Used only when First/Last are
 *                           both absent.
 *   Client Email          -> partner1_email
 *   Client Phone          -> partner1_phone
 *   Project Date          -> wedding_date
 *   Total Invoiced         -> booking_value (cents)
 *   Project Status         -> weddings.status (see STATUS mapping below)
 *   Lead Source            -> weddings.source_detail, VERBATIM. Never
 *                           interpreted into a canonical channel -- see
 *                           "Lead source" below.
 *   Date Created            -> inquiry_date
 *   Date Booked             -> booked_at
 *   Internal Notes           -> notes
 *
 * Partner 2
 * ---------
 * Dubsado's own client record is single-client; there is no dedicated
 * "Client 2" column in the shape this adapter targets. Coordinators
 * commonly still name the PROJECT after both partners ("Rosalind & Tom
 * Wedding") even though only Rosalind is the Dubsado client contact.
 * `derivePartner2FromProjectName` reads that pattern: it strips a
 * trailing "Wedding"/"Event"/etc. word, runs the shared couple-cell
 * parser (`primitives/couple-parser.ts`, the same one Aisle Planner's
 * "Couple" column uses) against what remains, and -- only when doing
 * so finds a SECOND name that is not the already-known Client First
 * Name -- fills partner2, inheriting Client Last Name as the shared
 * surname when the project name didn't carry one of its own. A
 * project named after one person only ("Priya Nair Wedding") yields no
 * partner2, which is correct: there is nothing in the row that claims
 * one exists.
 *
 * Status mapping
 * --------------
 * Dubsado's own status vocabulary (Lead / Active / Archived / Lost /
 * Completed, sometimes "Won") is handled by the shared status-deriver
 * primitive's DEFAULT_STATUS_ALIASES
 * (`primitives/status-deriver.ts`) -- the same lifecycle mapping
 * HoneyBook's adapter effectively uses (inquiry / tour_scheduled /
 * tour_completed / proposal_sent / booked / completed / lost /
 * cancelled). An unrecognised status string does not get silently
 * coerced into 'inquiry' -- it's surfaced as a per-row warning
 * (`describeStatusGap`) and only THEN defaults to 'inquiry', matching
 * the HoneyBook adapter's own behaviour.
 *
 * Lead source
 * -----------
 * Per the Stream-TT adapter-as-facts contract (see honeybook.ts's own
 * long note on this) a CRM-import adapter must not decide the couple's
 * real acquisition channel -- that's the lead-source-derivation cron's
 * job, working from Q7 / web-form / email-domain / UTM signals. This
 * adapter goes a step further than HoneyBook's and does not even
 * attempt to RECOGNISE known channel names in the Lead Source cell: it
 * writes the raw string to `source_detail` and nothing else.
 * `weddings.source` is left null (the shared commit helper's own
 * already-justified default), so there is nothing here for the
 * adapter-source-justification guard to flag.
 *
 * Money
 * -----
 * `Total Invoiced` maps to `booking_value`. Dubsado does not export a
 * paid/deposit/tax/gratuity/refunded breakdown in this report shape,
 * so those NormalisedLeadRow fields are left null -- a coordinator who
 * needs that detail today exports it from Dubsado's separate invoicing
 * view and types it in by hand (out of scope for this adapter).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  CommitResult,
  NormalisedLostDealRow,
} from './index'
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'
import { findColumn } from './primitives/field-detector'
import { parseCurrency } from './primitives/financial-parser'
import {
  deriveStatus,
  describeStatusGap,
  DEFAULT_STATUS_ALIASES,
} from './primitives/status-deriver'
import { parseCoupleFromCell, splitFullName } from './primitives/couple-parser'

// ---------------------------------------------------------------------------
// Column detection
// ---------------------------------------------------------------------------

interface ResolvedColumns {
  projectName: string | null
  clientFirst: string | null
  clientLast: string | null
  clientName: string | null
  clientEmail: string | null
  clientPhone: string | null
  projectDate: string | null
  totalInvoiced: string | null
  projectStatus: string | null
  leadSource: string | null
  dateCreated: string | null
  dateBooked: string | null
  internalNotes: string | null
}

function resolveColumns(headers: string[]): ResolvedColumns {
  return {
    projectName: findColumn(headers, [['Project Name']]),
    clientFirst: findColumn(headers, [['Client First Name']]),
    clientLast: findColumn(headers, [['Client Last Name']]),
    clientName: findColumn(headers, [['Client Name']]),
    clientEmail: findColumn(headers, [['Client Email', 'Email']]),
    clientPhone: findColumn(headers, [['Client Phone', 'Phone']]),
    projectDate: findColumn(headers, [['Project Date', 'Event Date', 'Wedding Date']]),
    totalInvoiced: findColumn(headers, [['Total Invoiced', 'Total', 'Project Value']]),
    projectStatus: findColumn(headers, [['Project Status', 'Status']]),
    leadSource: findColumn(headers, [['Lead Source', 'Source']]),
    dateCreated: findColumn(headers, [['Date Created', 'Created Date', 'Created']]),
    dateBooked: findColumn(headers, [['Date Booked', 'Contract Signed Date', 'Booked Date']]),
    internalNotes: findColumn(headers, [['Internal Notes', 'Notes']]),
  }
}

function cell(headers: string[], row: string[], col: string | null): string | null {
  if (!col) return null
  const i = headers.indexOf(col)
  if (i < 0) return null
  return (row[i] ?? '').trim() || null
}

// ---------------------------------------------------------------------------
// Date helpers (local -- same shape as honeybook.ts's, kept per-file per
// the existing convention rather than a new shared primitive).
// ---------------------------------------------------------------------------

function parseDateIso(raw: string | null): string | null {
  if (!raw) return null
  const d = new Date(raw.trim())
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function parseDateYmd(raw: string | null): string | null {
  const iso = parseDateIso(raw)
  return iso ? iso.slice(0, 10) : null
}

// ---------------------------------------------------------------------------
// Partner 2 from the Project Name (see docstring above).
// ---------------------------------------------------------------------------

function stripTrailingProjectWord(raw: string): string {
  return raw
    .trim()
    .replace(/\b(wedding|event|reception|ceremony|nuptials)\b\s*$/i, '')
    .trim()
}

function derivePartner2FromProjectName(
  projectName: string | null,
  clientFirst: string | null,
  clientLast: string | null,
): { first: string | null; last: string | null } {
  const empty = { first: null, last: null }
  if (!projectName || !clientFirst) return empty
  const stripped = stripTrailingProjectWord(projectName)
  if (!stripped) return empty
  const { partners } = parseCoupleFromCell(stripped)
  if (partners.length < 2) return empty

  const clientFirstNorm = clientFirst.trim().toLowerCase()
  const other = partners.find((p) => {
    const name = (p.name ?? '').trim().toLowerCase()
    return name !== '' && name !== clientFirstNorm && !name.startsWith(`${clientFirstNorm} `)
  })
  if (!other?.name) return empty
  const split = splitFullName(other.name)
  return {
    first: split.first,
    last: split.last ?? clientLast ?? null,
  }
}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

async function parseDubsado(config: AdapterConfig): Promise<ParseResult> {
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

  const headerRow = (csvRows[0] ?? []).map((h) => (h ?? '').trim())
  const cols = resolveColumns(headerRow)

  const hasIdentityColumn = (cols.clientFirst && cols.clientLast) || cols.clientName
  const missing: string[] = []
  if (!hasIdentityColumn) missing.push('Client First Name + Client Last Name (or Client Name)')
  if (!cols.projectDate) missing.push('Project Date')
  if (missing.length > 0) {
    return {
      ok: false, rows: [], warnings,
      errors: [
        `Dubsado export is missing required column(s): ${missing.join(', ')}. ` +
        `Expected headers like: Client First Name, Client Last Name, Project Date. ` +
        `Re-export from Dubsado (Reports -> Project Reports -> Export All) ` +
        `and ensure all columns are included.`,
      ],
    }
  }

  const rows: NormalisedLeadRow[] = []

  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]!
    const get = (col: string | null) => cell(headerRow, data, col)

    const projectName = get(cols.projectName)
    const clientEmail = get(cols.clientEmail)
    let first = get(cols.clientFirst)
    let last = get(cols.clientLast)
    if (!first && !last && cols.clientName) {
      const split = splitFullName(get(cols.clientName))
      first = split.first
      last = split.last
    }

    if (!first && !clientEmail && !projectName) {
      warnings.push(`row ${r}: skipped -- no client name, email, or project name`)
      continue
    }

    const partner2 = derivePartner2FromProjectName(projectName, first, last)

    const projectStatusRaw = get(cols.projectStatus)
    const status = deriveStatus(
      { explicit_status: projectStatusRaw },
      DEFAULT_STATUS_ALIASES,
    )
    const statusGapWarning = describeStatusGap({ explicit_status: projectStatusRaw })
    if (statusGapWarning) {
      warnings.push(`"${projectName ?? first ?? `row ${r}`}": ${statusGapWarning}`)
    }
    const finalStatus = status ?? 'inquiry'

    const inquiry = parseDateIso(get(cols.dateCreated))
    const booked = parseDateIso(get(cols.dateBooked))
    const leadSourceRaw = get(cols.leadSource)

    const lostAtIso = finalStatus === 'lost'
      ? (booked ?? parseDateIso(get(cols.projectDate)) ?? new Date().toISOString())
      : null
    const lostDeal: NormalisedLostDealRow | null = finalStatus === 'lost'
      ? {
          lost_at: lostAtIso ?? new Date().toISOString(),
          lost_at_stage: null,
          reason_category: 'other',
          reason_detail: 'Imported from Dubsado (no detail available).',
          competitor_name: null,
        }
      : null

    rows.push({
      source_id: projectName ?? (clientEmail ? `dubsado:${clientEmail}` : null),
      partner1_first_name: first,
      partner1_last_name: last,
      partner1_email: clientEmail,
      partner1_phone: get(cols.clientPhone),
      partner2_first_name: partner2.first,
      partner2_last_name: partner2.last,
      wedding_date: parseDateYmd(get(cols.projectDate)),
      booking_value: parseCurrency(get(cols.totalInvoiced)),
      raw_row: Object.fromEntries(
        headerRow.map((h, i) => [h || `col_${i}`, (data[i] ?? '').trim()]),
      ),
      status: finalStatus,
      // adapter-source-justified: Dubsado's Lead Source is a raw
      // provenance string, never interpreted into a canonical channel.
      // weddings.source stays null (the shared commit helper's own
      // default); only source_detail carries the coordinator-visible
      // text. See the "Lead source" section of this file's header
      // docstring.
      source: null,
      source_detail: leadSourceRaw,
      inquiry_date: inquiry,
      booked_at: booked,
      lost_at: lostAtIso,
      lost_reason: finalStatus === 'lost' ? 'other' : null,
      notes: get(cols.internalNotes),
      interactions: [],
      tours: [],
      lost_deal: lostDeal,
      related_contacts: [],
    })
  }

  return { ok: errors.length === 0, rows, errors, warnings }
}

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

function previewDubsado(rows: NormalisedLeadRow[]): PreviewResult {
  const warnings: string[] = []
  if (rows.length > 50) warnings.push(`only first 50 of ${rows.length} rows shown`)

  const byStatus = new Map<string, number>()
  let earliest: string | null = null
  let latest: string | null = null
  const sources = new Set<string>()
  let withPartner2 = 0
  for (const r of rows) {
    byStatus.set(r.status ?? 'inquiry', (byStatus.get(r.status ?? 'inquiry') ?? 0) + 1)
    if (r.wedding_date) {
      if (!earliest || r.wedding_date < earliest) earliest = r.wedding_date
      if (!latest || r.wedding_date > latest) latest = r.wedding_date
    }
    if (r.source_detail) sources.add(r.source_detail)
    if (r.partner2_first_name) withPartner2 += 1
  }
  if (rows.length > 0) {
    const parts = Array.from(byStatus.entries()).map(([k, v]) => `${k}=${v}`).join(', ')
    warnings.push(`Summary -- ${rows.length} rows (${parts})`)
    if (earliest && latest) warnings.push(`Date range: ${earliest} -> ${latest}`)
    if (sources.size > 0) warnings.push(`Distinct lead sources: ${sources.size}`)
    if (withPartner2 > 0) {
      warnings.push(`${withPartner2} row(s) read a second partner from the project name`)
    }
  }

  return {
    rows: rows.slice(0, 50),
    total: rows.length,
    errors: [],
    warnings,
  }
}

// ---------------------------------------------------------------------------
// commit()
// ---------------------------------------------------------------------------

async function commitDubsado(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
  preview?: boolean
}): Promise<CommitResult> {
  const { commitNormalisedRows } = await import('./index')
  return commitNormalisedRows({
    ...args,
    crmSource: 'dubsado',
    defaultInteractionSignalClass: 'crm',
  })
}

export const dubsadoAdapter: CrmAdapter = {
  name: 'dubsado',
  label: 'Dubsado',
  description:
    'Import a Project Report CSV exported from Dubsado (Reports -> Project Reports -> ' +
    'Export All). Client First/Last Name and Project Date are required; email, phone, ' +
    'total invoiced, status, lead source, and dates are mapped automatically.',
  ready: true,
  parse: parseDubsado,
  preview: previewDubsado,
  commit: commitDubsado,
}
