#!/usr/bin/env node
/**
 * Retro-generate a Sage draft for the Lyndsey Rivera + Andie Matten
 * calculator submissions that were skipped today (2026-05-13) by the
 * `rixeymanor.com -> no_draft` filter. The filter is now deleted
 * (delete-own-domain-no-draft-filters.mjs --apply) and the auto-learner
 * guard is in (inbox-filters.ts), so this won't recur. But these two
 * specific weddings have NO draft and need one minted by hand.
 *
 * For each target wedding:
 *   1. Find the "New estimate..." interaction (operator notification
 *      with structured key:value body — has the form-submit data).
 *   2. Call generateInquiryDraft with the parsed data.
 *   3. Insert a drafts row matching the pipeline's schema.
 *
 * Idempotent: if a draft already exists on the interaction, skip.
 */
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v
}

const { createClient } = await import('@supabase/supabase-js')
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const { generateInquiryDraft, BRAIN_PROMPT_VERSION } = await import(
  '../src/lib/services/brain/inquiry.ts'
)

const targets = [
  {
    label: 'Lyndsey Rivera',
    weddingId: '35b1e26b-8b45-4783-a2f8-732c19e6067b',
  },
  {
    label: 'Andie Matten',
    weddingId: '1a9c2c8d-f627-4ff4-93f5-21488a917de4',
  },
]

function extractQuestionsFromBody(body) {
  if (!body) return []
  const sentences = body.split(/[.!?\n]+/)
  return sentences
    .map((s) => s.trim())
    .filter((s) => s.endsWith('?') && s.length > 10 && s.length < 300)
    .slice(0, 5)
}

for (const t of targets) {
  console.log(`\n=== ${t.label} (${t.weddingId}) ===`)

  // Find the "New estimate" interaction (operator notif with key:value body)
  const { data: interactions } = await sb
    .from('interactions')
    .select('id, subject, from_email, from_name, full_body, timestamp, gmail_thread_id, gmail_connection_id, intent_class')
    .eq('wedding_id', t.weddingId)
    .eq('venue_id', RIXEY)
    .eq('direction', 'inbound')
    .ilike('subject', 'New estimate%')
    .order('timestamp', { ascending: false })
    .limit(1)
  const inter = interactions?.[0]
  if (!inter) {
    console.log('  no "New estimate" interaction found — skipping')
    continue
  }
  console.log(`  interaction ${inter.id} subj="${inter.subject}"`)

  // Skip if a draft already exists
  const { data: existingDrafts } = await sb
    .from('drafts')
    .select('id, status, created_at')
    .eq('interaction_id', inter.id)
  if (existingDrafts && existingDrafts.length > 0) {
    console.log(`  draft already exists (${existingDrafts.length}); skipping`)
    continue
  }

  // Parse out partner1 email + name + guests + wedding date from the body
  // (the calculator's key:value structured lines or close-prose hits).
  const body = inter.full_body ?? ''
  const eventDateMatch = body.match(/wedding\s+date[:\s]+([^\n]+)/i) || body.match(/event\s+date[:\s]+([^\n]+)/i)
  const guestMatch = body.match(/guests?\s*[:\s]+(\d+)/i)
  const fromEmail = inter.from_email ?? null

  // Get the gmail connection's received-at address (for multi-Gmail venues).
  let receivedAtAddress = null
  if (inter.gmail_connection_id) {
    const { data: gc } = await sb
      .from('gmail_connections')
      .select('email_address')
      .eq('id', inter.gmail_connection_id)
      .maybeSingle()
    receivedAtAddress = gc?.email_address ?? null
  }

  console.log(`  from=${fromEmail} eventDate=${eventDateMatch?.[1]?.trim() ?? '—'} guests=${guestMatch?.[1] ?? '—'}`)
  console.log(`  calling generateInquiryDraft...`)

  try {
    const inquiryResult = await generateInquiryDraft({
      venueId: RIXEY,
      contactEmail: fromEmail,
      inquiry: {
        from: fromEmail,
        subject: inter.subject,
        body,
      },
      extractedData: {
        questions: extractQuestionsFromBody(body),
        eventDate: eventDateMatch?.[1]?.trim() ?? undefined,
        guestCount: guestMatch ? parseInt(guestMatch[1], 10) : undefined,
      },
      taskType: 'new_inquiry',
      source: 'website',
      receivedAtAddress,
      weddingId: t.weddingId,
      correlationId: `retro-${Date.now()}-${t.weddingId.slice(0, 8)}`,
    })

    const draftBody = inquiryResult.draft
    if (!draftBody) {
      console.log('  generateInquiryDraft returned no draft text — skipping insert')
      continue
    }
    console.log(`  draft generated (${draftBody.length} chars), confidence=${inquiryResult.confidence ?? '—'}`)

    // Compose a Re: subject — Sage normally derives this elsewhere; for retro
    // we use a "Reply to your Rixey Manor inquiry" pattern that matches the
    // pipeline's default for fresh inquiries.
    const draftSubject = `Re: ${(inter.subject ?? '').replace(/^(Re:\s*)+/i, '')}`

    const { data: draft, error: dErr } = await sb
      .from('drafts')
      .insert({
        venue_id: RIXEY,
        wedding_id: t.weddingId,
        interaction_id: inter.id,
        to_email: fromEmail,
        subject: draftSubject,
        draft_body: draftBody,
        original_sage_body: draftBody,
        status: 'pending',
        context_type: 'inquiry',
        brain_used: 'inquiry',
        confidence_score: inquiryResult.confidence ?? null,
        auto_sent: false,
        prompt_version_used: BRAIN_PROMPT_VERSION,
        correlation_id: `retro-${Date.now()}-${t.weddingId.slice(0, 8)}`,
      })
      .select('id')
      .single()
    if (dErr) {
      console.error(`  draft insert failed: ${dErr.message}`)
      continue
    }
    console.log(`  ✓ draft ${draft.id} created for ${t.label}`)
  } catch (err) {
    console.error(`  generateInquiryDraft threw: ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log('\nDone.')
