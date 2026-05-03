/**
 * CRM-import adapter registry (T5-followup-Y / Pattern I closure).
 *
 * Day-3 of the 5-day onboarding-project flow needs to import each
 * venue's existing CRM lead-history so the Forensic Record isn't a blank
 * slate for the first 6-12 months. This module is the adapter
 * scaffolding: a common interface + per-provider implementations.
 *
 * Adapters in this folder:
 *   - generic-csv     full implementation. Coordinator supplies a
 *                     column-mapping JSON so any export's headers can be
 *                     remapped to Bloom's schema.
 *   - honeybook       SCAFFOLD ONLY. Throws "not yet implemented" until
 *                     a dev sees a real export and fills in the mapper.
 *   - dubsado         SCAFFOLD ONLY.
 *   - aisleplanner    SCAFFOLD ONLY.
 *
 * Mapped tables (per spec):
 *   Lead → weddings (confidence_flag='imported_medium', crm_source=<provider>)
 *   Communication → interactions (direction, subject, body, occurred_at;
 *                  auto_sent=false; crm_source=<provider>)
 *   Tour → tours (crm_source=<provider>)
 *   Lost outcome → lost_deals (when applicable)
 *
 * Confidence rule:
 *   CRM exports get 'imported_medium' — coordinator-curated but not
 *   platform-live. Pricing-history reconstruction (single-row form)
 *   gets 'imported_high' since the coordinator types it themselves.
 *
 * The adapter contract is intentionally narrow: parse + preview return
 * pure data, commit takes a Supabase service client + venue id and
 * writes. No adapter is allowed to mutate global state.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Stable identifier for the per-row crm_source column. Mirrors the
 *  weddings.crm_source CHECK constraint extended by migration 178 to
 *  include 'web_form' for the T5-Rixey-HH web-form intake adapter. */
export type CrmSource = 'honeybook' | 'dubsado' | 'aisle_planner' | 'generic_csv' | 'web_form'

/**
 * T5-Rixey-II: tour-scheduler adapter shared types.
 *
 * `TourSchedulerHint` tells the parser which scheduling-tool's column-
 * shape it's looking at. `ClassifiedEventType` is the per-event-type
 * bucket the classifier emits — tour vs post-booking-touchpoint vs
 * other-interaction. Coordinators override the heuristic in the preview
 * UI; the override map is keyed by exact Event Type Name.
 *
 * `RoutedQuestion` is the closed enum of Bloom fields the per-row Q&A
 * router can target. Anything outside this set is "unknown" and concats
 * into notes for the coordinator to read post-import.
 *
 * Note: tour-scheduler imports COMMIT with crm_source='generic_csv' (the
 * existing catch-all in migration 178's CHECK enum). Adding a dedicated
 * 'tour_scheduler' value would require its own migration; deferred per
 * T5-Rixey-II scope ("No new migration expected from this stream").
 * Provider-name (calendly / acuity / etc.) is encoded in
 * weddings.source_detail + interactions.full_body prefix so downstream
 * surfaces can still distinguish.
 */
export type TourSchedulerProvider =
  | 'calendly'
  | 'acuity'
  | 'square_appointments'
  | 'generic_ical'
  | 'custom'

/** Hint name passed in via AdapterConfig.provider. Same string set as
 *  TourSchedulerProvider — the alias keeps adapter-internal code from
 *  repeating the exhaustive list when it just wants to check the hint. */
export type TourSchedulerHint = TourSchedulerProvider

export type ClassifiedEventType =
  | 'tour'
  | 'post_booking_touchpoint'
  | 'other_interaction'

export interface EventClassification {
  bucket: ClassifiedEventType
  /** Human-readable explanation of why the classifier chose this bucket.
   *  Surfaces in the preview UI tooltip so coordinators can override
   *  with context. */
  reason: string
}

export type RoutedQuestion =
  | 'partner1_phone'
  | 'partner2_name'
  | 'partner2_email'
  | 'wedding_date_hint'
  | 'estimated_guests'
  | 'lead_source'
  | 'package_interest'
  | 'pricing_calculator'
  | 'meeting_topic'
  | 'attendees'

/**
 * Canonical Bloom-shape row that adapters produce. Adapters do their
 * own provider-specific column normalisation; the commit step is then
 * the same across providers.
 */
export interface NormalisedLeadRow {
  /** Coordinator-readable identifier from the source export (CRM ID,
   *  email, couple name); used for de-dup hints in preview. */
  source_id?: string | null

  /** Lead → weddings */
  partner1_first_name?: string | null
  partner1_last_name?: string | null
  partner1_email?: string | null
  partner1_phone?: string | null
  partner2_first_name?: string | null
  partner2_last_name?: string | null
  partner2_email?: string | null          // T5-Rixey-HH: web-form intake
  partner2_phone?: string | null          // captures partner2 contact too
  wedding_date?: string | null            // ISO yyyy-mm-dd
  guest_count_estimate?: number | null
  booking_value?: number | null           // in cents (Bloom convention)
  status?: 'inquiry' | 'tour_scheduled' | 'tour_completed' | 'proposal_sent'
         | 'booked' | 'completed' | 'lost' | 'cancelled' | null
  source?: string | null                  // wedding source channel
  source_detail?: string | null
  inquiry_date?: string | null            // ISO timestamp
  booked_at?: string | null
  lost_at?: string | null
  lost_reason?: string | null
  notes?: string | null

