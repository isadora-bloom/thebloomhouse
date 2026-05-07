/**
 * HoneyBook adapter (T5-Rixey, follow-up to T5-followup-Y / Pattern I).
 *
 * Real implementation. Promoted from scaffold by Stream FF so Rixey
 * Manor's HoneyBook export can be backfilled into Bloom on Day-3 of
 * the onboarding-project flow without going through the generic-csv
 * mapping ceremony.
 *
 * HoneyBook export format (Path 1 — Project / Lead CSV)
 * ------------------------------------------------------
 * The coordinator exports from:
 *   HoneyBook → Settings → Reports → Projects → Export as CSV
 *
 * Typical headers (Q1 2026 export — case-insensitive matching, with
 * common variants accepted):
 *
 *   Project Name      → couple identifier ("First Last Wedding" or
 *                       "First & First Last Wedding"). We split into
 *                       partner1 / partner2 names.
 *   Project Type      → e.g. Wedding / Event (informational; not stored)
 *   Project Date      → wedding_date  (variants: Event Date, Date)
 *   Project Status    → maps into weddings.status (see STATUS_MAP)
 *   Client Name       → primary partner1 name (overrides Project-Name parse
 *                       if provided)
 *   Client Email      → people.email + partner1_email
 *   Client Phone      → people.phone + partner1_phone
 *   Total             → booking_value (parsed "$4,500.00" → 450000 cents)
 *                       (variants: Project Value, Total Project Cost)
 *   Paid              → informational; not stored
 *   Balance           → informational; not stored
 *   Source            → weddings.source (mapped via SOURCE_ALIASES);
 *                       original string preserved in source_detail
 *                       (variants: Lead Source)
 *   Inquiry Date      → weddings.inquiry_date
 *                       (variants: Created Date, Created)
 *   Booking Date      → weddings.booked_at  (variants: Booked Date,
 *                       Contract Signed Date)
 *   Tags              → concatenated into weddings.notes (no tags column)
 *   Notes             → weddings.notes
 *
 * Path 3 (per-project Activity Log CSV) is intentionally NOT supported in
 * this first cut — that flow requires the coordinator to export each
 * project individually and stitch them together. Defer.
 *
 * Tested against HoneyBook export format Q1 2026; if columns rename,
 * update the column-name regex variants in `findColumn()`.
 *
 * Status mapping (HoneyBook → weddings.status enum)
 * -------------------------------------------------
 *   Inquiry / New / Lead              → 'inquiry'
 *   Tour Scheduled                    → 'tour_scheduled'
 *   Tour Completed                    → 'tour_completed'
 *   Proposal / Proposal Sent          → 'proposal_sent'
 *   Booked / Contracted /
 *     Signed Contract / Active        → 'booked'
 *   Completed / Done                  → 'completed'
 *   Cancelled / Canceled              → 'cancelled'
 *   Lost / Closed Lost / Archived     → 'lost'  (also creates a lost_deals
 *                                                row with reason_category=
 *                                                'other' so downstream
 *                                                lost-deal queries see it)
 *
 * Source attribution (T5-Rixey-TT adapter-as-facts refactor, 2026-05-02)
 * ----------------------------------------------------------------------
 * HoneyBook is a CRM (scheduling + invoicing + workflows) — it is NOT
 * an acquisition channel. The previous version of this adapter wrote
 * `weddings.source = 'honeybook'` (or canonicalised the free-text
 * "Lead Source" column to the restricted enum). That short-circuited
 * the lead-source-derivation chain: the Calendly Q7 "where did you
 * hear about us?" answer or the inbound-email-domain analysis would
 * have produced a real first-touch (the_knot / wedding_wire / referral),
 * but a non-NULL `weddings.source = 'honeybook'` made the chain skip
 * the row.
 *
 * New contract: this adapter writes FACTS only.
 *   - `weddings.crm_source = 'honeybook'`  (factual: which CRM)
 *   - `weddings.source_detail` keeps the raw "Source" cell verbatim
 *     so the coordinator's hand-typed value isn't lost
 *   - `weddings.source = NULL` always — the lead-source-derivation
 *     cron decides the real first-touch from Q7 / web-form / email-
 *     domain / UTM in priority order
 *
 * If the HoneyBook "Source" cell happens to encode a real channel
 * (e.g. coordinator typed "The Knot"), the value is also dropped into
 * `interactions.extracted_identity.hear_source` on a synthetic per-row
 * interaction so the derivation chain Priority-2 can pick it up. Per
 * Stream-TT design.
 *
 * Confidence + provenance
 * -----------------------
 * Every wedding/person/lost_deal we insert is tagged
 *   confidence_flag = 'imported_medium'
 *   crm_source      = 'honeybook'
 * per migrations 137 + 172.
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
  { key: 'project_name',  variants: [/^project\s*name$/i, /^name$/i],                    required: true },
  { key: 'project_type',  variants: [/^project\s*type$/i, /^type$/i] },
  { key: 'project_date',  variants: [/^project\s*date$/i, /^event\s*date$/i, /^wedding\s*date$/i, /^date$/i], required: true },
  { key: 'project_status',variants: [/^project\s*status$/i, /^status$/i, /^lead\s*status$/i] },
  { key: 'client_name',   variants: [/^client\s*name$/i, /^primary\s*client(\s*name)?$/i] },
  { key: 'client_email',  variants: [/^client\s*email$/i, /^email$/i, /^primary\s*email$/i],     required: true },
  { key: 'client_phone',  variants: [/^client\s*phone$/i, /^phone$/i, /^primary\s*phone$/i] },
  { key: 'total',         variants: [/^total$/i, /^total\s*project\s*cost$/i, /^project\s*value$/i, /^total\s*invoiced$/i] },
  { key: 'paid',          variants: [/^paid$/i, /^total\s*paid$/i] },
  { key: 'balance',       variants: [/^balance$/i, /^outstanding(\s*balance)?$/i] },
  { key: 'source',        variants: [/^source$/i, /^lead\s*source$/i, /^how\s*did\s*you\s*hear/i] },
  { key: 'inquiry_date',  variants: [/^inquiry\s*date$/i, /^created\s*date$/i, /^created$/i, /^date\s*created$/i] },
  { key: 'booking_date',  variants: [/^booking\s*date$/i, /^booked\s*date$/i, /^date\s*booked$/i, /^contract\s*signed\s*date$/i] },
  { key: 'tags',          variants: [/^tags$/i] },
  { key: 'notes',         variants: [/^notes$/i, /^internal\s*notes$/i, /^description$/i] },
]

interface ColumnIndex {
  /** map of canonical key → column index in the CSV header row, or -1 if absent */
  byKey: Record<string, number>
  /** required keys that we couldn't find */
  missingRequired: string[]
}

