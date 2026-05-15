/**
 * CRM-import API (T5-followup-Y / Pattern I closure).
 *
 * POST /api/onboarding/crm-import
 *   body: {
 *     adapter: 'honeybook' | 'dubsado' | 'aisle_planner' | 'generic_csv',
 *     csv?: string,
 *     json?: string,
 *     columnMapping?: Record<string, string>,
 *     preview?: boolean,
 *   }
 *
 *   preview=true → parse + return rows for coordinator review (no inserts)
 *   preview=false → parse + commit to weddings/interactions/tours/lost_deals
 *
 * Auth: getPlatformAuth — coordinator-only.
 *
 * The adapter does the parsing + the commit; the API route just routes
 * the request and gates auth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  findAdapter,
  type NormalisedLeadRow,
  type TourSchedulerProvider,
} from '@/lib/services/crm-import'

// A full CRM/Calendly backfill commits per-row (resolveIdentity +
// mintWedding + per-interaction dedup + reconstruction enqueue), so a
// few hundred rows can run well past the platform's default function
// budget. Pin the ceiling to 300s so a large first import finishes
// instead of dropping the connection mid-write.
export const maxDuration = 300

const VALID_PROVIDERS: ReadonlySet<TourSchedulerProvider> = new Set([
  'calendly', 'acuity', 'square_appointments', 'generic_ical', 'custom',
])

function coerceProvider(raw: string | undefined): TourSchedulerProvider | undefined {
  if (!raw) return undefined
  return VALID_PROVIDERS.has(raw as TourSchedulerProvider)
    ? (raw as TourSchedulerProvider)
    : undefined
}

interface RequestBody {
  adapter?: string
  csv?: string
  json?: string
  columnMapping?: Record<string, string>
  preview?: boolean
  /** T5-Rixey-II: provider hint for the tour-scheduler adapter
   *  ('calendly' | 'acuity' | 'square_appointments' | 'generic_ical' |
   *  'custom'). Other adapters ignore this field. */
  provider?: string
}

/**
 * Maximum request body size for CRM uploads. Pre-fix the route accepted
 * unbounded CSV / JSON bodies — a coordinator (or attacker) uploading a
 * 100MB CSV would block a Vercel function instance for the duration of
 * its parse + commit + leave a partial mess if it timed out.
 *
 * 5MB comfortably covers a real-world export (HoneyBook + Dubsado top out
 * around 1-2MB for thousands of rows; Aisle Planner's verbose JSON shape
 * still fits well under 5MB for typical venue data sets). #88,
 * T5-followup-CC.
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/**
 * Pre-commit validation. Re-runs after parse() but before commit() to
 * catch rows that the adapter happily normalised but the DB will reject.
 * Returns a list of row-index → error tuples so we can refuse the entire
 * batch atomically.
 *
 * Pre-fix the commit loop wrote per-row inside a JS for-loop — partial
 * failure (a single bad date, a too-long booking_value, an unknown
 * status enum value) committed earlier rows and left orphan weddings
 * shells with no interactions / tours / lost_deals attached. Without
 * Postgres explicit transactions in the Supabase JS client the cheapest
 * path to atomicity is "validate every row before writing any".
 *
 * Validation focuses on what the DB constraints would reject:
 *   - status enum membership (CRM exports often have "in progress" /
 *     custom statuses that adapter coerce maps to NULL — that NULL fails
 *     the weddings.status NOT NULL CHECK)
 *   - estimated_guests range (1-1000 from migration 165)
 *   - booking_value sign (must be >= 0)
 *   - wedding_date / inquiry_date / booked_at / lost_at parse-ability
 *   - email shape (loose)
 */
const VALID_STATUSES: ReadonlySet<NonNullable<NormalisedLeadRow['status']>> = new Set([
  'inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent',
  'booked', 'completed', 'lost', 'cancelled',
])

