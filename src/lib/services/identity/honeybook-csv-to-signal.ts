/**
 * Phase 1 Batch 2 — Pbatch2-1: HoneyBook CSV → NormalizedSignal adapter.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-1 + §3 phase A H1/H2/H3.
 *
 * One signal per CSV row. The adapter consumes a `NormalisedLeadRow`
 * (the canonical Bloom shape that crm-import/honeybook.ts already
 * emits at index.ts:131-208) and yields the cascade signal that H3
 * will pass to `linkSignalBatch`.
 *
 * Channel taxonomy
 * ----------------
 * channel = 'honeybook' — verified canonical (used by
 * `identity/sources/anchors.ts:102`). The free-text channel column on
 * touchpoints (mig 346:191) lists honeybook explicitly.
 *
 * action_type mapping (status → action_type)
 * ------------------------------------------
 *   inquiry / tour_scheduled / tour_completed / proposal_sent
 *     → 'crm_imported_inquiry'
 *   booked / completed
 *     → 'crm_imported_booked'
 *   lost / cancelled
 *     → 'crm_imported_lost'
 *   (synthetic provenance row, has extracted_identity.hear_source)
 *     → 'crm_attribution'
 *
 * The synthetic `crm_attribution` row is the one
 * `crm-import/honeybook.ts:~680-700` emits per project to carry the
 * "How did you hear?" provenance — call this builder with mode
 * 'attribution' when synthesising that row's spine signal.
 *
 * signal_tier
 * -----------
 *   booked / completed                                    → 'high'
 *   crm_attribution AND hear_source recognised            → 'high'
 *   everything else                                       → 'medium'
 *
 * external_id (OQ-H2)
 * -------------------
 * Prefer a HoneyBook project ID if the row carries one (probed off
 * `raw_row['Project ID']` / 'project_id' / 'ProjectID'). Falls back
 * to `"honeybook:provenance:" + normalized_project_name + ":" +
 * inquiry_date_iso` so a coordinator re-uploading the same CSV gets
 * idempotent upserts.
 *
 * importRowId is carried in raw_payload for recurring-CSV dedup
 * (crm_import_rows.id, mig 335).
 */

import type { NormalizedSignal } from './sources/types'
import { deriveIdentityHint } from './signal-helpers/identity-hint'
import { mergeRawPayload } from './signal-helpers/raw-payload'

/** Subset of NormalisedLeadRow this builder reads. Kept as a local
 *  interface so this file does NOT import from `crm-import/index.ts`
 *  (avoids cycles + keeps the contract narrow). */
export interface HoneybookCsvRowInput {
  source_id?: string | null
  partner1_first_name?: string | null
  partner1_last_name?: string | null
  partner1_email?: string | null
  partner1_phone?: string | null
  partner2_first_name?: string | null
  partner2_last_name?: string | null
  partner2_email?: string | null
  partner2_phone?: string | null
  wedding_date?: string | null
  status?:
    | 'inquiry'
    | 'tour_scheduled'
    | 'tour_completed'
    | 'proposal_sent'
    | 'booked'
    | 'completed'
    | 'lost'
    | 'cancelled'
    | null
  inquiry_date?: string | null
  booked_at?: string | null
  lost_at?: string | null
  source?: string | null
  raw_row?: Record<string, unknown> | null
  /** Set on the synthetic provenance row. When present, the builder
   *  switches to `crm_attribution` action_type regardless of status. */
  extracted_identity?: Record<string, unknown> | null
}

export interface HoneybookCsvToSignalInput {
  row: HoneybookCsvRowInput
  /** Legacy weddings.id this row's project resolved to. */
  weddingId?: string | null
  /** crm_import_rows.id — mig 335 recurring-CSV dedup key. Carried in
   *  raw_payload so a re-import that hits dedup-unchanged at the
   *  crm-import layer can still be traced through the spine. */
  importRowId?: string | null
  /** Force the synthetic-provenance treatment for an attribution row
   *  even if the caller hasn't populated `extracted_identity` yet. */
  mode?: 'row' | 'attribution'
}

function joinName(first?: string | null, last?: string | null): string | null {
  const parts = [first, last].filter((x): x is string => Boolean(x?.trim()))
  if (parts.length === 0) return null
  return parts.join(' ').trim() || null
}

function actionTypeForStatus(
  status: HoneybookCsvRowInput['status'],
): 'crm_imported_inquiry' | 'crm_imported_booked' | 'crm_imported_lost' {
  switch (status) {
    case 'booked':
    case 'completed':
      return 'crm_imported_booked'
    case 'lost':
    case 'cancelled':
      return 'crm_imported_lost'
    case 'inquiry':
    case 'tour_scheduled':
    case 'tour_completed':
    case 'proposal_sent':
    case null:
    case undefined:
    default:
      return 'crm_imported_inquiry'
  }
}

