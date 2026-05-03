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

/** Stable identifier for the per-row crm_source column. */
export type CrmSource = 'honeybook' | 'dubsado' | 'aisle_planner' | 'generic_csv'

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
  partner2_email?: string | null
  partner2_phone?: string | null
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

  /** T5-Rixey-GG / migration 175 — extra financial detail. All in cents. */
  tax_amount?: number | null
  amount_paid?: number | null
  gratuity_amount?: number | null
  refunded_amount?: number | null
  /** T5-Rixey-GG / migration 175 — provider's primary key, for dedup. */
  crm_external_id?: string | null
  /** T5-Rixey-GG / migration 175 — provider-side team assignments. */
  crm_team_members?: Array<{ name: string | null; email: string | null; role: string | null }> | null
  /** T5-Rixey-GG / migration 175 — per-row import warnings. */
  import_warnings?: Array<{ field: string; issue: string; value: unknown }> | null

  /** Linked sub-records (each becomes one row in its respective table). */
  interactions?: NormalisedInteractionRow[]
  tours?: NormalisedTourRow[]
  lost_deal?: NormalisedLostDealRow | null

  /** Other people surfaced by the CRM (parents, planners, vendors). Each
   *  becomes a `people` row with role != partner1/partner2. */
  others?: NormalisedPersonRow[]
}

/** Additional people on a wedding row beyond partner1 / partner2. */
export interface NormalisedPersonRow {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  role: string                             // 'parent_mother' / 'planner' / etc.
}

export interface NormalisedInteractionRow {
  occurred_at: string                      // ISO timestamp
  direction: 'inbound' | 'outbound'
  type: 'email' | 'call' | 'voicemail' | 'sms'
  subject?: string | null
  body?: string | null
}

export interface NormalisedTourRow {
  scheduled_at: string                     // ISO timestamp
  tour_type?: 'in_person' | 'virtual' | 'phone' | null
  outcome?: 'completed' | 'cancelled' | 'no_show' | 'rescheduled' | null
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
}

/**
 * Pre-commit validation question. The adapter's `validate()` method
 * surfaces these to the coordinator BEFORE commit so they can supply
 * defaults for ambiguous decisions (e.g. "12% of projects have no
 * booking date — should they be Lost or Inquiry?"). Per T5-Rixey-GG /
 * Stream GG.
 */
export interface ValidationQuestion {
  /** Stable id the UI uses to keep the answer with the question. */
  id: string
  /** Coordinator-facing question text. */
  question: string
  /** Possible answers — each becomes a button in the UI. */
  choices: Array<{
    /** Stable id sent back to the adapter on commit. */
    id: string
    /** Coordinator-facing label. */
    label: string
    /** Whether this is the recommended default. */
    recommended?: boolean
  }>
  /** Number of rows this question affects. Drives prominence in UI. */
  affectedRowCount: number
  /** First few example row identifiers (couple name / source_id) for
   *  coordinator preview. */
  exampleRows?: string[]
}

export interface ValidationResult {
  questions: ValidationQuestion[]
  /** Pure-info notes that don't require an answer (e.g. "94 rows have
   *  Lead Source = Unknown — Bloom will backfill from Calendly data"). */
  notes: string[]
  /** Rows that will be skipped at commit time and why. */
  skipped: Array<{ rowIndex: number; reason: string; identifier?: string | null }>
}

/** Coordinator answers keyed by ValidationQuestion.id → choice.id. */
export type ValidationAnswers = Record<string, string>

export interface CrmAdapter {
  /** Stable identifier matching the crm_source enum. */
  name: CrmSource
  /** Human-readable label rendered in the UI provider-picker. */
  label: string
  /** Description shown next to the picker entry. */
  description: string
  /** Whether the adapter is fully implemented. The UI greys out
   *  scaffold-only adapters and shows a "coming soon" tooltip. */
  ready: boolean
  parse(config: AdapterConfig): Promise<ParseResult>
  preview(rows: NormalisedLeadRow[]): PreviewResult
  /**
   * Optional pre-commit validation pass — the adapter can surface
   * questions to the coordinator before commit (per T5-Rixey-GG).
   * Adapters without ambiguity (generic_csv) can omit this.
   */
  validate?(rows: NormalisedLeadRow[]): ValidationResult
  /**
   * Optional answer-applier — given coordinator answers from
   * validate(), the adapter mutates / re-shapes rows before commit.
   * Adapters without validate() can omit this.
   */
  applyAnswers?(rows: NormalisedLeadRow[], answers: ValidationAnswers): NormalisedLeadRow[]
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

export const ADAPTERS: ReadonlyArray<CrmAdapter> = [
  genericCsvAdapter,
  honeybookAdapter,
  dubsadoAdapter,
  aislePlannerAdapter,
]

export function findAdapter(name: string): CrmAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null
}

