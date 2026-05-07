/**
 * Pricing-history reconstruction API (T5-followup-Y / Pattern I closure).
 *
 * GET  /api/onboarding/pricing-history
 *   → list existing rows for the venue (most recent first)
 *
 * POST /api/onboarding/pricing-history
 *   body: { mode: 'single', package_name, effective_date, prior_price?,
 *           new_price, notes? }
 *     → insert one manual_form row
 *   body: { mode: 'csv', csv: string, preview?: boolean }
 *     → parse CSV, insert all rows (or return preview)
 *
 * DELETE /api/onboarding/pricing-history?id=<uuid>
 *   → delete a manually-entered row (only manual_form / manual_csv —
 *     trigger-fired rows are append-only)
 *
 * Auth: getPlatformAuth — coordinator-only.
 *
 * Validation per spec:
 *   - effective_date must be in past 5 years
 *   - prices > 0 cents and <= 100,000,00 cents ($1M)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'

const FIVE_YEARS_MS = 5 * 365 * 86_400_000
const MAX_PRICE_CENTS = 1_000_000 * 100  // $1,000,000

interface SingleRowBody {
  mode: 'single'
  package_name: string
  effective_date: string  // yyyy-mm-dd
  prior_price?: number | null  // cents
  new_price: number       // cents
  notes?: string | null
}

interface CsvBody {
  mode: 'csv'
  csv: string
  preview?: boolean
}

interface ParsedCsvRow {
  package_name: string
  effective_date: string
  prior_price: number | null
  new_price: number
  rowIndex: number
}

interface CsvParseOutcome {
  rows: ParsedCsvRow[]
  errors: string[]
}

function validateEffectiveDate(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'invalid date'
  const now = Date.now()
  if (d.getTime() > now) return 'effective_date must not be in the future'
  if (now - d.getTime() > FIVE_YEARS_MS) return 'effective_date must be within the past 5 years'
  return null
}

function validatePriceCents(p: unknown): string | null {
  if (typeof p !== 'number' || !Number.isFinite(p)) return 'must be a number'
  if (p <= 0) return 'must be > 0'
  if (p > MAX_PRICE_CENTS) return 'must be <= $1,000,000'
  if (!Number.isInteger(p)) return 'must be an integer (cents)'
  return null
}

function parseHistoricalCsv(csv: string): CsvParseOutcome {
  const errors: string[] = []
  const rows: ParsedCsvRow[] = []
  const csvRows = parseCsvRows(csv)
  if (csvRows.length < 2) {
    return { rows, errors: ['csv must include a header row + at least one data row'] }
  }
  const header = csvRows[0].map((h) => h.trim().toLowerCase())
  const required = ['package_name', 'effective_date', 'new_price']
  for (const r of required) {
    if (!header.includes(r)) errors.push(`csv missing required column: ${r}`)
  }
  if (errors.length) return { rows, errors }

  const idx = (col: string): number => header.indexOf(col)
  const pkgIdx = idx('package_name')
  const dateIdx = idx('effective_date')
  const priorIdx = idx('prior_price')
  const newIdx = idx('new_price')

  for (let i = 1; i < csvRows.length; i++) {
    const data = csvRows[i]
    const pkg = (data[pkgIdx] ?? '').trim()
    const date = (data[dateIdx] ?? '').trim()
    const priorRaw = priorIdx >= 0 ? (data[priorIdx] ?? '').trim() : ''
    const newRaw = (data[newIdx] ?? '').trim()
    if (!pkg || !date || !newRaw) {
      errors.push(`row ${i}: missing package_name / effective_date / new_price`)
      continue
    }
    const dateErr = validateEffectiveDate(date)
    if (dateErr) {
      errors.push(`row ${i}: effective_date — ${dateErr}`)
      continue
    }
    const priorCents = priorRaw ? Math.round(Number(priorRaw.replace(/[$,\s]/g, '')) * 100) : null
    const newCents = Math.round(Number(newRaw.replace(/[$,\s]/g, '')) * 100)
    const newErr = validatePriceCents(newCents)
    if (newErr) {
      errors.push(`row ${i}: new_price — ${newErr}`)
      continue
    }
    if (priorCents != null) {
      const priorErr = validatePriceCents(priorCents)
      if (priorErr) {
        errors.push(`row ${i}: prior_price — ${priorErr}`)
        continue
      }
    }
    rows.push({
      package_name: pkg,
      effective_date: date,
      prior_price: priorCents,
      new_price: newCents,
      rowIndex: i,
    })
  }
  return { rows, errors }
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('pricing_history')
    .select('id, field_name, old_value, new_value, context, notes, source_provenance, confidence_flag, changed_at')
    .eq('venue_id', auth.venueId)
    .order('changed_at', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rows: data ?? [] })
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: SingleRowBody | CsvBody
  try {
    body = (await request.json()) as SingleRowBody | CsvBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (body.mode === 'single') {
    const { package_name, effective_date, prior_price, new_price, notes } = body
    if (!package_name || !package_name.trim()) {
      return NextResponse.json({ error: 'package_name is required' }, { status: 400 })
    }
    const dateErr = validateEffectiveDate(effective_date)
    if (dateErr) return NextResponse.json({ error: `effective_date: ${dateErr}` }, { status: 400 })
    const newErr = validatePriceCents(new_price)
    if (newErr) return NextResponse.json({ error: `new_price: ${newErr}` }, { status: 400 })
    if (prior_price != null) {
      const priorErr = validatePriceCents(prior_price)
      if (priorErr) return NextResponse.json({ error: `prior_price: ${priorErr}` }, { status: 400 })
    }

    const { error } = await supabase.from('pricing_history').insert({
      venue_id: auth.venueId,
      field_name: package_name.trim(),
      old_value: prior_price != null ? { value: prior_price } : null,
      new_value: { value: new_price },
      changed_by: auth.isDemo ? null : auth.userId,
      changed_at: new Date(effective_date).toISOString(),
      context: 'manual_form',
      notes: notes?.trim() || null,
      source_provenance: 'manual_form',
      confidence_flag: 'imported_high',
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, inserted: 1 })
  }

  if (body.mode === 'csv') {
    if (!body.csv || !body.csv.trim()) {
      return NextResponse.json({ error: 'csv content is empty' }, { status: 400 })
    }
    const { rows, errors } = parseHistoricalCsv(body.csv)
    if (body.preview) {
      return NextResponse.json({
        preview: rows.map((r) => ({
          package_name: r.package_name,
          effective_date: r.effective_date,
          prior_price: r.prior_price,
          new_price: r.new_price,
        })),
        total: rows.length,
        errors,
      })
    }
    if (errors.length) {
      return NextResponse.json({ error: 'csv has validation errors', details: errors }, { status: 400 })
    }
    if (rows.length === 0) {
      return NextResponse.json({ error: 'no rows to insert' }, { status: 400 })
    }
    const payloads = rows.map((r) => ({
      venue_id: auth.venueId,
      field_name: r.package_name,
      old_value: r.prior_price != null ? { value: r.prior_price } : null,
      new_value: { value: r.new_price },
      changed_by: auth.isDemo ? null : auth.userId,
      changed_at: new Date(r.effective_date).toISOString(),
      context: 'manual_csv',
      source_provenance: 'manual_csv',
      confidence_flag: 'imported_high' as const,
    }))
    const { error } = await supabase.from('pricing_history').insert(payloads)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, inserted: payloads.length })
  }

  return NextResponse.json({ error: 'unknown mode' }, { status: 400 })
}

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const id = request.nextUrl.searchParams.get('id')
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }
  const supabase = createServiceClient()
  // Verify the row belongs to the caller's venue + is manual-source
  // (trigger rows are append-only).
  const { data: row } = await supabase
    .from('pricing_history')
    .select('venue_id, source_provenance')
    .eq('id', id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (row.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (row.source_provenance !== 'manual_form' && row.source_provenance !== 'manual_csv') {
    return NextResponse.json({ error: 'only manual rows can be deleted' }, { status: 400 })
  }
  const { error } = await supabase.from('pricing_history').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
