/**
 * Website pixel / visitor ingester.
 *
 * A venue's own website tracking pixel produces two related exports:
 *
 *   site_visitors  - one row per visitor (the identity-and-attribution
 *                    row). Columns: visitor_id, first_seen_at,
 *                    last_seen_at, visit_count, pageview_count,
 *                    first_source, first_medium, first_campaign,
 *                    first_content, first_term, first_referrer,
 *                    first_landing_page, last_source, last_medium,
 *                    last_campaign, last_referrer, last_landing_page,
 *                    first_name, partner_name, email, phone, role,
 *                    identified_at, user_agent, ip_country.
 *
 *   site_visits    - one row per pageview. Columns: id, visitor_id,
 *                    session_id, path, query, referrer, ts.
 *
 * Design:
 *
 *   - IDENTIFIED visitors (email present) become a NormalisedLeadRow.
 *     commitNormalisedRows runs the identity resolver, so the visitor
 *     attaches to an existing couple (if Bloom already knows the email)
 *     or mints a fresh wedding shell. The first-touch UTM
 *     (first_source / first_medium / ...) is stamped onto weddings.utm_*
 *     via the shared helper - that is the acquisition-channel record.
 *     Each identified visitor also gets one synthetic interaction whose
 *     extracted_identity carries the visitor_id (the external
 *     identifier) plus the FULL browsing history (paths visited), so a
 *     real couple's website journey is attached to their record.
 *
 *   - ANONYMOUS visitors (no email) stay aggregate - one
 *     tangential_signals row each (signal_type='website_visit'). They
 *     carry the visitor_id so that IF the same visitor_id later turns
 *     up identified, the cross-source matcher can stitch the history.
 *
 *   - site_visits is OPTIONAL. When supplied alongside site_visitors
 *     (the route passes it as a second CSV), each visitor's pageviews
 *     are joined on visitor_id and folded into the interaction body /
 *     the tangential signal payload. site_visits on its own (no
 *     site_visitors) is ingested as anonymous pageview signals.
 *
 * visitor_id as an external identifier:
 *   visitor_id is the stable cross-link key. It is written into every
 *   interaction's extracted_identity.visitor_id and every tangential
 *   signal's extracted_identity.visitor_id. When a website signal and
 *   a couple share a visitor_id, downstream identity resolution can
 *   cross-link a browsing history to a real couple.
 *
 * Constraint note: this adapter does NOT write attribution_events
 * directly - that table is keyed on candidate_identity_id and owned by
 * the identity service. UTM first/last touch is recorded the
 * Bloom-canonical way: weddings.utm_* (stamped by commitNormalisedRows)
 * for identified visitors, and the tangential_signals payload for
 * anonymous ones. The identity / attribution crons promote those into
 * attribution_events.
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
} from './index'
import { commitNormalisedRows } from './index'
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'

// ---------------------------------------------------------------------------
// Column detection - case-insensitive, accepts snake_case + Title Case.
// ---------------------------------------------------------------------------

function buildColumnLookup(header: string[]): (names: string[]) => number {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const idx = new Map<string, number>()
  header.forEach((h, i) => {
    if (!idx.has(norm(h))) idx.set(norm(h), i)
  })
  return (names: string[]): number => {
    for (const n of names) {
      const hit = idx.get(norm(n))
      if (hit != null) return hit
    }
    return -1
  }
}

function parseTsIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function parseIntSafe(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const cleaned = raw.replace(/[,\s]/g, '').trim()
  if (!cleaned) return null
  const n = Number.parseInt(cleaned, 10)
  return Number.isFinite(n) ? n : null
}

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (!digits || digits.length < 7 || digits.length > 15) return null
  return digits
}

function splitFullName(
  raw: string | null | undefined,
): { first: string | null; last: string | null } {
  if (!raw) return { first: null, last: null }
  const tokens = String(raw).trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { first: null, last: null }
  if (tokens.length === 1) return { first: tokens[0] ?? null, last: null }
  return { first: tokens[0] ?? null, last: tokens.slice(1).join(' ') }
}

// ---------------------------------------------------------------------------
// Parsed visitor + pageview shapes.
// ---------------------------------------------------------------------------

interface ParsedVisitor {
  visitor_id: string | null
  first_seen_at: string | null
  last_seen_at: string | null
  visit_count: number | null
  pageview_count: number | null
  first_source: string | null
  first_medium: string | null
  first_campaign: string | null
  first_content: string | null
  first_term: string | null
  first_referrer: string | null
  first_landing_page: string | null
  last_source: string | null
  last_medium: string | null
  last_campaign: string | null
  last_referrer: string | null
  last_landing_page: string | null
  first_name: string | null
  partner_name: string | null
  email: string | null
  phone: string | null
  role: string | null
  identified_at: string | null
  user_agent: string | null
  ip_country: string | null
  raw_row: Record<string, string>
}

interface ParsedPageview {
  visitor_id: string | null
  session_id: string | null
  path: string | null
  query: string | null
  referrer: string | null
  ts: string | null
}

// ---------------------------------------------------------------------------
// CSV parsers for the two file shapes.
// ---------------------------------------------------------------------------

function parseVisitorsCsv(csvText: string): {
  visitors: ParsedVisitor[]
  errors: string[]
} {
  const errors: string[] = []
  const csvRows = parseCsvRows(csvText)
  if (csvRows.length < 2) {
    return { visitors: [], errors: ['site_visitors csv must have a header row and at least one data row'] }
  }
  const header = csvRows[0].map((h) => h.trim())
  const col = buildColumnLookup(header)
  const c = {
    visitor_id: col(['visitor_id', 'visitor id', 'visitorid']),
    first_seen_at: col(['first_seen_at', 'first seen at', 'first_seen']),
    last_seen_at: col(['last_seen_at', 'last seen at', 'last_seen']),
    visit_count: col(['visit_count', 'visits', 'session_count']),
    pageview_count: col(['pageview_count', 'pageviews', 'page_views']),
    first_source: col(['first_source', 'first utm source']),
    first_medium: col(['first_medium']),
    first_campaign: col(['first_campaign']),
    first_content: col(['first_content']),
    first_term: col(['first_term']),
    first_referrer: col(['first_referrer']),
    first_landing_page: col(['first_landing_page']),
    last_source: col(['last_source']),
    last_medium: col(['last_medium']),
    last_campaign: col(['last_campaign']),
    last_referrer: col(['last_referrer']),
    last_landing_page: col(['last_landing_page']),
    first_name: col(['first_name', 'first name', 'name']),
    partner_name: col(['partner_name', 'partner name']),
    email: col(['email', 'email_address']),
    phone: col(['phone', 'phone_number']),
    role: col(['role']),
    identified_at: col(['identified_at']),
    user_agent: col(['user_agent']),
    ip_country: col(['ip_country', 'country']),
  }
  if (c.visitor_id < 0) {
    errors.push('site_visitors csv is missing the visitor_id column')
  }

  const visitors: ParsedVisitor[] = []
  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]
    const g = (i: number): string | null => {
      if (i < 0) return null
      return (data[i] ?? '').trim() || null
    }
    visitors.push({
      visitor_id: g(c.visitor_id),
      first_seen_at: parseTsIso(g(c.first_seen_at)),
      last_seen_at: parseTsIso(g(c.last_seen_at)),
      visit_count: parseIntSafe(g(c.visit_count)),
      pageview_count: parseIntSafe(g(c.pageview_count)),
      first_source: g(c.first_source),
      first_medium: g(c.first_medium),
      first_campaign: g(c.first_campaign),
      first_content: g(c.first_content),
      first_term: g(c.first_term),
      first_referrer: g(c.first_referrer),
      first_landing_page: g(c.first_landing_page),
      last_source: g(c.last_source),
      last_medium: g(c.last_medium),
      last_campaign: g(c.last_campaign),
      last_referrer: g(c.last_referrer),
      last_landing_page: g(c.last_landing_page),
      first_name: g(c.first_name),
      partner_name: g(c.partner_name),
      email: g(c.email),
      phone: g(c.phone),
      role: g(c.role),
      identified_at: parseTsIso(g(c.identified_at)),
      user_agent: g(c.user_agent),
      ip_country: g(c.ip_country),
      raw_row: Object.fromEntries(
        header.map((h, i) => [h || `col_${i}`, (data[i] ?? '').trim()]),
      ),
    })
  }
  return { visitors, errors }
}

function parseVisitsCsv(csvText: string): {
  visits: ParsedPageview[]
  errors: string[]
} {
  const errors: string[] = []
  const csvRows = parseCsvRows(csvText)
  if (csvRows.length < 2) {
    return { visits: [], errors: ['site_visits csv must have a header row and at least one data row'] }
  }
  const header = csvRows[0].map((h) => h.trim())
  const col = buildColumnLookup(header)
  const c = {
    visitor_id: col(['visitor_id', 'visitor id']),
    session_id: col(['session_id', 'session id']),
    path: col(['path', 'page', 'url']),
    query: col(['query', 'query_string']),
    referrer: col(['referrer', 'referer']),
    ts: col(['ts', 'timestamp', 'visited_at', 'time']),
  }
  if (c.visitor_id < 0) {
    errors.push('site_visits csv is missing the visitor_id column')
  }
  const visits: ParsedPageview[] = []
  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]
    const g = (i: number): string | null => {
      if (i < 0) return null
      return (data[i] ?? '').trim() || null
    }
    visits.push({
      visitor_id: g(c.visitor_id),
      session_id: g(c.session_id),
      path: g(c.path),
      query: g(c.query),
      referrer: g(c.referrer),
      ts: parseTsIso(g(c.ts)),
    })
  }
  return { visits, errors }
}

// ---------------------------------------------------------------------------
// AdapterConfig extension - the route may pass a second CSV (site_visits)
// alongside the primary site_visitors CSV.
// ---------------------------------------------------------------------------

interface SiteVisitorsAdapterConfig extends AdapterConfig {
  /** Optional second file: the per-pageview site_visits export. */
  visitsCsvText?: string
}

