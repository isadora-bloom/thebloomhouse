/**
 * Bloom House — recurring-CSV import dedup primitive.
 *
 * Anchor: memory/bloom-recurring-csv-import-doctrine.md (2026-05-13).
 *
 * What this is
 * ------------
 * Every recurring CSV adapter (Knot weekly export, HoneyBook export,
 * WeddingWire, Zola, Calendly CSV) writes one row per source row into
 * `crm_import_rows` BEFORE deciding to mint/attach a wedding. This
 * gives us hard idempotency: re-uploading the same row is a no-op
 * short-circuit. Schema lives in migration 335.
 *
 * Two hashes per row:
 *
 *   - `row_fingerprint` — IDENTITY. Stable across re-exports of the
 *     same row. Used as the dedup primary key together with
 *     (venue_id, source). Priority chain:
 *       1. normalised_email + inquiry_date (YYYY-MM-DD)
 *       2. normalised_phone + inquiry_date
 *       3. normalised_full_name + wedding_date
 *     Calendly bypasses the chain: event_uuid is the natural identity.
 *
 *   - `content_hash` — STATE. Mutates only when a state-significant
 *     field on the row actually changed. Used to detect "this row's
 *     status flipped Inquired→Tour Booked" diffs separately from "this
 *     row is identical". Excludes timestamps, casing, whitespace —
 *     trivial export-format differences MUST NOT trigger fake diffs.
 *
 * Per-row decision tree (`upsertImportRow` enforces this):
 *
 *   fingerprint NEW → caller runs the resolution chain (Layer 2),
 *     then upserts with resolved_wedding_id + resolution. ONE
 *     touchpoint per row at the caller layer.
 *
 *   fingerprint EXISTS, content_hash SAME → bump last_seen_at, noop.
 *     No touchpoint, no LLM, no re-resolution.
 *
 *   fingerprint EXISTS, content_hash DIFFERS → compute diff over
 *     state-significant fields, append diff to state_history, update
 *     content_hash + row_data + last_seen_at. Caller writes ONE
 *     touchpoint describing the diff.
 *
 * This file only owns the primitive — adapters consume it. The Knot /
 * HoneyBook / Calendly adapter wiring lives in its own file each.
 */

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CrmImportSource =
  | 'tour_scheduler'   // Calendly / Acuity / iCal CSV
  | 'knot'
  | 'honeybook'
  | 'wedding_wire'
  | 'zola'
  | 'dubsado'
  | 'aisle_planner'
  | 'generic_csv'
  | 'web_form'

export type CrmImportResolution =
  | 'attached_strong'
  | 'attached_medium'
  | 'flagged'
  | 'minted_new'
  | 'rejected'

/**
 * Identity signals the adapter extracted from the CSV row. The
 * fingerprint formula picks the strongest available channel.
 */
export interface IdentitySignals {
  /** Adapter-provided unique key, if the source assigns one
   *  (Calendly event_uuid, HoneyBook deal id, Knot inquiry id).
   *  When set, this becomes the fingerprint directly — bypasses the
   *  priority chain since the source's own id is already stable. */
  externalId?: string | null
  email?: string | null
  phone?: string | null
  fullName?: string | null
  /** YYYY-MM-DD or ISO date string. Used in the priority chain. */
  inquiryDate?: string | null
  /** YYYY-MM-DD or ISO date string. Used as last-resort anchor. */
  weddingDate?: string | null
}

/**
 * State-significant fields. Pass only fields whose changes you want
 * to surface as a state diff. Trivial CSV-export differences
 * (timestamps, casing, whitespace) MUST NOT be in this object.
 */
export interface StateSnapshot {
  status?: string | null
  weddingDate?: string | null
  guestCount?: number | null
  budget?: number | null
  tourScheduledFor?: string | null
  canceled?: boolean | null
  /** Adapter-specific state fields go in here as kebab-case keys. */
  extras?: Record<string, string | number | boolean | null | undefined>
}

export interface UpsertResult {
  /** The crm_import_rows row id. */
  importRowId: string
  fingerprint: string
  contentHash: string
  /** Whether this was a brand-new fingerprint (caller should resolve
   *  + attach a wedding) or a re-sighting of an existing one. */
  state: 'new' | 'unchanged' | 'state_changed'
  /** Set on 'state_changed' — fields that flipped, oldValue → newValue. */
  diff?: Record<string, [unknown, unknown]>
  /** Set when state already had a resolution from prior sight. */
  resolvedWeddingId: string | null
  resolution: CrmImportResolution | null
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed.includes('@')) return null
  // Strip plus-tagging and dots on the local-part for gmail-style addrs.
  const [local, domain] = trimmed.split('@')
  if (!local || !domain) return null
  const localCanon = local.split('+')[0].replace(/\./g, '')
  return `${localCanon}@${domain}`
}