function isIsoLike(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true
  if (typeof value !== 'string') return false
  const d = new Date(value)
  return !Number.isNaN(d.getTime())
}

/**
 * Per-row validation. Returns rowIndex -> human reasons for every row
 * that fails. The route SKIPS failing rows (with the reason surfaced
 * to the coordinator) and imports the rest — it does NOT refuse the
 * whole batch. commitNormalisedRows rolls back any single row that
 * fails at insert time, so importing only the verified rows can never
 * leave orphan wedding shells.
 */
function validateRows(rows: NormalisedLeadRow[]): Map<number, string[]> {
  const byRow = new Map<number, string[]>()
  const add = (idx: number, msg: string): void => {
    const arr = byRow.get(idx) ?? []
    arr.push(msg)
    byRow.set(idx, arr)
  }
  rows.forEach((row, idx) => {
    if (row.status && !VALID_STATUSES.has(row.status)) {
      add(idx, `status "${row.status}" is not a status Bloom recognises`)
    }
    if (
      row.guest_count_estimate !== null
      && row.guest_count_estimate !== undefined
      && (row.guest_count_estimate < 1 || row.guest_count_estimate > 1000)
    ) {
      add(idx, `guest count ${row.guest_count_estimate} is outside the allowed 1-1000`)
    }
    if (
      row.booking_value !== null
      && row.booking_value !== undefined
      && row.booking_value < 0
    ) {
      add(idx, `booking value cannot be negative`)
    }
    if (!isIsoLike(row.wedding_date)) add(idx, `wedding date "${row.wedding_date}" could not be read`)
    if (!isIsoLike(row.inquiry_date)) add(idx, `inquiry date "${row.inquiry_date}" could not be read`)
    if (!isIsoLike(row.booked_at)) add(idx, `booked date "${row.booked_at}" could not be read`)
    if (!isIsoLike(row.lost_at)) add(idx, `lost date "${row.lost_at}" could not be read`)
    for (const interaction of row.interactions ?? []) {
      if (!isIsoLike(interaction.occurred_at)) add(idx, `an interaction date could not be read`)
    }
    for (const tour of row.tours ?? []) {
      if (!isIsoLike(tour.scheduled_at)) add(idx, `a tour date could not be read`)
    }
    if (row.lost_deal && !isIsoLike(row.lost_deal.lost_at)) {
      add(idx, `the lost-deal date could not be read`)
    }
  })
  return byRow
}

interface WriteErrorSummary {
  unique: Array<{ message: string; count: number }>
  schema_hint: string | null
}

/**
 * Collapse per-row commit errors into a deduped summary. 112 identical
 * Postgres errors become one line with a count. If the errors carry a
 * missing-column signature, derive a plain-language migration hint —
 * so a failed import says "apply the migration" instead of dumping a
 * wall of schema-cache errors.
 */
function summariseWriteErrors(errors: string[]): WriteErrorSummary {
  const counts = new Map<string, number>()
  for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1)
  const unique = Array.from(counts.entries())
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
  let schema_hint: string | null = null
  for (const { message } of unique) {
    const m = message.match(
      /could not find the '([^']+)' column|column "?([a-zA-Z_]+)"? does not exist/i,
    )
    if (m) {
      const col = m[1] ?? m[2]
      schema_hint =
        `The database is missing the "${col}" column on weddings — a pending ` +
        `migration has not been applied. Apply the latest migrations, then re-import.`
      break
    }
  }
  return { unique, schema_hint }
}

