import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { classifyEmail } from '@/lib/services/router-brain'

// ---------------------------------------------------------------------------
// POST /api/agent/reprocess-orphans
//
// For inbound interactions that have a resolved person_id but no wedding_id
// (the legacy of findOrCreateContact returning personId=null, which caused
// the pipeline's wedding-creation step to create the wedding but skip the
// people link — or to bail before wedding creation entirely), re-run the
// AI classifier and do the linkage this time.
//
// Three outcomes per row:
//   link_existing: the person is already attached to a wedding (from a
//     later email in the same thread or a manual link). Just stamp
//     interactions.wedding_id and move on.
//   create_inquiry: classifier says new_inquiry. Create a weddings row
//     with status='inquiry', attach the person to it, stamp the
//     interaction.
//   skip: anything else (vendor, spam, internal, low-confidence). Leave
//     the interaction orphaned; the user can map it manually in
//     /agent/codes if needed.
//
// Chunked: processes up to ?limit= rows per call (default 25, max 100).
// Classification is an AI call so we keep batches small. Call repeatedly
// until `remaining` drops to 0.
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const rawLimit = Number(url.searchParams.get('limit') ?? '25')
  const limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 25))

  const venueId = auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Candidates: inbound emails in this venue with a person_id but no wedding_id.
  const { data: candidates, error: candidatesError } = await supabase
    .from('interactions')
    .select('id, person_id, from_email, from_name, subject, full_body, timestamp')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .is('wedding_id', null)
    .not('person_id', 'is', null)
    .order('timestamp', { ascending: true })
    .limit(limit)

  if (candidatesError) {
    return NextResponse.json({ error: candidatesError.message }, { status: 500 })
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ processed: 0, remaining: 0, linked: 0, created: 0, skipped: 0 })
  }

  let linked = 0
  let created = 0
  let skipped = 0

  for (const row of candidates) {
    const personId = row.person_id as string

    // 1. If the person is already attached to a wedding, just stamp the
    //    interaction and move on. Avoids a classifier call.
    const { data: person } = await supabase
      .from('people')
      .select('wedding_id, first_name, last_name, email')
      .eq('id', personId)
      .maybeSingle()

    if (person?.wedding_id) {
      await supabase
        .from('interactions')
        .update({ wedding_id: person.wedding_id })
        .eq('id', row.id)
      linked++
      continue
    }

    // 2. Classify the email. Skip anything not clearly an inquiry.
    let classification: Awaited<ReturnType<typeof classifyEmail>>
    try {
      classification = await classifyEmail(venueId, {
        from: (row.from_email as string) || '',
        subject: (row.subject as string) || '',
        body: (row.full_body as string) || '',
      })
    } catch (err) {
      console.error(`[reprocess-orphans] classify failed for ${row.id}:`, err)
      skipped++
      continue
    }

    const cls = classification.classification
    const isInquiry = cls === 'new_inquiry' || cls === 'inquiry_reply'
    if (!isInquiry || classification.confidence < 50) {
      skipped++
      continue
    }

    // 3. Create a weddings row in status='inquiry' and link the person.
    const detectedSource = classification.extractedData?.source ?? 'direct'
    const { data: newWedding, error: weddingError } = await supabase
      .from('weddings')
      .insert({
        venue_id: venueId,
        status: 'inquiry',
        source: detectedSource,
        inquiry_date: (row.timestamp as string) ?? new Date().toISOString(),
        heat_score: 0,
        temperature_tier: 'cool',
      })
      .select('id')
      .single()

    if (weddingError || !newWedding) {
      console.error(`[reprocess-orphans] wedding create failed for ${row.id}:`, weddingError?.message)
      skipped++
      continue
    }

    const weddingId = newWedding.id as string

    // Link the person to the wedding.
    await supabase
      .from('people')
      .update({ wedding_id: weddingId })
      .eq('id', personId)

    // Stamp this interaction.
    await supabase
      .from('interactions')
      .update({ wedding_id: weddingId })
      .eq('id', row.id)

    // Also stamp any other interactions from the same person that are still
    // orphaned — they're part of the same lead.
    await supabase
      .from('interactions')
      .update({ wedding_id: weddingId })
      .eq('venue_id', venueId)
      .eq('person_id', personId)
      .is('wedding_id', null)

    created++
  }

  // How many remain?
  const { count: remaining } = await supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .is('wedding_id', null)
    .not('person_id', 'is', null)

  return NextResponse.json({
    processed: candidates.length,
    linked,
    created,
    skipped,
    remaining: remaining ?? 0,
  })
}
