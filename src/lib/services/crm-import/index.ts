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
 *
 * W35 (NOVEMBER-PLAN.md wave 5, 2026-09-12): the commit path now hands
 * every row to `linkSignal`, the one spine writer, instead of relying on
 * a mirror and a bolted-on handle stamp. The wedding row is minted first
 * and the signals follow it; the reasoning for that order, and what it
 * costs, is written out in full at the top of ./row-signals.ts. W29's
 * `commitHandleStamps` is gone with it. Handles and first_seen_at now
 * arrive through the stamp inside the cascade like every other channel.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { htmlToText } from '@/lib/utils/html-text'
import type { Cents } from '@/lib/types/monetary'
import type { Surface } from '@/lib/services/email/surface-classifier'
// Migrated to mintWedding 2026-05-12. See docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
import { mintWedding } from '@/lib/services/identity/mint-wedding'
import { normalizeHandles } from '@/lib/services/identity/handles'
import type { HandlePlatform } from '@/lib/services/identity/sources/types'

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
  // Commercial detail from a booked-couple CRM export. All money in
  // integer cents. Columns: amount_paid / tax_amount / gratuity_amount
  // / refunded_amount (migration 175), deposit_amount + package_name
  // (migration 351).
  amount_paid?: Cents | number | null
  deposit_amount?: Cents | number | null
  tax_amount?: Cents | number | null
  gratuity_amount?: Cents | number | null
  refunded_amount?: Cents | number | null
  package_name?: string | null
  /** Full header-keyed source CSV row. Preserved into
   *  weddings.raw_import_row (migration 355) so any column with no
   *  typed field is not lost and surfaces on the Data Fields page. */
  raw_row?: Record<string, unknown> | null
  status?: 'inquiry' | 'tour_scheduled' | 'tour_completed' | 'proposal_sent'
         | 'booked' | 'completed' | 'lost' | 'cancelled' | null
  source?: string | null                  // wedding source channel
  source_detail?: string | null
  inquiry_date?: string | null            // ISO timestamp
  booked_at?: string | null
  lost_at?: string | null
  lost_reason?: string | null
  notes?: string | null

  /** Structured Calendly / form Q&A payload. Migration 322 added
   *  weddings.calendly_qa as the canonical home for `key:value` form
   *  answers that previously got stuffed into notes as free text.
   *  Writing here instead of (or in addition to) notes means the
   *  name-upgrade regex pipeline never sees Capitalized Q&A values
   *  like "Whole Weekend" as candidate names. Shape:
   *    { partner2_email?, package_interest?, pricing_calculator?,
   *      unknown_q_a?, plus any future Calendly question key }
   *  See NAME-LEAK-TRACE-2026-05-12.md. */
  calendly_qa?: Record<string, unknown> | null

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

  /** W20 (2026-09-09): people on the source record who are NOT the
   *  couple — a mother, a planner, an aunt paying the invoice. A
   *  HoneyBook project export puts one row per person, so a three- or
   *  four-row group is a couple plus family. These used to be counted
   *  in a warning and thrown away. They now become Agent-class people
   *  on the spine, linked to the couple with a role. */
  related_contacts?: NormalisedRelatedContactRow[]
}

/**
 * One non-couple human attached to an imported row. Becomes, through
 * `linkSignal`'s Agent branch: a `couples` row at
 * lifecycle_state='agent', an `agent_couple_links` row joining them to
 * the couple, and a `wedding_relationships` row carrying the role.
 * See IDENTITY-FIRST-ARCHITECTURE.md §1 (the Agent class).
 */
export interface NormalisedRelatedContactRow {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  /** Role on the couple's record. The coarse vocabulary a project export
   *  can actually support: a CRM contact list carries no gender and no
   *  "of the bride", so 'parent' is as precise as the data gets. A
   *  channel that knows more (an email signature saying "mother of the
   *  bride") may pass any value migration 255 documents for
   *  `wedding_relationships.relationship_role`. */
  role: 'parent' | 'planner' | 'other' | string
  /** Why the role was chosen, kept verbatim for the coordinator.
   *  "Company: Ivy Lane Events", "shares the surname Blaine". */
  role_detail?: string | null
  /** Stable per-contact key. Feeds both the touchpoint's external_id and
   *  the crm_import_rows dedup fingerprint, so a re-upload of the same
   *  export writes nothing twice. */
  external_id?: string | null
  /** 1-based CSV row this contact came from, for operator forensics. */
  source_row?: number | null
  /** Header-keyed source row, preserved into the touchpoint payload. */
  raw_row?: Record<string, unknown> | null
}

