/**
 * Surgically fix pending Zola drafts where the pipeline drafted to
 * `weddingvendors@zola.com` (Zola's shared support relay) instead of the
 * per-prospect `connect-{uuid}@vmkt-message.zola.com` reply-to address.
 *
 * Root cause (pre-7d68f37): isPerProspectRelay's regex required literal
 * @zola.com and rejected the @vmkt-message.zola.com subdomain Zola moved
 * to. Fixed in commit 7d68f37 (2026-05-26) but pre-deploy drafts already
 * in queue still have the wrong to_email and no wedding_id.
 *
 * Mirrors /api/agent/reprocess-form-relays for the interaction-rewire
 * step (mints couple/wedding + links interaction), then ADDITIONALLY
 * updates the draft's to_email + wedding_id which the route does not
 * touch.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/fix-zola-orphan-drafts.ts
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/fix-zola-orphan-drafts.ts --apply
 */

import { createClient } from '@supabase/supabase-js'
import { detectFormRelay } from '../src/lib/services/ingestion/form-relay-parsers'
import { venueOwnEmails, findOrCreateContact } from '../src/lib/services/email/pipeline'
import { parseFuzzyDate, parseGuestCount } from '../src/lib/services/fuzzy-date'
import { normalizeSource } from '../src/lib/services/normalize-source'
import { mintWedding } from '../src/lib/services/identity/mint-wedding'
import { captureNameEvidence } from '../src/lib/services/identity/name-capture'

