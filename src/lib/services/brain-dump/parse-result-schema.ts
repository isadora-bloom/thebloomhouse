/**
 * Discriminated-union schema for `brain_dump_entries.parse_result`.
 *
 * Bug 11 (2026-05-09). The column is `jsonb` and every writer shoves
 * a different shape in. The resolve route's Cases A-G sniffed for
 * `pr.shape`, `pr.vision`, `pr.proposed_client_note`, etc. to decide
 * what to do. New intents needed both writer + reader edits with no
 * type-system support — easy to ship a propose path with no matching
 * confirm path.
 *
 * Fix: every new write carries a `kind` discriminant. Readers narrow
 * with the helpers below. The legacy heuristic (sniff `pr.shape`,
 * `pr.vision`, etc.) is preserved by callers as a fallback for rows
 * persisted before this commit so back-compat reads still work; new
 * writes always include `kind`.
 *
 * Adding a new shape: append a member to `BrainDumpParseResult`, then
 * add the matching `is<Kind>` helper. The resolve route will get a
 * compile error if it does not handle the new kind in its switch.
 */

import type { CsvShape } from '@/lib/services/brain-dump/csv-shape'
import type { ReviewRow } from '@/lib/services/brain-dump/imports'

/** Co-extracted alongside CSV preview, sample of first N rows. */
export interface CsvPreviewSample {
  headers: string[]
  rows: string[][]
}

/** Storefront analytics chart data extracted by vision. */
export interface AnalyticsRow {
  source: string
  metric: string
  rows: Array<{ label: string; value: number }>
}

/** Vision-extracted identity candidates for tangential_signals. */
export interface VisionIdentityRow {
  name?: string
  first_name?: string
  last_name?: string
  username?: string
  handle?: string
  platform?: string
  context?: string
  signal_type?: string
}

/**
 * Discriminated union of every shape stored on
 * `brain_dump_entries.parse_result`. The `kind` field is the
 * discriminator. Writers added after Bug 11 always set it; readers
 * narrow with the type guards below.
 */
export type BrainDumpParseResult =
  | {
      kind: 'csv_preview'
      shape: CsvShape
      storagePath: string
      rowCount: number
      columns?: Record<string, number | string | undefined>
      sample?: CsvPreviewSample
    }
  | {
      kind: 'vision_reviews'
      reviews: ReviewRow[]
    }
  | {
      kind: 'vision_storefront_analytics'
      analytics: AnalyticsRow
      identities?: VisionIdentityRow[]
    }
  | {
      kind: 'vision_identity_signals'
      summary: string | null
      identities: VisionIdentityRow[]
    }
  | {
      kind: 'vision_other'
      summary: string | null
    }
  | {
      kind: 'pdf_preview'
      name: string
      pages: number | null
      chars: number
      truncated: boolean
      extractedText: string
      storagePath: string
    }
  | {
      kind: 'pdf_extract_failed'
      name: string
      reason: string
    }
  | {
      kind: 'pdf_oversized'
      name: string
      bytes: number
    }
  | {
      kind: 'url_pinterest_preview'
      url: string
      title: string | null
      description: string | null
      imageUrl: string | null
      extractedText: string
    }
  | {
      kind: 'url_generic_preview'
      url: string
      title: string | null
      description: string | null
      extractedText: string
    }
  | {
      kind: 'url_google_doc_deferred'
      url: string
      reason: string
    }
  | {
      kind: 'json_parse_failed'
      reason: string
    }
  | {
      kind: 'json_contract_violation'
      reason: string
      sample?: unknown
    }
  | {
      kind: 'scraper_json_imported'
      source: string | null
      capturedAt: string | null
      rowCount: number
    }
  | {
      kind: 'proposed_client_note'
      weddingId: string
      noteBody: string
      coupleLabel: string | null
    }
  | {
      kind: 'proposed_kb_rows'
      rows: Array<{ question: string; answer: string; category: string }>
    }
  | {
      kind: 'proposed_operational_note'
      noteBody: string
    }
  | {
      kind: 'proposed_staff_observation'
      staffName: string
      noteBody: string
      resolvedUserId: string | null
    }
  | {
      kind: 'proposed_analytics'
      source: string
      metric: string
      rows: Array<{ label: string; value: number }>
    }
  | {
      kind: 'proposed_availability'
      date: string
      action: 'cancel' | 'block' | 'hold' | 'release'
    }
  | {
      kind: 'help_answer'
      body: string
      links: Array<{ label: string; href: string }>
    }
  | {
      kind: 'duplicate_upload'
      originalEntryId: string
      originalIntent: string
    }

