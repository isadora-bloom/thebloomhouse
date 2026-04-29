/**
 * Brain-dump import routers for the new shapes introduced in the
 * CSV-shape + vision expansion.
 *
 * Each function takes a parsed CSV (header row + data rows) already
 * sniffed by brain-dump-csv-shape.ts and writes it into the right
 * destination table(s). All writers go through the service client to
 * bypass RLS — we already verified the caller's venue at the API route
 * layer.
 *
 * These are additive operations that never overwrite existing state.
 * Dedupe strategies per import:
 *   - leads:            (venue_id, email) on people.email → skip dup
 *   - reviews:          (venue_id, source, source_review_id) OR
 *                       (venue_id, reviewer_name, review_date) fallback
 *   - platform_activity: (venue_id, event_type, metadata.visitor_name,
 *                        metadata.visit_date) — idempotent on retry
 *   - tour_links:       overwrite venue_ai_config.tour_booking_links
 *                        (explicit replacement is the expected UX for
 *                        a config sheet)
 *   - knowledge_base_tc: (venue_id, question) dedupe, same as qa path
 *
 * Each function returns a summary with counts so the UI can say
 * "imported N leads, skipped M duplicates".
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ShapeDetection } from '@/lib/services/brain-dump-csv-shape'
import { rowToRecord } from '@/lib/services/brain-dump-csv-shape'
import { normalizeSource } from '@/lib/services/normalize-source'

export interface ImportSummary {
  inserted: number
  updated: number
  skipped: number
  errors: string[]
  /** Phase B (2026-04-28): platform-signal imports also chain
   *  candidate clustering + resolver. When present, surfaces
   *  cluster + match counts in the import summary UI so the
   *  coordinator sees what happened end-to-end (not just "1486 rows
   *  inserted"). Optional so the leads/reviews/etc paths don't have
   *  to populate it. */
  phase_b?: {
    candidates_created: number
    candidates_updated: number
    candidates_flagged_for_review: number
    auto_linked_to_wedding: number
    deferred_to_ai: number
    conflicts_flagged: number
    no_match: number
  }
}

function parseFirstName(full: string | null): string {
  if (!full) return ''
  return full.split(/\s+/)[0] ?? ''
}

function parseLastName(full: string | null): string {
  if (!full) return ''
  const parts = full.split(/\s+/)
  return parts.length > 1 ? parts.slice(1).join(' ') : ''
}

/**
 * Convert "150", "100-150", "51 - 100", "Not Sure" to an integer estimate.
 * Range → midpoint. Non-numeric → null.
 */
function parseGuestCount(raw: string | null): number | null {
  if (!raw) return null
  const match = raw.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (match) {
    return Math.round((Number(match[1]) + Number(match[2])) / 2)
  }
  const single = raw.match(/(\d+)/)
  if (single) return Number(single[1])
  return null
}

/**
 * Parse a variety of date strings the wedding-CRM column contains:
 *   - ISO 'YYYY-MM-DD'         → as-is, precision=day
 *   - 'M/D/YYYY'               → ISO, precision=day
 *   - Excel serial '46291'     → convert from 1900 epoch
 *   - Freeform 'August 21st'   → null (let coordinator resolve)
 *   - Month name 'August'      → null + pair with year column
 *
 * Returns { iso, precision } or null when unparseable.
 */
function parseDate(raw: string | null): { iso: string; precision: 'day' | 'month' | 'year' } | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Excel serial date
  if (/^\d{4,6}$/.test(trimmed)) {
    const serial = Number(trimmed)
    if (serial > 1000 && serial < 80000) {
      // Excel epoch: 1899-12-30
      const ms = (serial - 25569) * 86400 * 1000
      const d = new Date(ms)
      if (!isNaN(d.getTime())) return { iso: d.toISOString().split('T')[0], precision: 'day' }
    }
  }

  // ISO
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return { iso: trimmed, precision: 'day' }

  // M/D/YYYY or MM/DD/YYYY
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    const [, m, d, y] = slash
    return { iso: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, precision: 'day' }
  }

  return null
}

// ---------------------------------------------------------------------------
// Leads import — CRM sheet → weddings + people + interactions
// ---------------------------------------------------------------------------

