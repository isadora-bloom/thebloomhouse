/**
 * HoneyBook adapter (T5-Rixey-GG / Stream GG rewrite — was Stream FF).
 *
 * Stream FF promoted this adapter against ASSUMED column shape (a
 * multi-state `Project Status`, separate `Client Email`, etc.). The
 * real Q1 2026 Rixey export landed and broke every assumption: it
 * shipped binary `Booked (yes/no)`, concatenated `Client Info`,
 * `Lead Source = "Unknown"` on every row, and six financial columns
 * Stream FF didn't anticipate (Tax / Total Paid / Gratuity / Refunded
 * Amount / Total Project Value / Number of files sent).
 *
 * Stream GG is the root-aware fix: extract the parsing primitives
 * (field-detector, couple-parser, status-deriver, financial-parser)
 * into `crm-import/primitives/` so every CRM adapter shares them. The
 * HoneyBook adapter then becomes a small file containing HINTS
 * (column aliases, status-flag conventions) + thin glue to the
 * primitives.
 *
 * Real HoneyBook Q1 2026 columns (Rixey export, May-2024-Project-report):
 *
 *   Company Name, Project Name, Booked (yes/no), Project Owner,
 *   Team Members, Client Info, Project Type, Lead Source,
 *   Project Creation Date, Booked Date, Project Date,
 *   Number of files sent, Total Project Value, Tax,
 *   Total Paid, Gratuity, Refunded Amount
 *
 * Mapping (HoneyBook → Bloom):
 *   Project Name             → notes-prefix + couple parse fallback
 *   Booked (yes/no)          → status-deriver booked_flag
 *   Project Owner            → crm_team_members[0] (free-text "Name email")
 *   Team Members             → crm_team_members[1..n] (semicolon-separated)
 *   Client Info              → couple-parser → partner1/partner2 + others
 *   Project Type             → filter Wedding-vs-Other; non-weddings go
 *                              to skipped[]
 *   Lead Source              → weddings.source (mapped); 'Unknown' → null
 *                              with a coordinator note (Calendly backfill)
 *   Project Creation Date    → inquiry_date
 *   Booked Date              → booked_at
 *   Project Date             → wedding_date
 *   Total Project Value      → booking_value (cents)
 *   Tax                      → tax_amount (cents)
 *   Total Paid               → amount_paid (cents)
 *   Gratuity                 → gratuity_amount (cents)
 *   Refunded Amount          → refunded_amount (cents)
 *   Number of files sent     → notes-suffix (informational)
 *
 * Pre-commit validation surfaces:
 *   - Lead Source = Unknown on N rows: backfill via Calendly later? (default Yes)
 *   - X% of unbooked projects have past dates — Lost or Inquiry? (default Lost)
 *   - Y rows have Project Type = "Other" — exclude from wedding intel? (default Yes)
 *   - Z rows have no Client Info / no email — skip? (default Skip)
 *   - W rows have Tax > 0 — treat Total as inclusive of tax? (default Yes)
 *
 * Confidence + provenance: every row gets confidence_flag='imported_medium'
 * and crm_source='honeybook'. Per migrations 137 + 172 + 175.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  NormalisedPersonRow,
  CommitResult,
  NormalisedLostDealRow,
  ValidationResult,
  ValidationAnswers,
} from './index'
import { commitNormalisedRows } from './index'
import { parseCsvRows } from '@/lib/services/brain-dump-csv-shape'
import { findColumnIndex } from './primitives/field-detector'
import { parseCoupleFromCell, splitFullName } from './primitives/couple-parser'
import {
  deriveStatus,
  describeStatusGap,
  DEFAULT_STATUS_ALIASES,
  type WeddingStatus,
} from './primitives/status-deriver'
import {
  parseCurrency,
  parseFinancials,
} from './primitives/financial-parser'

// ---------------------------------------------------------------------------
// Per-CRM column hints — these stay close to the wire shape since they're
// the only CRM-specific knowledge that doesn't generalise.
// ---------------------------------------------------------------------------

const COLUMN_HINTS = {
  project_name:    [['project name', 'name']],
  booked_flag:     [['booked (yes/no)', 'booked yes/no', 'booked']],
  project_owner:   [['project owner', 'owner']],
  team_members:    [['team members', 'team']],
  client_info:     [['client info', 'client information', 'client', 'client name', 'clients']],
  project_type:    [['project type', 'type']],
  lead_source:     [['lead source', 'source', 'how did you hear']],
  creation_date:   [['project creation date', 'created date', 'created', 'date created', 'inquiry date']],
  booked_date:     [['booked date', 'booking date', 'date booked', 'contract signed date']],
  project_date:    [['project date', 'event date', 'wedding date', 'date']],
  files_sent:      [['number of files sent', 'files sent']],
  total_value:     [['total project value', 'total', 'project value', 'total invoiced']],
  tax:             [['tax', 'tax amount']],
  total_paid:      [['total paid', 'paid']],
  gratuity:        [['gratuity', 'tip']],
  refunded:        [['refunded amount', 'refunded', 'refund']],
  external_id:     [['project id', 'id']],
}

// HoneyBook-specific status alias: the binary path is the rule but
// occasionally exports are configured with a `Project Status` column —
// we still lookup any free-text status against the default alias map.
const HONEYBOOK_STATUS_ALIASES: Record<string, WeddingStatus> = {
  ...DEFAULT_STATUS_ALIASES,
  // No HoneyBook-specific overrides today; placeholder for the future.
}

// ---------------------------------------------------------------------------
// Source-channel canonicalisation. HoneyBook's "Lead Source" is
// free-text + frequently the literal "Unknown". We preserve the raw
// string in source_detail and canonicalise to the Bloom enum when
// possible — Unknown returns null so backfill from Calendly etc. can
// fill it later.
// ---------------------------------------------------------------------------

function canonicaliseSource(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (s === 'unknown' || s === 'n/a' || s === 'na' || s === 'none') return null
  if (/(the\s*knot|theknot)/.test(s)) return 'the_knot'
  if (/(wedding\s*wire|weddingwire)/.test(s)) return 'weddingwire'
  if (/(instagram|insta|\big\b)/.test(s)) return 'instagram'
  if (/(google|search|seo|sem|ads?)/.test(s)) return 'google'
  if (/(referral|referred|word of mouth|wom)/.test(s)) return 'referral'
  if (/(website|web\s*form|own\s*site|inquiry\s*form)/.test(s)) return 'website'
  if (/(walk[\s-]*in|drop[\s-]*in)/.test(s)) return 'walk_in'
  return 'other'
}

// ---------------------------------------------------------------------------
// Date helpers. HoneyBook ships timestamps as "YYYY-MM-DD HH:MM:SS UTC"
// or just "YYYY-MM-DD". JS Date.parse handles both.
// ---------------------------------------------------------------------------

function parseDateIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function parseDateYmd(raw: string | null | undefined): string | null {
  const iso = parseDateIso(raw)
  return iso ? iso.slice(0, 10) : null
}

// ---------------------------------------------------------------------------
// Project-Name fallback parse — only used when Client Info is missing.
// HoneyBook coordinators name projects "Sarah Chen Wedding" /
// "Sarah and Mike Chen Wedding" / "Sarah Chen's Project". We strip the
// trailing event-token, then run the couple-parser shared-surname path.
// ---------------------------------------------------------------------------

function parseProjectNameFallback(raw: string | null | undefined) {
  if (!raw) return { partners: [], others: [] }
  const stripped = raw
    .trim()
    // Strip "'s Project" / "'s Wedding" / etc.
    .replace(/'s\s+(project|wedding|event|reception|ceremony|nuptials)\s*$/i, '')
    .replace(/\b(wedding|event|reception|ceremony|nuptials|weddings)\b\s*$/i, '')
    .trim()
  if (!stripped) return { partners: [], others: [] }
  return parseCoupleFromCell(stripped)
}

// ---------------------------------------------------------------------------
// Team-members parse. HoneyBook ships "Name email@x.com" or
// "Name1 email1@x, Name2 email2@y" or "" — we re-use parseCoupleFromCell
// since the shape is identical, then drop the partner-vs-other distinction
// and tag every entry as a team member.
// ---------------------------------------------------------------------------

function parseTeamMembers(...cells: Array<string | null>): Array<{
  name: string | null
  email: string | null
  role: string | null
}> {
  const out: Array<{ name: string | null; email: string | null; role: string | null }> = []
  for (const cell of cells) {
    if (!cell) continue
    const parsed = parseCoupleFromCell(cell)
    for (const p of [...parsed.partners, ...parsed.others]) {
      if (!p.name && !p.email) continue
      out.push({
        name: p.name,
        email: p.email,
        role: p.role_raw ?? p.role,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// parse() — CSV → NormalisedLeadRow[]
// ---------------------------------------------------------------------------

interface ParseContext {
  /** Tracks "Lead Source = Unknown on every row" pattern for the validate() pass. */
  unknownSourceCount: number
  /** Tracks ambiguous-tax rows for the validate() pass. */
  taxableCount: number
  /** Tracks rows skipped because Project Type !== Wedding. */
  nonWeddingSkipped: Array<{ rowIndex: number; identifier: string | null }>
  /** Tracks rows skipped for missing identity. */
  noIdentitySkipped: Array<{ rowIndex: number; identifier: string | null }>
  /** Tracks unbooked-with-past-date count for the validate() pass. */
  unbookedPastCount: number
  /** Tracks unbooked-with-future-date count. */
  unbookedFutureCount: number
}