/**
 * Map our richer parsed role strings (parent_mother / planner /
 * coordinator / vendor / wedding_party / officiant / witness / other)
 * into the people.role CHECK enum (partner1 / partner2 / guest /
 * wedding_party / vendor / family). Per T5-Rixey-GG / Stream GG.
 */
function mapParsedRoleToPeopleRole(parsedRole: string): string {
  switch (parsedRole) {
    case 'parent_mother':
    case 'parent_father':
      return 'family'
    case 'planner':
    case 'coordinator':
    case 'vendor':
    case 'officiant':
      return 'vendor'
    case 'wedding_party':
    case 'witness':
      return 'wedding_party'
    case 'partner':
      // Fallback when more than 2 partners parsed (unusual). Treat as guest.
      return 'guest'
    default:
      return 'guest'
  }
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
}): Promise<CommitResult> {
  const { supabase, venueId, rows, crmSource } = args
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
        // T5-Rixey-GG: source can be NULL for "Unknown" CRM exports —
        // the source channel is later backfilled from Calendly /
        // web-inquiry data. Don't force 'other' or downstream attribution
        // gets a misleading explicit channel for every imported row.
        source: row.source ?? null,
        source_detail: row.source_detail ?? null,
        wedding_date: row.wedding_date ?? null,
        guest_count_estimate: row.guest_count_estimate ?? null,
        booking_value: row.booking_value ?? null,
        inquiry_date: row.inquiry_date ?? new Date().toISOString(),
        booked_at: row.booked_at ?? null,
        lost_at: row.lost_at ?? null,
        lost_reason: row.lost_reason ?? null,
        notes: row.notes ?? null,
        // T5-Rixey-GG / migration 175 — extra financial detail.
        tax_amount: row.tax_amount ?? null,
        amount_paid: row.amount_paid ?? null,
        gratuity_amount: row.gratuity_amount ?? null,
        refunded_amount: row.refunded_amount ?? null,
        crm_external_id: row.crm_external_id ?? null,
        crm_team_members: row.crm_team_members ?? null,
        import_warnings: row.import_warnings ?? null,
        confidence_flag: 'imported_medium',
        crm_source: crmSource,
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
          confidence_flag: 'imported_medium',
          crm_source: crmSource,
        })
      }
      if (row.partner2_first_name || row.partner2_last_name || row.partner2_email) {
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          role: 'partner2',
          first_name: row.partner2_first_name ?? null,
          last_name: row.partner2_last_name ?? null,
          email: row.partner2_email ?? null,
          phone: row.partner2_phone ?? null,
          confidence_flag: 'imported_medium',
          crm_source: crmSource,
        })
      }

      // T5-Rixey-GG: extra people on the wedding (parents, planners,
      // vendors). The people.role CHECK currently allows
      // ('partner1', 'partner2', 'guest', 'wedding_party', 'vendor',
      // 'family'). We map our richer parsed roles into those allowed
      // values so the insert doesn't violate the constraint.
      if (row.others?.length) {
        for (const other of row.others) {
          const dbRole = mapParsedRoleToPeopleRole(other.role)
          await supabase.from('people').insert({
            venue_id: venueId,
            wedding_id: weddingId,
            role: dbRole,
            first_name: other.first_name ?? null,
            last_name: other.last_name ?? null,
            email: other.email ?? null,
            phone: other.phone ?? null,
            confidence_flag: 'imported_medium',
            crm_source: crmSource,
          })
        }
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
          confidence_flag: 'imported_medium',
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
