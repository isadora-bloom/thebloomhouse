/**
 * Aisle Planner adapter (T5-followup-Y / Pattern I closure; promoted
 * from scaffold by W53, NOVEMBER-PLAN.md wave 8).
 *
 * Real implementation. Aisle Planner's export tool is CRM -> Leads ->
 * "Export to CSV".
 *
 * Column signature
 * -----------------
 * Mirrors the Aisle Planner detector already built into
 * `src/lib/services/brain-dump/csv-shape.ts` (Wave 4 Phase 4c), so a
 * file routed through that detector and one pasted directly into this
 * adapter via the onboarding picker parse identically:
 *
 *   Lead ID            -> source_id
 *   Couple              -> partner1 + partner2 names. A single cell
 *                         carrying BOTH partners -- "Sarah Smith,
 *                         James Lee", "Petra & Simon Vance", or just
 *                         "Sarah Chen" for a lead with one named
 *                         contact so far. Parsed with the shared
 *                         `parseCoupleFromCell` primitive
 *                         (`primitives/couple-parser.ts`) -- the same
 *                         one this file's own docstring names as
 *                         written FOR this exact shape.
 *   Email Address / Email -> partner1_email (REQUIRED alongside Couple)
 *   Phone                -> partner1_phone
 *   Wedding Date /
 *     Event Date          -> wedding_date (REQUIRED)
 *   Estimated Budget       -> NOT booking_value. See "Estimated Budget"
 *                            below.
 *   Status                 -> weddings.status (see STATUS mapping)
 *   Lead Source / Source    -> weddings.source_detail, VERBATIM. Never
 *                            interpreted -- see honeybook.ts's Stream-TT
 *                            note and dubsado.ts's "Lead source" section
 *                            for the full reasoning; this adapter
 *                            follows the same contract.
 *   Created / Date Created /
 *     Inquiry Date           -> inquiry_date
 *   Booked Date              -> booked_at
 *   Notes                    -> notes
 *
 * Estimated Budget
 * -----------------
 * This is the COUPLE's stated budget, not a contract total -- writing
 * it to `booking_value` would make an unbooked inquiry look like a
 * signed deal at that figure. It goes into `notes` instead, clearly
 * labelled, so the coordinator sees it but nothing downstream (heat
 * scoring, revenue reporting) mistakes a guess for a fact.
 *
 * Status mapping
 * --------------
 * Aisle Planner's vocabulary (New / In Progress / Booked / Completed /
 * Lost / On Hold) runs through the shared status-deriver primitive
 * (`primitives/status-deriver.ts`). "On Hold" has no clean Bloom
 * equivalent (per this adapter's original scaffold TODO) -- it maps to
 * 'inquiry' via the primitive's default 'in progress' alias bucket
 * extended with an explicit 'on hold' alias below, and the adapter
 * appends a note so the hold isn't invisible on the leads page.
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
import { parseCurrency, formatCents } from './primitives/financial-parser'
import {
  deriveStatus,
  describeStatusGap,
  DEFAULT_STATUS_ALIASES,
  type WeddingStatus,
} from './primitives/status-deriver'
import { parseCoupleFromCell, splitFullName } from './primitives/couple-parser'

// Aisle Planner's "On Hold" status has no default alias in the shared
// primitive (it's specific to this CRM's vocabulary). Extend rather
// than mutate the shared default so other adapters are unaffected.
const AISLE_PLANNER_STATUS_ALIASES: Record<string, WeddingStatus> = {
  ...DEFAULT_STATUS_ALIASES,
  'on hold': 'inquiry',
  'on-hold': 'inquiry',
  'on_hold': 'inquiry',
  'hold': 'inquiry',
}

// ---------------------------------------------------------------------------
// Column detection
// ---------------------------------------------------------------------------

interface ResolvedColumns {
  leadId: string | null
  couple: string | null
  email: string | null
  phone: string | null
  weddingDate: string | null
  estimatedBudget: string | null
  status: string | null
  leadSource: string | null
  created: string | null
  bookedDate: string | null
  notes: string | null
}

function resolveColumns(headers: string[]): ResolvedColumns {
  return {
    leadId: findColumn(headers, [['Lead ID']]),
    couple: findColumn(headers, [['Couple']]),
    email: findColumn(headers, [['Email Address', 'Email']]),
    phone: findColumn(headers, [['Phone']]),
    weddingDate: findColumn(headers, [['Wedding Date', 'Event Date']]),
    estimatedBudget: findColumn(headers, [['Estimated Budget']]),
    status: findColumn(headers, [['Status']]),
    leadSource: findColumn(headers, [['Lead Source', 'Source']]),
    created: findColumn(headers, [['Created', 'Date Created', 'Inquiry Date']]),
    bookedDate: findColumn(headers, [['Booked Date']]),
    notes: findColumn(headers, [['Notes']]),
  }
}

function cell(headers: string[], row: string[], col: string | null): string | null {
  if (!col) return null
  const i = headers.indexOf(col)
  if (i < 0) return null
  return (row[i] ?? '').trim() || null
}

// ---------------------------------------------------------------------------
// Date helpers (local -- same shape as honeybook.ts's / dubsado.ts's).
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
// parse()
// ---------------------------------------------------------------------------

async function parseAislePlanner(config: AdapterConfig): Promise<ParseResult> {
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

  const missing: string[] = []
  if (!cols.couple) missing.push('Couple')
  if (!cols.weddingDate) missing.push('Wedding Date (or Event Date)')
  if (missing.length > 0) {
    return {
      ok: false, rows: [], warnings,
      errors: [
        `Aisle Planner export is missing required column(s): ${missing.join(', ')}. ` +
        `Expected headers like: Couple, Email Address, Wedding Date. ` +
        `Re-export from Aisle Planner (CRM -> Leads -> Export to CSV) ` +
        `and ensure all columns are included.`,
      ],
    }
  }

  const rows: NormalisedLeadRow[] = []

  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]!
    const get = (col: string | null) => cell(headerRow, data, col)

    const coupleRaw = get(cols.couple)
    const rowEmail = get(cols.email)

    if (!coupleRaw && !rowEmail) {
      warnings.push(`row ${r}: skipped -- no couple name or email`)
      continue
    }

    const { partners } = parseCoupleFromCell(coupleRaw)
    const p1 = partners[0] ?? null
    const p2 = partners[1] ?? null
    const p1Name = splitFullName(p1?.name ?? null)
    const p2Name = splitFullName(p2?.name ?? null)

    if (coupleRaw && partners.length === 0) {
      warnings.push(`row ${r}: "${coupleRaw}" could not be parsed into a name -- imported without a partner name`)
    }

    const statusRaw = get(cols.status)
    const status = deriveStatus(
      { explicit_status: statusRaw },
      AISLE_PLANNER_STATUS_ALIASES,
    )
    const statusGapWarning = describeStatusGap({ explicit_status: statusRaw })
    if (statusGapWarning) {
      warnings.push(`"${coupleRaw ?? `row ${r}`}": ${statusGapWarning}`)
    }
    const finalStatus = status ?? 'inquiry'
    const isOnHold = (statusRaw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ') === 'on hold'
      || (statusRaw ?? '').trim().toLowerCase() === 'hold'

    const inquiry = parseDateIso(get(cols.created))
    const booked = parseDateIso(get(cols.bookedDate))
    const leadSourceRaw = get(cols.leadSource)
    const budgetCents = parseCurrency(get(cols.estimatedBudget))

    const noteParts: string[] = []
    const originalNotes = get(cols.notes)
    if (originalNotes) noteParts.push(originalNotes)
    if (budgetCents != null) {
      noteParts.push(`Estimated budget (coordinator stated, Aisle Planner): ${formatCents(budgetCents)}`)
    }
    if (isOnHold) {
      noteParts.push('Aisle Planner status: On Hold.')
    }
    const combinedNotes = noteParts.length > 0 ? noteParts.join('\n\n') : null

    const lostAtIso = finalStatus === 'lost'
      ? (booked ?? parseDateIso(get(cols.weddingDate)) ?? new Date().toISOString())
      : null
    const lostDeal: NormalisedLostDealRow | null = finalStatus === 'lost'
      ? {
          lost_at: lostAtIso ?? new Date().toISOString(),
          lost_at_stage: null,
          reason_category: 'other',
          reason_detail: 'Imported from Aisle Planner (no detail available).',
          competitor_name: null,
        }
      : null

    rows.push({
      source_id: get(cols.leadId) ?? (coupleRaw ? `aisle_planner:${coupleRaw}` : null),
      partner1_first_name: p1Name.first,
      partner1_last_name: p1Name.last,
      partner1_email: p1?.email ?? rowEmail,
      partner1_phone: p1?.phone ?? get(cols.phone),
      partner2_first_name: p2Name.first,
      partner2_last_name: p2Name.last,
      partner2_email: p2?.email ?? null,
      partner2_phone: p2?.phone ?? null,
      wedding_date: parseDateYmd(get(cols.weddingDate)),
      raw_row: Object.fromEntries(
        headerRow.map((h, i) => [h || `col_${i}`, (data[i] ?? '').trim()]),
      ),
      status: finalStatus,
      // adapter-source-justified: Aisle Planner's Lead Source is a raw
      // provenance string, never interpreted into a canonical channel.
      // weddings.source stays null; only source_detail carries the
      // coordinator-visible text. See this file's "Lead source" note.
      source: null,
      source_detail: leadSourceRaw,
      inquiry_date: inquiry,
      booked_at: booked,
      lost_at: lostAtIso,
      lost_reason: finalStatus === 'lost' ? 'other' : null,
      notes: combinedNotes,
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

function previewAislePlanner(rows: NormalisedLeadRow[]): PreviewResult {
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
      warnings.push(`${withPartner2} row(s) had a second partner in the Couple cell`)
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

async function commitAislePlanner(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
  preview?: boolean
}): Promise<CommitResult> {
  const { commitNormalisedRows } = await import('./index')
  return commitNormalisedRows({
    ...args,
    crmSource: 'aisle_planner',
    defaultInteractionSignalClass: 'crm',
  })
}

export const aislePlannerAdapter: CrmAdapter = {
  name: 'aisle_planner',
  label: 'Aisle Planner',
  description:
    'Import a Leads CSV exported from Aisle Planner (CRM -> Leads -> Export to CSV). ' +
    'Couple and Wedding Date are required; email, phone, status, lead source, and dates ' +
    'are mapped automatically. Estimated Budget goes into notes, not booking value.',
  ready: true,
  parse: parseAislePlanner,
  preview: previewAislePlanner,
  commit: commitAislePlanner,
}
