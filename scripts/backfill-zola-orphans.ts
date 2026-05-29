/**
 * Backfill all Rixey Zola inbound interactions that are orphaned
 * (wedding_id IS NULL) — re-parse the body with the corrected form-relay
 * parser, mint the real couple/wedding, and rewire the interaction so
 * /intel surfaces the lost leads.
 *
 * Operator carry-forward from 7d68f37 (2026-05-26 "73 lost leads in 12
 * days"): the parser fix went out but no backfill ran. Historical Zola
 * inbounds with from_email='weddingvendors@zola.com' (the platform
 * shared relay, which the v1 isPerProspectRelay falsely picked over the
 * real connect-{uuid}@vmkt-message.zola.com per-prospect address) still
 * have wedding_id=null.
 *
 * Three outcomes per interaction:
 *   - REAL INQUIRY (parser extracts a prospect with name/date/etc.) →
 *     mint couple + wedding, rewire interaction.
 *   - MARKETING (parser matches the domain but extracts no signal AND
 *     replyTo equals the original from) → flag + skip. Don't mint a
 *     bogus couple. The interaction stays orphaned but won't pollute
 *     /intel.
 *   - PARSER MISS (detectFormRelay returns null on stored body) → skip.
 *     Body has unusual shape; needs manual triage.
 *
 * Idempotent — re-running is safe (mintWedding deduplicates on
 * email_exact; rewire is a no-op when already correct).
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-zola-orphans.ts
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-zola-orphans.ts --apply
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
  console.log(`backfill-zola-orphans -- ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log('='.repeat(78))

  // All inbound Zola interactions at Rixey that don't have a wedding
  // linked yet. Use ilike on zola.com to catch both the shared relay
  // (weddingvendors@zola.com) and any per-prospect / vendor-namespaced
  // variants Zola has emitted.
  const { data: rows, error } = await sb
    .from('interactions')
    .select('id, gmail_message_id, subject, full_body, body_preview, from_email, from_name, timestamp, person_id, wedding_id')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .ilike('from_email', '%@zola.com')
    .is('wedding_id', null)
    .order('timestamp', { ascending: true })
    .limit(5000)
  if (error) { console.error(error); process.exit(1) }

  const orphans = rows ?? []
  console.log(`Scanned ${orphans.length} orphan Zola inbound interactions at Rixey.\n`)
  if (orphans.length === 0) { console.log('Nothing to do.'); return }

  const ownEmails = await venueOwnEmails(RIXEY_VENUE_ID)

  let real = 0
  let marketing = 0
  let parserMiss = 0
  let minted = 0
  let mintedExisting = 0
  let rewired = 0
  let fail = 0
  const marketingSamples: string[] = []
  const realSamples: Array<{ name: string; date: string | null; replyTo: string }> = []

  for (const row of orphans as Array<{
    id: string
    subject: string | null
    full_body: string | null
    body_preview: string | null
    from_email: string | null
    from_name: string | null
    timestamp: string | null
    person_id: string | null
  }>) {
    const body = (row.full_body ?? row.body_preview) ?? ''
    const fromHeader = row.from_name
      ? `${row.from_name} <${row.from_email ?? ''}>`
      : (row.from_email ?? '')

    const lead = detectFormRelay(
      { from: fromHeader, to: '', subject: row.subject ?? '', body },
      ownEmails,
    )
    if (!lead || !lead.leadEmail) { parserMiss++; continue }

    // Marketing guard — same shape as fix-zola-orphan-drafts.ts.
    const replyToEqualsFrom =
      (lead.replyToEmail ?? '').toLowerCase() === (row.from_email ?? '').toLowerCase()
    const noProspectSignal =
      !lead.leadName && !lead.partnerName && !lead.eventDate &&
      !lead.guestCount && !lead.budget && !lead.note
    if (replyToEqualsFrom && noProspectSignal) {
      marketing++
      if (marketingSamples.length < 5) marketingSamples.push(`${row.subject ?? '(no subject)'} ← ${row.from_email}`)
      continue
    }

    real++
    if (realSamples.length < 8) {
      realSamples.push({
        name: `${lead.leadName ?? '?'}${lead.partnerName ? ' & ' + lead.partnerName : ''}`,
        date: lead.eventDate ?? null,
        replyTo: lead.replyToEmail ?? '?',
      })
    }

    if (!APPLY) continue

    try {
      const contact = await findOrCreateContact(RIXEY_VENUE_ID, lead.leadEmail, lead.leadName ?? null)
      if (!contact.personId) { fail++; continue }
      if (lead.leadName) {
        try {
          await captureNameEvidence(sb, contact.personId, {
            full: lead.leadName,
            email: lead.leadEmail,
            source: 'form_relay',
          })
        } catch { /* non-fatal */ }
      }
      let weddingId = contact.weddingId
      if (!weddingId) {
        const parsedDate = parseFuzzyDate(lead.eventDate ?? undefined)
        const parsedGuests = parseGuestCount(
          lead.guestCount ? Number(lead.guestCount.match(/\d+/)?.[0] ?? '') : undefined,
        )
        const m = await mintWedding({
          venueId: RIXEY_VENUE_ID,
          source: 'reprocess_form_relays',
          reason: 'backfill_zola_orphans',
          supabase: sb,
          signals: {
            email: lead.leadEmail,
            fullName: lead.leadName ?? null,
            partner1Name: lead.leadName ?? null,
            weddingDate: parsedDate?.iso ?? null,
            inquiryDate: row.timestamp ?? null,
            guestCount: parsedGuests ?? null,
          },
        })
        weddingId = m.weddingId
        if (m.isNew) {
          minted++
          const update: Record<string, unknown> = { source: normalizeSource(lead.source) }
          if (parsedDate?.precision) update.wedding_date_precision = parsedDate.precision
          if (parsedGuests != null) update.guest_count_estimate = parsedGuests
          await sb.from('weddings').update(update).eq('id', weddingId)
        } else {
          mintedExisting++
        }
        await sb.from('people').update({ wedding_id: weddingId }).eq('id', contact.personId)
      } else {
        mintedExisting++
      }
      const intUpdate: Record<string, unknown> = { person_id: contact.personId, from_email: lead.leadEmail }
      if (lead.leadName) intUpdate.from_name = lead.leadName
      if (weddingId) intUpdate.wedding_id = weddingId
      await sb.from('interactions').update(intUpdate).eq('id', row.id)
      rewired++
    } catch (err) {
      console.warn('  ! exception:', err instanceof Error ? err.message : err)
      fail++
    }
  }

  console.log('-'.repeat(60))
  console.log(`Summary:`)
  console.log(`  scanned          : ${orphans.length}`)
  console.log(`  parser miss      : ${parserMiss}`)
  console.log(`  marketing        : ${marketing}`)
  console.log(`  real inquiries   : ${real}`)
  if (APPLY) {
    console.log(`  new weddings     : ${minted}`)
    console.log(`  attached to existing : ${mintedExisting}`)
    console.log(`  interactions rewired : ${rewired}`)
    console.log(`  failures         : ${fail}`)
  }

  if (realSamples.length > 0) {
    console.log(`\nReal-inquiry samples (first ${realSamples.length}):`)
    for (const s of realSamples) console.log(`  - ${s.name} ${s.date ? `(${s.date})` : ''} → ${s.replyTo}`)
  }
  if (marketingSamples.length > 0) {
    console.log(`\nMarketing samples (first ${marketingSamples.length}, skipped):`)
    for (const s of marketingSamples) console.log(`  - ${s}`)
  }

  if (!APPLY) console.log(`\nDRY RUN. Pass --apply to mint weddings + rewire interactions.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