function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D+/g, '')
  if (digits.length < 7) return null
  // Strip a leading 1 from US 11-digit numbers so 17035551234 and
  // 7035551234 fingerprint identically.
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return digits
}

function normaliseName(raw: string | null | undefined): string | null {
  if (!raw) return null
  // NFKD-normalize, lowercase, collapse whitespace, strip non-letters.
  // (Names with accents fingerprint the same as their ASCII form.)
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || null
}

function dateOnly(raw: string | null | undefined): string | null {
  if (!raw) return null
  // Accept YYYY-MM-DD or ISO; emit YYYY-MM-DD.
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Compute the IDENTITY fingerprint for a CSV row.
 *
 * Priority:
 *   externalId → sha256(externalId)
 *   email + inquiryDate → sha256("email|" + normEmail + "|" + dateOnly)
 *   phone + inquiryDate → sha256("phone|" + normPhone + "|" + dateOnly)
 *   name + weddingDate → sha256("name|" + normName + "|" + dateOnly)
 *   fallback: throw — adapter must provide at least one identity signal
 */
export function computeRowFingerprint(
  source: CrmImportSource,
  signals: IdentitySignals,
): string {
  if (signals.externalId && signals.externalId.trim()) {
    return sha256(`ext|${source}|${signals.externalId.trim().toLowerCase()}`)
  }
  const email = normaliseEmail(signals.email)
  const inquiry = dateOnly(signals.inquiryDate)
  if (email && inquiry) {
    return sha256(`email|${source}|${email}|${inquiry}`)
  }
  const phone = normalisePhone(signals.phone)
  if (phone && inquiry) {
    return sha256(`phone|${source}|${phone}|${inquiry}`)
  }
  const name = normaliseName(signals.fullName)
  const wedding = dateOnly(signals.weddingDate)
  if (name && wedding) {
    return sha256(`name|${source}|${name}|${wedding}`)
  }
  // Last resort: name alone if nothing else available. Bad fingerprint
  // (re-export with same name + different date will collide), but
  // better than throwing — the row will land flagged.
  if (name) return sha256(`name-only|${source}|${name}`)
  throw new Error(
    `crm-import: row has no identity signals (externalId/email+date/phone+date/name+date)`,
  )
}

/**
 * Compute the STATE hash for a CSV row. Only state-significant fields
 * participate. Excluded as noise: timestamps, casing, whitespace,
 * last_modified, internal source ids, surfaces. Trivial export-format
 * differences MUST NOT trigger fake state changes.
 */
export function computeContentHash(state: StateSnapshot): string {
  // Canonicalise: lower-case, trim, drop undefined/null/'' to keep
  // re-export formatting noise out of the hash.
  const entries: Array<[string, string]> = []
  const push = (k: string, v: unknown): void => {
    if (v === undefined || v === null || v === '') return
    let canon: string
    if (typeof v === 'boolean') canon = v ? '1' : '0'
    else if (typeof v === 'number') canon = String(v)
    else canon = String(v).trim().toLowerCase()
    if (canon === '') return
    entries.push([k, canon])
  }
  push('status', state.status)
  push('weddingDate', dateOnly(state.weddingDate))
  push('guestCount', state.guestCount)
  push('budget', state.budget)
  push('tourScheduledFor', dateOnly(state.tourScheduledFor))
  push('canceled', state.canceled)
  if (state.extras) {
    for (const [k, v] of Object.entries(state.extras)) push(`ex.${k}`, v)
  }
  entries.sort(([a], [b]) => a.localeCompare(b))
  const joined = entries.map(([k, v]) => `${k}=${v}`).join('|')
  return sha256(joined || 'empty')
}

// ---------------------------------------------------------------------------
// Upsert primitive
// ---------------------------------------------------------------------------

export interface UpsertArgs {
  supabase: SupabaseClient
  venueId: string
  source: CrmImportSource
  /** The CSV row's identity signals — feeds the fingerprint. */
  identity: IdentitySignals
  /** The CSV row's state-significant snapshot — feeds the content
   *  hash + state_history. */
  state: StateSnapshot
  /** The full parsed row snapshot stored as `row_data` jsonb. The
   *  adapter is responsible for picking which fields to persist. */
  rowData: Record<string, unknown>
}

/**
 * Look up (venue, source, fingerprint). Return one of:
 *   - state='new'           — caller resolves + then calls
 *                             `recordResolution` to finalise.
 *   - state='unchanged'     — bump last_seen_at only.
 *   - state='state_changed' — diff appended to state_history; caller
 *                             writes one touchpoint describing the diff.
 *
 * The caller wraps the resolution step in the adapter and feeds the
 * outcome back via `recordResolution` so the row's resolved_wedding_id
 * + resolution field land in one place.
 */
export async function classifyImportRow(
  args: UpsertArgs,
): Promise<UpsertResult> {
  const fingerprint = computeRowFingerprint(args.source, args.identity)
  const contentHash = computeContentHash(args.state)
  const now = new Date().toISOString()

  const { data: existing, error: selErr } = await args.supabase
    .from('crm_import_rows')
    .select(
      'id, content_hash, row_data, state_history, resolved_wedding_id, resolution',
    )
    .eq('venue_id', args.venueId)
    .eq('source', args.source)
    .eq('row_fingerprint', fingerprint)
    .maybeSingle()
  if (selErr) {
    throw new Error(`crm-import: classify lookup failed: ${selErr.message}`)
  }

  if (!existing) {
    // NEW fingerprint — insert with resolution='flagged' as a
    // placeholder; the caller will call recordResolution() once the
    // resolution chain decides.
    const { data: inserted, error: insErr } = await args.supabase
      .from('crm_import_rows')
      .insert({
        venue_id: args.venueId,
        source: args.source,
        row_fingerprint: fingerprint,
        content_hash: contentHash,
        row_data: args.rowData,
        state_history: [],
        first_seen_at: now,
        last_seen_at: now,
        resolution: 'flagged',
      })
      .select('id')
      .single()
    if (insErr || !inserted) {
      throw new Error(
        `crm-import: classify insert failed: ${insErr?.message ?? 'no row'}`,
      )
    }
    return {
      importRowId: inserted.id as string,
      fingerprint,
      contentHash,
      state: 'new',
      resolvedWeddingId: null,
      resolution: null,
    }
  }

  if (existing.content_hash === contentHash) {
    // Re-sighting, no state change — bump last_seen_at only.
    await args.supabase
      .from('crm_import_rows')
      .update({ last_seen_at: now })
      .eq('id', existing.id)
    return {
      importRowId: existing.id as string,
      fingerprint,
      contentHash,
      state: 'unchanged',
      resolvedWeddingId: (existing.resolved_wedding_id as string | null) ?? null,
      resolution: (existing.resolution as CrmImportResolution | null) ?? null,
    }
  }

  // STATE CHANGED — diff old row_data state-significant fields vs
  // new args.rowData. Append to state_history. We diff on the
  // canonicalised state snapshot, not the raw row_data, since
  // row_data may include adapter-specific noise.
  const oldData = (existing.row_data as Record<string, unknown> | null) ?? {}
  const diff = computeStateDiff(oldData, args.rowData)

  const history = Array.isArray(existing.state_history)
    ? (existing.state_history as Array<unknown>)
    : []
  const trimmedHistory = history.slice(-49)
  trimmedHistory.push({
    seen_at: now,
    content_hash: contentHash,
    diff,
  })

  await args.supabase
    .from('crm_import_rows')
    .update({
      content_hash: contentHash,
      row_data: args.rowData,
      state_history: trimmedHistory,
      last_seen_at: now,
    })
    .eq('id', existing.id)

  return {
    importRowId: existing.id as string,
    fingerprint,
    contentHash,
    state: 'state_changed',
    diff,
    resolvedWeddingId: (existing.resolved_wedding_id as string | null) ?? null,
    resolution: (existing.resolution as CrmImportResolution | null) ?? null,
  }
}

/**
 * Caller invokes this after running the resolution chain on a 'new'
 * fingerprint. Updates resolution + resolved_wedding_id atomically.
 */
export async function recordResolution(args: {
  supabase: SupabaseClient
  importRowId: string
  resolution: CrmImportResolution
  resolvedWeddingId: string | null
  reason: string
  resolvedByUserId?: string | null
}): Promise<void> {
  const { error } = await args.supabase
    .from('crm_import_rows')
    .update({
      resolution: args.resolution,
      resolved_wedding_id: args.resolvedWeddingId,
      resolution_reason: args.reason,
      resolved_by_user_id: args.resolvedByUserId ?? null,
      resolved_at:
        args.resolution === 'flagged' ? null : new Date().toISOString(),
    })
    .eq('id', args.importRowId)
  if (error) {
    throw new Error(`crm-import: recordResolution failed: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Internal: diff over state-significant fields
// ---------------------------------------------------------------------------

function computeStateDiff(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
): Record<string, [unknown, unknown]> {
  const diff: Record<string, [unknown, unknown]> = {}
  const stateKeys = new Set([
    'status',
    'wedding_date',
    'weddingDate',
    'guest_count',
    'guestCount',
    'guest_count_estimate',
    'budget',
    'booking_value',
    'tour_scheduled_for',
    'tourScheduledFor',
    'canceled',
    'cancelled',
  ])
  // Compare snake_case-vs-camelCase tolerantly — keep adapter free to
  // choose either convention in row_data without breaking the diff.
  for (const k of stateKeys) {
    const oldV = oldData[k] ?? null
    const newV = newData[k] ?? null
    if (canonical(oldV) !== canonical(newV)) {
      diff[k] = [oldV, newV]
    }
  }
  return diff
}

function canonical(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return String(v)
  return String(v).trim().toLowerCase()
}
