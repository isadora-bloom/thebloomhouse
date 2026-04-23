import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  upsertSpendRows,
  parseSpendCsv,
  extractSpendFromText,
  type SpendRow,
} from '@/lib/services/marketing-spend'

/**
 * POST /api/intel/spend
 *
 * Multi-channel ad-spend import. Body shape variants:
 *
 *   (A) Form row(s):
 *       { mode: 'rows', rows: SpendRow[] }
 *   (B) CSV text:
 *       { mode: 'csv', csv: string }
 *   (C) Free-text / brain-dump:
 *       { mode: 'text', text: string }
 *
 * All three land in marketing_spend via upsertSpendRows. Dedup on
 * (venue_id, source, month). Returns an ImportResult + preview (the
 * parsed rows) so the UI can show "I found 4 rows — import?" before
 * persisting on a second call. Two-step import is opt-in via
 * ?preview=true query — default is commit.
 */
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const preview = request.nextUrl.searchParams.get('preview') === 'true'

  let body: { mode?: 'rows' | 'csv' | 'text'; rows?: SpendRow[]; csv?: string; text?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let rows: SpendRow[] = []
  const errors: string[] = []

  if (body.mode === 'rows' && Array.isArray(body.rows)) {
    rows = body.rows
  } else if (body.mode === 'csv' && typeof body.csv === 'string') {
    const parsed = parseSpendCsv(body.csv)
    rows = parsed.rows
    errors.push(...parsed.errors)
  } else if (body.mode === 'text' && typeof body.text === 'string') {
    const extracted = await extractSpendFromText({
      venueId: auth.venueId,
      text: body.text,
    })
    rows = extracted.rows
    errors.push(...extracted.errors)
  } else {
    return NextResponse.json(
      { error: 'mode must be "rows" | "csv" | "text" with matching payload' },
      { status: 400 }
    )
  }

  if (preview || rows.length === 0) {
    return NextResponse.json({
      preview: true,
      rowsPreview: rows,
      errors,
    })
  }

  const result = await upsertSpendRows({ venueId: auth.venueId, rows })
  return NextResponse.json({
    preview: false,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    rows: result.rows,
    errors: [...errors, ...result.errors],
  })
}
