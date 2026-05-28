/**
 * One-shot: backfill cc_emails on existing pending Knot drafts so they
 * get the dual-route (primary personal email + Cc the per-prospect Knot
 * relay) without waiting for a fresh inbound to flow through the
 * post-mig-378 pipeline.
 *
 * For each Rixey pending draft whose to_email or interaction's from_email
 * is a Knot relay, re-parse the linked inbound body to recover BOTH the
 * personal email and the per-prospect Knot relay. Stamp draft.to_email =
 * personal and draft.cc_emails = [relay] when the parser extracts both.
 *
 * Idempotent — won't touch drafts already on the dual-route shape.
 * Dry-run by default; --apply gates writes.
 */

import { createClient } from '@supabase/supabase-js'
import { detectFormRelay } from '../src/lib/services/ingestion/form-relay-parsers'
import { venueOwnEmails } from '../src/lib/services/email/pipeline'

const APPLY = process.argv.includes('--apply')
const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const ownEmails = await venueOwnEmails(RIXEY_VENUE_ID)

  // Pull pending drafts where either the draft.to_email or the linked
  // interaction's from_email looks Knot-flavoured. We grab a wider net
  // (any pending draft) and filter in-memory because the relay can sit
  // on either side post-rewire.
  const { data: drafts } = await sb
    .from('drafts')
    .select('id, to_email, cc_emails, interaction_id, subject')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('status', 'pending')
  if (!drafts) { console.log('no drafts'); return }

  console.log('='.repeat(72))
  console.log(`backfill-knot-draft-cc -- ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log('='.repeat(72))

  let upgraded = 0
  let already = 0
  let skipped = 0

  for (const d of drafts) {
    const toEmail = (d.to_email as string | null)?.toLowerCase() ?? null
    const cc = (d.cc_emails as string[] | null) ?? []

    if (!d.interaction_id) { skipped++; continue }

    const { data: interaction } = await sb
      .from('interactions')
      .select('from_email, from_name, subject, full_body, body_preview')
      .eq('id', d.interaction_id)
      .maybeSingle()
    if (!interaction) { skipped++; continue }

    const body = (interaction.full_body as string | null) || (interaction.body_preview as string | null) || ''
    const fromHeader = interaction.from_name
      ? `${interaction.from_name} <${interaction.from_email ?? ''}>`
      : (interaction.from_email as string | null) ?? ''

    const lead = detectFormRelay(
      { from: fromHeader, to: '', subject: (interaction.subject as string | null) ?? '', body },
      ownEmails,
    )
    if (!lead || lead.source !== 'the_knot') { skipped++; continue }
    if (!lead.replyToEmail || !lead.ccEmails || lead.ccEmails.length === 0) {
      // Parser didn't surface a CC — either no personal email known, or
      // relay was unroutable. Leave the draft as-is.
      skipped++; continue
    }

    // Compose the new routing.
    const newTo = lead.replyToEmail.toLowerCase()
    const newCc = lead.ccEmails.map((c) => c.toLowerCase())

    // Already correctly routed?
    const already_to = toEmail === newTo
    const already_cc = cc.length === newCc.length && cc.every((c) => newCc.includes(c.toLowerCase()))
    if (already_to && already_cc) {
      already++
      continue
    }

    console.log(`  ${d.id}`)
    console.log(`    subject     : ${(d.subject as string | null)?.slice(0, 60) ?? ''}`)
    console.log(`    to (now)    : ${toEmail}`)
    console.log(`    cc (now)    : ${cc.length > 0 ? cc.join(', ') : '(none)'}`)
    console.log(`    to (new)    : ${newTo}`)
    console.log(`    cc (new)    : ${newCc.join(', ')}`)
    upgraded++

    if (APPLY) {
      await sb.from('drafts')
        .update({ to_email: newTo, cc_emails: newCc })
        .eq('id', d.id)
        .eq('status', 'pending')
    }
  }

  console.log('-'.repeat(72))
  console.log(`Upgraded: ${upgraded} / Already correct: ${already} / Skipped: ${skipped}`)
  if (!APPLY) console.log(`DRY RUN — pass --apply to write.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
