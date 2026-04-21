import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST /api/agent/backfill-unknown-couples
//
// Existing weddings on the pipeline kanban render as "Unknown" when the
// linked partner1 person has null first_name AND null last_name. That
// happens for forwarded-format inquiries (The Knot Pro Network,
// WeddingWire, etc.) where the from_name is the network itself and the
// couple's real name is buried inside the email body. The classifier
// extracted that name into extractedData.senderName — we just never
// wrote it back onto the person row.
//
// This endpoint scans partner1 people with null names, looks up the
// latest intelligence_extractions row for the same wedding, and if it
// carries a senderName in metadata.extractedData, patches the person.
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const venueId = auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // 1. Find nameless partner1 rows that are attached to a wedding.
  const { data: nameless, error: namelessErr } = await supabase
    .from('people')
    .select('id, wedding_id')
    .eq('venue_id', venueId)
    .eq('role', 'partner1')
    .not('wedding_id', 'is', null)
    .is('first_name', null)
    .is('last_name', null)

  if (namelessErr) {
    return NextResponse.json({ error: namelessErr.message }, { status: 500 })
  }

  if (!nameless || nameless.length === 0) {
    return NextResponse.json({ scanned: 0, patched: 0 })
  }

  let patched = 0
  let noExtraction = 0
  let noSender = 0

  for (const p of nameless) {
    const weddingId = p.wedding_id as string

    // Most recent extraction for this wedding.
    const { data: extractions } = await supabase
      .from('intelligence_extractions')
      .select('metadata')
      .eq('wedding_id', weddingId)
      .eq('extraction_type', 'inquiry_classification')
      .order('created_at', { ascending: false })
      .limit(1)

    if (!extractions || extractions.length === 0) {
      noExtraction++
      continue
    }

    const meta = (extractions[0].metadata ?? {}) as {
      extractedData?: { senderName?: string | null }
    }
    const senderName = meta.extractedData?.senderName?.trim() || ''
    if (!senderName) {
      noSender++
      continue
    }

    const [first, ...rest] = senderName.split(/\s+/)
    const last = rest.join(' ') || null
    if (!first) {
      noSender++
      continue
    }

    const { error: updErr } = await supabase
      .from('people')
      .update({ first_name: first, last_name: last })
      .eq('id', p.id as string)

    if (!updErr) patched++
  }

  return NextResponse.json({
    scanned: nameless.length,
    patched,
    noExtraction,
    noSender,
  })
}