interface SiteVisitorsParseResult extends ParseResult {
  /** Visitors with no email - written as anonymous tangential_signals. */
  anonymousVisitors?: ParsedVisitor[]
  /** Pageviews for visitor_ids that did not appear in site_visitors -
   *  written as anonymous website_visit signals. */
  orphanPageviews?: ParsedPageview[]
}

// ---------------------------------------------------------------------------
// Build the synthetic browsing-history interaction for an identified
// visitor. The body lists the first/last touch + the pages visited.
// ---------------------------------------------------------------------------

function buildVisitorInteraction(
  v: ParsedVisitor,
  pageviews: ParsedPageview[],
): NormalisedInteractionRow {
  const lines: string[] = []
  lines.push('provider:website_pixel')
  if (v.visitor_id) lines.push(`visitor_id:${v.visitor_id}`)
  if (v.first_source) {
    lines.push(
      `first_touch:${[v.first_source, v.first_medium, v.first_campaign]
        .filter(Boolean)
        .join(' / ')}`,
    )
  }
  if (v.first_landing_page) lines.push(`first_landing_page:${v.first_landing_page}`)
  if (v.first_referrer) lines.push(`first_referrer:${v.first_referrer}`)
  if (v.last_source) {
    lines.push(
      `last_touch:${[v.last_source, v.last_medium, v.last_campaign]
        .filter(Boolean)
        .join(' / ')}`,
    )
  }
  if (v.visit_count != null) lines.push(`visit_count:${v.visit_count}`)
  if (v.pageview_count != null) lines.push(`pageview_count:${v.pageview_count}`)
  if (pageviews.length > 0) {
    lines.push('pages_visited:')
    for (const pv of pageviews.slice(0, 100)) {
      lines.push(`  ${pv.ts ?? '(no ts)'} ${pv.path ?? ''}${pv.query ? '?' + pv.query : ''}`)
    }
    if (pageviews.length > 100) lines.push(`  ...and ${pageviews.length - 100} more`)
  }

  const occurredAt =
    v.identified_at ?? v.last_seen_at ?? v.first_seen_at ?? new Date().toISOString()

  return {
    occurred_at: occurredAt,
    direction: 'inbound',
    // The website visit is an event, not an email. interactions.type
    // has no 'website' value; 'web_form' (mig 178) is the closest
    // structural fit for a first-party website signal.
    type: 'web_form',
    subject: 'Website visit history',
    body: lines.join('\n'),
    extracted_identity: {
      provider: 'website_pixel',
      // visitor_id is the cross-link external identifier.
      visitor_id: v.visitor_id,
      // first-touch UTM - the canonical acquisition-channel signal the
      // lead-source-derivation chain reads.
      utm_source: v.first_source,
      utm_medium: v.first_medium,
      utm_campaign: v.first_campaign,
      first_referrer: v.first_referrer,
      first_landing_page: v.first_landing_page,
      last_source: v.last_source,
      last_referrer: v.last_referrer,
      pageview_count: v.pageview_count,
      visit_count: v.visit_count,
    },
    // A first-party website visit IS a discovery-channel signal - the
    // first-touch UTM names the acquisition channel.
    signal_class: 'source',
    // Synthetic provenance row - keep off /agent/inbox; lead-detail
    // timelines aggregate every surface.
    surface: 'crm_attribution',
  }
}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

