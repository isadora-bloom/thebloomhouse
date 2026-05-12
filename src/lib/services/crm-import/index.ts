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
import { htmlToText } from '@/lib/utils/html-text'
import type { Cents } from '@/lib/types/monetary'
import type { Surface } from '@/lib/services/email/surface-classifier'
// Migrated to mintWedding 2026-05-12. See docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
import { mintWedding } from '@/lib/services/identity/mint-wedding'

/** Stable identifier for the per-row crm_source column. Mirrors the
 *  weddings.crm_source CHECK constraint extended by migration 178 to
 *  include 'web_form' for the T5-Rixey-HH web-form intake adapter. */
export type CrmSource = 'honeybook' | 'dubsado' | 'aisle_planner' | 'generic_csv' | 'web_form'

/**
 * Wave 2B: map CrmSource to the identity name-capture chokepoint's
 * NameSource. The chokepoint scores confidence by source — calculator
 * forms are 95 (highest non-coordinator), CSV imports are 65 (mid-
 * confidence). Tour-scheduler imports use form_relay (60) since they
 * arrive via Calendly / Acuity / similar form intake.
 */
function pickChokepointSourceForCrm(crmSource: CrmSource):
  | 'csv_import'
  | 'calculator_form'
  | 'form_relay'
{
  if (crmSource === 'web_form') return 'calculator_form'
  // Tour-scheduler commits with crm_source='generic_csv' but the parsed
  // shape is form-relay-flavoured (Calendly invitee answers). Pure
  // generic_csv from a coordinator export is csv_import. We can't
  // distinguish here without an extra hint, so we err on csv_import
  // (the safer floor) — a future commit can pass an explicit override.
  return 'csv_import'
}

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
  booking_value?: Cents | number | null   // in cents (Bloom convention) — branded Cents preferred (T5-Rixey-RR fix #5)
  status?: 'inquiry' | 'tour_scheduled' | 'tour_completed' | 'proposal_sent'
         | 'booked' | 'completed' | 'lost' | 'cancelled' | null
  source?: string | null                  // wedding source channel
  source_detail?: string | null
  inquiry_date?: string | null            // ISO timestamp
  booked_at?: string | null
  lost_at?: string | null
  lost_reason?: string | null
  notes?: string | null

  /** Per-row import-time warnings the coordinator should review.
   *  Schema: { field, issue, value }[] — see migration 175. T5-Rixey-UU
   *  Bug G adds couple_name 'unparseable_concat' warnings when the
   *  splitter can't confidently break a glued name like
   *  "Megandcooperrosenberg". */
  import_warnings?: Array<{ field: string; issue: string; value?: string | null }> | null

  /** Stream WWW (migration 205): UTM parameters captured from inbound
   *  form payloads (web-form adapter) or extracted_identity payloads
   *  (email-pipeline). The shared commitNormalisedRows helper writes
   *  these straight to weddings.utm_* and stamps utm_first_seen_at on
   *  first-time stamp. Per the migration-205 column COMMENT, downstream
   *  importers MUST NOT overwrite a non-NULL value at the application
   *  layer — preserves the original acquisition channel even after a
   *  HoneyBook contract lands. */
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_term?: string | null
  utm_content?: string | null

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
  /** T5-Rixey-TT: lets adapters write factual attribution data (e.g.
   *  HoneyBook's "Lead Source" column, Calendly's Q7 "where did you
   *  hear about us?" answer) into interactions.extracted_identity so
   *  the lead-source-derivation Priority-2 picks it up. Adapters
   *  must NOT write to weddings.source directly — see Stream-TT
   *  adapter-as-facts contract. Per migration 113. */
  extracted_identity?: Record<string, unknown> | null
  /** T5-Rixey-BBB: required class-of-signal declaration. Every
   *  adapter-written interaction MUST carry one of source / touchpoint
   *  / crm / outcome / unclassified — the cluster-compute service
   *  reads this column to find the earliest source-class signal in
   *  each lead's identity cluster. The CI guard
   *  (scripts/check-signal-class-declared.mjs) fails the build when
   *  an insert against interactions does not declare the field. Use
   *  'unclassified' only when the class is genuinely ambiguous (e.g.
   *  brain-dump CSVs without provenance) — prefer the most specific
   *  class that matches the signal's role in the lead journey. */
  signal_class?: 'source' | 'touchpoint' | 'crm' | 'outcome' | 'unclassified'
  /** Wave 28 (mig 294): which UI surface this interaction belongs to.
   *  Per-row override; if absent, falls through to the adapter's
   *  defaultSurface in commitNormalisedRows. Synthetic CRM provenance
   *  rows declare 'crm_attribution' here; web-form / Calendly tour
   *  rows declare 'integration_event'; regular CRM-recorded couple
   *  conversations stay 'inbox'. */
  surface?: Surface
}