function buildImportMessage(args: {
  total: number
  inserted: number
  matched: number
  upgraded: number
  skippedInvalid: number
  write: WriteErrorSummary
}): string {
  const { total, inserted, matched, upgraded, skippedInvalid, write } = args
  if (total === 0) return 'The file had no data rows to import.'
  const handled = inserted + matched
  const failedAtWrite = write.unique.reduce((s, e) => s + e.count, 0)

  const parts: string[] = []
  if (handled === total && skippedInvalid === 0 && failedAtWrite === 0) {
    parts.push(`Imported all ${total} rows.`)
  } else {
    parts.push(`Processed ${handled} of ${total}.`)
  }
  // "matched" means the row resolved to a couple already in Bloom
  // (e.g. an inquiry the email backfill created). Spelling that out
  // stops a correctly-deduped import from looking like it did nothing.
  if (matched > 0) {
    parts.push(
      `${inserted} new, ${matched} matched to couples already in Bloom` +
      (upgraded > 0 ? ` — ${upgraded} marked booked` : '') + '.',
    )
  }
  if (skippedInvalid > 0) {
    parts.push(
      `${skippedInvalid} row${skippedInvalid === 1 ? '' : 's'} skipped — the data did not validate (details below).`,
    )
  }
  if (failedAtWrite > 0) {
    parts.push(`${failedAtWrite} could not be saved.`)
    parts.push(write.schema_hint ?? `Reason: ${write.unique[0]!.message}`)
  }
  return parts.join(' ')
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // #88 (T5-followup-CC): cap body size before we let Next.js parse
  // it. content-length is a hint not a guarantee but it's the cheapest
  // pre-parse defense and the request streams through us anyway. 413
  // for over-cap.
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const bytes = Number.parseInt(contentLength, 10)
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES, gotBytes: bytes },
        { status: 413 },
      )
    }
  }

  let body: RequestBody
  try {
    body = (await request.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const adapter = findAdapter(body.adapter ?? '')
  if (!adapter) {
    return NextResponse.json({ error: `unknown adapter: ${body.adapter}` }, { status: 400 })
  }

  // T5-followup-EE (#93). Scaffold-only adapters (`ready: false`) used to
  // fall through to parse() and surface their "not yet implemented" string
  // as a generic 400 — coordinators read it as a parse error and tried
  // re-uploading. Short-circuit BEFORE parse so the rejection is unambiguous.
  // Stream FF is promoting honeybook to a real implementation; once that
  // lands its `ready` flag flips to true and this gate becomes a no-op for it.
  if (adapter.ready === false) {
    return NextResponse.json(
      {
        error: 'adapter_not_implemented',
        adapter: adapter.name,
        message: 'Use generic-csv adapter or contact support.',
      },
      { status: 501 }
    )
  }

  const parsed = await adapter.parse({
    csvText: body.csv,
    jsonText: body.json,
    columnMapping: body.columnMapping,
    // T5-Rixey-II: only the tour-scheduler adapter consumes `provider`;
    // others ignore it. We coerce to the canonical union (silently dropping
    // invalid hints — the adapter falls back to its default in that case).
    provider: coerceProvider(body.provider),
  })

  if (!parsed.ok) {
    return NextResponse.json({
      ok: false,
      adapter: adapter.name,
      ready: adapter.ready,
      errors: parsed.errors,
      warnings: parsed.warnings,
      rows: [],
    }, { status: 400 })
  }

  if (body.preview) {
    const previewResult = adapter.preview(parsed.rows)
    return NextResponse.json({
      ok: true,
      preview: true,
      adapter: adapter.name,
      total: previewResult.total,
      rows: previewResult.rows,
      errors: previewResult.errors,
      warnings: [...parsed.warnings, ...previewResult.warnings],
    })
  }

  // Per-row validation. A row that fails is SKIPPED with a reason the
  // coordinator sees — it does NOT refuse the whole batch. The verified
  // rows still import. commitNormalisedRows rolls back any single row
  // that fails at insert time, so a partial import never leaves orphan
  // wedding shells.
  const rowErrors = validateRows(parsed.rows)
  const validRows: NormalisedLeadRow[] = []
  const skippedInvalid: Array<{ row: number; reasons: string[] }> = []
  parsed.rows.forEach((row, i) => {
    const errs = rowErrors.get(i)
    if (errs && errs.length > 0) skippedInvalid.push({ row: i + 1, reasons: errs })
    else validRows.push(row)
  })

  const supabase = createServiceClient()
  const commitResult =
    validRows.length > 0
      ? await adapter.commit({
          supabase,
          venueId: auth.venueId,
          rows: validRows,
        })
      : {
          ok: true,
          weddingsInserted: 0,
          interactionsInserted: 0,
          toursInserted: 0,
          lostDealsInserted: 0,
          errors: [] as string[],
          touchedWeddingIds: [] as string[],
        }

  // Wave 4 Phase 4c: raw-source persistence + import_runs audit row.
  // The existing endpoint already does the right adapter dispatch; we
  // additionally write the raw CSV to the crm-imports bucket and emit
  // an import_runs row + enqueue identity-reconstruction for every
  // wedding the import touched. Same end state as the unified
  // import-router but reached via the explicit adapter-name path.
  // Errors here are non-fatal — the import itself already committed.
  let importRunId: string | null = null
  let reconstructionEnqueuedCount = 0
  try {
    const { persistAndEnqueueAfterAdapterCommit } = await import(
      '@/lib/services/import-router/route-and-process-after-adapter'
    )
    const persistResult = await persistAndEnqueueAfterAdapterCommit({
      supabase,
      venueId: auth.venueId,
      ingestedBy: auth.userId,
      sourcePath: 'crm-import-onboarding',
      adapterName: adapter.name,
      csvText: body.csv ?? null,
      jsonText: body.json ?? null,
      filename: deriveFilenameFromBody(adapter.name, body),
      commitResult,
    })
    importRunId = persistResult.importRunId
    reconstructionEnqueuedCount = persistResult.reconstructionEnqueuedCount
  } catch (err) {
    console.warn(
      '[crm-import] persistAndEnqueueAfterAdapterCommit failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  const writeErrors = summariseWriteErrors(commitResult.errors)
  const matched = commitResult.weddingsMatchedExisting ?? 0
  const upgraded = commitResult.weddingsStatusUpgraded ?? 0
  const message = buildImportMessage({
    total: parsed.rows.length,
    inserted: commitResult.weddingsInserted,
    matched,
    upgraded,
    skippedInvalid: skippedInvalid.length,
    write: writeErrors,
  })

  // Always 200 — a partial import is a success, not an HTTP error. The
  // `ok` flag + `message` tell the coordinator the real state.
  return NextResponse.json({
    ok:
      commitResult.ok
      && skippedInvalid.length === 0
      && commitResult.errors.length === 0,
    adapter: adapter.name,
    message,
    total_rows: parsed.rows.length,
    weddings_inserted: commitResult.weddingsInserted,
    weddings_matched_existing: matched,
    weddings_status_upgraded: upgraded,
    interactions_inserted: commitResult.interactionsInserted,
    tours_inserted: commitResult.toursInserted,
    lost_deals_inserted: commitResult.lostDealsInserted,
    // Rows that failed pre-commit validation, each with a plain reason.
    skipped_invalid: skippedInvalid,
    // Deduped commit-time failures + a migration hint when applicable.
    write_errors: writeErrors.unique,
    schema_hint: writeErrors.schema_hint,
    errors: commitResult.errors,
    warnings: parsed.warnings,
    import_run_id: importRunId,
    reconstruction_enqueued_count: reconstructionEnqueuedCount,
  }, { status: 200 })
}

function deriveFilenameFromBody(adapterName: string, body: RequestBody): string {
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const ext = body.json ? 'json' : 'csv'
  return `${adapterName}-${ts}.${ext}`
}

export async function GET() {
  // Returns the adapter manifest so the UI provider-picker can render
  // without hardcoding the list.
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { ADAPTERS } = await import('@/lib/services/crm-import')
  return NextResponse.json({
    adapters: ADAPTERS.map((a) => ({
      name: a.name,
      label: a.label,
      description: a.description,
      ready: a.ready,
    })),
  })
}
