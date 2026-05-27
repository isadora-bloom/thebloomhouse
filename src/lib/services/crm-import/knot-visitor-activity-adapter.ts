/**
 * CRM-import adapter wrapper around `importKnotVisitorActivityCsv`.
 *
 * Why this wrapper (vs. registering importKnotVisitorActivityCsv directly):
 * the CRM-import registry expects every adapter to implement
 * `CrmAdapter` (parse/preview/commit producing NormalisedLeadRow[]).
 * Knot visitor-activity rows are NOT couples — they are visitor-level
 * touchpoints that LATER bind to people. So this adapter follows the
 * same "out-of-band payload" pattern the sibling storefront-activity
 * adapter uses: parse() returns `rows:[]` and rides the real payload
 * on a custom field; commit() reads that field and writes to
 * `knot_visitor_activity` (then enqueues the matcher sweep).
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
import {
  importKnotVisitorActivityCsv,
  parseKnotVisitorActivityCsv,
  type KnotVisitorRow,
} from './knot-visitor-activity'
import { matchKnotVisitorsToPeople } from '@/lib/services/identity/knot-visitor-match'

interface KnotVisitorActivityParseResult extends ParseResult {
  knotVisitorRows?: KnotVisitorRow[]
}

async function parseKnotVisitorActivity(
  config: AdapterConfig & { venueId?: string },
): Promise<KnotVisitorActivityParseResult> {
  if (!config.csvText || !config.csvText.trim()) {
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings: [] }
  }
  // The fingerprint depends on venue_id but at parse time the route
  // does NOT always pass venueId (legacy adapters infer it later from
  // auth). For the parser we accept a venueId via the config object;
  // when missing we use a stable placeholder so the parse step still
  // produces fingerprints (they get recomputed at commit time against
  // the real venue id via the importer).
  const venueId = (config as { venueId?: string }).venueId ?? 'parse-only'
  const parsed = parseKnotVisitorActivityCsv({
    venueId,
    csvText: config.csvText,
  })
  return {
    ok: parsed.ok,
    rows: [],
    errors: parsed.errors,
    warnings: parsed.warnings,
    knotVisitorRows: parsed.rows,
  }
}

function previewKnotVisitorActivity(_rows: NormalisedLeadRow[]): PreviewResult {
  // Like storefront-activity: lead-row preview is empty by design;
  // operator-facing summary lives in the route layer (it reads the
  // out-of-band knotVisitorRows count).
  return { rows: [], total: 0, errors: [], warnings: [] }
}

async function commitKnotVisitorActivity(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
  knotVisitorRows?: KnotVisitorRow[]
  /** §7 OPERATOR-BLOCK item 4 dry-run pass-through. */
  preview?: boolean
}): Promise<CommitResult> {
  const isDryRun = args.preview === true

  // The route only ever has the raw CSV text; we re-run the importer
  // here with the REAL venue_id so the fingerprint hashes are correct
  // (the parse-time venueId placeholder above is intentionally ignored).
  //
  // We need the original CSV text — adapters don't receive csvText in
  // commit() today. The route DOES have it. The cleanest path: have
  // the route call `importKnotVisitorActivityCsv` directly (see the
  // route file), and use this adapter only for the registry / preview
  // hooks. So the commit branch here is a fallback that operates on
  // the parsed knotVisitorRows when present.
  const rows = args.knotVisitorRows ?? []

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
    result.previewDecisions = rows.map((_, idx) => ({
      rowIndex: idx,
      willInsert: 'new' as const,
      reason:
        'knot_visitor_activity row — commit would insert into knot_visitor_activity (idempotent on row_fingerprint).',
    }))
    return result
  }

  if (rows.length === 0) return result

  // Synthesise a CSV from the parsed rows so we can reuse the importer
  // (which expects raw CSV). We only need ONE round-trip for the
  // commit step — the upserter is the same code path either way.
  const header = 'Action Taken,Visitor Name,Date of Visit,City,State'
  const actionLabel: Record<string, string> = {
    storefront_view: 'Storefront View',
    storefront_save: 'Storefront Save',
    message: 'Message',
    click_to_website: 'Click to Website',
    click_to_social: 'Click to Social',
    other: 'Other',
  }
  const csv = [
    header,
    ...rows.map((r) =>
      [
        actionLabel[r.action_taken] ?? r.action_taken,
        quote(r.visitor_name),
        new Date(r.action_at).toISOString().slice(0, 10),
        quote(r.city ?? ''),
        quote(r.state ?? ''),
      ].join(','),
    ),
  ].join('\n')

  const importRes = await importKnotVisitorActivityCsv({
    venueId: args.venueId,
    csvText: csv,
    supabase: args.supabase,
  })

  result.interactionsInserted = importRes.inserted
  if (!importRes.ok) {
    result.ok = false
    result.errors.push(...importRes.parseErrors)
  }

  // Kick off the matcher sweep against the rows we just inserted.
  // Failures here are non-fatal — the import itself committed and the
  // operator can re-run the matcher (a future admin endpoint or cron).
  try {
    const matchRes = await matchKnotVisitorsToPeople({
      venueId: args.venueId,
      batchId: importRes.importBatchId,
      supabase: args.supabase,
    })
    if (matchRes.dougTrace.length > 0) {
      // Surface the canary trace as a non-fatal warning so the operator
      // sees what happened to Doug L. in the UI.
      for (const line of matchRes.dougTrace) {
        result.errors.push(`note: ${line}`)
      }
    }
  } catch (err) {
    result.errors.push(
      `matcher sweep failed (rows imported, matching deferred): ${err instanceof Error ? err.message : 'unknown'}`,
    )
  }

  return result
}

function quote(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export const knotVisitorActivityAdapter: CrmAdapter = {
  name: 'knot_visitor_activity' as CrmAdapter['name'],
  label: 'Knot visitor activity (per-row history CSV)',
  description:
    'Import a Knot visitor-activities CSV (Action Taken / Visitor Name / Date of Visit / City / State). ' +
    'One row per action; idempotent on re-upload via row_fingerprint. Matcher binds rows to people by ' +
    'first name + last initial. Visitors who messaged or saved without a matching person become ghost ' +
    'records via the cascade. View / click rows from couples already in pipeline emit verification-visit ' +
    'heat signals — a new signal Bloom did not have before.',
  ready: true,
  parse: parseKnotVisitorActivity,
  preview: previewKnotVisitorActivity,
  commit: commitKnotVisitorActivity as CrmAdapter['commit'],
}
