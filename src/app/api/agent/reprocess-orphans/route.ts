import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { classifyEmail } from '@/lib/services/router-brain'

// Accepts "2026-06-14", "June 14, 2026", "6/14/26" etc. Returns an ISO
// date string (YYYY-MM-DD) or null if we can't parse.
function parseEventDate(raw: unknown): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

// Accepts a number or a string like "150" / "~150 guests". Returns an
// integer or null.
function parseGuestCount(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw)
  if (typeof raw === 'string') {
    const m = raw.match(/\d+/)
    if (m) return parseInt(m[0], 10)
  }
  return null
}

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
    const extracted = classification.extractedData ?? {}
    // Tightened guard: must be an inquiry at high confidence AND the
    // classifier must have pulled at least one wedding-shaped signal
    // (event date, guest count, or named partner). Marketing blasts and
    // vendor solicitations almost never trigger all three at once.
    const hasWeddingSignal =
      Boolean(extracted.eventDate) ||
      Boolean(extracted.guestCount) ||
      Boolean(extracted.partnerName)
    if (!isInquiry || classification.confidence < 70 || !hasWeddingSignal) {
      skipped++
      continue
    }

    // 3. Create a weddings row in status='inquiry' and link the person.
    const detectedSource = extracted.source ?? 'direct'
    const parsedEventDate = parseEventDate(extracted.eventDate)
    const parsedGuestCount = parseGuestCount(extracted.guestCount)
    const { data: newWedding, error: weddingError } = await supabase
      .from('weddings')
      .insert({
        venue_id: venueId,
        status: 'inquiry',
        source: detectedSource,
        inquiry_date: (row.timestamp as string) ?? new Date().toISOString(),
        wedding_date: parsedEventDate,
        guest_count_estimate: parsedGuestCount,
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

    // Second partner: if the classifier extracted a name, seed a partner2
    // people row so the detail page has a couple label to render. Skip if
    // one already exists on this wedding.
    if (extracted.partnerName) {
      const { data: existingPartner2 } = await supabase
        .from('people')
        .select('id')
        .eq('wedding_id', weddingId)
        .eq('role', 'partner2')
        .maybeSingle()
      if (!existingPartner2) {
        const [p2First, ...p2Rest] = extracted.partnerName.trim().split(/\s+/)
        const p2Last = p2Rest.join(' ') || null
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          role: 'partner2',
          first_name: p2First || null,
          last_name: p2Last,
        })
      }
    }

    // Persist the full classifier blob for the intel layer + client page.
    await supabase.from('intelligence_extractions').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      interaction_id: row.id as string,
      extraction_type: 'inquiry_classification',
      confidence: classification.confidence / 100,
      metadata: {
        classification: cls,
        confidence: classification.confidence,
        extractedData: extracted,
        via: 'reprocess-orphans',
      },
    })

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
