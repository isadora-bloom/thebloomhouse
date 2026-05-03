/**
 * Web-form intake API (T5-Rixey-HH).
 *
 * POST /api/onboarding/web-form-import
 *   body: {
 *     formProvider: 'rixey_calculator' | 'typeform' | 'jotform' | 'google_forms' | 'custom',
 *     csv: string,
 *     hintOverrides?: Partial<FormHint>,    // override built-in hint columns
 *     columnMapping?: Record<string,string>, // legacy generic-csv style mapping
 *     preview?: boolean,
 *   }
 *
 *   preview=true → parse + return rows for coordinator review (no inserts)
 *   preview=false → parse + commit to weddings/people/interactions/
 *                   tangential_signals
 *
 * GET /api/onboarding/web-form-import → returns the FORM_HINTS manifest
 *   so the UI can render the provider picker without hardcoding the list.
 *
 * Auth: getPlatformAuth — coordinator-only.
 *
 * Mirrors the CRM-import API at /api/onboarding/crm-import: same
 * 5MB body cap, same pre-commit validation gate, same response shape.
 * Kept separate so the two intakes can evolve independently — a venue
 * with both a calculator AND HoneyBook lands data through both paths.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { webFormAdapter, FORM_HINTS, type FormHint } from '@/lib/services/crm-import/web-form'
import type { NormalisedLeadRow } from '@/lib/services/crm-import'

interface RequestBody {
  formProvider?: string
  csv?: string
  hintOverrides?: Partial<FormHint>
  columnMapping?: Record<string, string>
  preview?: boolean
}

const MAX_BODY_BYTES = 5 * 1024 * 1024

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
  })
  return errors
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

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

  // Pass through to the adapter via its standard parse() signature.
  // The adapter's parseWebForm reads cfg.formProvider + cfg.hintOverrides.
  const parsed = await webFormAdapter.parse({
    csvText: body.csv,
    columnMapping: body.columnMapping,
    // Adapter widens AdapterConfig at the type level — these extra
    // keys are picked up by the parseWebForm cast.
    ...({ formProvider: body.formProvider, hintOverrides: body.hintOverrides } as Record<string, unknown>),
  })

  if (!parsed.ok) {
    return NextResponse.json({
      ok: false,
      adapter: 'web_form',
      errors: parsed.errors,
      warnings: parsed.warnings,
      rows: [],
    }, { status: 400 })
  }

  if (body.preview) {
    const previewResult = webFormAdapter.preview(parsed.rows)
    return NextResponse.json({
      ok: true,
      preview: true,
      adapter: 'web_form',
      total: previewResult.total,
      rows: previewResult.rows,
      errors: previewResult.errors,
      warnings: [...parsed.warnings, ...previewResult.warnings],
    })
  }

  const validationErrors = validateAllRows(parsed.rows)
  if (validationErrors.length > 0) {
    return NextResponse.json({
      ok: false,
      adapter: 'web_form',
      errors: validationErrors,
      warnings: parsed.warnings,
      reason: 'validation_failed_pre_commit',
      rows: [],
    }, { status: 400 })
  }

  const supabase = createServiceClient()
  const commitResult = await webFormAdapter.commit({
    supabase,
    venueId: auth.venueId,
    rows: parsed.rows,
  })

  return NextResponse.json({
    ok: commitResult.ok,
    adapter: 'web_form',
    weddings_inserted: commitResult.weddingsInserted,
    interactions_inserted: commitResult.interactionsInserted,
    tours_inserted: commitResult.toursInserted,
    lost_deals_inserted: commitResult.lostDealsInserted,
    errors: commitResult.errors,
    warnings: parsed.warnings,
  }, { status: commitResult.ok ? 200 : 500 })
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  return NextResponse.json({
    hints: FORM_HINTS.map((h) => ({
      provider: h.provider,
      label: h.label,
      description: h.description,
      // Surface the configured columns so the UI can show "Looks for: X, Y, Z".
      configuredColumns: {
        date: h.dateColumn ?? null,
        contactEmail: h.contactEmailColumn ?? null,
        contactName: h.contactNameColumn ?? null,
        partnerEmail: h.partnerEmailColumn ?? null,
        partnerName: h.partnerNameColumn ?? null,
        weddingDate: h.weddingDateColumn ?? null,
        guestCount: h.guestCountColumn ?? null,
        notes: h.notesColumn ?? null,
        packages: h.packageColumns ?? [],
        upgrades: h.upgradeColumns ?? [],
        discounts: h.discountColumns ?? [],
        calculatedTotal: h.calculatedTotalColumn ?? null,
      },
    })),
  })
}