export async function importLeads(args: {
  supabase: SupabaseClient
  venueId: string
  detection: ShapeDetection
  headerRow: string[]
  dataRows: string[][]
}): Promise<ImportSummary> {
  const { supabase, venueId, detection, headerRow, dataRows } = args
  const summary: ImportSummary = { inserted: 0, updated: 0, skipped: 0, errors: [] }

  // Pull existing people emails for this venue so we can dedupe.
  const { data: existingPeople } = await supabase
    .from('people')
    .select('email')
    .eq('venue_id', venueId)
    .not('email', 'is', null)
  const existingEmails = new Set(
    (existingPeople ?? [])
      .map((p) => (p.email as string | null)?.toLowerCase())
      .filter((e): e is string => !!e)
  )

  for (const row of dataRows) {
    try {
      const r = rowToRecord(detection, headerRow, row)
      const email1 = (r.email_1 ?? '').toLowerCase()
      if (!email1) { summary.skipped++; continue }
      if (existingEmails.has(email1)) { summary.skipped++; continue }

      // Create a wedding row (inquiry stage).
      const date = parseDate(r.wedding_date)
      const inquiryDate = parseDate(r.first_contact)
      const { data: wedding, error: wErr } = await supabase
        .from('weddings')
        .insert({
          venue_id: venueId,
          status: 'inquiry',
          source: normalizeSource(r.source ?? 'csv_import'),
          wedding_date: date?.iso ?? null,
          wedding_date_precision: date?.precision ?? null,
          guest_count_estimate: parseGuestCount(r.guests),
          inquiry_date: inquiryDate?.iso ? `${inquiryDate.iso}T00:00:00Z` : null,
          notes: r.notes ?? null,
        })
        .select('id')
        .single()
      if (wErr || !wedding) {
        summary.errors.push(`lead "${email1}": ${wErr?.message ?? 'insert failed'}`)
        continue
      }

      // Partner 1 — first name from client_name.
      await supabase.from('people').insert({
        venue_id: venueId,
        wedding_id: wedding.id,
        role: 'partner1',
        first_name: parseFirstName(r.client_name),
        last_name: parseLastName(r.client_name),
        email: email1,
      })
      existingEmails.add(email1)

      // Partner 2 if provided.
      if (r.partner_name) {
        const email2 = (r.email_2 ?? '').toLowerCase() || null
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: wedding.id,
          role: 'partner2',
          first_name: parseFirstName(r.partner_name),
          last_name: parseLastName(r.partner_name),
          email: email2,
        })
        if (email2) existingEmails.add(email2)
      }

      // Additional emails on partner1 — insert as people rows with role='contact'.
      for (const key of ['email_3', 'email_4'] as const) {
        const e = (r[key] ?? '').toLowerCase()
        if (!e || existingEmails.has(e)) continue
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: wedding.id,
          role: 'contact',
          first_name: parseFirstName(r.client_name),
          last_name: parseLastName(r.client_name),
          email: e,
        })
        existingEmails.add(e)
      }

      // Capture the notes field as an interaction so Sage has context.
      if (r.notes) {
        await supabase.from('interactions').insert({
          venue_id: venueId,
          wedding_id: wedding.id,
          type: 'note',
          direction: 'inbound',
          subject: 'Historical note from CRM import',
          full_body: r.notes,
          body_preview: r.notes.slice(0, 200),
          timestamp: inquiryDate?.iso ? `${inquiryDate.iso}T00:00:00Z` : new Date().toISOString(),
          from_email: email1,
          from_name: r.client_name ?? null,
        })
      }

      // Log FAQ candidates from the sheet into knowledge_gaps so they
      // surface for triage rather than getting lost.
      if (r.faq_questions) {
        await supabase.from('knowledge_gaps').insert({
          venue_id: venueId,
          question: r.faq_questions,
          category: 'imported_from_crm',
          frequency: 1,
          status: 'open',
        })
      }

      summary.inserted++
    } catch (err) {
      summary.errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  return summary
}

// ---------------------------------------------------------------------------
// Reviews import — CSV or vision-extracted → reviews + phrase extraction
// ---------------------------------------------------------------------------

export interface ReviewRow {
  source: string
  reviewer_name: string
  rating: number
  body: string
  review_date?: string | null
  title?: string | null
}

export async function importReviews(args: {
  supabase: SupabaseClient
  venueId: string
  rows: ReviewRow[]
}): Promise<ImportSummary> {
  const { supabase, venueId, rows } = args
  const summary: ImportSummary = { inserted: 0, updated: 0, skipped: 0, errors: [] }

  // Dedupe on (venue_id, reviewer_name, review_date). Can't trust
  // source_review_id because many coordinators don't have it.
  const { data: existing } = await supabase
    .from('reviews')
    .select('reviewer_name, review_date')
    .eq('venue_id', venueId)
  const existingKey = (n: string, d: string | null) => `${n.toLowerCase()}::${d ?? ''}`
  const existingSet = new Set(
    (existing ?? []).map((r) => existingKey(r.reviewer_name as string, r.review_date as string | null))
  )

  for (const r of rows) {
    if (existingSet.has(existingKey(r.reviewer_name, r.review_date ?? null))) {
      summary.skipped++
      continue
    }
    const { error } = await supabase.from('reviews').insert({
      venue_id: venueId,
      source: r.source,
      reviewer_name: r.reviewer_name,
      rating: Math.max(1, Math.min(5, Math.round(r.rating))),
      body: r.body,
      title: r.title ?? null,
      review_date: r.review_date ?? null,
    })
    if (error) {
      summary.errors.push(`review by ${r.reviewer_name}: ${error.message}`)
      continue
    }
    existingSet.add(existingKey(r.reviewer_name, r.review_date ?? null))
    summary.inserted++
  }

  return summary
}

