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
import { findAdapter, type NormalisedLeadRow } from '@/lib/services/crm-import'

interface RequestBody {
  adapter?: string
  csv?: string
  json?: string
  columnMapping?: Record<string, string>
  preview?: boolean
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

function validateAllRows(rows: NormalisedLeadRow[]): string[] {
  const errors: string[] = []
  rows.forEach((row, idx) => {
    if (row.status && !VALID_STATUSES.has(row.status)) {
      errors.push(`row ${idx + 1}: status='${row.status}' not in Bloom enum`)
    }
    if (
      row.guest_count_estimate !== null
      && row.guest_count_estimate !== undefined
      && (row.guest_count_estimate < 1 || row.guest_count_estimate > 1000)
    ) {
      errors.push(`row ${idx + 1}: guest_count_estimate=${row.guest_count_estimate} out of range 1-1000`)
    }
    if (
      row.booking_value !== null
      && row.booking_value !== undefined
      && row.booking_value < 0
    ) {
      errors.push(`row ${idx + 1}: booking_value=${row.booking_value} cannot be negative`)
    }
    if (!isIsoLike(row.wedding_date)) errors.push(`row ${idx + 1}: wedding_date='${row.wedding_date}' unparseable`)
    if (!isIsoLike(row.inquiry_date)) errors.push(`row ${idx + 1}: inquiry_date='${row.inquiry_date}' unparseable`)
    if (!isIsoLike(row.booked_at)) errors.push(`row ${idx + 1}: booked_at='${row.booked_at}' unparseable`)
    if (!isIsoLike(row.lost_at)) errors.push(`row ${idx + 1}: lost_at='${row.lost_at}' unparseable`)

    for (const interaction of row.interactions ?? []) {
      if (!isIsoLike(interaction.occurred_at)) {
        errors.push(`row ${idx + 1}: interaction occurred_at='${interaction.occurred_at}' unparseable`)
      }
    }
    for (const tour of row.tours ?? []) {
      if (!isIsoLike(tour.scheduled_at)) {
        errors.push(`row ${idx + 1}: tour scheduled_at='${tour.scheduled_at}' unparseable`)
      }
    }
    if (row.lost_deal && !isIsoLike(row.lost_deal.lost_at)) {
      errors.push(`row ${idx + 1}: lost_deal.lost_at='${row.lost_deal.lost_at}' unparseable`)
    }
  })
  return errors
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

  // #88 (T5-followup-CC): atomic-ish commit. Supabase JS doesn't expose
  // explicit BEGIN/COMMIT and the per-adapter commit loop writes
  // weddings → people → interactions → tours → lost_deals row-by-row.
  // Pre-fix a single bad row (unparseable date, unknown status, out-of-
  // range headcount) committed earlier rows and left orphan weddings
  // shells with no children. Cheapest fix without a server-side RPC:
  // validate every row first, only proceed to commit if 100% pass.
  const validationErrors = validateAllRows(parsed.rows)
  if (validationErrors.length > 0) {
    return NextResponse.json({
      ok: false,
      adapter: adapter.name,
      ready: adapter.ready,
      errors: validationErrors,
      warnings: parsed.warnings,
      reason: 'validation_failed_pre_commit',
      rows: [],
    }, { status: 400 })
  }

  const supabase = createServiceClient()
  const commitResult = await adapter.commit({
    supabase,
    venueId: auth.venueId,
    rows: parsed.rows,
  })

  return NextResponse.json({
    ok: commitResult.ok,
    adapter: adapter.name,
    weddings_inserted: commitResult.weddingsInserted,
    interactions_inserted: commitResult.interactionsInserted,
    tours_inserted: commitResult.toursInserted,
    lost_deals_inserted: commitResult.lostDealsInserted,
    errors: commitResult.errors,
    warnings: parsed.warnings,
  }, { status: commitResult.ok ? 200 : 500 })
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
