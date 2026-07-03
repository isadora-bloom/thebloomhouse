import { NextRequest, NextResponse } from 'next/server'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { parseSeatingFile, commitSeatingChart, type ParsedSeatingChart } from '@/lib/services/couple-portal/seating-import'

const MAX_BYTES = 20 * 1024 * 1024 // 20 MB

const ACCEPTED_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel',                                           // xls
  'text/csv',
  'application/csv',
])

// ---------------------------------------------------------------------------
// POST /api/couple/seating/import
// action=parse  → parse xlsx, return preview (no DB writes)
// action=commit → write parsed chart to DB
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return badRequest('Expected multipart/form-data')
  }

  const action = (formData.get('action') as string | null) ?? 'parse'

  // ---- COMMIT ----
  if (action === 'commit') {
    const chartJson = formData.get('chart') as string | null
    const replace = formData.get('replaceExisting') === 'true'
    if (!chartJson) return badRequest('Missing chart data')

    let chart: ParsedSeatingChart
    try {
      chart = JSON.parse(chartJson)
    } catch {
      return badRequest('Invalid chart JSON')
    }

    try {
      const result = await commitSeatingChart({
        venueId: auth.venueId,
        weddingId: auth.weddingId,
        chart,
        replaceExisting: replace,
      })
      return NextResponse.json({ ok: true, ...result })
    } catch (error) {
      return serverError(error)
    }
  }

  // ---- PARSE ----
  const file = formData.get('file')
  if (!(file instanceof File)) return badRequest('Missing file')

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large. Max ${Math.round(MAX_BYTES / 1024 / 1024)} MB.` },
      { status: 413 },
    )
  }

  const mime = (file.type || '').toLowerCase().split(';')[0].trim()
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (!ACCEPTED_TYPES.has(mime) && ext !== 'xlsx' && ext !== 'xls' && ext !== 'csv') {
    return badRequest('Only .xlsx, .xls, or .csv files are accepted.')
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const chart = await parseSeatingFile(buffer, file.name)
    return NextResponse.json({ chart })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to parse file'
    return NextResponse.json({ error: msg }, { status: 422 })
  }
}
