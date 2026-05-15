/**
 * Storefront-activity ingester - The Knot / WeddingWire funnel exports.
 *
 * A wedding-marketplace storefront (theknot.com, weddingwire.com) gives
 * the venue an analytics export of every action couples took ON the
 * storefront: views, saves, messages, clicks, calls, reviews. This is
 * NOT the leads export (that is the knot.ts adapter - couples who
 * actually submitted an inquiry). This is the wider funnel: the views
 * and saves that lead up to a message.
 *
 * Example column shape (Knot storefront-activity export):
 *   "Action Taken","Visitor Name","Date of Visit","City","State"
 *
 * Action Taken values seen in the wild:
 *   Storefront View              - couple viewed the venue page
 *   Storefront Save              - couple saved the venue
 *   Message                      - couple sent a message (a real inquiry)
 *   Click to Website/Social      - couple clicked through to the site
 *   Couple unmarked as booked    - a booked couple was un-marked
 *   Reviewed                     - couple left a review
 *   Call                         - couple called the venue
 *
 * Identity problem:
 *   "Visitor Name" is partial - "Jayden P." (first name + last initial).
 *   That is NOT enough to identify a couple. So every row is ingested as
 *   a LOW-CONFIDENCE touchpoint into tangential_signals, never a
 *   wedding. The identity resolver / cross-source matcher promotes a
 *   tangential signal to a couple later, when a fuller identity (email,
 *   full name) for "Jayden P." arrives via the leads export or Gmail.
 *
 * What this adapter does:
 *   - Every row -> one tangential_signals row (source_platform, action
 *     class, partial extracted_identity, signal_date). The aggregate is
 *     the discovery funnel: views -> saves -> messages.
 *   - 'Message' rows are the highest-value: they are real inquiries.
 *     They get action_class='message' + signal_class='source' so the
 *     funnel and the cross-source matcher weight them heavily. We still
 *     do NOT mint a wedding from a partial name - the knot.ts leads
 *     adapter is the path that mints weddings (it has email).
 *   - 'Storefront View' / 'Storefront Save' are aggregate-only.
 *
 * Because rows do not carry a couple identity, this adapter does not
 * use commitNormalisedRows at all - it writes tangential_signals
 * directly (the same table web-form.ts writes its form_submission
 * signals to). NormalisedLeadRow[] is returned EMPTY from parse(); the
 * real payload rides in an out-of-band field the commit() reads.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  CommitResult,
} from './index'
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'

// ---------------------------------------------------------------------------
// Action-Taken classification.
//
// Maps the storefront's free-text "Action Taken" value to:
//   - action_class : the tangential_signals.action_class value
//   - signal_class : source / touchpoint per the class-of-signal model
//   - funnel_stage : where in the discovery funnel this action sits
//
// A 'message' is a real inquiry (the strongest funnel signal short of a
// booking) - signal_class='source'. Views / saves / clicks are earlier-
// funnel touchpoints. 'review' / 'call' / 'unmark' are post-discovery
// and tagged accordingly.
// ---------------------------------------------------------------------------

interface ActionClassification {
  action_class: string
  signal_class: 'source' | 'touchpoint' | 'crm' | 'outcome'
  funnel_stage: 'view' | 'save' | 'click' | 'message' | 'review' | 'call' | 'other'
}

function classifyAction(rawAction: string | null | undefined): ActionClassification {
  const a = (rawAction ?? '').trim().toLowerCase()

  // A storefront message IS an inquiry - the acquisition channel signal.
  if (a.includes('message')) {
    return { action_class: 'message', signal_class: 'source', funnel_stage: 'message' }
  }
  if (a.includes('save')) {
    return { action_class: 'save', signal_class: 'touchpoint', funnel_stage: 'save' }
  }
  if (a.includes('view')) {
    return { action_class: 'view', signal_class: 'touchpoint', funnel_stage: 'view' }
  }
  if (a.includes('click')) {
    return { action_class: 'click', signal_class: 'touchpoint', funnel_stage: 'click' }
  }
  if (a.includes('review')) {
    return { action_class: 'review', signal_class: 'touchpoint', funnel_stage: 'review' }
  }
  if (a.includes('call')) {
    // A call from a storefront contact is a real reach-out - treat it as
    // a source-class discovery signal like a message.
    return { action_class: 'call', signal_class: 'source', funnel_stage: 'call' }
  }
  if (a.includes('unmark')) {
    // "Couple unmarked as booked" - a CRM-side correction, not discovery.
    return { action_class: 'unmark', signal_class: 'crm', funnel_stage: 'other' }
  }
  return { action_class: 'other', signal_class: 'touchpoint', funnel_stage: 'other' }
}

// ---------------------------------------------------------------------------
// Provider detection - the export does not always say which marketplace
// it came from, so we expose a `provider` hint and default to 'the_knot'
// (the most common). The hint rides on AdapterConfig.provider, reusing
// the same field the tour-scheduler adapter uses.
// ---------------------------------------------------------------------------

type StorefrontProvider = 'the_knot' | 'wedding_wire'

function resolveProvider(hint: string | undefined): StorefrontProvider {
  if (hint === 'wedding_wire') return 'wedding_wire'
  return 'the_knot'
}

// ---------------------------------------------------------------------------
// Column detection - case-insensitive, accepts common variants.
// ---------------------------------------------------------------------------

interface ColIndex {
  action: number
  visitor: number
  date: number
  city: number
  state: number
}

function indexColumns(header: string[]): ColIndex {
  const find = (variants: RegExp[]): number => {
    for (let i = 0; i < header.length; i++) {
      const h = (header[i] ?? '').trim()
      if (variants.some((re) => re.test(h))) return i
    }
    return -1
  }
  return {
    action: find([/^action\s*taken$/i, /^action$/i, /^activity$/i, /^event$/i]),
    visitor: find([/^visitor\s*name$/i, /^visitor$/i, /^couple\s*name$/i, /^name$/i, /^user$/i]),
    date: find([/^date\s*of\s*visit$/i, /^visit\s*date$/i, /^date$/i, /^activity\s*date$/i]),
    city: find([/^city$/i]),
    state: find([/^state$/i, /^region$/i]),
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function parseDateIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** "Jayden P." -> { first_name: 'Jayden', last_initial: 'P' }. The last
 *  name is intentionally a single letter - that is all the storefront
 *  exposes, and recording it as last_initial (not last_name) keeps the
 *  cross-source matcher from treating it as a full surname. */