async function parseHoneybook(config: AdapterConfig): Promise<ParseResult> {
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
  // Resolve column indices via the field-detector primitive.
  const idx: Record<string, number> = {}
  for (const [key, aliases] of Object.entries(COLUMN_HINTS)) {
    idx[key] = findColumnIndex(header, aliases)
  }

  // Required columns: project_name OR client_info, project_date OR booked_date.
  // (HoneyBook Rixey export sometimes has projects without project_date —
  // those are inquiries that haven't picked a date yet.)
  if (idx.project_name < 0 && idx.client_info < 0) {
    return {
      ok: false, rows: [], warnings,
      errors: [
        'HoneyBook export needs at least one of: Project Name, Client Info. ' +
        'Re-export from HoneyBook (Settings → Reports → Projects → Export ' +
        'as CSV) and ensure all columns are included.',
      ],
    }
  }

  const ctx: ParseContext = {
    unknownSourceCount: 0,
    taxableCount: 0,
    nonWeddingSkipped: [],
    noIdentitySkipped: [],
    unbookedPastCount: 0,
    unbookedFutureCount: 0,
  }

  const rows: NormalisedLeadRow[] = []

  const get = (data: string[], key: string): string | null => {
    const i = idx[key]
    if (i == null || i < 0) return null
    return (data[i] ?? '').trim() || null
  }

  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]

    const projectName  = get(data, 'project_name')
    const clientInfo   = get(data, 'client_info')
    const projectType  = get(data, 'project_type')
    const bookedRaw    = get(data, 'booked_flag')
    const projectOwner = get(data, 'project_owner')
    const teamMembers  = get(data, 'team_members')
    const sourceRaw    = get(data, 'lead_source')
    const creation     = get(data, 'creation_date')
    const bookedDate   = get(data, 'booked_date')
    const projDate     = get(data, 'project_date')
    const filesSent    = get(data, 'files_sent')
    const totalRaw     = get(data, 'total_value')
    const taxRaw       = get(data, 'tax')
    const paidRaw      = get(data, 'total_paid')
    const gratRaw      = get(data, 'gratuity')
    const refundedRaw  = get(data, 'refunded')
    const externalId   = get(data, 'external_id')

    const identifier = projectName ?? clientInfo ?? `row ${r}`

    // Filter non-Wedding rows. Project Type 'Other' is HoneyBook's
    // catch-all for popups, photo shoots, rentals — not weddings.
    if (projectType && projectType.trim().toLowerCase() === 'other') {
      ctx.nonWeddingSkipped.push({ rowIndex: r, identifier })
      continue
    }

    // Couple parse — prefer Client Info, fall back to Project Name.
    const couple = clientInfo
      ? parseCoupleFromCell(clientInfo)
      : parseProjectNameFallback(projectName)

    const partner1 = couple.partners[0] ?? null
    const partner2 = couple.partners[1] ?? null

    // Identity gate. Need at least one of: partner1 with name OR email,
    // OR client_info contained anything parseable.
    const hasIdentity = Boolean(
      (partner1 && (partner1.name || partner1.email)) ||
      (partner2 && (partner2.name || partner2.email))
    )
    if (!hasIdentity) {
      ctx.noIdentitySkipped.push({ rowIndex: r, identifier })
      continue
    }

    // Status. Use the binary booked flag as primary signal; when
    // there's an explicit_status column too (rare for HoneyBook) we
    // also try the alias map.
    const bookedFlag =
      bookedRaw == null ? null
      : /^(yes|y|true|1)$/i.test(bookedRaw.trim()) ? true
      : /^(no|n|false|0)$/i.test(bookedRaw.trim()) ? false
      : null

    const derivedStatus = deriveStatus(
      {
        booked_flag: bookedFlag,
        project_date: projDate ? parseDateIso(projDate) : null,
      },
      HONEYBOOK_STATUS_ALIASES,
    )

    const statusGap = describeStatusGap({
      explicit_status: bookedRaw,
    })
    if (statusGap) warnings.push(`row ${r}: ${statusGap}`)

    const status: WeddingStatus = derivedStatus ?? 'inquiry'

    // Track unbooked-past vs unbooked-future for the validate() pass.
    if (bookedFlag === false && projDate) {
      const projIso = parseDateIso(projDate)
      if (projIso) {
        const projTime = new Date(projIso).getTime()
        const now = Date.now()
        if (projTime < now) ctx.unbookedPastCount++
        else ctx.unbookedFutureCount++
      }
    }

    // Source canonicalisation. "Unknown" → null + tracked.
    const canonicalSource = canonicaliseSource(sourceRaw)
    if (sourceRaw && sourceRaw.trim().toLowerCase() === 'unknown') {
      ctx.unknownSourceCount++
    }

    // Financials.
    const fin = parseFinancials({
      total: totalRaw,
      tax: taxRaw,
      paid: paidRaw,
      gratuity: gratRaw,
      refunded: refundedRaw,
    })
    if ((fin.tax_cents ?? 0) > 0) ctx.taxableCount++

    // Team members aggregate. Project Owner + Team Members (the latter
    // is usually a comma-separated list of "Name email" pairs).
    const teamArray = parseTeamMembers(projectOwner, teamMembers)

    // Notes — accumulate Project Name (when not used for couple), files-sent.
    const noteParts: string[] = []
    if (projectName && clientInfo && projectName !== clientInfo) {
      noteParts.push(`HoneyBook project: ${projectName}`)
    }
    if (filesSent && filesSent !== '0') {
      noteParts.push(`Files sent: ${filesSent}`)
    }
    const notes = noteParts.length > 0 ? noteParts.join('\n') : null

    // Lost-deals stub.
    const lostAtIso =
      status === 'lost'
        ? (parseDateIso(bookedDate) ?? parseDateIso(projDate) ?? new Date().toISOString())
        : null
    const lostDeal: NormalisedLostDealRow | null =
      status === 'lost'
        ? {
            lost_at: lostAtIso ?? new Date().toISOString(),
            lost_at_stage: null,
            reason_category: 'other',
            reason_detail: 'Imported from HoneyBook (no detail available).',
            competitor_name: null,
          }
        : null

    // Per-row import warnings. These are stored in
    // weddings.import_warnings as a jsonb array for coordinator review.
    const rowWarnings: Array<{ field: string; issue: string; value: unknown }> = []
    if (sourceRaw && sourceRaw.trim().toLowerCase() === 'unknown') {
      rowWarnings.push({
        field: 'source',
        issue: 'lead_source_unknown',
        value: sourceRaw,
      })
    }
    if (!partner1?.email && !partner2?.email) {
      rowWarnings.push({
        field: 'partner_email',
        issue: 'no_partner_email',
        value: clientInfo,
      })
    }
    if ((fin.tax_cents ?? 0) > 0) {
      rowWarnings.push({
        field: 'booking_value',
        issue: 'tax_inclusivity_ambiguous',
        value: fin.total_cents,
      })
    }

    // Normalise partner1 / partner2 names + extract `others`.
    const p1Split = splitFullName(partner1?.name ?? null)
    const p2Split = splitFullName(partner2?.name ?? null)
    const others: NormalisedPersonRow[] = couple.others.map((o) => {
      const split = splitFullName(o.name)
      return {
        first_name: split.first,
        last_name: split.last,
        email: o.email,
        phone: o.phone,
        role: o.role,
      }
    })

    rows.push({
      source_id: externalId ?? projectName,
      crm_external_id: externalId,
      partner1_first_name: p1Split.first,
      partner1_last_name: p1Split.last,
      partner1_email: partner1?.email ?? null,
      partner1_phone: partner1?.phone ?? null,
      partner2_first_name: p2Split.first,
      partner2_last_name: p2Split.last,
      partner2_email: partner2?.email ?? null,
      partner2_phone: partner2?.phone ?? null,
      wedding_date: parseDateYmd(projDate),
      guest_count_estimate: null,
      booking_value: fin.total_cents,
      tax_amount: fin.tax_cents,
      amount_paid: fin.paid_cents,
      gratuity_amount: fin.gratuity_cents,
      refunded_amount: fin.refunded_cents,
      crm_team_members: teamArray.length > 0 ? teamArray : null,
      status,
      source: canonicalSource,
      source_detail: sourceRaw,
      inquiry_date: parseDateIso(creation),
      booked_at: parseDateIso(bookedDate),
      lost_at: lostAtIso,
      lost_reason: status === 'lost' ? 'other' : null,
      notes,
      import_warnings: rowWarnings.length > 0 ? rowWarnings : null,
      interactions: [],
      tours: [],
      lost_deal: lostDeal,
      others,
    })
  }

  // Surface aggregate ctx into warnings so the API layer can pass them
  // through to validate() without re-parsing.
  if (ctx.nonWeddingSkipped.length > 0) {
    warnings.push(
      `${ctx.nonWeddingSkipped.length} rows had Project Type='Other' — ` +
      `excluded from import (see validate() for review)`
    )
  }
  if (ctx.noIdentitySkipped.length > 0) {
    warnings.push(
      `${ctx.noIdentitySkipped.length} rows had no parseable Client Info / ` +
      `Project Name — skipped`
    )
  }

  // Stash ctx on the parse result via a "warnings annotation" — adapters
  // don't return ctx directly; we re-derive it inside validate().
  return { ok: errors.length === 0, rows, errors, warnings }
}