async function parseSiteVisitors(config: AdapterConfig): Promise<SiteVisitorsParseResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const cfg = config as SiteVisitorsAdapterConfig

  if (!cfg.csvText || !cfg.csvText.trim()) {
    // site_visits-only import is allowed: the primary CSV is empty but a
    // visits CSV was supplied. Treat every pageview as anonymous.
    if (cfg.visitsCsvText && cfg.visitsCsvText.trim()) {
      const { visits, errors: vErrs } = parseVisitsCsv(cfg.visitsCsvText)
      return {
        ok: vErrs.length === 0,
        rows: [],
        errors: vErrs,
        warnings: ['no site_visitors file - every pageview ingested as an anonymous signal'],
        orphanPageviews: visits,
      }
    }
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings }
  }

  const { visitors, errors: visitorErrs } = parseVisitorsCsv(cfg.csvText)
  errors.push(...visitorErrs)

  // Optional second file: per-pageview detail.
  let pageviewsByVisitor = new Map<string, ParsedPageview[]>()
  let allPageviews: ParsedPageview[] = []
  if (cfg.visitsCsvText && cfg.visitsCsvText.trim()) {
    const { visits, errors: visitErrs } = parseVisitsCsv(cfg.visitsCsvText)
    for (const e of visitErrs) warnings.push(`site_visits: ${e}`)
    allPageviews = visits
    pageviewsByVisitor = new Map()
    for (const pv of visits) {
      if (!pv.visitor_id) continue
      const arr = pageviewsByVisitor.get(pv.visitor_id) ?? []
      arr.push(pv)
      pageviewsByVisitor.set(pv.visitor_id, arr)
    }
  }

  const knownVisitorIds = new Set(
    visitors.map((v) => v.visitor_id).filter((x): x is string => !!x),
  )

  const rows: NormalisedLeadRow[] = []
  const anonymousVisitors: ParsedVisitor[] = []

  for (const v of visitors) {
    const pageviews = v.visitor_id
      ? pageviewsByVisitor.get(v.visitor_id) ?? []
      : []

    if (v.email) {
      // Identified visitor - becomes a lead. The resolver in
      // commitNormalisedRows attaches it to the matching couple (or
      // mints a fresh shell). first-touch UTM is stamped on weddings.
      const p1 = splitFullName(v.first_name)
      const p2 = splitFullName(v.partner_name)
      rows.push({
        source_id: v.visitor_id ?? v.email,
        partner1_first_name: p1.first,
        partner1_last_name: p1.last,
        partner1_email: v.email,
        partner1_phone: normalizePhone(v.phone),
        partner2_first_name: p2.first,
        partner2_last_name: p2.last,
        wedding_date: null,
        guest_count_estimate: null,
        booking_value: null,
        // A website visitor is a brand-new inquiry-stage signal. The
        // resolver will upgrade status if a further-along wedding
        // already exists for this email.
        status: 'inquiry',
        // adapter-as-facts: leave weddings.source NULL. The synthetic
        // interaction below carries the first-touch UTM and the
        // lead-source-derivation chain decides the canonical channel.
        source: null,
        source_detail: 'website_pixel',
        // inquiry_date anchors to identified_at (when the visitor became
        // identifiable) or first_seen_at - the earliest website signal.
        inquiry_date: v.identified_at ?? v.first_seen_at ?? null,
        booked_at: null,
        lost_at: null,
        lost_reason: null,
        notes: v.ip_country ? `Website visitor - country: ${v.ip_country}` : null,
        raw_row: v.raw_row,
        // first-touch UTM -> weddings.utm_* via commitNormalisedRows.
        // Per migration 205, downstream importers never overwrite a
        // non-null utm value, so this is safe even when the couple
        // already has acquisition UTM from an earlier signal.
        utm_source: v.first_source,
        utm_medium: v.first_medium,
        utm_campaign: v.first_campaign,
        utm_term: v.first_term,
        utm_content: v.first_content,
        interactions: [buildVisitorInteraction(v, pageviews)],
        tours: [],
        lost_deal: null,
      })
    } else {
      // Anonymous visitor - aggregate only.
      anonymousVisitors.push(v)
    }
  }

  // Pageviews whose visitor_id is not in site_visitors at all - pure
  // anonymous browsing. Recorded as their own anonymous signals.
  const orphanPageviews = allPageviews.filter(
    (pv) => !pv.visitor_id || !knownVisitorIds.has(pv.visitor_id),
  )

  return {
    ok: errors.length === 0,
    rows,
    errors,
    warnings,
    anonymousVisitors,
    orphanPageviews,
  }
}