function parsePartialName(
  raw: string | null | undefined,
): { first_name: string | null; last_initial: string | null; raw: string | null } {
  if (!raw) return { first_name: null, last_initial: null, raw: null }
  const trimmed = raw.trim()
  if (!trimmed) return { first_name: null, last_initial: null, raw: null }
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { first_name: null, last_initial: null, raw: trimmed }
  if (tokens.length === 1) {
    return { first_name: tokens[0] ?? null, last_initial: null, raw: trimmed }
  }
  // Last token is usually "P." or "P" - strip the dot, keep first letter.
  const last = (tokens[tokens.length - 1] ?? '').replace(/[^A-Za-z]/g, '')
  return {
    first_name: tokens[0] ?? null,
    last_initial: last ? (last[0]?.toUpperCase() ?? null) : null,
    raw: trimmed,
  }
}

// ---------------------------------------------------------------------------
// The parsed storefront-signal row. This is NOT a NormalisedLeadRow -
// storefront activity does not become a wedding. It is carried out of
// parse() on the ParseResult and consumed by commit().
// ---------------------------------------------------------------------------

export interface StorefrontSignalRow {
  action_raw: string | null
  action_class: string
  signal_class: 'source' | 'touchpoint' | 'crm' | 'outcome'
  funnel_stage: string
  visitor_first_name: string | null
  visitor_last_initial: string | null
  visitor_name_raw: string | null
  city: string | null
  state: string | null
  signal_date: string | null
  /** Full untouched source row, header-keyed. */
  raw_row: Record<string, string>
}

interface StorefrontParseResult extends ParseResult {
  storefrontSignals?: StorefrontSignalRow[]
  storefrontProvider?: StorefrontProvider
}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