export interface NormalisedInteractionRow {
  occurred_at: string                      // ISO timestamp
  direction: 'inbound' | 'outbound'
  /** Mirrors interactions.type CHECK. 'meeting' added by migration 100,
   *  'web_form' added by migration 178 (T5-Rixey-HH). */
  type: 'email' | 'call' | 'voicemail' | 'sms' | 'meeting' | 'web_form'
  /** 2026-05-13: adapter-provided unique key from the source system —
   *  Calendly event_uuid, HoneyBook event id, Knot inquiry id. When
   *  set, commitNormalisedRows runs classifyImportRow against
   *  crm_import_rows (migration 335) BEFORE inserting the interaction:
   *  - 'unchanged' state → interaction NOT inserted (re-upload no-op)
   *  - 'new' / 'state_changed' → inserted + recordResolution called
   *  This is the universal dedup layer for recurring CSV uploads.
   *  Adapters without a stable per-row key leave this null.
   *  See bloom-recurring-csv-import-doctrine.md. */
  external_id?: string | null
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

/**
 * Per-row outcome the commit step would produce. Populated only when
 * `commitNormalisedRows` runs in dry-run mode (`preview:true`). The
 * operator-facing pre-flight UI renders this as a table BEFORE the
 * coordinator confirms the commit, so they can see at a glance how
 * many rows are net-new vs already-known.
 *
 * Outcomes — chosen to be at the per-ROW granularity the operator
 * thinks in (one CSV row = one couple, one decision):
 *   - 'new'                       — no fingerprint match in
 *                                   crm_import_rows AND no identity
 *                                   match in weddings/people; commit
 *                                   would mint a fresh wedding.
 *   - 'matched_existing_wedding'  — identity resolver attached to a
 *                                   wedding already in Bloom (email
 *                                   backfill / earlier CSV / etc.);
 *                                   commit would BACKFILL fields onto
 *                                   the existing wedding.
 *   - 'dedup_skip'                — every interaction this row carries
 *                                   has an external_id that already
 *                                   landed via a prior upload with the
 *                                   same content_hash; commit would
 *                                   write nothing. THIS is the "we've
 *                                   seen this row before" verdict.
 *   - 'partial_dedup_skip'        — some interactions in this row are
 *                                   dedup-skips, others are net-new or
 *                                   state-changed. Commit would write
 *                                   the new/changed ones only.
 *   - 'failed'                    — preview-mode lookup or row
 *                                   resolution failed. Commit would
 *                                   either skip the row or error.
 */
export interface PreviewDecision {
  rowIndex: number
  willInsert:
    | 'new'
    | 'matched_existing_wedding'
    | 'dedup_skip'
    | 'partial_dedup_skip'
    | 'failed'
  /** Human-readable explanation suitable for tooltip / row detail. */
  reason: string
  partner1?: string | null
  partner2?: string | null
  weddingDate?: string | null
  status?: string | null
  /** When the row is `matched_existing_wedding` or `partial_dedup_skip`,
   *  this is the existing wedding id the commit would attach to. */
  resolvedWeddingId?: string | null
  /** Per-interaction breakdown (when row.interactions is non-empty
   *  AND any of them carry external_id). 'dedup_unchanged' = same
   *  content_hash, 'dedup_state_changed' = fingerprint exists but
   *  content differs (commit would write a touchpoint diff). */
  interactionDecisions?: Array<{
    occurredAt: string
    type: string
    externalId: string | null
    state: 'new' | 'dedup_unchanged' | 'dedup_state_changed' | 'no_external_id'
  }>
}

export interface CommitResult {
  ok: boolean
  weddingsInserted: number
  /** Rows that resolved to a wedding that already existed (e.g. an
   *  inquiry the email backfill created) and were attached/updated
   *  rather than inserted. weddingsInserted counts only NEW rows, so
   *  without this an import that correctly de-duped looked like it
   *  imported nothing. */
  weddingsMatchedExisting?: number
  /** Of the matched-existing weddings, how many had their status
   *  upgraded (e.g. inquiry -> booked) by this import. */
  weddingsStatusUpgraded?: number
  interactionsInserted: number
  /** 2026-05-13: count of interactions skipped by the crm_import_rows
   *  dedup layer (migration 335). Equals the number of rows in this
   *  batch whose external_id was already seen with the same
   *  content_hash. Operator UI shows "weekly Knot re-upload: 95% of
   *  rows already known". Absent on batches with no external_id rows. */
  interactionsSkippedDedup?: number
  toursInserted: number
  /** Tours skipped because a tour for the same wedding at the same
   *  scheduled_at already existed — re-import / timed-out-retry dedup.
   *  The tours table has no external_id, so this is keyed on
   *  (wedding_id, scheduled_at). Absent when no tour was a duplicate. */
  toursSkippedDedup?: number
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
  /** Dry-run pre-flight diff. Populated ONLY when the caller passes
   *  `preview:true` to `commitNormalisedRows`. The list is row-aligned
   *  with the input `rows` so the UI can render a row-by-row table.
   *  When `preview` is unset (default), this field is absent — every
   *  existing caller continues to see byte-identical output. */
  preview?: true
  previewDecisions?: PreviewDecision[]
  /** W20: what happened to the non-couple people on the imported rows
   *  (parents, planners, whoever else was on the project). Absent when
   *  the batch carried none. Replaces the old warn-and-drop, so an
   *  import that saw fourteen parents can say so. */
  relatedContacts?: RelatedContactsSummary
  /** W29 (HANDLE-IDENTITY-SPEC.md §1): platform handles this import
   *  added to `couples.handles`. Counted per (couple, platform), so a
   *  row whose Instagram handle the couple already had counts zero —
   *  the import recorded nothing new. Absent when the batch carried no
   *  handle column at all (every HoneyBook export today). */
  handlesRecorded?: number
  /** Platforms where the row's handle disagreed with the one already on
   *  the couple. Nothing was overwritten; `handle-merge.ts` keeps the
   *  stored value and the cascade writes a `handle_contradiction` row to
   *  `couple_merge_events` for a human to look at. A non-zero count here
   *  is the number that wants eyes on it. */
  handleConflicts?: number
}

/** Per-import tally for the Agent-class people an import produced. */
export interface RelatedContactsSummary {
  /** Non-couple contacts seen on the parsed rows. */
  seen: number
  /** New agent-class `couples` rows minted by this import. */
  created: number
  /** Contacts that ended the import joined to their couple through
   *  `agent_couple_links`, whether this run wrote the link or a previous
   *  one did. */
  linked: number
  /** `wedding_relationships` rows written by this run. */
  rolesRecorded: number
  /** Every contact that was NOT linked, and why. One entry per contact —
   *  a dropped human is never a bare number. */
  skipped: Array<{ contact: string; reason: string }>
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
 *  generic_csv, web_form), but some adapters use their own identifier
 *  because they commit with crm_source='generic_csv' (no dedicated enum
 *  value yet — adding one requires a migration on the weddings.crm_source
 *  CHECK constraint). 'tour_scheduler' and 'knot' are the current
 *  alias-only entries. Registry-name is what the API route + UI
 *  provider-picker key off; crm_source is what the shared commit helper
 *  writes to the DB. The recurring-CSV dedup ledger
 *  (crm_import_rows.source) does carry 'knot' as a distinct value so
 *  per-row identity is correctly partitioned at the dedup layer. */
export type AdapterName =
  | CrmSource
  | 'tour_scheduler'
  | 'knot'
  // Universal fall-through importer. Commits with crm_source='generic_csv'.
  // See ai-mapped.ts - sends unrecognised headers to the LLM for a
  // proposed column mapping the coordinator confirms before commit.
  | 'ai_mapped'
  // Wedding-marketplace storefront-activity export (Knot / WeddingWire
  // funnel events). Writes low-confidence tangential_signals, not
  // weddings. See storefront-activity.ts.
  | 'storefront_activity'
  // First-party website pixel / visitor analytics export. Writes
  // tangential_signals + attribution-grade visitor history. See
  // site-visitors.ts.
  | 'site_visitors'
  // Per-row Knot visitor-activity history (`<Venue>-visitor-activities (N).csv`).
  // Writes knot_visitor_activity (mig 377) + runs the identity matcher
  // (knot-visitor-match.ts) to bind / ghost / emit verification-visit
  // heat signals. Sibling to storefront-activity (which aggregates the
  // funnel into tangential_signals). See knot-visitor-activity.ts.
  | 'knot_visitor_activity'

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
    /** Dry-run pre-flight diff. When true, the commit runs the parse
     *  + decision logic (resolveIdentity lookup, crm_import_rows
     *  fingerprint lookup) but performs ZERO writes — no weddings,
     *  no people, no interactions, no tours, no lost_deals, no
     *  linkSignal, no row-signal push. Returns
     *  CommitResult.previewDecisions populated so the operator UI
     *  can show "X new, Y already in Bloom, Z dedup-skipped" BEFORE
     *  the coordinator confirms. Optional — adapters that ignore
     *  it MUST behave as if `preview:false` (the default). */
    preview?: boolean
  }): Promise<CommitResult>
}

import { honeybookAdapter } from './honeybook'
import { dubsadoAdapter } from './dubsado'
import { aislePlannerAdapter } from './aisleplanner'
import { genericCsvAdapter } from './generic-csv'
import { aiMappedAdapter } from './ai-mapped'
import { webFormAdapter } from './web-form'
import { tourSchedulerAdapter } from './tour-scheduler'
import { knotAdapter } from './knot'
import { storefrontActivityAdapter } from './storefront-activity'
import { siteVisitorsAdapter } from './site-visitors'
import { knotVisitorActivityAdapter } from './knot-visitor-activity-adapter'

export const ADAPTERS: ReadonlyArray<CrmAdapter> = [
  genericCsvAdapter,
  aiMappedAdapter,
  honeybookAdapter,
  dubsadoAdapter,
  aislePlannerAdapter,
  webFormAdapter,
  tourSchedulerAdapter,
  knotAdapter,
  storefrontActivityAdapter,
  siteVisitorsAdapter,
  knotVisitorActivityAdapter,
]

export function findAdapter(name: string): CrmAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null
}

// ---------------------------------------------------------------------------
// Handles and first-seen off a CSV row (HANDLE-IDENTITY-SPEC.md §1 + §3)
// ---------------------------------------------------------------------------
//
// W25 taught the web-form / calculator adapter to read an `instagram` or
// `tiktok` column and put the normalised value on the row's interaction, at
// `extracted_identity.handles`. W29 collected those per row and stamped them
// onto the mirrored couple after the loop, because this path did not go
// through `linkSignal` and so had no cascade stamp to ride on.
//
// W35 removed that second pass. The two readers below survive it, because
// they are what turns an adapter's row shape into the two fields a signal
// needs. `handlesFromRow` produces the row anchor's `handles`;
// `firstSeenCandidateFor` produces its `occurred_at`, which is what moves
// `couples.first_seen_at` earlier. Both are pure, and both are exercised on
// every row now rather than only on rows that happened to carry a handle.
//
// The path stays generic: it reads `extracted_identity.handles` off whatever
// the adapter produced. HoneyBook exports carry no handle column today, so a
// HoneyBook import counts zero and writes nothing. That is the correct
// outcome, not a gap.

/** The closed platform set, mirrored here so an adapter that ever writes an
 *  unknown key cannot reach `normalizeHandle`. That function's per-platform
 *  lookup tables assume the closed set and throw on a stranger, and a throw
 *  inside the row loop would roll the whole row back over a social handle.
 *  `extraction.ts` guards its model output the same way. */