const APPLY = process.argv.includes('--apply')
const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  console.log('='.repeat(78))
  console.log(`fix-zola-orphan-drafts -- ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log('='.repeat(78))

  // Pending drafts at Rixey whose to_email is on the Zola domain (any
  // subdomain) AND which have no wedding_id yet — those are the orphans
  // from the pre-7d68f37 deploy window.
  const { data: drafts, error: draftsErr } = await sb
    .from('drafts')
    .select('id, to_email, subject, interaction_id, wedding_id, created_at')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('status', 'pending')
    .ilike('to_email', '%@zola.com')
    .order('created_at', { ascending: true })
  if (draftsErr) { console.error(draftsErr); process.exit(1) }
  const orphans = (drafts ?? []).filter((d) =>
    d.to_email === 'weddingvendors@zola.com' ||
    d.to_email?.endsWith('-vendor@zola.com') ||
    !d.wedding_id,
  )
  console.log(`Found ${orphans.length} Zola orphan draft(s) to fix.\n`)

  if (orphans.length === 0) { console.log('Nothing to do.'); return }

  const ownEmails = await venueOwnEmails(RIXEY_VENUE_ID)

  let ok = 0
  let fail = 0
  for (const d of orphans) {
    console.log('-'.repeat(60))
    console.log(`draft ${d.id}`)
    console.log(`  current to_email : ${d.to_email}`)
    console.log(`  current wedding  : ${d.wedding_id ?? '(null)'}`)

    if (!d.interaction_id) { console.log('  ✗ no interaction_id linked, skipping'); fail++; continue }

    const { data: interaction } = await sb.from('interactions')
      .select('id, from_email, from_name, subject, full_body, body_preview, wedding_id, person_id, timestamp')
      .eq('id', d.interaction_id)
      .maybeSingle()
    if (!interaction) { console.log('  ✗ interaction not found'); fail++; continue }

    const body = (interaction.full_body as string | null) || (interaction.body_preview as string | null) || ''
    const fromHeader = interaction.from_name
      ? `${interaction.from_name} <${interaction.from_email ?? ''}>`
      : (interaction.from_email as string | null) ?? ''

    const lead = detectFormRelay(
      { from: fromHeader, to: '', subject: (interaction.subject as string | null) ?? '', body },
      ownEmails,
    )
    if (!lead) { console.log('  ✗ detectFormRelay returned null on stored body'); fail++; continue }
    if (!lead.leadEmail) { console.log('  ✗ lead has no leadEmail'); fail++; continue }
    // Guard: if the form-relay parser hit the platform but extracted NO
    // useful prospect data (no name, no date, no guest count, no budget,
    // AND the replyTo equals the original notification sender), the
    // inbound is almost certainly a platform marketing email that got
    // misclassified as a new_inquiry — not a couple inquiry. Examples:
    // Zola "Featured Spots" upsell, Knot Q4 newsletter, WW best-of-list
    // promotion. Sage shouldn't reply to those at all — reject the
    // draft rather than minting a bogus couple/wedding.
    const replyToEqualsFrom =
      (lead.replyToEmail ?? '').toLowerCase() === (interaction.from_email as string).toLowerCase()
    const noProspectSignal =
      !lead.leadName && !lead.partnerName && !lead.eventDate &&
      !lead.guestCount && !lead.budget && !lead.note
    if (replyToEqualsFrom && noProspectSignal) {
      console.log(`  ⚠ no prospect signal — looks like platform marketing, not a couple inquiry`)
      if (!APPLY) {
        console.log(`  → WOULD: reject draft with feedback "misclassified platform marketing as new_inquiry"`)
        continue
      }
      await sb.from('drafts').update({
        status: 'rejected',
        feedback_notes: `${new Date().toISOString().slice(0,10)} bulk-rejected: form-relay parser found platform domain but no prospect data — Zola/Knot/WW marketing email misclassified as new_inquiry`,
      }).eq('id', d.id).eq('status', 'pending')
      console.log('  ✓ rejected as misclassified marketing')
      ok++
      continue
    }
    console.log(`  parsed lead     : ${lead.leadName ?? '(no name)'} ${lead.partnerName ? '& ' + lead.partnerName : ''} <${lead.leadEmail}>`)
    console.log(`  source          : ${lead.source}`)
    console.log(`  event date      : ${lead.eventDate ?? '(none)'}`)
    console.log(`  guest count     : ${lead.guestCount ?? '(none)'}`)
    console.log(`  budget          : ${lead.budget ?? '(none)'}`)

    if (!APPLY) {
      console.log(`  → WOULD: rewire interaction + mint wedding + update draft.to_email='${lead.replyToEmail}'`)
      continue
    }

    try {
      const contact = await findOrCreateContact(RIXEY_VENUE_ID, lead.leadEmail, lead.leadName ?? null)
      if (!contact.personId) { console.log('  ✗ findOrCreateContact returned no personId'); fail++; continue }

      if (lead.leadName) {
        try {
          await captureNameEvidence(sb, contact.personId, {
            full: lead.leadName,
            email: lead.leadEmail,
            source: 'form_relay',
          })
        } catch (err) {
          console.warn('  ! captureNameEvidence failed (non-fatal):', err instanceof Error ? err.message : err)
        }
      }

      let weddingId = contact.weddingId
      if (!weddingId) {
        const parsedDate = parseFuzzyDate(lead.eventDate ?? undefined)
        const parsedGuests = parseGuestCount(
          lead.guestCount ? Number(lead.guestCount.match(/\d+/)?.[0] ?? '') : undefined,
        )
        const minted = await mintWedding({
          venueId: RIXEY_VENUE_ID,
          source: 'reprocess_form_relays',
          reason: 'fix_zola_orphan_drafts',
          supabase: sb,
          signals: {
            email: lead.leadEmail,
            fullName: lead.leadName ?? null,
            partner1Name: lead.leadName ?? null,
            weddingDate: parsedDate?.iso ?? null,
            inquiryDate: (interaction.timestamp as string | null) ?? null,
            guestCount: parsedGuests ?? null,
          },
        })
        weddingId = minted.weddingId
        if (minted.isNew) {
          const inquiryUpdate: Record<string, unknown> = { source: normalizeSource(lead.source) }
          if (parsedDate?.precision) inquiryUpdate.wedding_date_precision = parsedDate.precision
          if (parsedGuests != null) inquiryUpdate.guest_count_estimate = parsedGuests
          await sb.from('weddings').update(inquiryUpdate).eq('id', weddingId)
        }
        await sb.from('people').update({ wedding_id: weddingId }).eq('id', contact.personId)
      }

      // Rewire the interaction.
      const intUpdate: Record<string, unknown> = {
        person_id: contact.personId,
        from_email: lead.leadEmail,
      }
      if (lead.leadName) intUpdate.from_name = lead.leadName
      if (weddingId) intUpdate.wedding_id = weddingId
      await sb.from('interactions').update(intUpdate).eq('id', interaction.id)

      // Update the draft itself — to_email + wedding_id.
      const dUpdate: Record<string, unknown> = { to_email: lead.replyToEmail }
      if (weddingId) dUpdate.wedding_id = weddingId
      await sb.from('drafts').update(dUpdate).eq('id', d.id).eq('status', 'pending')

      console.log(`  ✓ rewired (person ${contact.personId}, wedding ${weddingId ?? '(none)'}, draft.to_email -> ${lead.replyToEmail})`)
      ok++
    } catch (err) {
      console.log(`  ✗ exception: ${err instanceof Error ? err.message : err}`)
      fail++
    }
  }

  console.log('-'.repeat(60))
  console.log(`Done. Fixed ${ok} / Failed ${fail} / Total ${orphans.length}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