async function parseStorefrontActivity(config: AdapterConfig): Promise<StorefrontParseResult> {
  const errors: string[] = []
  const warnings: string[] = []

  if (!config.csvText || !config.csvText.trim()) {
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings }
  }

  const csvRows = parseCsvRows(config.csvText)
  if (csvRows.length < 2) {
    return {
      ok: false,
      rows: [],
      errors: ['csv must have a header row and at least one data row'],
      warnings,
    }
  }

  const header = csvRows[0].map((h) => h.trim())
  const idx = indexColumns(header)
  if (idx.action < 0) {
    return {
      ok: false,
      rows: [],
      errors: [
        'Could not find an "Action Taken" column. A storefront-activity ' +
        'export must have an Action Taken / Activity column. If this is a ' +
        'leads export (couples who submitted an inquiry), use the ' +
        'The Knot adapter instead.',
      ],
      warnings,
    }
  }

  const provider = resolveProvider(config.provider as string | undefined)
  const signals: StorefrontSignalRow[] = []

  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]
    const get = (i: number): string | null => {
      if (i < 0) return null
      return (data[i] ?? '').trim() || null
    }

    const actionRaw = get(idx.action)
    if (!actionRaw) {
      warnings.push(`row ${r}: skipped - empty Action Taken`)
      continue
    }
    const cls = classifyAction(actionRaw)
    const name = parsePartialName(get(idx.visitor))

    signals.push({
      action_raw: actionRaw,
      action_class: cls.action_class,
      signal_class: cls.signal_class,
      funnel_stage: cls.funnel_stage,
      visitor_first_name: name.first_name,
      visitor_last_initial: name.last_initial,
      visitor_name_raw: name.raw,
      city: get(idx.city),
      state: get(idx.state),
      signal_date: parseDateIso(get(idx.date)),
      raw_row: Object.fromEntries(
        header.map((h, i) => [h || `col_${i}`, (data[i] ?? '').trim()]),
      ),
    })
  }

  if (signals.length === 0) {
    errors.push('no storefront-activity rows could be read')
  }

  // rows stays EMPTY - storefront activity never mints a wedding. The
  // signals ride on storefrontSignals.
  return {
    ok: errors.length === 0,
    rows: [],
    errors,
    warnings,
    storefrontSignals: signals,
    storefrontProvider: provider,
  }
}

// ---------------------------------------------------------------------------
// preview() - funnel summary. The aggregate IS the value here.
// ---------------------------------------------------------------------------

function previewStorefrontActivity(_rows: NormalisedLeadRow[]): PreviewResult {
  // The route hands NormalisedLeadRow[] (always empty for this adapter)
  // to preview(); the real funnel summary is built in the route off the
  // storefrontSignals field. Keep this minimal + correct.
  return { rows: [], total: 0, errors: [], warnings: [] }
}

/**
 * Build the funnel summary from the parsed signals. Called by the route
 * so the coordinator sees views -> saves -> messages before committing.
 */
export function summariseStorefrontFunnel(signals: StorefrontSignalRow[]): {
  total: number
  byStage: Record<string, number>
  messages: number
  dateRange: { earliest: string | null; latest: string | null }
} {
  const byStage: Record<string, number> = {}
  let earliest: string | null = null
  let latest: string | null = null
  for (const s of signals) {
    byStage[s.funnel_stage] = (byStage[s.funnel_stage] ?? 0) + 1
    if (s.signal_date) {
      if (!earliest || s.signal_date < earliest) earliest = s.signal_date
      if (!latest || s.signal_date > latest) latest = s.signal_date
    }
  }
  return {
    total: signals.length,
    byStage,
    messages: byStage['message'] ?? 0,
    dateRange: { earliest, latest },
  }
}

// ---------------------------------------------------------------------------
// commit() - write tangential_signals directly. No weddings.
// ---------------------------------------------------------------------------

/**
 * Map a storefront funnel stage to the tangential_signals.signal_type
 * CHECK enum. Migration 356 widens that enum to include the storefront
 * funnel values; until applied, these inserts fail with a constraint
 * error the route surfaces as a schema hint.
 */