// ---------------------------------------------------------------------------
// validate() — coordinator-facing pre-commit questions
// ---------------------------------------------------------------------------

function validateHoneybook(rows: NormalisedLeadRow[]): ValidationResult {
  const total = rows.length
  let unknownSource = 0
  let unbookedPast = 0
  let unbookedFuture = 0
  let noEmail = 0
  let taxableTotals = 0
  const skipped: ValidationResult['skipped'] = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.source_detail && r.source_detail.trim().toLowerCase() === 'unknown') unknownSource++
    if (!r.partner1_email && !r.partner2_email) noEmail++
    if (r.tax_amount && r.tax_amount > 0) taxableTotals++
    // Determine unbooked-past / unbooked-future via lost_at OR by status.
    if (r.status === 'lost' && r.wedding_date) {
      const projTime = new Date(r.wedding_date).getTime()
      if (Number.isFinite(projTime)) {
        if (projTime < Date.now()) unbookedPast++
        else unbookedFuture++
      }
    } else if (r.status === 'inquiry' && r.wedding_date) {
      const projTime = new Date(r.wedding_date).getTime()
      if (Number.isFinite(projTime)) {
        if (projTime < Date.now()) unbookedPast++
      }
    }
  }

  const questions: ValidationResult['questions'] = []

  if (unknownSource > 0) {
    questions.push({
      id: 'unknown_lead_source',
      question:
        `Lead Source is 'Unknown' on ${unknownSource} of ${total} projects — ` +
        `Bloom will leave source NULL and try to backfill from Calendly + ` +
        `web inquiry data after import. OK?`,
      choices: [
        { id: 'backfill', label: 'Yes, backfill later', recommended: true },
        { id: 'keep_other', label: 'No, mark them Other now' },
      ],
      affectedRowCount: unknownSource,
    })
  }

  if (unbookedPast > 0) {
    const pct = Math.round((unbookedPast / total) * 100)
    questions.push({
      id: 'unbooked_past_disposition',
      question:
        `${pct}% (${unbookedPast}) of projects have no booking but the project ` +
        `date has already passed — should they be marked Lost or kept as Inquiry?`,
      choices: [
        { id: 'lost', label: 'Mark as Lost', recommended: true },
        { id: 'inquiry', label: 'Keep as Inquiry' },
        { id: 'cancelled', label: 'Mark as Cancelled' },
      ],
      affectedRowCount: unbookedPast,
    })
  }

  if (noEmail > 0) {
    questions.push({
      id: 'no_email_disposition',
      question:
        `${noEmail} rows have no Client Info / Client Email — they'll be ` +
        `imported but won't be reachable until a coordinator adds contact info. ` +
        `Continue?`,
      choices: [
        { id: 'import', label: 'Yes, import them anyway', recommended: true },
        { id: 'skip', label: 'No, skip these rows' },
      ],
      affectedRowCount: noEmail,
    })
  }

  if (taxableTotals > 0) {
    questions.push({
      id: 'tax_inclusivity',
      question:
        `${taxableTotals} rows have Tax > 0. HoneyBook's Total Project Value ` +
        `is inclusive of tax in some accounts and exclusive in others — which ` +
        `is true for your account?`,
      choices: [
        { id: 'inclusive', label: 'Total includes tax', recommended: true },
        { id: 'exclusive', label: 'Total excludes tax (add tax to total on import)' },
      ],
      affectedRowCount: taxableTotals,
    })
  }

  const notes: string[] = []
  if (unbookedFuture > 0) {
    notes.push(
      `${unbookedFuture} unbooked projects have FUTURE dates — kept as Inquiry ` +
      `(coordinator can re-engage).`
    )
  }

  return { questions, notes, skipped }
}