// ---------------------------------------------------------------------------
// preview()
// ---------------------------------------------------------------------------

function previewSiteVisitors(rows: NormalisedLeadRow[]): PreviewResult {
  const warnings: string[] = []
  if (rows.length > 50) warnings.push(`only first 50 of ${rows.length} identified visitors shown`)
  if (rows.length > 0) {
    const withUtm = rows.filter((r) => r.utm_source).length
    warnings.push(
      `${rows.length} identified visitor(s) will attach to couples; ${withUtm} carry first-touch UTM.`,
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
// commit() - identified visitors funnel through commitNormalisedRows;
// anonymous visitors + orphan pageviews go straight to tangential_signals.
// ---------------------------------------------------------------------------

async function commitSiteVisitors(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
  anonymousVisitors?: ParsedVisitor[]
  orphanPageviews?: ParsedPageview[]
}): Promise<CommitResult> {
  const { supabase, venueId, rows } = args
  const anonymous = args.anonymousVisitors ?? []
  const orphanPageviews = args.orphanPageviews ?? []

  // Identified visitors - standard shared commit. confidence_flag
  // 'imported_medium': a pixel-identified email is good but not as
  // strong as a coordinator-typed record.
  let result: CommitResult
  if (rows.length > 0) {
    result = await commitNormalisedRows({
      supabase,
      venueId,
      rows,
      crmSource: 'web_form',
      confidenceFlag: 'imported_medium',
      sourceProvenance: 'website_pixel_import',
      // The synthetic interaction declares signal_class='source'
      // per-row; this default covers any future un-classed rows.
      defaultInteractionSignalClass: 'source',
      // Synthetic provenance rows belong on the lead-detail timeline,
      // not /agent/inbox.
      defaultSurface: 'crm_attribution',
    })
  } else {
    result = {
      ok: true,
      weddingsInserted: 0,
      interactionsInserted: 0,
      toursInserted: 0,
      lostDealsInserted: 0,
      errors: [],
      touchedWeddingIds: [],
    }
  }

  // Anonymous visitors -> one tangential_signals row each. They carry
  // the visitor_id so a later identified signal with the same
  // visitor_id can stitch the history.
  const anonRows = anonymous.map((v) => ({
    venue_id: venueId,
    signal_type: 'website_visit',
    source_platform: 'website',
    action_class: 'visit',
    extracted_identity: {
      // Anonymous: no email. visitor_id is the only cross-link key.
      visitor_id: v.visitor_id,
      first_name: v.first_name,
      utm_source: v.first_source,
      utm_medium: v.first_medium,
      utm_campaign: v.first_campaign,
      first_referrer: v.first_referrer,
      first_landing_page: v.first_landing_page,
      pageview_count: v.pageview_count,
      visit_count: v.visit_count,
      ip_country: v.ip_country,
    },
    source_context: `website visit (visitor ${v.visitor_id ?? 'unknown'})`,
    signal_date: v.first_seen_at ?? v.last_seen_at ?? new Date().toISOString(),
    match_status: 'unmatched' as const,
    matched_person_id: null,
    confidence_score: null,
    // First-party website visit is a discovery-channel (source) signal.
    signal_class: 'source' as const,
  }))

  // Orphan pageviews (visitor never in site_visitors) -> one signal each.
  // Kept lean - these are aggregate browsing data.
  const orphanRows = orphanPageviews.map((pv) => ({
    venue_id: venueId,
    signal_type: 'website_visit',
    source_platform: 'website',
    action_class: 'visit',
    extracted_identity: {
      visitor_id: pv.visitor_id,
      path: pv.path,
      query: pv.query,
      referrer: pv.referrer,
      session_id: pv.session_id,
    },
    source_context: `pageview ${pv.path ?? ''}`,
    signal_date: pv.ts ?? new Date().toISOString(),
    match_status: 'unmatched' as const,
    matched_person_id: null,
    confidence_score: null,
    signal_class: 'source' as const,
  }))

  const allTangential = [...anonRows, ...orphanRows]
  const CHUNK = 500
  let signalsWritten = 0
  for (let i = 0; i < allTangential.length; i += CHUNK) {
    const chunk = allTangential.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    // signal-class-justified: every anonymous-visitor and orphan-pageview
    //   row is built above with signal_class='source' - a first-party
    //   website visit is a discovery-channel signal.
    const { error } = await supabase.from('tangential_signals').insert(chunk)
    if (error) {
      result.errors.push(`website-pixel tangential_signals insert: ${error.message}`)
      // Auxiliary funnel data - do not flip ok=false on its own.
      continue
    }
    signalsWritten += chunk.length
  }
  // Fold the anonymous-signal count into interactionsInserted so the
  // operator summary reflects "signals written". Identified visitors
  // already contributed their own interaction counts.
  result.interactionsInserted += signalsWritten

  return result
}

// ---------------------------------------------------------------------------
// Adapter export.
// ---------------------------------------------------------------------------

export const siteVisitorsAdapter: CrmAdapter = {
  name: 'site_visitors',
  label: 'Website pixel (visitor + pageview export)',
  description:
    'Import your website tracking-pixel export. Identified visitors (email present) attach ' +
    'to couples with their first-touch UTM recorded as the acquisition channel; anonymous ' +
    'visitors stay aggregate. Optionally include the per-pageview site_visits file to attach ' +
    'each couple\'s full browsing history. visitor_id cross-links website signals to couples.',
  ready: true,
  parse: parseSiteVisitors,
  preview: previewSiteVisitors,
  commit: commitSiteVisitors as CrmAdapter['commit'],
}