  /** Linked sub-records (each becomes one row in its respective table). */
  interactions?: NormalisedInteractionRow[]
  tours?: NormalisedTourRow[]
  lost_deal?: NormalisedLostDealRow | null
}

export interface NormalisedInteractionRow {
  occurred_at: string                      // ISO timestamp
  direction: 'inbound' | 'outbound'
  /** Mirrors interactions.type CHECK. 'meeting' added by migration 100,
   *  'web_form' added by migration 178 (T5-Rixey-HH). */
  type: 'email' | 'call' | 'voicemail' | 'sms' | 'meeting' | 'web_form'
  subject?: string | null
  body?: string | null
}

export interface NormalisedTourRow {
  scheduled_at: string                     // ISO timestamp
  tour_type?: 'in_person' | 'virtual' | 'phone' | null
  /** Mirrors the migration-077 widened tours.outcome CHECK enum. 'pending'
   *  added 2026-05-02 for T5-Rixey-II — tour-scheduler imports record
   *  scheduled-but-not-yet-conducted tours. */
  outcome?: 'pending' | 'completed' | 'booked' | 'lost' | 'cancelled' | 'no_show' | 'rescheduled' | null
  notes?: string | null
}

export interface NormalisedLostDealRow {
  lost_at: string                          // ISO timestamp
  lost_at_stage?: 'inquiry' | 'tour' | 'hold' | 'contract' | null
  reason_category?: string | null
  reason_detail?: string | null
  competitor_name?: string | null
}

export interface ParseResult {
  ok: boolean
  rows: NormalisedLeadRow[]
  errors: string[]
  warnings: string[]
}

export interface PreviewResult {
  rows: NormalisedLeadRow[]
  total: number
  errors: string[]
  warnings: string[]
}

export interface CommitResult {
  ok: boolean
  weddingsInserted: number
  interactionsInserted: number
  toursInserted: number
  lostDealsInserted: number
  errors: string[]
}

/** Optional config the adapter may consume — only generic_csv currently
 *  uses it (column mapping). Future per-provider adapters might use it
 *  to override default field-mappings without touching code. */
export interface AdapterConfig {
  columnMapping?: Record<string, string>   // bloom_field → header_in_csv
  csvText?: string                         // raw CSV content (browser-uploaded)
  jsonText?: string                        // raw JSON content (some exports are JSON)
  /** T5-Rixey-II: provider hint for the tour-scheduler adapter. Tells
   *  the parser which scheduler's column-shape it's looking at (calendly
   *  is fully implemented; the others are scaffolds). Other adapters
   *  ignore this field. */
  provider?: TourSchedulerProvider
}

/** Identifier the adapter registry exposes to the UI. Most adapters use
 *  the same string as their crm_source enum value (honeybook, dubsado,
 *  generic_csv, web_form), but the tour-scheduler adapter uses its own
 *  identifier ('tour_scheduler') because it commits with crm_source=
 *  'generic_csv' (no dedicated enum value yet). Registry-name is what
 *  the API route + UI provider-picker key off; crm_source is what the
 *  shared commit helper writes to the DB. */
export type AdapterName = CrmSource | 'tour_scheduler'

export interface CrmAdapter {
  /** Stable identifier exposed to the UI provider-picker. */
  name: AdapterName
  /** Human-readable label rendered in the UI provider-picker. */
  label: string
  /** Description shown next to the picker entry. */
  description: string
  /** Whether the adapter is fully implemented. The UI greys out
   *  scaffold-only adapters and shows a "coming soon" tooltip. */
  ready: boolean
  parse(config: AdapterConfig): Promise<ParseResult>
  preview(rows: NormalisedLeadRow[]): PreviewResult
  commit(args: {
    supabase: SupabaseClient
    venueId: string
    rows: NormalisedLeadRow[]
  }): Promise<CommitResult>
}

import { honeybookAdapter } from './honeybook'
import { dubsadoAdapter } from './dubsado'
import { aislePlannerAdapter } from './aisleplanner'
import { genericCsvAdapter } from './generic-csv'
import { webFormAdapter } from './web-form'
import { tourSchedulerAdapter } from './tour-scheduler'

export const ADAPTERS: ReadonlyArray<CrmAdapter> = [
  genericCsvAdapter,
  honeybookAdapter,
  dubsadoAdapter,
  aislePlannerAdapter,
  webFormAdapter,
  tourSchedulerAdapter,
]

export function findAdapter(name: string): CrmAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null
}

/**
 * Shared commit helper. All adapters normalise to NormalisedLeadRow and
 * then funnel through this for the actual writes — keeps the row-shape
 * → DB-shape mapping in one place + means future schema additions only
 * touch this function.
 */