// ---------------------------------------------------------------------------
// Tour links config — CSV → venue_ai_config.tour_booking_links jsonb
// ---------------------------------------------------------------------------

export interface TourLinkRow {
  label: string
  url: string
  audience?: string | null
  description?: string | null
}

export async function importTourLinks(args: {
  supabase: SupabaseClient
  venueId: string
  rows: TourLinkRow[]
}): Promise<ImportSummary> {
  const { supabase, venueId, rows } = args
  const summary: ImportSummary = { inserted: 0, updated: 0, skipped: 0, errors: [] }

  // Separate out "Pricing Calculator" into its own config field — it's
  // not a Calendly booking link, it's a public pricing URL.
  const pricingRow = rows.find((r) => /pricing|calculator/i.test(r.label))
  const bookingRows = rows.filter((r) => r !== pricingRow)

  const linksJson = bookingRows.map((r, idx) => ({
    label: r.label,
    url: r.url.startsWith('http') ? r.url : `https://${r.url}`,
    audience: r.audience ?? null,
    description: r.description ?? null,
    is_default: idx === 0,
  }))

  const updates: Record<string, unknown> = {
    tour_booking_links: linksJson,
  }
  if (linksJson[0]) updates.tour_booking_link = linksJson[0].url
  if (pricingRow) {
    const u = pricingRow.url.startsWith('http') ? pricingRow.url : `https://${pricingRow.url}`
    updates.pricing_calculator_link = u
  }

  const { error } = await supabase
    .from('venue_ai_config')
    .update(updates)
    .eq('venue_id', venueId)
  if (error) {
    summary.errors.push(error.message)
  } else {
    summary.updated = linksJson.length + (pricingRow ? 1 : 0)
  }
  return summary
}

// ---------------------------------------------------------------------------
// Platform activity — storefront views / messages / saves → engagement_events
// ---------------------------------------------------------------------------

const ACTIVITY_POINTS: Record<string, number> = {
  storefront_view: 1,
  storefront_save: 5,
  storefront_message: 10,
}

function classifyActivity(action: string): { event_type: string; points: number } {
  const a = action.toLowerCase()
  if (/storefront view|view/.test(a)) return { event_type: 'storefront_view', points: ACTIVITY_POINTS.storefront_view }
  if (/storefront save|saved|save/.test(a)) return { event_type: 'storefront_save', points: ACTIVITY_POINTS.storefront_save }
  if (/message|inquiry/.test(a)) return { event_type: 'storefront_message', points: ACTIVITY_POINTS.storefront_message }
  return { event_type: 'platform_activity_other', points: 0 }
}

export async function importPlatformActivity(args: {
  supabase: SupabaseClient
  venueId: string
  detection: ShapeDetection
  headerRow: string[]
  dataRows: string[][]
  sourceHint?: string // e.g., 'the_knot' | 'wedding_wire'
}): Promise<ImportSummary> {
  const { supabase, venueId, detection, headerRow, dataRows, sourceHint } = args
  const summary: ImportSummary = { inserted: 0, updated: 0, skipped: 0, errors: [] }

  // Dedupe on (venue_id, event_type, metadata->>visitor, metadata->>visit_date).
  // engagement_events has no natural key so we query per-row against
  // metadata. Cheap for the volumes we expect.
  for (const row of dataRows) {
    try {
      const r = rowToRecord(detection, headerRow, row)
      if (!r.action) { summary.skipped++; continue }
      const { event_type, points } = classifyActivity(r.action)
      const visitDate = parseDate(r.date) ?? null
      const metadata = {
        visitor_name: r.visitor ?? null,
        visit_date: visitDate?.iso ?? r.date ?? null,
        city: r.city ?? null,
        state: r.state ?? null,
        source: sourceHint ?? 'platform_csv',
      }

      // Lightweight dedupe: same visitor + event_type + date.
      const { count } = await supabase
        .from('engagement_events')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('event_type', event_type)
        .eq('metadata->>visitor_name', metadata.visitor_name ?? '')
        .eq('metadata->>visit_date', metadata.visit_date ?? '')
      if ((count ?? 0) > 0) { summary.skipped++; continue }

      const { error } = await supabase.from('engagement_events').insert({
        venue_id: venueId,
        event_type,
        points,
        metadata,
      })
      if (error) {
        summary.errors.push(`${event_type} ${r.visitor}: ${error.message}`)
        continue
      }
      summary.inserted++
    } catch (err) {
      summary.errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  return summary
}