function normaliseProjectName(s: string | null | undefined): string {
  if (!s) return 'unknown'
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    || 'unknown'
}

function pickProjectId(row: HoneybookCsvRowInput): string | null {
  const raw = row.raw_row ?? null
  if (!raw) return null
  for (const k of ['Project ID', 'project_id', 'ProjectID', 'projectId']) {
    const v = raw[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function pickOccurredAt(row: HoneybookCsvRowInput, action: string): string {
  if (action === 'crm_imported_booked') {
    return row.booked_at ?? row.inquiry_date ?? new Date().toISOString()
  }
  if (action === 'crm_imported_lost') {
    return row.lost_at ?? row.inquiry_date ?? new Date().toISOString()
  }
  return row.inquiry_date ?? row.booked_at ?? new Date().toISOString()
}

/**
 * Build the cascade `NormalizedSignal` for one HoneyBook CSV row.
 * Returns a signal in 'crm_attribution' mode when the row carries
 * `extracted_identity.hear_source` (the synthetic provenance row at
 * `crm-import/honeybook.ts:~680`) OR when the caller passes
 * `mode='attribution'`.
 */
export function honeybookCsvToNormalizedSignal(
  input: HoneybookCsvToSignalInput,
): NormalizedSignal {
  const { row, weddingId = null, importRowId = null, mode = 'row' } = input

  const ext = (row.extracted_identity ?? null) as
    | { hear_source?: unknown; hear_source_raw?: unknown }
    | null
  const recognisedHearSource =
    typeof ext?.hear_source === 'string' && ext.hear_source.trim()
      ? ext.hear_source.trim()
      : null

  const isAttribution =
    mode === 'attribution' || recognisedHearSource !== null

  const actionType: string = isAttribution
    ? 'crm_attribution'
    : actionTypeForStatus(row.status)

  const occurredAt = pickOccurredAt(row, actionType)

  const partner1Name = joinName(row.partner1_first_name, row.partner1_last_name)
  const partner2Name = joinName(row.partner2_first_name, row.partner2_last_name)

  // signal_tier:
  //  - 'high' for booked/completed (acquisition-complete signal)
  //  - 'high' for synthetic-provenance with a recognised hear_source
  //    (a known-source attribution row carries strong meaning)
  //  - 'medium' otherwise (inquiry/lost rows are useful but not strongest)
  let signalTier: NormalizedSignal['signal_tier'] = 'medium'
  if (actionType === 'crm_imported_booked') signalTier = 'high'
  if (isAttribution && recognisedHearSource) signalTier = 'high'

  // external_id (OQ-H2): HoneyBook project ID when present, else
  // honeybook:provenance:<project_slug>:<inquiry_date_iso>.
  const projectId = pickProjectId(row)
  let externalId: string
  if (projectId) {
    externalId = `honeybook:project:${projectId}`
  } else {
    const slug = normaliseProjectName(row.source_id)
    const dateIso =
      (row.inquiry_date ?? row.booked_at ?? occurredAt).slice(0, 10)
    externalId = `honeybook:provenance:${slug}:${dateIso}`
  }
  // Disambiguate the multiple signals one CSV row spawns
  // (inquiry/booked/lost row + provenance row) so they don't collide
  // on UNIQUE(venue_id, channel, external_id).
  externalId = `${externalId}:${actionType}`

  return {
    external_id: externalId,
    channel: 'honeybook',
    action_type: actionType,
    occurred_at: occurredAt,
    signal_tier: signalTier,
    identity_hint: deriveIdentityHint({
      name: partner1Name,
      email: row.partner1_email,
      phone: row.partner1_phone,
    }),
    primary_name: partner1Name,
    primary_email: row.partner1_email ?? null,
    primary_phone: row.partner1_phone ?? null,
    partner_name: partner2Name,
    partner_email: row.partner2_email ?? null,
    partner_phone: row.partner2_phone ?? null,
    wedding_date: row.wedding_date ?? null,
    session_ip: null,
    session_fingerprint: null,
    raw_payload: mergeRawPayload(
      { subject: row.source_id ?? null },
      {
        crm_import_row_id: importRowId,
        honeybook_project_id: projectId,
        honeybook_source_raw: row.source ?? null,
        honeybook_status: row.status ?? null,
        hear_source: recognisedHearSource,
        hear_source_raw:
          typeof ext?.hear_source_raw === 'string'
            ? ext.hear_source_raw
            : null,
        inquiry_date: row.inquiry_date ?? null,
        booked_at: row.booked_at ?? null,
        lost_at: row.lost_at ?? null,
      },
    ),
    legacy_wedding_id: weddingId,
  }
}