export async function commitNormalisedRows(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
  crmSource: CrmSource
  /** Override default 'imported_medium' confidence_flag — web-form
   *  intake passes 'imported_high' since it's first-party data. */
  confidenceFlag?: 'imported_high' | 'imported_medium' | 'imported_low'
  /** Override default null — web-form intake passes 'web_form_import'
   *  so the data-source orphan sweep can split first-party form rows
   *  from email-pipeline rows. Per migration 178. */
  sourceProvenance?: string | null
}): Promise<CommitResult> {
  const { supabase, venueId, rows, crmSource } = args
  const confidenceFlag = args.confidenceFlag ?? 'imported_medium'
  const sourceProvenance = args.sourceProvenance ?? null
  const result: CommitResult = {
    ok: true,
    weddingsInserted: 0,
    interactionsInserted: 0,
    toursInserted: 0,
    lostDealsInserted: 0,
    errors: [],
  }

  for (const row of rows) {
    try {
      const weddingPayload = {
        venue_id: venueId,
        status: row.status ?? 'inquiry',
        source: row.source ?? 'other',
        source_detail: row.source_detail ?? null,
        wedding_date: row.wedding_date ?? null,
        guest_count_estimate: row.guest_count_estimate ?? null,
        booking_value: row.booking_value ?? null,
        inquiry_date: row.inquiry_date ?? new Date().toISOString(),
        booked_at: row.booked_at ?? null,
        lost_at: row.lost_at ?? null,
        lost_reason: row.lost_reason ?? null,
        notes: row.notes ?? null,
        confidence_flag: confidenceFlag,
        crm_source: crmSource,
        source_provenance: sourceProvenance,
      }
      const { data: wedding, error: wedErr } = await supabase
        .from('weddings')
        .insert(weddingPayload)
        .select('id')
        .single()
      if (wedErr || !wedding) {
        result.errors.push(`weddings insert failed: ${wedErr?.message ?? 'no row returned'}`)
        result.ok = false
        continue
      }
      result.weddingsInserted += 1
      const weddingId = wedding.id as string

      // people: insert primary partner if we have any name/email
      if (row.partner1_first_name || row.partner1_last_name || row.partner1_email) {
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          role: 'partner1',
          first_name: row.partner1_first_name ?? null,
          last_name: row.partner1_last_name ?? null,
          email: row.partner1_email ?? null,
          phone: row.partner1_phone ?? null,
          confidence_flag: confidenceFlag,
          crm_source: crmSource,
        })
      }
      if (row.partner2_first_name || row.partner2_last_name) {
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          role: 'partner2',
          first_name: row.partner2_first_name ?? null,
          last_name: row.partner2_last_name ?? null,
          email: row.partner2_email ?? null,
          phone: row.partner2_phone ?? null,
          confidence_flag: confidenceFlag,
          crm_source: crmSource,
        })
      }

      // interactions
      if (row.interactions?.length) {
        const interactionPayloads = row.interactions.map((i) => ({
          venue_id: venueId,
          wedding_id: weddingId,
          type: i.type,
          direction: i.direction,
          subject: i.subject ?? null,
          full_body: i.body ?? null,
          body_preview: (i.body ?? '').slice(0, 200) || null,
          timestamp: i.occurred_at,
          confidence_flag: confidenceFlag,
          crm_source: crmSource,
        }))
        const { error: intErr } = await supabase.from('interactions').insert(interactionPayloads)
        if (intErr) {
          result.errors.push(`interactions insert (wedding ${weddingId}): ${intErr.message}`)
          result.ok = false
        } else {
          result.interactionsInserted += interactionPayloads.length
        }
      }

      // tours
      if (row.tours?.length) {
        const tourPayloads = row.tours.map((t) => ({
          venue_id: venueId,
          wedding_id: weddingId,
          scheduled_at: t.scheduled_at,
          tour_type: t.tour_type ?? null,
          outcome: t.outcome ?? null,
          notes: t.notes ?? null,
          crm_source: crmSource,
        }))
        const { error: tourErr } = await supabase.from('tours').insert(tourPayloads)
        if (tourErr) {
          result.errors.push(`tours insert (wedding ${weddingId}): ${tourErr.message}`)
          result.ok = false
        } else {
          result.toursInserted += tourPayloads.length
        }
      }

      // lost_deals (only if status='lost' AND a lost_deal payload exists)
      if (row.lost_deal && (row.status === 'lost' || row.lost_at)) {
        const { error: lostErr } = await supabase.from('lost_deals').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          lost_at: row.lost_deal.lost_at,
          lost_at_stage: row.lost_deal.lost_at_stage ?? null,
          reason_category: row.lost_deal.reason_category ?? null,
          reason_detail: row.lost_deal.reason_detail ?? null,
          competitor_name: row.lost_deal.competitor_name ?? null,
          crm_source: crmSource,
        })
        if (lostErr) {
          result.errors.push(`lost_deals insert (wedding ${weddingId}): ${lostErr.message}`)
          result.ok = false
        } else {
          result.lostDealsInserted += 1
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown commit error'
      result.errors.push(msg)
      result.ok = false
    }
  }

  return result
}
