import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { classifyEmail } from '@/lib/services/brain/router'
import { parseFuzzyDate, parseGuestCount } from '@/lib/services/fuzzy-date'
import { normalizeSource } from '@/lib/services/normalize-source'
// Migrated to mintWedding 2026-05-12. See docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
import { mintWedding } from '@/lib/services/identity/mint-wedding'

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

  // Pull the venue's own Gmail connection addresses. Any interaction whose
  // from_email matches these is the venue/Sage itself — their own outbound
  // showing up in the thread — and must NEVER be promoted to an inquiry.
  // This is what creates the "Sage at Rixey Manor" ghost on the pipeline.
  const { data: connectionsData } = await supabase
    .from('gmail_connections')
    .select('email_address')
    .eq('venue_id', venueId)
  const selfEmails = new Set(
    ((connectionsData ?? []) as Array<{ email_address: string }>)
      .map((c) => (c.email_address || '').toLowerCase().trim())
      .filter(Boolean)
  )

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

    // 0. Self-filter: if the sender is one of the venue's own Gmail
    //    connections, this is Sage/the coordinator replying in-thread, not a
    //    couple inquiring. Skip silently — we never want a pipeline entry
    //    with the venue itself as the "couple".
    const fromEmailLower = ((row.from_email as string) || '').toLowerCase().trim()
    if (fromEmailLower && selfEmails.has(fromEmailLower)) {
      skipped++
      continue
    }

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
    // Guard: classification must be inquiry-family at reasonable confidence.
    // We do NOT require a wedding signal (eventDate/guestCount/partnerName)
    // because forwarded-format emails (The Knot Pro Network, WeddingWire)
    // wrap the real message in preamble/boilerplate the classifier often
    // can't parse extractedData from. False positives are caught by a
    // cheap marketing-body keyword check instead.
    const body = ((row.full_body as string) || '').toLowerCase()
    const looksMarketing =
      body.includes('unsubscribe') ||
      body.includes('view in browser') ||
      body.includes('update your preferences') ||
      body.includes('promotional offer') ||
      body.includes('you are receiving this')
    if (!isInquiry || classification.confidence < 65 || looksMarketing) {
      skipped++
      continue
    }

    // 3. Mint a wedding via the canonical chokepoint. The resolver will
    //    attach to an existing wedding if the person already has one
    //    (e.g. same email arrived twice in the same orphan sweep).
    // Migrated to mintWedding 2026-05-12. See docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
    const detectedSource = normalizeSource(extracted.source ?? 'direct')
    const parsedEventDateObj = parseFuzzyDate(extracted.eventDate)
    const parsedEventDate = parsedEventDateObj?.iso ?? null
    const parsedGuestCount = parseGuestCount(extracted.guestCount)
    // Prefer the classifier's extracted senderName for the resolver's
    // fullName signal. Falls back to from_name and then email local-part
    // upstream in the resolver.
    const resolverFullName =
      (extracted.senderName as string | null | undefined)?.trim()
        || (row.from_name as string | null) || null
    let weddingId: string
    try {
      const minted = await mintWedding({
        venueId,
        source: 'reprocess_orphans',
        reason: 'reprocess_orphan',
        supabase,
        signals: {
          email: (row.from_email as string | null) ?? null,
          fullName: resolverFullName,
          partner1Name: resolverFullName,
          partner2Name: (extracted.partnerName as string | null | undefined) ?? null,
          weddingDate: parsedEventDate,
          inquiryDate: (row.timestamp as string) ?? null,
          guestCount: parsedGuestCount ?? null,
        },
      })
      weddingId = minted.weddingId
    } catch (mintErr) {
      console.error(`[reprocess-orphans] mintWedding failed for ${row.id}:`,
        mintErr instanceof Error ? mintErr.message : mintErr)
      skipped++
      continue
    }

    // Stamp the extra inquiry signal fields the resolver doesn't carry
    // (source / precision / guest_count_estimate). Only fills nulls so
    // re-running on an already-attached wedding is idempotent.
    const inquiryUpdate: Record<string, unknown> = {}
    if (detectedSource) inquiryUpdate.source = detectedSource
    if (parsedEventDateObj?.precision) inquiryUpdate.wedding_date_precision = parsedEventDateObj.precision
    if (parsedGuestCount != null) inquiryUpdate.guest_count_estimate = parsedGuestCount
    if (Object.keys(inquiryUpdate).length > 0) {
      await supabase
        .from('weddings')
        .update(inquiryUpdate)
        .eq('id', weddingId)
    }

    // Link the original person_id (from the interaction) to the wedding.
    // mintWedding resolves to a canonical person via the match chain,
    // which may be a DIFFERENT row than row.person_id when the resolver
    // matched by email-canonical / phone. Stamp the original row's
    // wedding_id so the legacy interaction link is intact.
    // Also backfill first/last name when missing — for Knot/WeddingWire
    // forwards the from_name is the network ("The Knot"), not the
    // couple, so the people row was created nameless. The classifier
    // pulled the actual sender out of the body into
    // extractedData.senderName; use that to give the pipeline kanban a
    // real label instead of "Unknown".
    const personUpdate: Record<string, unknown> = { wedding_id: weddingId }
    if (!person?.first_name && !person?.last_name && extracted.senderName) {
      const [sFirst, ...sRest] = extracted.senderName.trim().split(/\s+/)
      const sLast = sRest.join(' ') || null
      if (sFirst) {
        personUpdate.first_name = sFirst
        personUpdate.last_name = sLast
      }
    }
    await supabase
      .from('people')
      .update(personUpdate)
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
        parsedEventDate: parsedEventDateObj
          ? { iso: parsedEventDateObj.iso, precision: parsedEventDateObj.precision, raw: parsedEventDateObj.raw }
          : null,
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