// ---------------------------------------------------------------------------
// applyAnswers() — mutate rows in light of the coordinator's answers
// ---------------------------------------------------------------------------

function applyAnswersHoneybook(
  rows: NormalisedLeadRow[],
  answers: ValidationAnswers,
): NormalisedLeadRow[] {
  const out = rows.map((r) => ({ ...r }))

  // unknown_lead_source: 'keep_other' → coerce source = 'other'
  if (answers.unknown_lead_source === 'keep_other') {
    for (const r of out) {
      if (r.source_detail && r.source_detail.trim().toLowerCase() === 'unknown') {
        r.source = 'other'
      }
    }
  }

  // unbooked_past_disposition: 'inquiry' / 'cancelled' override
  if (answers.unbooked_past_disposition === 'inquiry') {
    for (const r of out) {
      if (r.status === 'lost' && r.wedding_date && new Date(r.wedding_date).getTime() < Date.now()) {
        r.status = 'inquiry'
        r.lost_at = null
        r.lost_reason = null
        r.lost_deal = null
      }
    }
  } else if (answers.unbooked_past_disposition === 'cancelled') {
    for (const r of out) {
      if (r.status === 'lost' && r.wedding_date && new Date(r.wedding_date).getTime() < Date.now()) {
        r.status = 'cancelled'
        r.lost_at = null
        r.lost_reason = null
        r.lost_deal = null
      }
    }
  }

  // no_email_disposition: 'skip' → drop them
  let filtered = out
  if (answers.no_email_disposition === 'skip') {
    filtered = filtered.filter((r) => r.partner1_email || r.partner2_email)
  }

  // tax_inclusivity: 'exclusive' → add tax to booking_value
  if (answers.tax_inclusivity === 'exclusive') {
    for (const r of filtered) {
      if (r.tax_amount && r.tax_amount > 0 && r.booking_value != null) {
        r.booking_value = r.booking_value + r.tax_amount
      }
    }
  }

  return filtered
}