function indexColumns(header: string[]): ColumnIndex {
  const byKey: Record<string, number> = {}
  const missingRequired: string[] = []
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
    if (spec.required && foundAt === -1) missingRequired.push(spec.key)
  }
  return { byKey, missingRequired }
}

// ---------------------------------------------------------------------------
// Status enum mapping
// ---------------------------------------------------------------------------

type WeddingStatus = NormalisedLeadRow['status']

const STATUS_MAP: Record<string, WeddingStatus> = {
  'inquiry': 'inquiry',
  'new': 'inquiry',
  'lead': 'inquiry',
  'tour scheduled': 'tour_scheduled',
  'tour_scheduled': 'tour_scheduled',
  'tour completed': 'tour_completed',
  'tour_completed': 'tour_completed',
  'proposal': 'proposal_sent',
  'proposal sent': 'proposal_sent',
  'proposal_sent': 'proposal_sent',
  'booked': 'booked',
  'contracted': 'booked',
  'signed contract': 'booked',
  'signed_contract': 'booked',
  'active': 'booked',
  'paid': 'booked',
  'completed': 'completed',
  'done': 'completed',
  'cancelled': 'cancelled',
  'canceled': 'cancelled',
  'lost': 'lost',
  'closed lost': 'lost',
  'closed_lost': 'lost',
  'archived': 'lost',
}

function mapStatus(raw: string | null | undefined): WeddingStatus {
  if (!raw) return 'inquiry'
  const key = raw.trim().toLowerCase()
  return STATUS_MAP[key] ?? null
}

// ---------------------------------------------------------------------------
// Source-channel canonicalisation (T5-Rixey-TT — scoped DOWN, not removed).
//
// The previous version returned a canonical enum value from the free-text
// "Source" cell and wrote it to `weddings.source`. That circumvented the
// lead-source-derivation chain: a typed "The Knot" or "Word of Mouth" got
// stamped immediately, blocking later signals (Q7, email-domain, UTM)
// from ever running for the row.
//
// New contract: this function still RECOGNISES known channels in the
// free-text — but the result feeds the synthetic interaction's
// `extracted_identity.hear_source` (which the lead-source-derivation
// Priority-2 reads), not `weddings.source` directly. Returning null
// means "I didn't recognise this string" — keep the raw value in
// source_detail and let derivation work from other signals.
// ---------------------------------------------------------------------------

