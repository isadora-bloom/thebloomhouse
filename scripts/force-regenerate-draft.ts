/**
 * One-off: force-regenerate a single pending draft by ID, ignoring the
 * "already on v1.6" filter. Used to re-run a draft after a same-version
 * brain code fix (e.g., the formatTourDateGuidance Calendly-format parser
 * patch on 2026-05-27 — drafts had already been bumped to v1.6 but the
 * fix landed inside the helper that v1.6 calls).
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/force-regenerate-draft.ts <draftId> [draftId ...]
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

const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (ids.length === 0) {
  console.error('Usage: force-regenerate-draft.ts <draftId> [draftId ...]')
  process.exit(1)
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  for (const draftId of ids) {
    const { data: draft, error } = await supabase
      .from('drafts')
      .select('id, venue_id, wedding_id, interaction_id, to_email, subject, context_type, status')
      .eq('id', draftId)
      .maybeSingle()
    if (error || !draft) {
      console.log(`✗ ${draftId} not found: ${error?.message ?? 'no row'}`)
      continue
    }
    if (draft.status !== 'pending') {
      console.log(`✗ ${draftId} status=${draft.status}, skipping`)
      continue
    }

    const correlationId = `force-regen-${draftId}-${Date.now()}`

    // Follow-up branch — no interaction_id.
    if (!draft.interaction_id) {
      const weddingId = draft.wedding_id as string | null
      const toEmail = draft.to_email as string | null
      if (!weddingId || !toEmail) {
        console.log(`✗ ${draftId} follow-up missing wedding_id or to_email`)
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
      let days = 7
      if (latestInbound?.timestamp) {
        const ms = Date.parse(latestInbound.timestamp as string)
        if (Number.isFinite(ms)) days = Math.max(1, Math.round((Date.now() - ms) / 86_400_000))
      }
      const result = await generateFollowUp({
        venueId: draft.venue_id,
        contactEmail: toEmail,
        weddingId,
        daysSinceLastContact: days,
        correlationId,
      })
      if (!result.draft) { console.log(`✗ ${draftId} empty draft`); continue }
      await supabase
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
      console.log(`✓ ${draftId} regenerated as follow-up (days=${days}, conf=${result.confidence.toFixed(2)})`)
      continue
    }

    // Inquiry / client branch.
    const { data: interaction } = await supabase
      .from('interactions')
      .select('id, from_email, subject, full_body, body_preview, wedding_id')
      .eq('id', draft.interaction_id)
      .maybeSingle()
    if (!interaction) { console.log(`✗ ${draftId} interaction not found`); continue }
    const weddingId = (draft.wedding_id as string | null) ?? (interaction.wedding_id as string | null)
    const fromEmail = (interaction.from_email as string | null) ?? (draft.to_email as string | null) ?? ''
    const body = (interaction.full_body as string | null) ?? (interaction.body_preview as string | null) ?? ''
    const subject = (interaction.subject as string | null) ?? ''
    const contextType = (draft.context_type as string | null) ?? 'inquiry'

    let newBody = ''
    let newConfidence = 0
    let newVersion = ''
    if (contextType === 'client' && weddingId) {
      const r = await generateClientDraft({
        venueId: draft.venue_id,
        contactEmail: fromEmail,
        weddingId,
        message: { from: fromEmail, subject, body },
        taskType: 'client_reply',
        correlationId,
        interactionId: draft.interaction_id,
      })
      newBody = r.draft; newConfidence = r.confidence; newVersion = CLIENT_BRAIN_PROMPT_VERSION
    } else {
      const r = await generateInquiryDraft({
        venueId: draft.venue_id,
        contactEmail: fromEmail,
        inquiry: { from: fromEmail, subject, body },
        extractedData: { questions: [] },
        taskType: 'new_inquiry',
        weddingId,
        correlationId,
      })
      newBody = r.draft; newConfidence = r.confidence; newVersion = INQUIRY_BRAIN_PROMPT_VERSION
    }
    if (!newBody) { console.log(`✗ ${draftId} empty draft`); continue }
    await supabase
      .from('drafts')
      .update({
        draft_body: newBody,
        original_sage_body: newBody,
        confidence_score: newConfidence,
        prompt_version_used: newVersion,
        correlation_id: correlationId,
      })
      .eq('id', draftId)
      .eq('status', 'pending')
    console.log(`✓ ${draftId} regenerated (conf=${newConfidence.toFixed(2)}, version=${newVersion})`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