export type BrainDumpParseResultKind = BrainDumpParseResult['kind']

/**
 * Read a `parse_result` blob and return its `kind` discriminant when
 * present. Older rows (written before Bug 11) have no `kind` field;
 * callers should fall back to the legacy heuristic when this returns
 * null.
 */
export function readParseResultKind(
  pr: unknown
): BrainDumpParseResultKind | null {
  if (!pr || typeof pr !== 'object') return null
  const k = (pr as { kind?: unknown }).kind
  return typeof k === 'string' ? (k as BrainDumpParseResultKind) : null
}

// ---------------------------------------------------------------------------
// Type-guard helpers
// ---------------------------------------------------------------------------
//
// Narrow `unknown` (the JSON column shape) into a specific union member.
// All guards return false when the input lacks `kind` so legacy rows do
// not falsely match a new shape.

function hasKind<K extends BrainDumpParseResultKind>(
  pr: unknown,
  kind: K
): pr is Extract<BrainDumpParseResult, { kind: K }> {
  return (
    !!pr &&
    typeof pr === 'object' &&
    (pr as { kind?: unknown }).kind === kind
  )
}

export function isCsvPreview(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'csv_preview' }> {
  return hasKind(pr, 'csv_preview')
}

export function isVisionReviews(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'vision_reviews' }> {
  return hasKind(pr, 'vision_reviews')
}

export function isVisionStorefrontAnalytics(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'vision_storefront_analytics' }> {
  return hasKind(pr, 'vision_storefront_analytics')
}

export function isVisionIdentitySignals(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'vision_identity_signals' }> {
  return hasKind(pr, 'vision_identity_signals')
}

export function isVisionOther(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'vision_other' }> {
  return hasKind(pr, 'vision_other')
}

export function isPdfPreview(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'pdf_preview' }> {
  return hasKind(pr, 'pdf_preview')
}

export function isPdfExtractFailed(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'pdf_extract_failed' }> {
  return hasKind(pr, 'pdf_extract_failed')
}

export function isPdfOversized(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'pdf_oversized' }> {
  return hasKind(pr, 'pdf_oversized')
}

export function isUrlPinterestPreview(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'url_pinterest_preview' }> {
  return hasKind(pr, 'url_pinterest_preview')
}

export function isUrlGenericPreview(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'url_generic_preview' }> {
  return hasKind(pr, 'url_generic_preview')
}

export function isUrlGoogleDocDeferred(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'url_google_doc_deferred' }> {
  return hasKind(pr, 'url_google_doc_deferred')
}

export function isJsonParseFailed(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'json_parse_failed' }> {
  return hasKind(pr, 'json_parse_failed')
}

export function isJsonContractViolation(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'json_contract_violation' }> {
  return hasKind(pr, 'json_contract_violation')
}

export function isScraperJsonImported(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'scraper_json_imported' }> {
  return hasKind(pr, 'scraper_json_imported')
}

export function isProposedClientNote(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'proposed_client_note' }> {
  return hasKind(pr, 'proposed_client_note')
}

export function isProposedKbRows(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'proposed_kb_rows' }> {
  return hasKind(pr, 'proposed_kb_rows')
}

export function isProposedOperationalNote(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'proposed_operational_note' }> {
  return hasKind(pr, 'proposed_operational_note')
}

export function isProposedStaffObservation(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'proposed_staff_observation' }> {
  return hasKind(pr, 'proposed_staff_observation')
}

export function isProposedAnalytics(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'proposed_analytics' }> {
  return hasKind(pr, 'proposed_analytics')
}

export function isProposedAvailability(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'proposed_availability' }> {
  return hasKind(pr, 'proposed_availability')
}

export function isHelpAnswer(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'help_answer' }> {
  return hasKind(pr, 'help_answer')
}

export function isDuplicateUpload(
  pr: unknown
): pr is Extract<BrainDumpParseResult, { kind: 'duplicate_upload' }> {
  return hasKind(pr, 'duplicate_upload')
}
