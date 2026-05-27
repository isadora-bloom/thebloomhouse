/**
 * Audit + bulk-regenerate pending drafts that contain relative-weekday
 * phrasings ("this Friday", "next Saturday", etc.) — the class of bug
 * Caitlin Mayer's draft caught (2026-05-27).
 *
 * Pattern: inquiry-brain v1.5 had no "today" anchor and loadTourStateLine
 * never passed the real tour datetime to the model. Drafts produced under
 * v1.5 (and earlier) frequently say "this Friday" / "this Saturday" for
 * tours that are actually 9-30 days out.
 *
 * Strategy:
 *   1. Query Rixey pending drafts.
 *   2. Pattern-match draft_body for relative-weekday phrases.
 *   3. For every match where prompt_version_used != 'inquiry-brain.prompt.v1.6',
 *      treat as suspect.
 *   4. Audit mode (default): print the suspect list with draft id,
 *      to_email, wedding_id, prompt_version_used, the matched phrase(s),
 *      and a regenerate URL the operator can click in the UI.
 *   5. With --apply: directly call generateInquiryDraft / generateClientDraft
 *      against the live v1.6 brain (this file, this process) and update
 *      draft_body / original_sage_body / confidence_score / prompt_version_used.
 *
 * Mirrors the regenerate API route logic at
 *   src/app/api/agent/drafts/[id]/regenerate/route.ts
 * but with service-role auth, batch processing, and pattern-gating so
 * we only burn tokens on the drafts that actually have the bug.
 *
 * Usage from bloom-house/ root:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/fix-relative-weekday-drafts.ts
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/fix-relative-weekday-drafts.ts --apply
 *
 * Read-only by default. --apply writes.
 */

import { createClient } from '@supabase/supabase-js'
import {
  generateInquiryDraft,
  generateFollowUp,
  BRAIN_PROMPT_VERSION as INQUIRY_BRAIN_PROMPT_VERSION,
} from '../src/lib/services/brain/inquiry'
import {
  generateClientDraft,
  BRAIN_PROMPT_VERSION as CLIENT_BRAIN_PROMPT_VERSION,
} from '../src/lib/services/brain/client'

const APPLY = process.argv.includes('--apply')

interface DraftRow {
  id: string
  venue_id: string
  wedding_id: string | null
  interaction_id: string | null
  to_email: string | null
  subject: string | null
  context_type: string | null
  status: string
  draft_body: string | null
  prompt_version_used: string | null
  created_at: string
}

interface Suspect {
  row: DraftRow
  matches: string[]
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Rixey lookup mirrors scripts/cleanup-pending-drafts.mjs exactly.
  const { data: vc } = await supabase
    .from('venue_config')
    .select('venue_id, business_name')
    .eq('venue_prefix', 'RM')
    .single()
  const venueId = vc?.venue_id ?? 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  const venueName = vc?.business_name ?? 'Rixey Manor (fallback)'

  const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://thebloomhouse.ai'

  console.log('='.repeat(78))
  console.log(`fix-relative-weekday-drafts -- ${APPLY ? 'APPLY MODE (writes)' : 'DRY RUN (read-only)'}`)
  console.log(`Venue: ${venueName} (${venueId})`)
  console.log(`Live inquiry-brain version: ${INQUIRY_BRAIN_PROMPT_VERSION}`)
  console.log(`Live client-brain  version: ${CLIENT_BRAIN_PROMPT_VERSION}`)
  console.log('='.repeat(78))

  // Pattern: a relative weekday reference. Matches "this Friday", "next
  // Saturday", "see you Friday" (no "this"/"next" anchor but day-of-week
  // alone is often interpreted as "this {DOW}" by the reader), and the
  // trailing variants. Case-insensitive. We err on the side of inclusion;
  // false positives waste a regen, not a customer email.
  const WEEKDAY = '(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)'
  const RELATIVE_WEEKDAY_PATTERNS: Array<{ name: string; rx: RegExp }> = [
    { name: 'this <weekday>', rx: new RegExp(`\\bthis\\s+${WEEKDAY}\\b`, 'gi') },
    { name: 'next <weekday>', rx: new RegExp(`\\bnext\\s+${WEEKDAY}\\b`, 'gi') },
    { name: 'see you <weekday>', rx: new RegExp(`\\bsee\\s+you\\s+${WEEKDAY}\\b`, 'gi') },
    // "on Friday at 1pm" matches; "on Friday, June 5" does not (comma /
    // month-name guard).
    { name: 'on <weekday>', rx: new RegExp(`\\bon\\s+${WEEKDAY}\\s+(?!,|\\d|the)`, 'gi') },
  ]