const KNOWN_HANDLE_PLATFORMS = new Set<string>([
  'instagram', 'tiktok', 'facebook', 'pinterest', 'twitter',
  'knot', 'weddingwire', 'zola',
])

/**
 * The handles an adapter put on a row, merged across its interactions.
 *
 * Everything is re-normalised through `normalizeHandles`, so an adapter that
 * wrote a raw `@Handle` or a profile URL still lands clean, and a junk value
 * lands as nothing. Earlier interactions win per platform: the first time a
 * row states a handle is the statement, and a later row-level repeat is not
 * new evidence.
 */
export function handlesFromRow(
  row: NormalisedLeadRow,
): Partial<Record<HandlePlatform, string>> | null {
  const merged: Partial<Record<HandlePlatform, string>> = {}
  for (const interaction of row.interactions ?? []) {
    const raw = (interaction.extracted_identity ?? null) as
      | { handles?: unknown }
      | null
    const stated = (raw?.handles ?? null) as Record<string, unknown> | null
    if (!stated || typeof stated !== 'object') continue
    const known: Partial<Record<HandlePlatform, string>> = {}
    for (const [key, value] of Object.entries(stated)) {
      if (typeof value !== 'string' || !value.trim()) continue
      if (!KNOWN_HANDLE_PLATFORMS.has(key)) continue
      known[key as HandlePlatform] = value
    }
    const cleaned = normalizeHandles(known)
    if (!cleaned) continue
    for (const platform of Object.keys(cleaned) as HandlePlatform[]) {
      if (!merged[platform]) merged[platform] = cleaned[platform]
    }
  }
  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * The earliest real-world timestamp the row can offer for `first_seen_at`.
 * The row's own interactions first (they are the touchpoints), then the
 * inquiry date. Returns '' when the row carries no usable date, which the
 * first-seen stamp reads as "leave it alone".
 *
 * W40 (NOVEMBER-PLAN.md wave 5): this candidate is for EVERY row, handle
 * or not. A dated HoneyBook row with no instagram/tiktok/etc. column still
 * has an inquiry_date, so it still has a usable date here — the function
 * does not look at, or need, `handlesFromRow`'s result. Before this wave
 * the only call site pushed to `pendingHandleStamps` gated on
 * `handlesFromRow(row)` being non-null (see the `rowHandles` check around
 * `commitHandleStamps`, W35-owned), so a handle-less row's candidate was
 * computed correctly here but never reached `stampFirstSeenAt` — the row
 * never got queued at all. Fixing that fully needs the call site to queue
 * a first-seen stamp whenever this function returns a non-empty string,
 * independent of whether the row also carries a handle (W35's commit
 * path owns that line; `stampHandlesAndFirstSeen` already tolerates
 * `signal.handles` being empty — it only skips the handle-merge branch,
 * `stampFirstSeenAt` still runs).
 */
export function firstSeenCandidateFor(row: NormalisedLeadRow): string {
  const candidates: string[] = []
  for (const interaction of row.interactions ?? []) {
    if (interaction.occurred_at) candidates.push(interaction.occurred_at)
  }
  if (row.inquiry_date) candidates.push(row.inquiry_date)
  const usable = candidates.filter((c) => Number.isFinite(Date.parse(c)))
  if (usable.length === 0) return ''
  return usable.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b))
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
  /** 2026-05-26 §7 operator pre-flight: dry-run mode. When true, this
   *  function runs the parse + decision logic (identity resolver
   *  lookup + crm_import_rows fingerprint check) BUT performs ZERO
   *  database writes — no weddings.insert, no people.insert, no
   *  interactions.insert, no linkSignal, no row-signal
   *  push, no portal provisioning. Returns CommitResult with
   *  `preview:true` + `previewDecisions[]` populated so the operator
   *  UI can show a pre-flight diff ("X new couples, Y already in
   *  Bloom") before the coordinator confirms the commit.
   *
   *  Backward-compat contract: when omitted/false, this function
   *  behaves byte-identically to the pre-flag implementation. */
  preview?: boolean
}): Promise<CommitResult> {
  const { supabase, venueId, rows, crmSource } = args
  const confidenceFlag = args.confidenceFlag ?? 'imported_medium'
  const sourceProvenance = args.sourceProvenance ?? null
  const defaultInteractionSignalClass = args.defaultInteractionSignalClass ?? 'unclassified'
  const chokepointNameSourceOverride = args.chokepointNameSource ?? null
  const defaultSurface: Surface = args.defaultSurface ?? 'inbox'
  const isDryRun = args.preview === true
  const result: CommitResult = {
    ok: true,
    weddingsInserted: 0,
    interactionsInserted: 0,
    toursInserted: 0,
    lostDealsInserted: 0,
    errors: [],
    touchedWeddingIds: [],
  }
  if (isDryRun) {
    result.preview = true
    result.previewDecisions = []
  }

  // W35: the cascade signals every row produces, flushed through
  // `linkSignal` after the loop. Replaces the HoneyBook-only H3
  // accumulator. Every adapter's rows now reach the one writer, not just
  // HoneyBook's. See ./row-signals.ts for the shape and the ordering
  // argument; the flush filters against the surviving weddings exactly as
  // the related-contacts flush does, so a row that rolled back links
  // nothing.
  //
  // HoneyBook keeps one signal of its own: the synthetic provenance row
  // carrying `extracted_identity.hear_source`, which is the only true
  // attribution signal that export provides. It is folded into the row's
  // time-ordered list rather than flushed separately.
  const isHoneybookImport = crmSource === 'honeybook'
  const pendingRowSignals: Array<
    import('./row-signals').PendingRowSignals
  > = []

  // W20: the non-couple people on the imported rows. Accumulated in the
  // row loop and flushed after it, so a row that rolls back (a failed
  // tours or lost_deals insert wipes the wedding) does not leave an
  // agent pointing at a wedding that no longer exists. The flush filters
  // against the surviving touched-wedding set.
  const pendingRelatedContacts: Array<
    import('./related-contacts').PendingRelatedContact
  > = []

  // ---------------------------------------------------------------------
  // Dry-run / pre-flight diff path.
  // ---------------------------------------------------------------------
  // The operator UI calls this before activating the Commit button so
  // they can see "X new couples, Y already in Bloom, Z dedup-skipped"
  // BEFORE damage is done. We mirror the commit-path's decision tree
  // (identity resolver lookup → crm_import_rows fingerprint lookup)
  // but skip every .insert / .update / .delete and skip the H3
  // cascade flush. The branches must stay in lock-step with the
  // commit path — a divergence would mean the operator sees a preview
  // that doesn't match reality, worse than no preview at all.
  if (isDryRun) {
    let importRowsModule: typeof import('./import-rows') | null = null
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!
      const decision: PreviewDecision = {
        rowIndex,
        willInsert: 'new',
        reason: 'no identity match in Bloom',
        partner1: [row.partner1_first_name, row.partner1_last_name]
          .filter(Boolean).join(' ') || null,
        partner2: [row.partner2_first_name, row.partner2_last_name]
          .filter(Boolean).join(' ') || null,
        weddingDate: row.wedding_date ?? null,
        status: row.status ?? null,
        resolvedWeddingId: null,
      }

      // (1) Identity-resolver dry-run. resolveIdentity has a side-
      //     effect-free read path when called with the same signals
      //     the commit path uses — but to be safe we mirror the
      //     commit-path's gate (only call when email or phone is
      //     present) and we DO NOT pass `supabase` writes through.
      //     The resolver itself MAY mint persons on the commit path
      //     (Branch C below), so for dry-run we only call it to
      //     check for an EXISTING match — if no match, we fall
      //     through to 'new' without invoking the minting branch.
      let resolvedWeddingId: string | null = null
      if (row.partner1_email || row.partner1_phone) {
        try {
          // Read-only lookup: query weddings by email/phone directly
          // rather than calling resolveIdentity (which mints persons
          // as a side effect on the no-match path via its Branch C).
          // This is the at-write-time half of the identity-resolver
          // contract: the commit path ALWAYS hits resolveIdentity
          // first and only mints when it returns null. We replicate
          // the "did it match?" half without the "mint on miss" half.
          if (row.partner1_email) {
            const { data: byEmail } = await supabase
              .from('people')
              .select('wedding_id')
              .eq('venue_id', venueId)
              .eq('email', row.partner1_email)
              .not('wedding_id', 'is', null)
              .limit(1)
              .maybeSingle()
            if (byEmail?.wedding_id) {
              resolvedWeddingId = byEmail.wedding_id as string
            }
          }
          if (!resolvedWeddingId && row.partner1_phone) {
            const { data: byPhone } = await supabase
              .from('people')
              .select('wedding_id')
              .eq('venue_id', venueId)
              .eq('phone', row.partner1_phone)
              .not('wedding_id', 'is', null)
              .limit(1)
              .maybeSingle()
            if (byPhone?.wedding_id) {
              resolvedWeddingId = byPhone.wedding_id as string
            }
          }
        } catch (err) {
          decision.willInsert = 'failed'
          decision.reason = `identity lookup failed: ${err instanceof Error ? err.message : 'unknown'}`
          result.previewDecisions!.push(decision)
          continue
        }
      }

      if (resolvedWeddingId) {
        decision.willInsert = 'matched_existing_wedding'
        decision.reason = 'partner1 email/phone matches a wedding already in Bloom; commit would backfill fields onto the existing couple'
        decision.resolvedWeddingId = resolvedWeddingId
      }

      // (2) crm_import_rows fingerprint lookup per interaction —
      //     mirrors the commit-path's classifyImportRow call. We
      //     classifyImportRow has an INSERT side-effect on the 'new'
      //     branch (it stamps a placeholder row), which we MUST NOT
      //     execute in dry-run. Instead we replicate just the
      //     fingerprint+content-hash compute and read crm_import_rows
      //     directly. This is the only divergence point between
      //     preview and commit — the read shape is identical, but
      //     commit-path also writes the placeholder. The result of
      //     "would this insert?" is identical either way.
      const interactionDecisions: NonNullable<PreviewDecision['interactionDecisions']> = []
      let totalInteractionsWithId = 0
      let unchangedCount = 0
      let stateChangedCount = 0
      let newCount = 0
      if (row.interactions?.length) {
        if (!importRowsModule) {
          importRowsModule = await import('./import-rows')
        }
        for (const i of row.interactions) {
          if (!i.external_id) {
            interactionDecisions.push({
              occurredAt: i.occurred_at,
              type: i.type,
              externalId: null,
              state: 'no_external_id',
            })
            continue
          }
          totalInteractionsWithId += 1
          try {
            // Compute the fingerprint + content_hash the same way
            // classifyImportRow does and read crm_import_rows directly.
            // The two compute functions are exported from import-rows.
            const fingerprint = importRowsModule.computeRowFingerprint(
              crmSource as Parameters<typeof importRowsModule.computeRowFingerprint>[0],
              {
                externalId: i.external_id,
                email: row.partner1_email ?? null,
                phone: row.partner1_phone ?? null,
                fullName: [row.partner1_first_name, row.partner1_last_name]
                  .filter(Boolean).join(' ') || null,
                inquiryDate: row.inquiry_date ?? i.occurred_at,
                weddingDate: row.wedding_date ?? null,
              },
            )
            const contentHash = importRowsModule.computeContentHash({
              status: row.status ?? null,
              weddingDate: row.wedding_date ?? null,
              guestCount: row.guest_count_estimate ?? null,
              tourScheduledFor: i.type === 'meeting' ? i.occurred_at : null,
              canceled: (i.subject ?? '').includes('[cancelled')
                || (i.subject ?? '').includes('[rescheduled')
                || row.status === 'cancelled',
              extras: { subject: i.subject ?? null },
            })
            const { data: existing } = await supabase
              .from('crm_import_rows')
              .select('id, content_hash')
              .eq('venue_id', venueId)
              .eq('source', crmSource)
              .eq('row_fingerprint', fingerprint)
              .maybeSingle()
            if (!existing) {
              newCount += 1
              interactionDecisions.push({
                occurredAt: i.occurred_at,
                type: i.type,
                externalId: i.external_id,
                state: 'new',
              })
            } else if ((existing.content_hash as string | null) === contentHash) {
              unchangedCount += 1
              interactionDecisions.push({
                occurredAt: i.occurred_at,
                type: i.type,
                externalId: i.external_id,
                state: 'dedup_unchanged',
              })
            } else {
              stateChangedCount += 1
              interactionDecisions.push({
                occurredAt: i.occurred_at,
                type: i.type,
                externalId: i.external_id,
                state: 'dedup_state_changed',
              })
            }
          } catch (err) {
            // Failed dedup lookup should NOT mark the whole row as
            // failed — the commit path also gracefully falls through
            // to insert. We classify the interaction as 'new' (worst-
            // case, the operator will see the count slightly inflated
            // but never under-counted) and surface the error on the
            // row's reason.
            newCount += 1
            interactionDecisions.push({
              occurredAt: i.occurred_at,
              type: i.type,
              externalId: i.external_id,
              state: 'new',
            })
            decision.reason +=
              `; dedup lookup failed (${err instanceof Error ? err.message : 'unknown'}), assuming new`
          }
        }
        decision.interactionDecisions = interactionDecisions
      }

      // (3) Roll the per-interaction dedup picture up to a per-row
      //     verdict. The H3 dedup gate (PART C) also uses this rule.
      if (totalInteractionsWithId > 0 && newCount === 0 && stateChangedCount === 0) {
        // Every interaction with an external_id is unchanged —
        // commit would write nothing for this row. This is the
        // "we've seen this file before" verdict.
        decision.willInsert = 'dedup_skip'
        decision.reason = `all ${unchangedCount} interaction(s) on this row already imported with the same content; commit would write nothing`
      } else if (totalInteractionsWithId > 0 && unchangedCount > 0) {
        // Some unchanged, some new/state_changed. The existing
        // verdict (new / matched_existing_wedding) is correct for
        // the wedding-level decision; tag the row so the operator
        // sees the partial.
        if (decision.willInsert === 'new' || decision.willInsert === 'matched_existing_wedding') {
          decision.reason +=
            `; partial dedup — ${unchangedCount} of ${totalInteractionsWithId} interaction(s) already imported`
        } else {
          decision.willInsert = 'partial_dedup_skip'
          decision.reason = `${unchangedCount} of ${totalInteractionsWithId} interaction(s) already imported, rest are new/changed`
        }
      }

      result.previewDecisions!.push(decision)
    }
    // Dry-run flush is skipped — no pending signals to write, no
    // portal provisioning, no recordResolution side-effect. Return
    // the decisions verbatim. Counters stay at zero because we did
    // not perform any write.
    //
    // W20: the one thing the pre-flight DOES report is how many
    // non-couple people the parse found, so the coordinator sees the
    // parents and planners before they press Commit. Seen only; nothing
    // is created or linked in a dry run.
    const relatedSeen = rows.reduce(
      (n, r) => n + (r.related_contacts?.length ?? 0),
      0,
    )
    if (relatedSeen > 0) {
      result.relatedContacts = {
        seen: relatedSeen,
        created: 0,
        linked: 0,
        rolesRecorded: 0,
        skipped: [],
      }
    }
    return result
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
    // W35: the interactions on this row that actually reached the spine:
    // dedup said new or changed AND the processed marker was written. An
    // interaction whose marker could not be written produces no signal,
    // because we cannot tell a first import from a fifth.
    const signalEligibleInteractions: NormalisedInteractionRow[] = []
    // HoneyBook's synthetic provenance row, when the export carried one.
    let honeybookAttributionSignal:
      | import('@/lib/services/identity/sources/types').NormalizedSignal
      | null = null
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
        // Commercial detail (migration 175 + 351). Recorded so a
        // booked-couple import keeps every revenue field, not just the
        // contract total.
        amount_paid: row.amount_paid ?? null,
        deposit_amount: row.deposit_amount ?? null,
        tax_amount: row.tax_amount ?? null,
        gratuity_amount: row.gratuity_amount ?? null,
        refunded_amount: row.refunded_amount ?? null,
        package_name: row.package_name ?? null,
        // Full source row preserved (migration 355) — nothing the
        // venue exported is lost, even columns with no typed field.
        raw_import_row: row.raw_row ?? null,
        inquiry_date: inquiryDateForRow,
        booked_at: row.booked_at ?? null,
        lost_at: row.lost_at ?? null,
        lost_reason: row.lost_reason ?? null,
        notes: row.notes ?? null,
        // Migration 322: structured Calendly Q&A. Writing here instead
        // of free-text in notes keeps form-bleed values out of the
        // name-upgrade regex pipeline.
        calendly_qa: row.calendly_qa ?? null,
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

      // W35 spine pre-check (read-only). Before the legacy resolver gets a
      // say, ask the spine whether a couple already holds this row's email
      // or phone. If it does AND that couple carries a legacy wedding, the
      // row belongs on it, and importing past it would mint a second couple
      // for someone the cascade already knows. Deterministic anchors only,
      // no judge, and nothing is written. A couple with no legacy wedding
      // is left alone: promoting it from here would be a second spine
      // writer, and the candidate queue already owns that reconciliation.
      // See ./row-signals.ts for why the ordering is mint-first at all.
      if (row.partner1_email || row.partner1_phone) {
        const { findSpineCoupleWedding } = await import('./row-signals')
        resolvedWeddingId = await findSpineCoupleWedding({
          supabase,
          venueId,
          email: row.partner1_email ?? null,
          phone: row.partner1_phone ?? null,
        })
      }

      if (!resolvedWeddingId && (row.partner1_email || row.partner1_phone)) {
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
        // Attach to the existing wedding. Backfill the fields the
        // import row carries.
        weddingId = resolvedWeddingId
        const backfill: Record<string, unknown> = {}
        if (row.booking_value != null) backfill.booking_value = row.booking_value
        if (row.wedding_date) backfill.wedding_date = row.wedding_date
        if (row.booked_at) backfill.booked_at = row.booked_at
        if (row.inquiry_date) backfill.inquiry_date = row.inquiry_date
        if (row.guest_count_estimate != null) backfill.guest_count_estimate = row.guest_count_estimate
        // Commercial detail — backfill only when the existing wedding
        // is missing it, so a re-import never clobbers a richer record.
        if (row.amount_paid != null) backfill.amount_paid = row.amount_paid
        if (row.deposit_amount != null) backfill.deposit_amount = row.deposit_amount
        if (row.tax_amount != null) backfill.tax_amount = row.tax_amount
        if (row.gratuity_amount != null) backfill.gratuity_amount = row.gratuity_amount
        if (row.refunded_amount != null) backfill.refunded_amount = row.refunded_amount
        if (row.package_name) backfill.package_name = row.package_name

        // Read the existing wedding's status + notes + dates in one round trip.
        const { data: cur } = await supabase
          .from('weddings').select('status, notes, booked_at, inquiry_date').eq('id', weddingId).maybeSingle()
        const existingStatus = (cur?.status as string | null) ?? null
        // Fill-only for dates already on the wedding (don't clobber a richer record).
        if (cur?.booked_at) delete backfill.booked_at
        if (cur?.inquiry_date) delete backfill.inquiry_date

        // STATUS UPGRADE. The import row is the venue's own CRM truth.
        // When it carries a more-progressed status than the wedding
        // currently has (e.g. a booked HoneyBook row matched the
        // inquiry-wedding the email backfill created), upgrade it —
        // otherwise 100+ booked couples silently stay 'inquiry' and
        // never reach the Weddings tab. Upgrade-only: never downgrade
        // a further-along wedding.
        const STATUS_RANK: Record<string, number> = {
          lost: -1, cancelled: -1,
          inquiry: 0, tour_scheduled: 1, tour_completed: 2,
          proposal_sent: 3, booked: 4, completed: 5,
        }
        let statusUpgraded = false
        if (row.status) {
          const importRank = STATUS_RANK[row.status] ?? 0
          const currentRank = existingStatus != null ? (STATUS_RANK[existingStatus] ?? 0) : -99
          if (importRank > currentRank) {
            backfill.status = row.status
            statusUpgraded = true
          }
        }

        // Fold the import row's notes into existing notes (don't overwrite).
        if (row.notes && row.notes.trim()) {
          const existing = (cur?.notes as string | null) ?? null
          backfill.notes = existing ? `${existing}\n\n[crm_import:${crmSource}]\n${row.notes}` : row.notes
        }
        if (Object.keys(backfill).length > 0) {
          const { error: backfillErr } = await supabase.from('weddings').update(backfill).eq('id', weddingId)
          if (backfillErr) {
            console.error('[crm-import] backfill UPDATE failed', { weddingId, keys: Object.keys(backfill), error: backfillErr.message })
            result.errors.push(`backfill_update_failed:${weddingId}:${backfillErr.message}`)
          }
        }
        // A status upgrade to a booked/completed state should reflect
        // on the couples graph too — re-mirror so /intel/couples and
        // the Weddings tab agree. Idempotent upsert.
        if (statusUpgraded && (row.status === 'booked' || row.status === 'completed')) {
          try {
            const { mirrorCoupleFromWedding } = await import(
              '@/lib/services/identity/mirror-couple'
            )
            await mirrorCoupleFromWedding({ venueId, weddingId, supabase })
          } catch { /* mirror is best-effort */ }
        }
        insertedWeddingId = weddingId
        // weddingsInserted counts NEW rows only; this attached to an
        // existing wedding. Track it separately so the import doesn't
        // report "0 imported" when it correctly de-duped 113 rows.
        result.weddingsMatchedExisting = (result.weddingsMatchedExisting ?? 0) + 1
        if (statusUpgraded) {
          result.weddingsStatusUpgraded = (result.weddingsStatusUpgraded ?? 0) + 1
        }
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
            // adapter-source-justified: factual provenance label for mintWedding telemetry/source_provenance (where the row came from), not an attribution decision on weddings.source.
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
        const { error: crmFieldsErr } = await supabase.from('weddings').update(crmFields).eq('id', weddingId)
        if (crmFieldsErr) {
          console.error('[crm-import] crmFields UPDATE failed', { weddingId, error: crmFieldsErr.message })
          result.errors.push(`crmfields_update_failed:${weddingId}:${crmFieldsErr.message}`)
        }
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
      // Track whether the mintPerson call genuinely CREATED a fresh row
      // (matchedBy='created_new') vs resolved to an existing one via the
      // alias_emails branch / pool / etc. The post-mint contracts-table-
      // mirror flow (further down) does NOT exist here today, but the
      // resolved-existing case must NOT re-run name-capture against a
      // canonical person — same shape as the Batch-1 M2 `mintIsNew` gate
      // (commit 8d95181) for the email-pipeline `findOrCreateContact`.
      let p1MintIsNew = false
      if (
        !resolvedPartner1Id &&
        (row.partner1_first_name || row.partner1_last_name || row.partner1_email)
      ) {
        // H1 flip (PHASE-1-BATCH-2.md §3 phase A H1, 2026-05-26): route
        // the partner1 mint through the `mintPerson` chokepoint instead
        // of a raw `people.insert`. Only the CREATE is rerouted — the
        // upstream `resolveIdentity` call at :609 already attempted the
        // canonical-resolver match step and missed (otherwise
        // `resolvedPartner1Id` would be set and this whole branch
        // skipped). mintPerson re-runs its own identifier match chain
        // (email_exact → email_canonical → phone) — on the same null
        // result the chain also misses, so it falls through to
        // `createPerson` and the create outcome is unchanged. The
        // chokepoint additionally: (a) routes the name through the
        // name-capture shape-classifier (no `Rosaliehoyle` junk-name),
        // (b) fires the venue self-loop guard (same class as the email
        // pipeline), (c) records `source:'crm_import'` provenance.
        //
        // Pattern mirrors Batch-1 M2 (commit 8d95181):
        //   - Map mintResult.isNew → p1MintIsNew (a fresh row, not an
        //     alias/pool hit) so post-mint operations don't mis-fire.
        //   - On personId:null log + degrade (mintPerson never throws
        //     by contract; null means self-loop blocked or resolver
        //     INSERT failed — neither should fire here since the
        //     resolver miss above already screened email+phone, but
        //     defend in depth).
        const partner1FullName = [row.partner1_first_name, row.partner1_last_name]
          .filter(Boolean).join(' ') || null
        const { mintPerson } = await import('@/lib/services/identity/mint-person')
        const p1Mint = await mintPerson({
          venueId,
          weddingId,
          role: 'partner1',
          signals: {
            email: row.partner1_email ?? null,
            phone: row.partner1_phone ?? null,
            fullName: partner1FullName,
            weddingDate: row.wedding_date ?? null,
            partner1Name: partner1FullName,
            partner2Name: [row.partner2_first_name, row.partner2_last_name]
              .filter(Boolean).join(' ') || null,
          },
          // adapter-source-justified: factual provenance label for mintPerson (where the person clue came from), not a weddings.source attribution write.
          source: 'crm_import',
          reason: `crm_import:${crmSource}:partner1`,
          supabase,
        })
        if (!p1Mint.personId) {
          // Self-loop blocked, or resolver_error. The pre-flip path
          // would have logged the failure and continued; preserve that
          // contract. The wedding row already exists; the partner1
          // people-mirror gap is auditable via the warn line + the
          // mintPerson telemetry surface.
          console.warn(
            `[crm-import] mintPerson (partner1) returned null ` +
              `(matchedBy=${p1Mint.matchedBy}, wedding=${weddingId}, ` +
              `crm_source=${crmSource}). Continuing without partner1 row.`,
          )
        } else {
          p1InsertedId = p1Mint.personId
          p1MintIsNew = p1Mint.matchedBy === 'created_new'
          // Capture the partner1 name signal through the chokepoint.
          // Pre-split first/last is the cleanest signal; the chokepoint
          // records evidence + recomputes the picker output. Even when
          // the row already had a real first/last, we still capture so
          // the evidence array reflects the import as a source.
          //
          // Guard on p1MintIsNew: when mintPerson resolved to an EXISTING
          // person via its identifier chain (alias_emails branch,
          // pool fallback), running captureNameEvidence with raw CSV
          // first/last would pollute a canonical record with this
          // import's (possibly stale) name evidence. Pre-flip the create
          // always inserted, so name-capture always ran against a
          // brand-new row — preserve that contract by gating on
          // genuinely-fresh creates.
          if (p1MintIsNew) {
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
                    // adapter-source-justified: captureNameEvidence provenance (which clue derived the name), not a weddings.source attribution write.
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
        // H2 flip (PHASE-1-BATCH-2.md §3 phase A H2, 2026-05-26): route
        // the partner2 mint through the `mintPerson` chokepoint — the
        // **Liam Hunt class** fix. The pre-flip `ilike('first_name', ...)`
        // dedup only catches duplicate first-names that match
        // case-insensitively; it misses last-name-only signals, spelling
        // variants ("Cat" vs "Catherine"), and the cross-channel case
        // where partner2's email/phone landed earlier via Calendly /
        // Knot relay etc. mintPerson's partner2 invariant
        // (enrichExistingPartner2 + the migration-367 unique index on
        // `(venue_id, wedding_id, role) WHERE merged_into_id IS NULL
        // AND role IN ('partner1','partner2')`) closes that class
        // permanently. Pattern mirrors Batch-1 M4/M5 (commit c39cd17).
        //
        // The existing `alreadyExists` ilike check is KEPT as a belt
        // on mintPerson's suspenders — when it fires TRUE, we skip the
        // mint entirely, which preserves the pre-flip "obvious case
        // 1-line skip" telemetry shape. When it fires FALSE,
        // mintPerson's enrich-or-skip takes over and the C1 + dup-
        // partner2 cases are covered.
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
          // partner2 name passed in `signals.fullName` — mintPerson's
          // enrich path (`enrichExistingPartner2`) and create path
          // (`createPartner2Person` / `createPerson`) both read the
          // incoming name from there.
          const partner2FullName = [row.partner2_first_name, row.partner2_last_name]
            .filter(Boolean).join(' ') || null
          let p2Id: string | null = null
          let p2MintIsNew = false
          try {
            const { mintPerson } = await import('@/lib/services/identity/mint-person')
            const p2Mint = await mintPerson({
              venueId,
              weddingId,
              role: 'partner2',
              signals: {
                email: row.partner2_email ?? null,
                phone: row.partner2_phone ?? null,
                fullName: partner2FullName,
                weddingDate: row.wedding_date ?? null,
                partner1Name: [row.partner1_first_name, row.partner1_last_name]
                  .filter(Boolean).join(' ') || null,
                partner2Name: partner2FullName,
              },
              // adapter-source-justified: factual provenance label for mintPerson (where the person clue came from), not a weddings.source attribution write.
              source: 'crm_import',
              reason: `crm_import:${crmSource}:partner2`,
              supabase,
            })
            p2Id = p2Mint.personId
            // 'created_new' OR collision-guard fresh-mint count as
            // genuinely-new for the name-capture gate; 'partner2_enriched'
            // and 'resolver_error' / 'self_loop_blocked' do not.
            p2MintIsNew =
              p2Mint.matchedBy === 'created_new'
              || p2Mint.matchedBy === 'partner2_same_wedding_collision'
              || p2Mint.matchedBy === 'partner2_cross_wedding_collision'
          } catch (err) {
            // mintPerson never throws by contract; belt for an
            // unexpected import/runtime failure.
            console.warn(
              '[crm-import] mintPerson (partner2) threw unexpectedly:',
              err instanceof Error ? err.message : err,
            )
          }
          // personId:null — resolver error, self-loop blocked, or
          // (post-migration-367) a concurrent-race unique-violation
          // round-tripped to the C1 collision branch's createPartner2
          // → enrich re-check → null. Either way the correct recovery
          // is the same as Batch-1 M4/M5: re-query the live partner2
          // row on this wedding and use it. Better than failing-hard.
          if (!p2Id) {
            try {
              const { data: existingP2 } = await supabase
                .from('people')
                .select('id')
                .eq('venue_id', venueId)
                .eq('wedding_id', weddingId)
                .eq('role', 'partner2')
                .is('merged_into_id', null)
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle()
              if (existingP2?.id) p2Id = existingP2.id as string
            } catch (err) {
              console.warn(
                '[crm-import] partner2 re-query after null mint failed:',
                err instanceof Error ? err.message : err,
              )
            }
          }
          if (p2Id) {
            // Name-capture gate: only on a genuinely-fresh mint. The
            // re-queried-after-null path is conservative — that row
            // already exists and probably already has name evidence;
            // re-running capture against it would be the same
            // pollution risk as H1's `p1MintIsNew` gate.
            if (p2MintIsNew) {
              try {
                await captureNameEvidence(supabase, p2Id, {
                  first: row.partner2_first_name ?? null,
                  last: row.partner2_last_name ?? null,
                  email: row.partner2_email ?? null,
                  source: chokepointSource,
                })
                if (row.partner2_email) {
                  const fromEmail = inferNameFromEmail(row.partner2_email)
                  if (fromEmail) {
                    await captureNameEvidence(supabase, p2Id, {
                      first: fromEmail.first,
                      last: fromEmail.last,
                      email: row.partner2_email,
                      // adapter-source-justified: captureNameEvidence provenance (which clue derived the name), not a weddings.source attribution write.
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
      }

      // interactions
      if (row.interactions?.length) {
        // 2026-05-13 recurring-CSV dedup wire-in. Migration 335 +
        // memory/bloom-recurring-csv-import-doctrine.md. For any
        // interaction with external_id (Calendly event_uuid, HoneyBook
        // event id, Knot inquiry id), check crm_import_rows BEFORE
        // inserting:
        //   - state='unchanged' → skip the insert (row was already
        //     written by a prior upload of the same CSV)
        //   - 'new' / 'state_changed' → include in batch + remember
        //     importRowId so recordResolution can fire after commit
        // Adapters without per-row identity (legacy generic_csv,
        // web_form one-shots) leave external_id null and bypass the
        // dedup branch — same as before.
        const decisions: Array<{
          interaction: NormalisedInteractionRow
          importRowId: string | null
          willInsert: boolean
          /** W35: false when the row carried an external_id but the
           *  processed marker could not be classified. Such an interaction
           *  still takes the legacy insert (pre-existing behaviour) but
           *  produces NO cascade signal. See the swallowed-dedup rule. */
          markerOk: boolean
        }> = []
        // Lazy import — only loads when an adapter actually populates
        // external_id. Most legacy adapter calls bypass entirely.
        let importRowsModule: typeof import('./import-rows') | null = null
        for (const i of row.interactions) {
          if (!i.external_id) {
            decisions.push({
              interaction: i, importRowId: null, willInsert: true, markerOk: true,
            })
            continue
          }
          if (!importRowsModule) {
            importRowsModule = await import('./import-rows')
          }
          try {
            const classified = await importRowsModule.classifyImportRow({
              supabase,
              venueId,
              source: crmSource as Parameters<typeof importRowsModule.classifyImportRow>[0]['source'],
              identity: {
                externalId: i.external_id,
                email: row.partner1_email ?? null,
                phone: row.partner1_phone ?? null,
                fullName: [row.partner1_first_name, row.partner1_last_name]
                  .filter(Boolean).join(' ') || null,
                inquiryDate: row.inquiry_date ?? i.occurred_at,
                weddingDate: row.wedding_date ?? null,
              },
              state: {
                status: row.status ?? null,
                weddingDate: row.wedding_date ?? null,
                guestCount: row.guest_count_estimate ?? null,
                tourScheduledFor: i.type === 'meeting' ? i.occurred_at : null,
                canceled: (i.subject ?? '').includes('[cancelled')
                  || (i.subject ?? '').includes('[rescheduled')
                  || row.status === 'cancelled',
                extras: { subject: i.subject ?? null },
              },
              rowData: {
                external_id: i.external_id,
                subject: i.subject,
                occurred_at: i.occurred_at,
                type: i.type,
                status: row.status,
              },
            })
            decisions.push({
              interaction: i,
              importRowId: classified.importRowId,
              willInsert: classified.state !== 'unchanged',
              markerOk: true,
            })
          } catch (err) {
            // Dedup failure must not block the import — fall through
            // to insert as before. Log + continue.
            //
            // W35: the legacy insert keeps its pre-existing fall-through,
            // but the cascade signal does not. Without a marker we cannot
            // tell a first import from a fifth, and the doctrine there is
            // skip rather than re-import. The touchpoint's own
            // UNIQUE(venue_id, channel, external_id) would catch a repeat
            // anyway; this just declines to lean on it.
            console.warn(
              `[crm-import] classifyImportRow failed (continuing without dedup): `,
              err instanceof Error ? err.message : err,
            )
            decisions.push({
              interaction: i, importRowId: null, willInsert: true, markerOk: false,
            })
          }
        }
        // Build payload from interactions we decided to insert.
        // T5-Rixey-RR fix #1: CRM exports often round-trip user-pasted
        // rich text — strip HTML at the writer so structured readers
        // (lead_source derivation regex, AI grounding) never see tags.
        // T5-Rixey-TT: also passes extracted_identity (factual attribution
        // metadata from CSVs e.g. HoneyBook's "Lead Source" column,
        // Calendly's Q7 answer) so lead-source-derivation Priority-2
        // can read it without adapters touching weddings.source.
        const insertDecisions = decisions.filter((d) => d.willInsert)
        const skippedCount = decisions.length - insertDecisions.length
        const interactionPayloads = insertDecisions.map(({ interaction: i }) => {
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
        const { error: intErr } = interactionPayloads.length === 0
          ? { error: null }
          : await supabase.from('interactions').insert(interactionPayloads)
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
          // Track skipped (dedup-unchanged) count separately for
          // operator-visible telemetry. Per-batch, not lifetime.
          if (skippedCount > 0) {
            result.interactionsSkippedDedup =
              (result.interactionsSkippedDedup ?? 0) + skippedCount
          }
          // After successful insert: stamp the crm_import_rows
          // resolution for every interaction we classified. 'unchanged'
          // rows already have a resolution from prior commit;
          // 'new'/'state_changed' rows landed here with resolution
          // 'flagged' (placeholder) and need recordResolution to make
          // them queryable as attached_strong.
          if (importRowsModule) {
            for (const d of decisions) {
              if (!d.importRowId || !d.willInsert) continue
              try {
                await importRowsModule.recordResolution({
                  supabase,
                  importRowId: d.importRowId,
                  resolution: 'attached_strong',
                  resolvedWeddingId: weddingId,
                  reason: `crm_import: attached on ${crmSource} commit`,
                })
              } catch (err) {
                console.warn(
                  `[crm-import] recordResolution failed: `,
                  err instanceof Error ? err.message : err,
                )
              }
            }
          }

          // W35: turn this row's committed interactions into cascade
          // signals. The interactions that reach the spine are exactly the
          // ones that both passed the dedup gate AND got a processed
          // marker; the rest are held back on purpose (see `markerOk`).
          // The push happens after the tours block, so a row that rolls
          // back never reaches the flush.
          for (const d of decisions) {
            if (!d.willInsert || !d.markerOk) continue
            signalEligibleInteractions.push(d.interaction)
          }

          // HoneyBook's synthetic-provenance signal, the one thing that
          // export carries which no generic row builder can derive: the
          // "how did you hear about us" answer. `honeybookCsvToNormalizedSignal`
          // in attribution mode promotes it to action_type 'crm_attribution'
          // and surfaces the value in raw_payload, which is what makes
          // "did Knot drive that booking?" answerable from the cohort funnel.
          //
          // Skipped when every interaction on the row was dedup-skipped: the
          // first upload already pushed this signal, and the touchpoint's
          // UNIQUE key would only turn the repeat into a no-op we paid for.
          const allInteractionsDedupSkipped =
            decisions.length > 0
            && insertDecisions.length === 0
            && skippedCount === decisions.length
          if (isHoneybookImport && !allInteractionsDedupSkipped) {
            try {
              const provenanceDecision = decisions.find((d) => {
                const ext = (d.interaction.extracted_identity ?? null) as
                  | { hear_source?: unknown; hear_source_raw?: unknown }
                  | null
                return (
                  d.willInsert
                  && d.markerOk
                  && ext
                  && (typeof ext.hear_source === 'string'
                    || typeof ext.hear_source_raw === 'string')
                )
              }) ?? null
              if (provenanceDecision) {
                const { honeybookCsvToNormalizedSignal } = await import(
                  '@/lib/services/identity/honeybook-csv-to-signal'
                )
                const ext = provenanceDecision.interaction.extracted_identity as
                  | { hear_source?: unknown; hear_source_raw?: unknown }
                  | null
                honeybookAttributionSignal = honeybookCsvToNormalizedSignal({
                  row: {
                    source_id: row.source_id ?? null,
                    partner1_first_name: row.partner1_first_name ?? null,
                    partner1_last_name: row.partner1_last_name ?? null,
                    partner1_email: row.partner1_email ?? null,
                    partner1_phone: row.partner1_phone ?? null,
                    partner2_first_name: row.partner2_first_name ?? null,
                    partner2_last_name: row.partner2_last_name ?? null,
                    partner2_email: row.partner2_email ?? null,
                    partner2_phone: row.partner2_phone ?? null,
                    wedding_date: row.wedding_date ?? null,
                    status: row.status ?? null,
                    inquiry_date: row.inquiry_date ?? null,
                    booked_at: row.booked_at ?? null,
                    lost_at: row.lost_at ?? null,
                    source: row.source ?? null,
                    raw_row: row.raw_row ?? null,
                    extracted_identity: {
                      hear_source:
                        typeof ext?.hear_source === 'string' ? ext.hear_source : null,
                      hear_source_raw:
                        typeof ext?.hear_source_raw === 'string'
                          ? ext.hear_source_raw : null,
                    },
                  },
                  weddingId,
                  importRowId: provenanceDecision.importRowId,
                  mode: 'attribution',
                })
              }
            } catch (err) {
              // Signal-build failure is non-fatal. The legacy insert above
              // committed, and the row still gets its own anchor signal.
              // Surface via warn so the gap is auditable.
              console.warn(
                `[crm-import] honeybook attribution signal build failed `
                  + `(wedding=${weddingId}):`,
                err instanceof Error ? err.message : err,
              )
            }
          }
        }
      }
      if (rowAborted) continue

      // tours
      if (row.tours?.length) {
        // Re-import dedup. Unlike interactions (deduped via
        // crm_import_rows on external_id), the tours table has no
        // external_id column — so a coordinator who re-runs the same
        // Calendly export, or whose first import timed out mid-write,
        // would otherwise get duplicate tour rows on every couple.
        // Natural key: a tour at the same wedding at the same exact
        // scheduled_at IS the same tour. Skip those already present.
        let existingTourTimes = new Set<number>()
        {
          const { data: existingTours } = await supabase
            .from('tours')
            .select('scheduled_at')
            .eq('wedding_id', weddingId)
          existingTourTimes = new Set(
            (existingTours ?? [])
              .map((t) => {
                const ts = (t as { scheduled_at: string | null }).scheduled_at
                return ts ? new Date(ts).getTime() : NaN
              })
              .filter((n) => !Number.isNaN(n)),
          )
        }
        const freshTours = row.tours.filter((t) => {
          if (!t.scheduled_at) return true
          const ms = new Date(t.scheduled_at).getTime()
          if (Number.isNaN(ms)) return true
          if (existingTourTimes.has(ms)) return false
          // Guard against two rows in THIS batch sharing a timestamp.
          existingTourTimes.add(ms)
          return true
        })
        const toursSkipped = row.tours.length - freshTours.length
        if (toursSkipped > 0) {
          result.toursSkippedDedup = (result.toursSkippedDedup ?? 0) + toursSkipped
        }
        const tourPayloads = freshTours.map((t) => ({
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
        const { error: tourErr } = tourPayloads.length === 0
          ? { error: null }
          : await supabase.from('tours').insert(tourPayloads)
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

      // W20: queue the non-couple people on this row (parents, planners,
      // whoever else the CRM had on the project). They are written after
      // the row loop, through linkSignal's Agent branch.
      for (const contact of row.related_contacts ?? []) {
        pendingRelatedContacts.push({
          contact,
          weddingId,
          rowSourceId: row.source_id ?? null,
          weddingDate: row.wedding_date ?? null,
        })
      }

      // W35: queue this row's cascade signals. Same reasoning as the
      // related contacts above. Sent after the loop so a row that rolls
      // back links nothing, and so the couple mirror that `mintWedding`
      // fired without awaiting has had the rest of the loop to land.
      //
      // Every row gets an anchor signal, even one with no interactions:
      // the row itself IS an observation, and it carries the handles and
      // the earliest date that move `couples.handles` and `first_seen_at`.
      // `firstSeenCandidateFor` therefore runs on every row now, not only
      // on rows that happened to have a handle column.
      {
        const { buildRowSignals } = await import('./row-signals')
        const signals = buildRowSignals({
          row,
          crmSource,
          weddingId,
          interactions: signalEligibleInteractions,
          handles: handlesFromRow(row),
          rowOccurredAt: firstSeenCandidateFor(row),
          extraSignals: honeybookAttributionSignal
            ? [honeybookAttributionSignal]
            : [],
        })
        if (signals.length > 0) {
          pendingRowSignals.push({
            weddingId,
            rowSourceId: row.source_id ?? null,
            signals,
          })
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

  // W35 flush: the row signals, through the one writer.
  //
  // Runs before the related-contacts flush on purpose. Both resolve their
  // couple through `couples.source_wedding_id`, and this one waits for the
  // mirror when `mintWedding`'s fire-and-forget copy has not landed yet.
  // Doing it first means an Agent link never arrives at a couple that does
  // not exist.
  //
  // Filtered against the surviving weddings, so a row that rolled back
  // mid-import links nothing. Never throws: the legacy rows are already
  // committed, and a cascade failure must not fail an import that
  // otherwise worked. Failures are counted and named, never swallowed.
  if (pendingRowSignals.length > 0) {
    try {
      const { commitRowSignals } = await import('./row-signals')
      const signalSummary = await commitRowSignals({
        supabase,
        venueId,
        crmSource,
        pending: pendingRowSignals,
        survivingWeddings: new Set(result.touchedWeddingIds ?? []),
      })
      // The handle counts the import summary reports now come off the link
      // results rather than a second pass over the couples table.
      result.handlesRecorded = signalSummary.handlesRecorded
      result.handleConflicts = signalSummary.handleConflicts
      for (const skip of signalSummary.skipped) {
        result.errors.push(`row_signal_skipped:${skip.row}:${skip.reason}`)
      }
      console.log(
        `[crm-import] row signals: rows=${pendingRowSignals.length} `
        + `sent=${signalSummary.sent} attached=${signalSummary.attached} `
        + `duplicate=${signalSummary.duplicate} minted=${signalSummary.minted} `
        + `handles=${signalSummary.handlesRecorded} `
        + `handle_conflicts=${signalSummary.handleConflicts} `
        + `skipped=${signalSummary.skipped.length}`,
      )
    } catch (err) {
      result.errors.push(
        `row signal flush failed (rows=${pendingRowSignals.length}): `
        + (err instanceof Error ? err.message : 'unknown'),
      )
    }
  }

  // W20 flush: the non-couple people on the imported rows (parents,
  // planners, whoever else the CRM had on the project). Written after the
  // row loop so a row that rolled back does not leave an agent pointing
  // at a wedding that no longer exists. See ./related-contacts.ts for
  // the doctrine and the dedup contract.
  if (pendingRelatedContacts.length > 0) {
    const { commitRelatedContacts } = await import('./related-contacts')
    const summary = await commitRelatedContacts({
      supabase,
      venueId,
      crmSource,
      pending: pendingRelatedContacts,
      survivingWeddings: new Set(result.touchedWeddingIds ?? []),
    })
    result.relatedContacts = summary
    console.log(
      `[crm-import] related contacts: seen=${summary.seen} `
      + `created=${summary.created} linked=${summary.linked} `
      + `roles=${summary.rolesRecorded} skipped=${summary.skipped.length}`,
    )
  }

  // Batch-provision the couple portal for every BOOKED wedding this
  // import touched. Onboarding a CRM export of booked couples should
  // land them in the Weddings tab with their portal ready on the
  // coordinator's side from day one — event_code + wedding_details
  // shell. provisionCouplePortal is idempotent and never throws, and
  // does NOT email: invitations stay coordinator-click-only.
  const touchedIds = result.touchedWeddingIds ?? []
  if (touchedIds.length > 0) {
    try {
      const { data: bookedRows } = await supabase
        .from('weddings')
        .select('id')
        .in('id', touchedIds)
        .eq('status', 'booked')
      const booked = (bookedRows ?? []) as Array<{ id: string }>
      if (booked.length > 0) {
        const { provisionCouplePortal } = await import(
          '@/lib/services/portal/provision'
        )
        for (const w of booked) {
          await provisionCouplePortal(supabase, w.id)
        }
      }
    } catch (provErr) {
      result.errors.push(
        `portal provisioning: ${provErr instanceof Error ? provErr.message : String(provErr)}`,
      )
    }
  }

  return result
}