function recogniseHearSource(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (/(the\s*knot|theknot)/.test(s)) return 'the_knot'
  if (/(wedding\s*wire|weddingwire)/.test(s)) return 'weddingwire'
  if (/(instagram|insta|\big\b)/.test(s)) return 'instagram'
  if (/(facebook|\bfb\b)/.test(s)) return 'facebook'
  if (/(pinterest)/.test(s)) return 'pinterest'
  if (/(tik[\s-]*tok)/.test(s)) return 'tiktok'
  if (/(google|search|seo|sem|ads?)/.test(s)) return 'google'
  if (/(referral|referred|word of mouth|wom|friend|family)/.test(s)) return 'referral'
  if (/(website|web\s*form|own\s*site|inquiry\s*form)/.test(s)) return 'website'
  if (/(walk[\s-]*in|drop[\s-]*in)/.test(s)) return 'walk_in'
  if (/(here\s*comes\s*the\s*guide)/.test(s)) return 'here_comes_the_guide'
  if (/(zola)/.test(s)) return 'zola'
  return null
}

// ---------------------------------------------------------------------------
// Money + date helpers
// ---------------------------------------------------------------------------

/** "$4,500.00" → 450000 (cents). Returns null if unparseable.
 *  T5-Rixey-RR fix #5: typed return surfaces the unit at call sites. */