// ---------------------------------------------------------------------------
// preview() — summary plus first 50 rows
// ---------------------------------------------------------------------------

function previewHoneybook(rows: NormalisedLeadRow[]): PreviewResult {
  const warnings: string[] = []
  if (rows.length > 50) warnings.push(`only first 50 of ${rows.length} rows shown`)

  // Surface a summary in warnings (the UI displays warnings prominently
  // and there's no dedicated summary slot in PreviewResult).
  const byStatus = new Map<string, number>()
  let earliest: string | null = null
  let latest: string | null = null
  const sources = new Set<string>()
  let totalRevenueCents = 0
  let totalPaidCents = 0
  let rowsMissingEmail = 0
  for (const r of rows) {
    byStatus.set(r.status ?? 'inquiry', (byStatus.get(r.status ?? 'inquiry') ?? 0) + 1)
    if (r.wedding_date) {
      if (!earliest || r.wedding_date < earliest) earliest = r.wedding_date
      if (!latest   || r.wedding_date > latest)   latest   = r.wedding_date
    }
    if (r.source_detail) sources.add(r.source_detail)
    if (r.booking_value) totalRevenueCents += r.booking_value
    if (r.amount_paid) totalPaidCents += r.amount_paid
    if (!r.partner1_email && !r.partner2_email) rowsMissingEmail++
  }
  if (rows.length > 0) {
    const parts = Array.from(byStatus.entries()).map(([k, v]) => `${k}=${v}`).join(', ')
    warnings.push(`Summary — ${rows.length} rows (${parts})`)
    if (earliest && latest) warnings.push(`Date range: ${earliest} → ${latest}`)
    if (sources.size > 0) warnings.push(`Distinct lead sources: ${sources.size}`)
    if (totalRevenueCents > 0) {
      const fmt = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      warnings.push(`Total contract value: ${fmt(totalRevenueCents)} (paid: ${fmt(totalPaidCents)})`)
    }
    if (rowsMissingEmail > 0) {
      warnings.push(`${rowsMissingEmail} row(s) missing partner email`)
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
// commit() — funnel through commitNormalisedRows so all adapters share
// the same row → DB shape.
// ---------------------------------------------------------------------------

async function commitHoneybook(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
}): Promise<CommitResult> {
  return commitNormalisedRows({ ...args, crmSource: 'honeybook' })
}

export const honeybookAdapter: CrmAdapter = {
  name: 'honeybook',
  label: 'HoneyBook',
  description:
    'Import a Projects CSV exported from HoneyBook (Settings → Reports → ' +
    'Projects → Export). Handles binary Booked yes/no, concatenated Client ' +
    'Info, Tax / Total Paid / Gratuity / Refunded. Lead Source = Unknown ' +
    'rows are flagged for Calendly backfill. Per T5-Rixey-GG / Stream GG.',
  ready: true,
  parse: parseHoneybook,
  preview: previewHoneybook,
  validate: validateHoneybook,
  applyAnswers: applyAnswersHoneybook,
  commit: commitHoneybook,
}

// Re-export the parseCurrency helper for tests / callers that want the
// HoneyBook flavour. Currently identical to the primitive.
export { parseCurrency }