export interface NormalisedTourRow {
  scheduled_at: string                     // ISO timestamp
  tour_type?: 'in_person' | 'virtual' | 'phone' | null
  /** Mirrors the migration-077 widened tours.outcome CHECK enum. 'pending'
   *  added 2026-05-02 for T5-Rixey-II — tour-scheduler imports record
   *  scheduled-but-not-yet-conducted tours. */
  outcome?: 'pending' | 'completed' | 'booked' | 'lost' | 'cancelled' | 'no_show' | 'rescheduled' | null
  notes?: string | null
  /** T5-Rixey-BBB: tours are ALWAYS touchpoint class. The shared
   *  commitNormalisedRows helper hard-codes this — the field exists on
   *  the row shape so future per-adapter overrides have a slot, but
   *  tour-class is structural and shouldn't normally be touched. */
  signal_class?: 'touchpoint'
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
  /** Wave 4 Phase 4c: list of wedding ids that this commit touched
   *  (both freshly-inserted weddings AND existing weddings that were
   *  resolved-and-attached via the canonical resolver). The unified
   *  import-router uses this to enqueue identity-reconstruction for
   *  every couple the import produced or modified — so a HoneyBook
   *  backfill of 71 couples enqueues 71 reconstructions, not 0.
   *  Optional for back-compat; the existing /onboarding/crm-import
   *  endpoint ignores it. */
  touchedWeddingIds?: string[]
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
  /** T5-Rixey-BBB: default class-of-signal for any per-row interaction
   *  the adapter doesn't classify itself. Each adapter has a natural
   *  default (HoneyBook → 'crm', web-form → 'touchpoint',
   *  tour-scheduler → 'touchpoint', generic-csv → 'unclassified'),
   *  and individual rows can still override via NormalisedInteractionRow.
   *  signal_class. Tours are always 'touchpoint' (hard-coded below).
   *  Lost-deals are always 'outcome'. */
  defaultInteractionSignalClass?: 'source' | 'touchpoint' | 'crm' | 'outcome' | 'unclassified'
  /** Wave 2B: override the chokepoint NameSource. Web-form passes
   *  'calculator_form' (95). Tour-scheduler passes 'form_relay' (60).
   *  Default falls back to the crmSource-derived map (csv_import for
   *  generic_csv / honeybook / dubsado / aisle_planner; calculator_form
   *  for web_form). */
  chokepointNameSource?: 'csv_import' | 'calculator_form' | 'form_relay'
  /** Wave 28 (mig 294): default UI surface for any per-row interaction
   *  that didn't declare its own surface. HoneyBook synthetic
   *  provenance rows arrive with surface='crm_attribution' set per-row
   *  (see honeybook.ts) and override this default. Regular CRM-recorded
   *  conversations stay 'inbox' so they show up in /agent/inbox. */
  defaultSurface?: Surface
}): Promise<CommitResult> {
  const { supabase, venueId, rows, crmSource } = args
  const confidenceFlag = args.confidenceFlag ?? 'imported_medium'
  const sourceProvenance = args.sourceProvenance ?? null
  const defaultInteractionSignalClass = args.defaultInteractionSignalClass ?? 'unclassified'
  const chokepointNameSourceOverride = args.chokepointNameSource ?? null
  const defaultSurface: Surface = args.defaultSurface ?? 'inbox'
  const result: CommitResult = {
    ok: true,
    weddingsInserted: 0,
    interactionsInserted: 0,
    toursInserted: 0,
    lostDealsInserted: 0,
    errors: [],
    touchedWeddingIds: [],
  }

  for (const row of rows) {
    // #88 (Stream PPP, 2026-05-03): per-row client-side rollback. The
    // route-level pre-commit validation (validateAllRows) already catches
    // the easy DB-constraint violations (status enum, guests range,
    // unparseable dates) BEFORE any insert. But a row can still fail
    // mid-insert from constraints validateAllRows can't see (RLS
    // misconfig, FK violation if wedding_id was somehow recycled, a
    // future CHECK constraint we haven't taught the validator about).
    // Pre-fix: when interactions / tours / lost_deals failed, the
    // already-inserted weddings + people rows stayed orphaned and the
    // batch summary said "X interactions inserted" without the
    // corresponding wedding shells.
    //
    // Fix: track the wedding_id we just inserted; if any child insert
    // fails or an unexpected throw happens further down, DELETE the
    // wedding row and rely on ON DELETE CASCADE (every child table
    // declares ON DELETE CASCADE off weddings(id) per migrations 002 +
    // 004) to clean up people / interactions / tours / lost_deals
    // children that did make it through. Counters are decremented to
    // match so the summary still tells the truth.
    let insertedWeddingId: string | null = null
    let rowAborted = false
    // Wave 4 Phase 4c: track whether THIS row's wedding id is in the
    // touchedWeddingIds list so the outer catch can unrecord on rollback.
    // Declared outside the try block so the catch can reach it.
    let weddingIdRecorded = false
    const recordTouched = (id: string): void => {
      if (weddingIdRecorded) return
      result.touchedWeddingIds = result.touchedWeddingIds ?? []
      result.touchedWeddingIds.push(id)
      weddingIdRecorded = true
    }
    const unrecordTouched = (id: string): void => {
      if (!weddingIdRecorded) return
      result.touchedWeddingIds = (result.touchedWeddingIds ?? []).filter((x) => x !== id)
      weddingIdRecorded = false
    }
    const rollbackRow = async (reason: string): Promise<void> => {
      if (!insertedWeddingId) return
      try {
        await supabase.from('weddings').delete().eq('id', insertedWeddingId)
      } catch (rollbackErr) {
        result.errors.push(
          `rollback failed for wedding ${insertedWeddingId} (after ${reason}): ` +
          (rollbackErr instanceof Error ? rollbackErr.message : 'unknown'),
        )
      }
    }
    try {
      // Stream WWW (migration 205): UTM stamping at create time.
      // Inserts always carry whatever UTM the adapter parsed — this is
      // a NEW row, so there's no "previous" value to preserve. The
      // never-overwrite policy applies on UPDATE paths (HoneyBook /
      // tour-scheduler adapters that touch existing weddings, see also
      // email-pipeline). When utm_source is non-null we stamp
      // utm_first_seen_at = inquiry_date so the "earliest UTM signal
      // observed" anchor reflects the form-submission moment, not
      // wall-clock NOW (which would drift on a backfill import).
      // signal-class-justified: UTM stamping at adapter create-time, not source-channel write
      const hasUtm = !!(row.utm_source || row.utm_medium || row.utm_campaign || row.utm_term || row.utm_content)
      const inquiryDateForRow = row.inquiry_date ?? new Date().toISOString()
      const weddingPayload = {
        venue_id: venueId,
        status: row.status ?? 'inquiry',
        // adapter-source-justified: this is the SHARED commit helper.
        //   It writes whatever the per-adapter `parse()` returned. Per
        //   T5-Rixey-TT every adapter that previously wrote a CRM/
        //   scheduling-tool value here was refactored to write null;
        //   the lead-source-derivation cron decides the real channel
        //   from Q7 / web-form / email-domain / UTM in priority order.
        //   If `row.source` arrives non-null on a future adapter, that
        //   adapter must add its own justification comment.
        source: row.source ?? null,
        source_detail: row.source_detail ?? null,
        wedding_date: row.wedding_date ?? null,
        guest_count_estimate: row.guest_count_estimate ?? null,
        booking_value: row.booking_value ?? null,
        inquiry_date: inquiryDateForRow,
        booked_at: row.booked_at ?? null,
        lost_at: row.lost_at ?? null,
        lost_reason: row.lost_reason ?? null,
        notes: row.notes ?? null,
        confidence_flag: confidenceFlag,
        crm_source: crmSource,
        source_provenance: sourceProvenance,
        // T5-Rixey-UU Bug G: pass per-row import_warnings through to
        // the weddings.import_warnings jsonb so the coordinator-facing
        // 'needs review' badge surfaces on the leads page.
        import_warnings: row.import_warnings && row.import_warnings.length > 0
          ? row.import_warnings
          : null,
        // Stream WWW: UTM columns. Always written on insert (no prior
        // value to preserve). utm_first_seen_at anchors to the inquiry
        // date when ANY utm key is present — the form-submission moment
        // is the canonical "first observed" point.
        utm_source: row.utm_source ?? null,
        utm_medium: row.utm_medium ?? null,
        utm_campaign: row.utm_campaign ?? null,
        utm_term: row.utm_term ?? null,
        utm_content: row.utm_content ?? null,
        utm_first_seen_at: hasUtm ? inquiryDateForRow : null,
      }
      // 2026-05-08 deep-fix-resolver: before creating a fresh wedding,
      // ask the canonical resolver if the partner1 identity already
      // exists at this venue. If yes, attach the imported interactions /
      // tours / lost_deal to the existing wedding instead of minting a
      // duplicate. This is the at-write-time half of the Stream KK
      // offline reconciliation; together they guarantee the Reem case
      // (Knot relay → calculator → contract-request) collapses to one
      // wedding even when the three signals arrive across three
      // different code paths.
      // Signals passed: email + phone + partner1 first/last name. We
      // omit weddingDate from the resolver input on purpose — the
      // import row's wedding_date may be a guess; the resolver decides
      // whether to flag a date conflict on the existing wedding.
      let resolvedWeddingId: string | null = null
      let resolvedPartner1Id: string | null = null
      if (row.partner1_email || row.partner1_phone) {
        try {
          const { resolveIdentity } = await import('@/lib/services/identity/resolver')
          const resolved = await resolveIdentity(
            venueId,
            {
              email: row.partner1_email ?? null,
              phone: row.partner1_phone ?? null,
              fullName: [row.partner1_first_name, row.partner1_last_name].filter(Boolean).join(' ') || null,
              weddingDate: row.wedding_date ?? null,
              partner1Name: [row.partner1_first_name, row.partner1_last_name].filter(Boolean).join(' ') || null,
              partner2Name: [row.partner2_first_name, row.partner2_last_name].filter(Boolean).join(' ') || null,
            },
            {
              sourceLabel: `crm_import:${crmSource}`,
              supabase,
              // Wave 9 root-cause: pass the CSV row's inquiry_date down to
              // the resolver so a wedding minted by Branch C (fresh person
              // + fresh wedding) doesn't drift to NOW() and trip
              // inquiry_date_drift on the next sweep.
              inquirySignalAt: row.inquiry_date ?? undefined,
            },
          )
          resolvedWeddingId = resolved.weddingId
          resolvedPartner1Id = resolved.personId
        } catch (err) {
          // Resolver failure should not block the import. Fall through
          // to the legacy create-fresh path; the offline reconciler
          // (Stream KK) catches anything we miss here.
          console.warn('[crm-import] resolveIdentity failed for row, falling back to fresh-create:', err)
        }
      }

      let weddingId: string
      if (resolvedWeddingId) {
        // Attach to the existing wedding. Backfill any null fields the
        // import row carries (booking_value, wedding_date, notes).
        weddingId = resolvedWeddingId
        const backfill: Record<string, unknown> = {}
        if (row.booking_value != null) backfill.booking_value = row.booking_value
        if (row.wedding_date) backfill.wedding_date = row.wedding_date
        if (row.guest_count_estimate != null) backfill.guest_count_estimate = row.guest_count_estimate
        // Fold the import row's notes into existing notes (don't overwrite).
        if (row.notes && row.notes.trim()) {
          const { data: cur } = await supabase
            .from('weddings').select('notes').eq('id', weddingId).maybeSingle()
          const existing = (cur?.notes as string | null) ?? null
          backfill.notes = existing ? `${existing}\n\n[crm_import:${crmSource}]\n${row.notes}` : row.notes
        }
        if (Object.keys(backfill).length > 0) {
          await supabase.from('weddings').update(backfill).eq('id', weddingId)
        }
        insertedWeddingId = weddingId
        // Don't bump weddingsInserted — we attached to an existing one.
        // Wave 4 Phase 4c: still record the touched wedding so the
        // import-router enqueues a reconstruction (the import added new
        // signals to an existing couple's record).
        recordTouched(weddingId)
      } else {
        // Migrated to mintWedding 2026-05-12. See docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
        // The fallback path (no email AND no phone, so resolveIdentity
        // wasn't called above) still has to mint a wedding shell. Route
        // it through the chokepoint so name+date dedup, source_provenance,
        // and cascade fire identically to the resolver-attached path.
        // After mintWedding returns, UPDATE the wedding with all the
        // CRM-specific fields (status, booking_value, UTM, etc.) the
        // resolver doesn't carry.
        const partner1FullName = [row.partner1_first_name, row.partner1_last_name]
          .filter(Boolean).join(' ') || null
        const partner2FullName = [row.partner2_first_name, row.partner2_last_name]
          .filter(Boolean).join(' ') || null
        let mintedWeddingId: string
        try {
          const minted = await mintWedding({
            venueId,
            source: 'crm_import',
            reason: `crm_import:${crmSource}`,
            supabase,
            correlationId: null,
            signals: {
              email: row.partner1_email ?? null,
              phone: row.partner1_phone ?? null,
              fullName: partner1FullName,
              partner1Name: partner1FullName,
              partner2Name: partner2FullName,
              weddingDate: row.wedding_date ?? null,
              inquiryDate: row.inquiry_date ?? null,
              guestCount: row.guest_count_estimate ?? null,
            },
          })
          mintedWeddingId = minted.weddingId
          if (minted.isNew) result.weddingsInserted += 1
        } catch (mintErr) {
          result.errors.push(`mintWedding failed: ${mintErr instanceof Error ? mintErr.message : 'unknown'}`)
          result.ok = false
          continue
        }
        weddingId = mintedWeddingId
        insertedWeddingId = weddingId
        recordTouched(weddingId)
        // Stamp the CRM-specific fields the chokepoint doesn't carry.
        // Strip the resolver-owned columns from the payload (venue_id,
        // inquiry_date, source_provenance) — the resolver already set
        // those — but keep status / booking_value / UTM / notes / etc.
        const crmFields: Record<string, unknown> = { ...weddingPayload }
        delete crmFields.venue_id
        delete crmFields.inquiry_date
        delete crmFields.source_provenance
        await supabase.from('weddings').update(crmFields).eq('id', weddingId)
      }

      // people: insert primary partner if we have any name/email AND the
      // resolver did not already attach an existing canonical person.
      // When resolvedPartner1Id is set, the canonical person row already
      // exists and the resolver has stamped its wedding_id where needed.
      //
      // Wave 2B: every people INSERT routes through the identity name-
      // capture chokepoint after the row is created. The chokepoint
      // appends a name_evidence row, runs the picker against the full
      // evidence array, and dual-writes first_name / last_name from the
      // picker's choice. CRM imports source = csv_import (confidence 65)
      // for generic CSV / HoneyBook, calculator_form (confidence 95) for
      // web-form, form_relay (confidence 60) for tour-scheduler.
      // Wave 4 Phase 4 (2026-05-10): detectPhantomPartner retired —
      // reconstruct.ts judges phantoms; profile-to-people-sync tombstones.
      const { captureNameEvidence, inferNameFromEmail } = await import(
        '@/lib/services/identity/name-capture'
      )
      const chokepointSource = chokepointNameSourceOverride
        ?? pickChokepointSourceForCrm(crmSource)

      let p1InsertedId: string | null = null
      if (
        !resolvedPartner1Id &&
        (row.partner1_first_name || row.partner1_last_name || row.partner1_email)
      ) {
        const { data: p1Row } = await supabase
          .from('people')
          .insert({
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
          .select('id')
          .single()
        if (p1Row?.id) {
          p1InsertedId = p1Row.id as string
          // Capture the partner1 name signal through the chokepoint.
          // Pre-split first/last is the cleanest signal; the chokepoint
          // records evidence + recomputes the picker output. Even when
          // the row already had a real first/last, we still capture so
          // the evidence array reflects the import as a source.
          try {
            await captureNameEvidence(supabase, p1InsertedId, {
              first: row.partner1_first_name ?? null,
              last: row.partner1_last_name ?? null,
              email: row.partner1_email ?? null,
              source: chokepointSource,
            })
            if (row.partner1_email) {
              const fromEmail = inferNameFromEmail(row.partner1_email)
              if (fromEmail) {
                await captureNameEvidence(supabase, p1InsertedId, {
                  first: fromEmail.first,
                  last: fromEmail.last,
                  email: row.partner1_email,
                  source: 'email_handle_parse',
                })
              }
            }
          } catch (err) {
            console.warn('[crm-import] name-capture (partner1) failed:',
              err instanceof Error ? err.message : err)
          }
        }
      }

      // Partner2 path. Wave 2B fixes:
      //   1. Empty-string ilike bug: the legacy dedup queried
      //      `ilike('first_name', row.partner2_first_name ?? '')` —
      //      when partner2_first_name was empty, ilike against '' matches
      //      EVERY row → falsely says partner2 already exists, skipping
      //      legitimate inserts. Fix: only fire the dedup query when
      //      partner2_first_name is non-empty.
      //
      // Wave 4 Phase 4 (2026-05-10): the synchronous phantom-partner
      // detector is retired. reconstruct.ts judges phantoms via
      // is_phantom_partner_relationship and profile-to-people-sync
      // tombstones the phantom partner2 row after the judge runs.
      const p2HasFirst = !!(row.partner2_first_name && row.partner2_first_name.trim())
      const p2HasLast = !!(row.partner2_last_name && row.partner2_last_name.trim())
      if (p2HasFirst || p2HasLast) {
        // Run the dedupe ONLY when we have a non-empty first name to
        // query with — empty-string ilike matches all.
        let alreadyExists = false
        if (p2HasFirst) {
          const { data: existingP2 } = await supabase
            .from('people')
            .select('id')
            .eq('wedding_id', weddingId)
            .eq('role', 'partner2')
            .ilike('first_name', row.partner2_first_name as string)
            .limit(1)
          alreadyExists = !!(existingP2 && existingP2.length > 0)
        }
        if (!alreadyExists) {
          const { data: p2Row } = await supabase
            .from('people')
            .insert({
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
            .select('id')
            .single()
          if (p2Row?.id) {
            try {
              await captureNameEvidence(supabase, p2Row.id as string, {
                first: row.partner2_first_name ?? null,
                last: row.partner2_last_name ?? null,
                email: row.partner2_email ?? null,
                source: chokepointSource,
              })
              if (row.partner2_email) {
                const fromEmail = inferNameFromEmail(row.partner2_email)
                if (fromEmail) {
                  await captureNameEvidence(supabase, p2Row.id as string, {
                    first: fromEmail.first,
                    last: fromEmail.last,
                    email: row.partner2_email,
                    source: 'email_handle_parse',
                  })
                }
              }
            } catch (err) {
              console.warn('[crm-import] name-capture (partner2) failed:',
                err instanceof Error ? err.message : err)
            }
          }
        }
      }

      // interactions
      if (row.interactions?.length) {
        // T5-Rixey-RR fix #1: CRM exports often round-trip user-pasted
        // rich text — strip HTML at the writer so structured readers
        // (lead_source derivation regex, AI grounding) never see tags.
        // T5-Rixey-TT: also passes extracted_identity (factual attribution
        // metadata from CSVs e.g. HoneyBook's "Lead Source" column,
        // Calendly's Q7 answer) so lead-source-derivation Priority-2
        // can read it without adapters touching weddings.source.
        const interactionPayloads = row.interactions.map((i) => {
          const cleanBody = i.body ? htmlToText(i.body) : null
          return {
            venue_id: venueId,
            wedding_id: weddingId,
            type: i.type,
            direction: i.direction,
            subject: i.subject ?? null,
            full_body: cleanBody,
            body_preview: cleanBody ? cleanBody.slice(0, 200) || null : null,
            timestamp: i.occurred_at,
            confidence_flag: confidenceFlag,
            crm_source: crmSource,
            extracted_identity: i.extracted_identity ?? null,
            // T5-Rixey-BBB: per-row signal_class overrides take
            // precedence over the adapter's default. Unset rows fall
            // back to the adapter-supplied default; if the adapter
            // didn't supply one either, the row lands as 'unclassified'
            // — the DB-level CHECK accepts it but the CI guard
            // (scripts/check-signal-class-declared.mjs) flags any
            // adapter that doesn't justify the lack of a class.
            // signal-class-justified: shared commit helper plumbs the per-adapter default
            signal_class: i.signal_class ?? defaultInteractionSignalClass,
            // Wave 28 (mig 294): per-row surface override takes precedence
            // over the adapter default. HoneyBook's synthetic provenance
            // rows pass 'crm_attribution'; tour-scheduler + web-form pass
            // 'integration_event' on the row representing the event itself.
            surface: i.surface ?? defaultSurface,
          }
        })
        const { error: intErr } = await supabase.from('interactions').insert(interactionPayloads)
        if (intErr) {
          // #88 rollback: kill the wedding (and cascade-clean the
          // people row we may have just inserted) so we don't leave a
          // shell with no email history attached.
          result.errors.push(`interactions insert (wedding ${weddingId}): ${intErr.message}`)
          result.ok = false
          await rollbackRow('interactions insert failed')
          result.weddingsInserted = Math.max(0, result.weddingsInserted - 1)
          unrecordTouched(weddingId)
          insertedWeddingId = null
          rowAborted = true
        } else {
          result.interactionsInserted += interactionPayloads.length
        }
      }
      if (rowAborted) continue

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
          // T5-Rixey-BBB: tours are ALWAYS touchpoint class — the
          // lead used a scheduling tool to book a visit AFTER
          // discovering the venue. They never contribute to first-
          // touch attribution.
          // signal-class-justified: tours are structurally always touchpoint
          signal_class: 'touchpoint' as const,
        }))
        const { error: tourErr } = await supabase.from('tours').insert(tourPayloads)
        if (tourErr) {
          // #88 rollback: tours failed → wipe wedding + cascade clean
          // any interactions / people we already wrote for this row.
          result.errors.push(`tours insert (wedding ${weddingId}): ${tourErr.message}`)
          result.ok = false
          await rollbackRow('tours insert failed')
          result.weddingsInserted = Math.max(0, result.weddingsInserted - 1)
          result.interactionsInserted = Math.max(
            0,
            result.interactionsInserted - (row.interactions?.length ?? 0),
          )
          unrecordTouched(weddingId)
          insertedWeddingId = null
          rowAborted = true
        } else {
          result.toursInserted += tourPayloads.length
        }
      }
      if (rowAborted) continue

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
          // T5-Rixey-BBB: lost-deal records are ALWAYS outcome class.
          // signal-class-justified: lost-deals are structurally always outcome
          signal_class: 'outcome' as const,
        })
        if (lostErr) {
          // #88 rollback: lost-deals failed → wipe wedding + cascade
          // clean every other child the row had written so far.
          result.errors.push(`lost_deals insert (wedding ${weddingId}): ${lostErr.message}`)
          result.ok = false
          await rollbackRow('lost_deals insert failed')
          result.weddingsInserted = Math.max(0, result.weddingsInserted - 1)
          result.interactionsInserted = Math.max(
            0,
            result.interactionsInserted - (row.interactions?.length ?? 0),
          )
          result.toursInserted = Math.max(
            0,
            result.toursInserted - (row.tours?.length ?? 0),
          )
          unrecordTouched(weddingId)
          insertedWeddingId = null
          rowAborted = true
        } else {
          result.lostDealsInserted += 1
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown commit error'
      result.errors.push(msg)
      result.ok = false
      // #88 rollback: anything thrown post-wedding-insert means the
      // children we wrote so far are orphans relative to a wedding
      // shell that could be partially populated. Drop the wedding +
      // cascade-clean. Counters are decremented to match the truth.
      if (insertedWeddingId) {
        await rollbackRow(`unexpected throw: ${msg}`)
        result.weddingsInserted = Math.max(0, result.weddingsInserted - 1)
        result.interactionsInserted = Math.max(
          0,
          result.interactionsInserted - (row.interactions?.length ?? 0),
        )
        result.toursInserted = Math.max(
          0,
          result.toursInserted - (row.tours?.length ?? 0),
        )
        unrecordTouched(insertedWeddingId)
        insertedWeddingId = null
      }
    }
  }

  return result
}