function parseMoneyToCents(raw: string | null | undefined): Cents | null {
  if (raw == null) return null
  const cleaned = raw.replace(/[$,\s]/g, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return dollarsToCents(asDollars(n))
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
  const iso = parseDateIso(raw)
  return iso ? iso.slice(0, 10) : null
}

// ---------------------------------------------------------------------------
// Project-Name parsing. HoneyBook coordinators routinely name projects
// like "Sarah Chen Wedding" or "Sarah & Mike Chen Wedding". Pull out
// partner1 + (optional) partner2 first/last names so we can populate the
// people table even when Client Name is missing or just one partner.
// ---------------------------------------------------------------------------

interface ParsedNames {
  partner1_first: string | null
  partner1_last: string | null
  partner2_first: string | null
  partner2_last: string | null
}

/**
 * Strip a trailing possessive `'s` / `’s` from each whitespace-separated
 * token. T5-Rixey-OO bug #5: "Rebecca and Mike's Wedding" survives the
 * trailing-"Wedding" strip but leaves "Mike's" as partner2_first_name.
 * The apostrophe-s on the second name is purely grammatical (it modifies
 * the now-stripped trailing "Wedding"); strip it from both partner
 * tokens AND from the full project-name string before splitting so the
 * fix is defensive against either order.
 */
function stripTrailingPossessive(token: string): string {
  return token.replace(/['’][sS]$/u, '')
}

function parseProjectName(raw: string | null): ParsedNames {
  const empty: ParsedNames = {
    partner1_first: null, partner1_last: null,
    partner2_first: null, partner2_last: null,
  }
  if (!raw) return empty
  // Strip trailing "Wedding" / "Event" / "Reception" tokens.
  let stripped = raw
    .trim()
    .replace(/\b(wedding|event|reception|ceremony|nuptials)\b\s*$/i, '')
    .trim()
  if (!stripped) return empty
  // Defensive: also strip a trailing possessive 's that the wedding-
  // word strip left dangling. e.g. "Rebecca and Mike's" → "Rebecca and Mike".
  stripped = stripTrailingPossessive(stripped).trim()

  // Two partners?  "Sarah & Mike Chen" / "Sarah and Mike Chen"
  const splitMatch = stripped.split(/\s+(?:&|and|\+)\s+/i)
  if (splitMatch.length === 2) {
    const [left, right] = splitMatch
    // Heuristic: shared last-name pattern → "Sarah" + "Mike Chen"
    // gives partner1_first=Sarah, partner2 first+last from right.
    // Strip possessive from each token in case the apostrophe-s landed
    // on a partner name and slipped past the whole-string strip above.
    const leftTokens = left.trim().split(/\s+/).map(stripTrailingPossessive).filter(Boolean)
    const rightTokens = right.trim().split(/\s+/).map(stripTrailingPossessive).filter(Boolean)
    const result: ParsedNames = { ...empty }
    if (leftTokens.length === 1 && rightTokens.length >= 2) {
      // Partner1 first only; partner2 first + last; partner1 inherits last
      result.partner1_first = leftTokens[0] ?? null
      result.partner2_first = rightTokens[0] ?? null
      result.partner2_last  = rightTokens.slice(1).join(' ')
      result.partner1_last  = result.partner2_last
    } else {
      // Independent full names.
      result.partner1_first = leftTokens[0] ?? null
      if (leftTokens.length > 1) result.partner1_last = leftTokens.slice(1).join(' ')
      result.partner2_first = rightTokens[0] ?? null
      if (rightTokens.length > 1) result.partner2_last = rightTokens.slice(1).join(' ')
    }
    return result
  }

  // Single partner. "Sarah Chen" / "Sarah". Take first + last.
  const tokens = stripped.split(/\s+/).map(stripTrailingPossessive).filter(Boolean)
  if (tokens.length === 1) {
    return { ...empty, partner1_first: tokens[0] ?? null }
  }
  return {
    ...empty,
    partner1_first: tokens[0] ?? null,
    partner1_last: tokens.slice(1).join(' '),
  }
}

/** "Sarah Chen" → ["Sarah", "Chen"]. */
function splitFullName(raw: string | null | undefined): { first: string | null; last: string | null } {
  if (!raw) return { first: null, last: null }
  // Strip trailing possessive 's on each token (T5-Rixey-OO #5 defence).
  const t = raw.trim().split(/\s+/).map(stripTrailingPossessive).filter(Boolean)
  if (t.length === 0) return { first: null, last: null }
  if (t.length === 1) return { first: t[0] ?? null, last: null }
  return { first: t[0] ?? null, last: t.slice(1).join(' ') }
}

// ---------------------------------------------------------------------------
// parse() — CSV → NormalisedLeadRow[]
// ---------------------------------------------------------------------------

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
  const idx = indexColumns(header)
  if (idx.missingRequired.length > 0) {
    return {
      ok: false, rows: [], warnings,
      errors: [
        `HoneyBook export is missing required column(s): ${idx.missingRequired.join(', ')}. ` +
        `Expected headers like: Project Name, Project Date, Client Email. ` +
        `Re-export from HoneyBook (Settings → Reports → Projects → Export as CSV) ` +
        `and ensure all columns are included.`,
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

    const projectName = get(data, 'project_name')
    const clientName  = get(data, 'client_name')
    const clientEmail = get(data, 'client_email')
    const clientPhone = get(data, 'client_phone')
    const projDate    = get(data, 'project_date')
    const status      = mapStatus(get(data, 'project_status'))
    const totalRaw    = get(data, 'total')
    const sourceRaw   = get(data, 'source')
    const inquiry     = get(data, 'inquiry_date')
    const booking     = get(data, 'booking_date')
    const tags        = get(data, 'tags')
    const notes       = get(data, 'notes')

    if (!projDate && !clientEmail && !projectName) {
      warnings.push(`row ${r}: skipped — no project date, email, or name`)
      continue
    }
    if (!clientEmail) {
      warnings.push(`row ${r}: missing Client Email — row imported without contact`)
    }

    // Identity: prefer Client Name (explicit, single string) for partner1;
    // fall back to parsing Project Name. Always run project-name parsing
    // so we can pick up partner2.
    const fromProject = parseProjectName(projectName)
    let p1 = { first: fromProject.partner1_first, last: fromProject.partner1_last }
    if (clientName) {
      const cn = splitFullName(clientName)
      // Only override if Client Name actually has tokens.
      if (cn.first || cn.last) p1 = cn
    }

    if (status == null && get(data, 'project_status')) {
      warnings.push(
        `row ${r}: unknown HoneyBook status '${get(data, 'project_status')}' — defaulting to 'inquiry'`,
      )
    }

    // Tags + notes — concatenate, prefix tags so coordinators can see them
    // even though we don't have a tags column.
    const noteParts: string[] = []
    if (tags)  noteParts.push(`Tags: ${tags}`)
    if (notes) noteParts.push(notes)
    const combinedNotes = noteParts.length > 0 ? noteParts.join('\n\n') : null

    // T5-Rixey-TT adapter-as-facts refactor: do NOT canonicalise the
    // free-text Source into weddings.source. Instead, recognise the
    // value (when possible) and tee it into a synthetic per-row
    // interaction's extracted_identity.hear_source so the lead-source-
    // derivation Priority-2 picks it up. The raw value is also kept
    // in source_detail.
    const recognisedHearSource = recogniseHearSource(sourceRaw)

    const adapterInteractions: NormalisedInteractionRow[] = []
    if (sourceRaw || recognisedHearSource) {
      // Anchor the synthetic interaction at the inquiry timestamp so
      // ORDER BY timestamp picks it up as one of the earliest rows
      // tied to the wedding (the derivation chain queries earliest-
      // first).
      const occurredAt = parseDateIso(inquiry) ?? parseDateIso(projDate) ?? new Date().toISOString()
      adapterInteractions.push({
        occurred_at: occurredAt,
        direction: 'inbound',
        type: 'meeting',
        subject: 'HoneyBook lead-source provenance',
        body: `provider:honeybook\nlead_source_raw:${sourceRaw ?? '(empty)'}`,
        extracted_identity: {
          provider: 'honeybook',
          hear_source_raw: sourceRaw,
          hear_source: recognisedHearSource,
        },
        // T5-Rixey-BBB: when the HoneyBook "Source" cell maps to a
        // recognised acquisition channel, this synthetic interaction
        // IS the source signal — the coordinator typed "The Knot" so
        // we credit The Knot. When unrecognised, default to 'crm'
        // class (HoneyBook is the CRM holding the record).
        // signal-class-justified: per-row override based on Q7-equivalent recognition
        signal_class: recognisedHearSource ? 'source' : 'crm',
      })
    }

    // Lost-deals stub when the row landed in 'lost' status with no further
    // detail. commitNormalisedRows wires this in if status === 'lost' OR
    // lost_at is present.
    const lostAtIso =
      status === 'lost'
        ? (parseDateIso(booking) ?? parseDateIso(projDate) ?? new Date().toISOString())
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

    rows.push({
      source_id: projectName,
      partner1_first_name: p1.first,
      partner1_last_name: p1.last,
      partner1_email: clientEmail,
      partner1_phone: clientPhone,
      partner2_first_name: fromProject.partner2_first,
      partner2_last_name: fromProject.partner2_last,
      wedding_date: parseDateYmd(projDate),
      guest_count_estimate: null,
      booking_value: parseMoneyToCents(totalRaw),
      status: status ?? 'inquiry',
      // T5-Rixey-TT: HoneyBook is a CRM (factual provenance lives in
      // crm_source='honeybook'). Lead-source derivation decides the real
      // first-touch from Q7 / email-domain / UTM in priority order.
      source: null,
      source_detail: sourceRaw,
      inquiry_date: parseDateIso(inquiry),
      booked_at: parseDateIso(booking),
      lost_at: lostAtIso,
      lost_reason: status === 'lost' ? 'other' : null,
      notes: combinedNotes,
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

function previewHoneybook(rows: NormalisedLeadRow[]): PreviewResult {
  const warnings: string[] = []
  if (rows.length > 50) warnings.push(`only first 50 of ${rows.length} rows shown`)

  // Surface a summary in warnings (the UI displays warnings prominently
  // and there's no dedicated summary slot in PreviewResult).
  const byStatus = new Map<string, number>()
  let earliest: string | null = null
  let latest: string | null = null
  const sources = new Set<string>()
  for (const r of rows) {
    byStatus.set(r.status ?? 'inquiry', (byStatus.get(r.status ?? 'inquiry') ?? 0) + 1)
    if (r.wedding_date) {
      if (!earliest || r.wedding_date < earliest) earliest = r.wedding_date
      if (!latest   || r.wedding_date > latest)   latest   = r.wedding_date
    }
    if (r.source_detail) sources.add(r.source_detail)
  }
  if (rows.length > 0) {
    const parts = Array.from(byStatus.entries()).map(([k, v]) => `${k}=${v}`).join(', ')
    warnings.push(`Summary — ${rows.length} rows (${parts})`)
    if (earliest && latest) warnings.push(`Date range: ${earliest} → ${latest}`)
    if (sources.size > 0)   warnings.push(`Distinct lead sources: ${sources.size}`)
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
// same row → DB shape. Stream CC's transaction wrapper (if landed) will
// call this; otherwise per-row inserts run.
// ---------------------------------------------------------------------------

async function commitHoneybook(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
}): Promise<CommitResult> {
  // T5-Rixey-BBB: HoneyBook is a CRM (not an acquisition channel).
  // Default per-row interaction class is 'crm'. The synthetic
  // hear-source interaction parseHoneybook produces (lines 458-477)
  // overrides this to 'source' on a per-row basis when the
  // coordinator-typed "Source" cell maps to a recognised channel.
  return commitNormalisedRows({
    ...args,
    crmSource: 'honeybook',
    defaultInteractionSignalClass: 'crm',
  })
}

export const honeybookAdapter: CrmAdapter = {
  name: 'honeybook',
  label: 'HoneyBook',
  description:
    'Import a Projects CSV exported from HoneyBook (Settings → Reports → Projects → Export). ' +
    'Project Name, Project Date, and Client Email are required; status, total, source, ' +
    'inquiry/booking dates, tags, and notes are mapped automatically.',
  ready: true,
  parse: parseHoneybook,
  preview: previewHoneybook,
  commit: commitHoneybook,
}