function signalTypeForStage(stage: string): string {
  switch (stage) {
    case 'view':
      return 'storefront_view'
    case 'save':
      return 'storefront_save'
    case 'message':
      return 'storefront_message'
    case 'click':
      return 'storefront_click'
    case 'review':
      return 'review'
    case 'call':
      return 'storefront_call'
    default:
      return 'analytics_entry'
  }
}

async function commitStorefrontActivity(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
  storefrontSignals?: StorefrontSignalRow[]
  storefrontProvider?: StorefrontProvider
}): Promise<CommitResult> {
  const { supabase, venueId } = args
  const signals = args.storefrontSignals ?? []
  const provider = args.storefrontProvider ?? 'the_knot'

  const result: CommitResult = {
    ok: true,
    weddingsInserted: 0,
    interactionsInserted: 0,
    toursInserted: 0,
    lostDealsInserted: 0,
    errors: [],
    touchedWeddingIds: [],
  }

  if (signals.length === 0) return result

  const tangentialRows = signals.map((s) => ({
    venue_id: venueId,
    signal_type: signalTypeForStage(s.funnel_stage),
    source_platform: provider,
    action_class: s.action_class,
    extracted_identity: {
      // Partial identity only - first name + last INITIAL. The
      // cross-source matcher treats this as a low-confidence fragment;
      // it cannot mint a couple on its own.
      first_name: s.visitor_first_name,
      last_initial: s.visitor_last_initial,
      name_raw: s.visitor_name_raw,
      city: s.city,
      state: s.state,
      storefront_action: s.action_raw,
    },
    source_context: `${provider} storefront: ${s.action_raw ?? 'activity'}`,
    signal_date: s.signal_date ?? new Date().toISOString(),
    // Partial-name storefront rows never auto-match a person. They sit
    // in the unmatched pool until a fuller identity for the visitor
    // arrives. Same posture web-form.ts uses for form submissions.
    match_status: 'unmatched' as const,
    matched_person_id: null,
    confidence_score: null,
    // Class-of-signal: a storefront message is the acquisition channel
    // (source); views / saves / clicks are earlier touchpoints. Per the
    // mig 192 class-of-signal model.
    signal_class: s.signal_class,
  }))

  // Insert in chunks so a large export does not blow a single statement.
  const CHUNK = 500
  let inserted = 0
  for (let i = 0; i < tangentialRows.length; i += CHUNK) {
    const chunk = tangentialRows.slice(i, i + CHUNK)
    // signal-class-justified: every row in tangentialRows carries an
    //   explicit signal_class from classifyAction (source for storefront
    //   messages and calls, touchpoint for views/saves/clicks, crm for unmark).
    const { error } = await supabase.from('tangential_signals').insert(chunk)
    if (error) {
      result.ok = false
      result.errors.push(`storefront tangential_signals insert: ${error.message}`)
      // Keep going - a later chunk may succeed and partial is fine here.
      continue
    }
    inserted += chunk.length
  }

  // interactionsInserted is the closest CommitResult counter for "signals
  // written" - there is no weddings/tours/lost-deals write on this path.
  // The route's funnel summary is the real operator-facing number.
  result.interactionsInserted = inserted
  return result
}

// ---------------------------------------------------------------------------
// Adapter export.
// ---------------------------------------------------------------------------

export const storefrontActivityAdapter: CrmAdapter = {
  name: 'storefront_activity',
  label: 'Storefront activity (The Knot / WeddingWire funnel export)',
  description:
    'Import a storefront-activity export from The Knot or WeddingWire - every view, save, ' +
    'message, click, and call couples took on your marketplace page. Visitor names are ' +
    'partial ("Jayden P.") so rows become low-confidence discovery-funnel signals, not ' +
    'couples. Messages are flagged as real inquiries. For the leads export (couples who ' +
    'inquired), use the The Knot adapter instead.',
  ready: true,
  parse: parseStorefrontActivity,
  preview: previewStorefrontActivity,
  commit: commitStorefrontActivity as CrmAdapter['commit'],
}
