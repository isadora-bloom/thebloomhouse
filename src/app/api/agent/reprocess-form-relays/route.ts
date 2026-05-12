import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  detectFormRelay,
  type FormRelayLead,
} from '@/lib/services/ingestion/form-relay-parsers'
import { venueOwnEmails, findOrCreateContact } from '@/lib/services/email/pipeline'
import { parseFuzzyDate, parseGuestCount } from '@/lib/services/fuzzy-date'
import { normalizeSource } from '@/lib/services/normalize-source'
// Migrated to mintWedding 2026-05-12. See docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
import { mintWedding } from '@/lib/services/identity/mint-wedding'
import { captureNameEvidence } from '@/lib/services/identity/name-capture'

export const maxDuration = 300

// ---------------------------------------------------------------------------
// POST /api/agent/reprocess-form-relays
//
// Walks every inbound email interaction for the current venue and runs
// the form-relay parsers over the stored full_body / from / to / subject.
// Any match is rewired:
//   - the parsed lead's email/name becomes the interaction's from_email /
//     from_name (so the inbox thread header shows the prospect, not the
//     relay),
//   - a person + wedding for the prospect are found/created,
//   - the interaction is re-linked to those.
//
// This is for venues whose inbox was synced BEFORE the detector existed
// in processIncomingEmail — the new detector fires at write time now, so
// future syncs don't need this, but historical rows do.
//
// Leaves stale "lead = relay address" people/weddings in place; they'll
// be cleaned up by /api/agent/cleanup-ghost-weddings once the
// interactions no longer point at them. Idempotent — re-running is safe.
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const supabase = createServiceClient()
  const ownEmails = await venueOwnEmails(venueId)

  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, gmail_message_id, subject, full_body, from_email, from_name, timestamp, person_id, wedding_id')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .limit(5000)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let scanned = 0
  let matched = 0
  let rewired = 0
  let createdPeople = 0
  let createdWeddings = 0
  const samples: Array<Record<string, unknown>> = []

  for (const row of (rows ?? []) as Array<{
    id: string
    subject: string | null
    full_body: string | null
    from_email: string | null
    from_name: string | null
    timestamp: string | null
    person_id: string | null
    wedding_id: string | null
  }>) {
    scanned++
    const body = row.full_body ?? ''
    const fromHeader = row.from_name
      ? `${row.from_name} <${row.from_email ?? ''}>`
      : row.from_email ?? ''
    const lead = detectFormRelay(
      { from: fromHeader, to: '', subject: row.subject ?? '', body },
      ownEmails
    )
    if (!lead) continue
    if (!lead.leadEmail || ownEmails.has(lead.leadEmail)) continue
    matched++

    // Find or create the real prospect.
    const contact = await findOrCreateContact(venueId, lead.leadEmail, lead.leadName ?? null)
    if (!contact.personId) continue
    if (contact.isNew) createdPeople++

    // Patch the person's name if we extracted one. Route through the
    // chokepoint so the picker dual-writes the legacy columns and the
    // evidence chain stays consistent. Form-relay leadName comes out of
    // a structured relay parser (Knot / WeddingWire / etc.) so it maps
    // to the form_relay source category. The picker decides whether to
    // overwrite based on shape + confidence — no need to gate on the
    // current first_name/last_name nulls here, the chokepoint won't
    // downgrade a stronger existing claim.
    if (lead.leadName) {
      try {
        await captureNameEvidence(supabase, contact.personId, {
          full: lead.leadName,
          email: lead.leadEmail ?? null,
          source: 'form_relay',
        })
      } catch (err) {
        console.warn(
          '[reprocess-form-relays] captureNameEvidence failed for person',
          contact.personId,
          ':',
          err instanceof Error ? err.message : err,
        )
      }
    }

    // Ensure the prospect has a wedding row (they are a lead after all).
    // Migrated to mintWedding 2026-05-12. See docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
    let weddingId = contact.weddingId
    if (!weddingId) {
      const parsedDate = parseFuzzyDate(lead.eventDate ?? undefined)
      const parsedGuests = parseGuestCount(
        lead.guestCount ? extractFirstNumber(lead.guestCount) : undefined
      )
      try {
        const minted = await mintWedding({
          venueId,
          source: 'reprocess_form_relays',
          reason: 'reprocess_form_relay',
          supabase,
          signals: {
            email: lead.leadEmail,
            fullName: lead.leadName ?? null,
            partner1Name: lead.leadName ?? null,
            weddingDate: parsedDate?.iso ?? null,
            inquiryDate: row.timestamp ?? null,
            guestCount: parsedGuests ?? null,
          },
        })
        weddingId = minted.weddingId
        if (minted.isNew) createdWeddings++
        // Stamp the source label + date precision + guest count the
        // resolver doesn't carry. Only when newly minted; for an
        // attached-existing wedding we don't relitigate.
        if (minted.isNew) {
          const inquiryUpdate: Record<string, unknown> = {
            source: normalizeSource(lead.source),
          }
          if (parsedDate?.precision) inquiryUpdate.wedding_date_precision = parsedDate.precision
          if (parsedGuests != null) inquiryUpdate.guest_count_estimate = parsedGuests
          await supabase
            .from('weddings')
            .update(inquiryUpdate)
            .eq('id', weddingId)
        }
        await supabase
          .from('people')
          .update({ wedding_id: weddingId })
          .eq('id', contact.personId)
      } catch (mintErr) {
        console.warn('[reprocess-form-relays] mintWedding failed:',
          mintErr instanceof Error ? mintErr.message : mintErr)
      }
    }

    // Rewire this interaction to the prospect + real wedding.
    const update: Record<string, unknown> = {
      person_id: contact.personId,
      from_email: lead.leadEmail,
    }
    if (lead.leadName) update.from_name = lead.leadName
    if (weddingId) update.wedding_id = weddingId
    await supabase.from('interactions').update(update).eq('id', row.id)
    rewired++

    if (samples.length < 10) {
      samples.push({
        interactionId: row.id,
        source: lead.source,
        leadEmail: lead.leadEmail,
        leadName: lead.leadName,
        previousFrom: row.from_email,
      })
    }
  }

  return NextResponse.json({
    venueId,
    scanned,
    matched,
    rewired,
    createdPeople,
    createdWeddings,
    samples,
  })
}

function extractFirstNumber(s: string): number | undefined {
  const m = s.match(/\d+/)
  return m ? parseInt(m[0], 10) : undefined
}