  const { data: drafts, error: draftErr } = await supabase
    .from('drafts')
    .select('id, venue_id, wedding_id, interaction_id, to_email, subject, context_type, status, draft_body, prompt_version_used, created_at')
    .eq('venue_id', venueId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  if (draftErr) {
    console.error('Draft query failed:', draftErr)
    process.exit(1)
  }
  const all = (drafts ?? []) as DraftRow[]
  console.log(`\nScanned ${all.length} pending drafts.\n`)

  const suspects: Suspect[] = []
  for (const row of all) {
    if (!row.draft_body) continue
    // Already on the fixed brain — skip. The v1.6 prompt has the TODAY
    // anchor + tour-date guidance; if it STILL emits a relative weekday,
    // that's deliberate and correct (the date really is in this/next week).
    if (row.prompt_version_used === INQUIRY_BRAIN_PROMPT_VERSION) continue
    if (row.prompt_version_used === CLIENT_BRAIN_PROMPT_VERSION) continue

    const matches: string[] = []
    for (const { name, rx } of RELATIVE_WEEKDAY_PATTERNS) {
      const hits = row.draft_body.match(rx)
      if (hits && hits.length > 0) matches.push(`${name}: ${[...new Set(hits)].join(' | ')}`)
    }
    if (matches.length > 0) suspects.push({ row, matches })
  }

  if (suspects.length === 0) {
    console.log('No suspect drafts found. Nothing to do.')
    return
  }

  console.log(`Found ${suspects.length} suspect draft(s) with relative-weekday phrasings on a stale brain version.\n`)

  let i = 0
  for (const { row, matches } of suspects) {
    i += 1
    console.log('-'.repeat(60))
    console.log(`[${i}/${suspects.length}] draft_id=${row.id}`)
    console.log(`  to_email           : ${row.to_email ?? '(null)'}`)
    console.log(`  subject            : ${row.subject ?? '(null)'}`)
    console.log(`  wedding_id         : ${row.wedding_id ?? '(null)'}`)
    console.log(`  context_type       : ${row.context_type ?? '(null)'}`)
    console.log(`  prompt_version_used: ${row.prompt_version_used ?? '(null)'}`)
    console.log(`  created_at         : ${row.created_at}`)
    console.log(`  matched phrases:`)
    for (const m of matches) console.log(`    - ${m}`)
    console.log(`  regenerate URL: ${APP_URL}/agent/drafts (find this id, click Regenerate)`)
  }
  console.log('-'.repeat(60))

  if (!APPLY) {
    console.log(`\nDRY RUN. ${suspects.length} draft(s) would be regenerated through the live ${INQUIRY_BRAIN_PROMPT_VERSION} brain.`)
    console.log(`Pass --apply to actually regenerate.`)
    return
  }

  // --apply: regenerate each suspect inline. Mirrors the route at
  // src/app/api/agent/drafts/[id]/regenerate/route.ts:118-216 but with
  // service-role + batched.
  console.log(`\nAPPLY mode — regenerating ${suspects.length} draft(s)...\n`)

  let okCount = 0
  let failCount = 0
  const failures: Array<{ draftId: string; reason: string }> = []

  for (const { row } of suspects) {
    const draftId = row.id
    const correlationId = `bulk-fix-weekday-${draftId}-${Date.now()}`

    // Follow-up branch: drafts with no interaction_id are proactive
    // outbound follow-ups generated by the follow-up cron, not replies
    // to a specific inbound. The regenerate API route can't handle these
    // (it hard-fails on missing interaction_id) so we mirror the call
    // shape used at follow-up-sequences.ts:926-931 directly — venueId,
    // contactEmail, weddingId, daysSinceLastContact. daysSinceLastContact
    // is recomputed fresh against the wedding's most recent inbound
    // timestamp; some drift from the original generation moment but
    // close enough — the brain mainly uses it to pick the tone bucket
    // (gentle first / second / final).
    if (!row.interaction_id) {
      const weddingId = row.wedding_id
      const toEmail = row.to_email
      if (!weddingId || !toEmail) {
        failures.push({ draftId, reason: 'follow-up draft missing wedding_id or to_email' })
        failCount += 1
        continue
      }

      const { data: latestInbound } = await supabase
        .from('interactions')
        .select('timestamp')
        .eq('wedding_id', weddingId)
        .eq('direction', 'inbound')
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()

      let daysSinceLastContact = 7
      if (latestInbound?.timestamp) {
        const lastMs = Date.parse(latestInbound.timestamp as string)
        if (Number.isFinite(lastMs)) {
          daysSinceLastContact = Math.max(1, Math.round((Date.now() - lastMs) / 86_400_000))
        }
      }

      try {
        const result = await generateFollowUp({
          venueId,
          contactEmail: toEmail,
          weddingId,
          daysSinceLastContact,
          correlationId,
        })
        if (!result.draft || result.draft.trim().length === 0) {
          failures.push({ draftId, reason: 'follow-up brain returned empty draft' })
          failCount += 1
          continue
        }
        const { error: updateErr } = await supabase
          .from('drafts')
          .update({
            draft_body: result.draft,
            original_sage_body: result.draft,
            confidence_score: result.confidence,
            prompt_version_used: INQUIRY_BRAIN_PROMPT_VERSION,
            correlation_id: correlationId,
          })
          .eq('id', draftId)
          .eq('status', 'pending')
        if (updateErr) {
          failures.push({ draftId, reason: `follow-up update failed: ${updateErr.message}` })
          failCount += 1
          continue
        }
        okCount += 1
        console.log(`  ✓ ${draftId} regenerated as follow-up (days=${daysSinceLastContact}, confidence=${result.confidence.toFixed(2)})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failures.push({ draftId, reason: `follow-up exception: ${msg}` })
        failCount += 1
        console.log(`  ✗ ${draftId} FAILED (follow-up): ${msg}`)
      }
      continue
    }

    const { data: interaction, error: interErr } = await supabase
      .from('interactions')
      .select('id, from_email, from_name, subject, full_body, body_preview, wedding_id')
      .eq('id', row.interaction_id)
      .maybeSingle()
    if (interErr || !interaction) {
      failures.push({ draftId, reason: `interaction load failed: ${interErr?.message ?? 'not found'}` })
      failCount += 1
      continue
    }

    const weddingId =
      row.wedding_id ?? (interaction.wedding_id as string | null) ?? null
    const fromEmail = (interaction.from_email as string | null) ?? row.to_email ?? ''
    const body =
      (interaction.full_body as string | null) ??
      (interaction.body_preview as string | null) ??
      ''
    const subject = (interaction.subject as string | null) ?? ''
    const contextType = row.context_type ?? 'inquiry'

    try {
      let newBody = ''
      let newConfidence = 0
      let newPromptVersion = ''

      if (contextType === 'client' && weddingId) {
        const result = await generateClientDraft({
          venueId,
          contactEmail: fromEmail,
          weddingId,
          message: { from: fromEmail, subject, body },
          taskType: 'client_reply',
          correlationId,
          interactionId: row.interaction_id,
        })
        newBody = result.draft
        newConfidence = result.confidence
        newPromptVersion = CLIENT_BRAIN_PROMPT_VERSION
      } else {
        const result = await generateInquiryDraft({
          venueId,
          contactEmail: fromEmail,
          inquiry: { from: fromEmail, subject, body },
          extractedData: { questions: [] },
          taskType: 'new_inquiry',
          weddingId,
          correlationId,
        })
        newBody = result.draft
        newConfidence = result.confidence
        newPromptVersion = INQUIRY_BRAIN_PROMPT_VERSION
      }

      if (!newBody || newBody.trim().length === 0) {
        failures.push({ draftId, reason: 'brain returned empty draft' })
        failCount += 1
        continue
      }

      const { error: updateErr } = await supabase
        .from('drafts')
        .update({
          draft_body: newBody,
          original_sage_body: newBody,
          confidence_score: newConfidence,
          prompt_version_used: newPromptVersion,
          correlation_id: correlationId,
        })
        .eq('id', draftId)
        .eq('status', 'pending')

      if (updateErr) {
        failures.push({ draftId, reason: `update failed: ${updateErr.message}` })
        failCount += 1
        continue
      }

      okCount += 1
      console.log(`  ✓ ${draftId} regenerated (confidence=${newConfidence.toFixed(2)}, version=${newPromptVersion})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failures.push({ draftId, reason: `exception: ${msg}` })
      failCount += 1
      console.log(`  ✗ ${draftId} FAILED: ${msg}`)
    }
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log(`Done. Regenerated: ${okCount} / Failed: ${failCount} / Total suspects: ${suspects.length}`)
  if (failures.length > 0) {
    console.log(`\nFailures:`)
    for (const f of failures) console.log(`  - ${f.draftId}: ${f.reason}`)
  }
  console.log('='.repeat(78))
}

main().catch((err) => {
  console.error('fix-relative-weekday-drafts failed:', err)
  process.exit(1)
})
