import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, forbidden, badRequest } from '@/lib/api/auth-helpers'
import { detectCsvShape } from '@/lib/services/brain-dump/csv-shape'
import { runCsvImport } from '@/app/api/brain-dump/route'

export const maxDuration = 300

/**
 * POST /api/admin/brain-dump/reprocess/[id]
 *
 * One-shot re-processor for brain_dump_entries that were confirmed
 * but never routed. Born from the 2026-05-09 LINDY case: a 43-page
 * PDF was extracted, parked, and confirmed, but the resolve route
 * had no Case for PDF preview confirms — so the entry's routed_to
 * stayed [] and 50K characters of client data sat in
 * parse_result.pdf.extractedText doing nothing.
 *
 * Case J in the resolve route now handles PDF confirms forward.
 * This endpoint covers the historical entries: pulls the entry,
 * detects CSV-shape from the extracted text, and runs the import
 * the original confirm should have run.
 *
 * Hard-scoped to the caller's venueId; entry must belong to it.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return forbidden('no venue scope on session')

  const { id } = await params
  if (!id) return badRequest('entry id is required')

  const supabase = createServiceClient()
  const { data: entry, error } = await supabase
    .from('brain_dump_entries')
    .select('id, venue_id, parse_status, parse_result, routed_to')
    .eq('id', id)
    .single()
  if (error || !entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if (entry.venue_id !== auth.venueId) return forbidden('entry out of scope')

  const pr = (entry.parse_result ?? {}) as Record<string, unknown>
  const pdfShape = pr.pdf as
    | { name: string; extractedText: string; pages?: number | null; truncated?: boolean }
    | undefined
  if (!pdfShape?.extractedText) {
    return badRequest('entry has no extracted PDF text to reprocess')
  }
  const extractedText = pdfShape.extractedText

  // Mirror Case J's CSV-shape detection.
  const firstLineEnd = extractedText.indexOf('\n')
  const candidateHeader =
    firstLineEnd > 0 ? extractedText.slice(0, firstLineEnd) : extractedText.slice(0, 400)
  const headerTokens = candidateHeader
    .split(/\t|\||\s{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
  const detection = detectCsvShape(headerTokens)

  if (detection.shape !== 'unknown' && detection.confidence >= 0.5 && headerTokens.length >= 3) {
    const lines = extractedText.split('\n').slice(1)
    const dataRows = lines
      .map((line) => line.split(/\t|\||\s{2,}/).map((c) => c.trim()).filter(Boolean))
      .filter((row) => row.length >= Math.max(2, Math.floor(headerTokens.length / 2)))

    const summary = await runCsvImport({
      supabase,
      venueId: auth.venueId,
      detection,
      headerRow: headerTokens,
      dataRows,
    })

    await supabase.from('brain_dump_entries').update({
      parse_result: {
        ...pr,
        reprocessed_at: new Date().toISOString(),
        summary,
        pdf_route: 'csv_import_reprocess',
      },
      routed_to: [{ table: 'pdf_csv_import', id: null, action: `reprocess:${detection.shape}:${summary.inserted ?? 0}` }],
    }).eq('id', id)

    return NextResponse.json({
      ok: true,
      entryId: id,
      pdfRoute: 'csv_import',
      detectedShape: detection.shape,
      detectionConfidence: detection.confidence,
      headerTokens,
      summary,
    })
  }

  return NextResponse.json({
    ok: false,
    entryId: id,
    pdfRoute: 'no_csv_shape_detected',
    detectedShape: detection.shape,
    detectionConfidence: detection.confidence,
    headerTokens,
    message: 'Could not detect a CSV shape from the PDF text. The text classifier path is not run here to avoid unintended writes; trigger via the regular brain-dump bubble.',
  })
}
