import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { detectCsvShape, parseCsvRows } from '@/lib/services/brain-dump-csv-shape'
import { runCsvImport } from '@/app/api/brain-dump/route'
import { importReviews } from '@/lib/services/brain-dump-imports'

/**
 * Resolve a pending brain-dump clarification.
 *
 * POST /api/brain-dump/:id/resolve
 * Body: { action: 'confirm' | 'dismiss', answer?: string }
 *
 * On confirm:
 *   - If parse_result describes a CSV preview (shape + storagePath), the
 *     CSV is re-downloaded from storage, parsed, and imported via the
 *     same pipeline that runs small CSVs inline.
 *   - If parse_result contains a vision reviews array that was parked
 *     for confirmation, import those reviews.
 *   - Otherwise, we just stamp clarification_answer + resolved_at.
 *
 * Dismiss always simply stamps status + resolved_at.
 *
 * Venue-scoped: the entry's venue_id must match the caller's venue.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing entry id' }, { status: 400 })

  let body: { action?: string; answer?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const action = body.action
  if (action !== 'confirm' && action !== 'dismiss') {
    return NextResponse.json({ error: 'action must be "confirm" or "dismiss"' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: entry, error: fetchErr } = await supabase
    .from('brain_dump_entries')
    .select('id, venue_id, parse_status, parse_result')
    .eq('id', id)
    .single()
  if (fetchErr || !entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if (entry.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (action === 'dismiss') {
    await supabase.from('brain_dump_entries').update({
      parse_status: 'dismissed',
      resolved_at: new Date().toISOString(),
    }).eq('id', id)
    return NextResponse.json({ id, status: 'dismissed' })
  }

  // Confirm — look for an actionable preview in parse_result.
  const pr = (entry.parse_result ?? {}) as Record<string, unknown>

  // Case A: CSV preview (shape + storagePath).
  if (pr.shape && pr.storagePath && typeof pr.shape === 'string' && typeof pr.storagePath === 'string') {
    const { data: file } = await supabase.storage.from('brain-dump').download(pr.storagePath)
    if (!file) {
      return NextResponse.json({ error: 'Stored CSV could not be read' }, { status: 500 })
    }
    const text = await file.text()
    const rows = parseCsvRows(text)
    const headerRow = rows[0] ?? []
    const dataRows = rows.slice(1)
    const detection = detectCsvShape(headerRow)
    const summary = await runCsvImport({
      supabase, venueId: auth.venueId, detection, headerRow, dataRows,
    })
    await supabase.from('brain_dump_entries').update({
      parse_status: 'confirmed',
      clarification_answer: body.answer?.trim() ?? null,
      parse_result: { ...pr, summary, confirmed_at: new Date().toISOString() },
      resolved_at: new Date().toISOString(),
    }).eq('id', id)
    return NextResponse.json({ id, status: 'confirmed', importSummary: summary })
  }

  // Case B: Vision reviews parked for confirm (rare — reviews path
  // currently imports inline, but a future flow may gate behind preview).
  if (pr.vision && typeof pr.vision === 'object') {
    const v = pr.vision as { intent?: string; reviews?: Array<{ reviewer_name: string; rating: number; body: string; review_date?: string | null; source?: string }> }
    if (v.intent === 'reviews' && v.reviews?.length) {
      const summary = await importReviews({
        supabase,
        venueId: auth.venueId,
        rows: v.reviews.map((r) => ({
          source: (r.source ?? 'other').toLowerCase(),
          reviewer_name: r.reviewer_name,
          rating: r.rating,
          body: r.body,
          review_date: r.review_date ?? null,
        })),
      })
      await supabase.from('brain_dump_entries').update({
        parse_status: 'confirmed',
        clarification_answer: body.answer?.trim() ?? null,
        parse_result: { ...pr, summary, confirmed_at: new Date().toISOString() },
        resolved_at: new Date().toISOString(),
      }).eq('id', id)
      return NextResponse.json({ id, status: 'confirmed', importSummary: summary })
    }
  }

  // Case C: plain clarification — just stamp the status and the answer.
  const updates: Record<string, unknown> = {
    parse_status: 'confirmed',
    resolved_at: new Date().toISOString(),
  }
  if (body.answer?.trim()) updates.clarification_answer = body.answer.trim()
  await supabase.from('brain_dump_entries').update(updates).eq('id', id)
  return NextResponse.json({ id, status: 'confirmed' })
}
