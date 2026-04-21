/**
 * Bloom House: Email Pipeline Service
 *
 * Main email processing orchestrator. Takes a raw email and runs it through
 * the full pipeline:
 *   Fetch -> Auto-ignore check -> Classify (router brain) -> Contact lookup ->
 *   Wedding creation (if new inquiry) -> Brain routing -> Draft generation ->
 *   Auto-send check -> Queue for approval
 *
 * Also handles the draft approval/rejection/edit lifecycle.
 *
 * Ported from bloom-agent-main/backend/services/email_pipeline.py
 */

import { createServiceClient } from '@/lib/supabase/service'
import { classifyEmail, type ClassificationResult } from '@/lib/services/router-brain'
import { generateInquiryDraft } from '@/lib/services/inquiry-brain'
import { generateClientDraft } from '@/lib/services/client-brain'
import { fetchNewEmails, sendEmail, type ParsedEmail } from '@/lib/services/gmail'
import { detectContractSigning } from '@/lib/services/extraction'
import { createNotification } from '@/lib/services/admin-notifications'
import { trackCoordinatorAction, trackResponseTime } from '@/lib/services/consultant-tracking'
import { appendAIDisclosure, fetchDisclosureContext } from '@/lib/services/ai-disclosure'
import { matchFilter, clearFilterCache } from '@/lib/services/inbox-filters'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IncomingEmail {
  messageId: string
  threadId: string
  from: string
  to: string
  subject: string
  body: string
  date: string
  connectionId?: string
  /** Gmail label ids for this message (e.g. INBOX, CATEGORY_PROMOTIONS, UNREAD).
   *  Used by venue_email_filters rules of pattern_type='gmail_label'. */
  labels?: string[]
}

interface PipelineResult {
  interactionId: string | null
  draftId: string | null
  classification: string
  autoSent: boolean
}

interface ProcessAllResult {
  processed: number
  skipped: number
  draftsGenerated: number
  autoSent: number
  errors: number
  results: PipelineResult[]
}

// ---------------------------------------------------------------------------
// Auto-ignore — universal patterns + per-venue rules
// ---------------------------------------------------------------------------
//
// Universal patterns catch the "no human on the other end" addresses that no
// venue ever wants to hear from. Per-venue rules (see inbox-filters service
// and venue_email_filters table) handle everything else — bulk senders a
// particular venue wants ignored, vendor domains to classify-but-not-draft,
// Gmail category labels, etc.
//
// The universal list stays small and safe. If a venue wants to add their own
// sender patterns, those go in venue_email_filters.

const UNIVERSAL_IGNORE_PATTERNS = [
  'no-reply@',
  'noreply@',
  'mailer-daemon@',
  'postmaster@',
  'donotreply@',
  'bounce@',
  'bounces@',
  'return@',
  'delivery-failure@',
]

function matchesUniversalIgnore(fromEmail: string): boolean {
  const lower = fromEmail.toLowerCase()
  for (const pattern of UNIVERSAL_IGNORE_PATTERNS) {
    if (lower.includes(pattern)) return true
  }
  return false
}

/**
 * Look up this venue's own Sage email address so Sage never processes her own
 * mail (loop protection). Works across venues — no hard-coded addresses.
 */
async function venueSageEmail(venueId: string): Promise<string | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('venue_ai_config')
    .select('ai_email')
    .eq('venue_id', venueId)
    .maybeSingle()
  const email = (data as { ai_email?: string | null } | null)?.ai_email
  return email ? email.toLowerCase().trim() : null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a clean email address from "Name <email@example.com>" format.
 */
export function extractEmailAddress(from: string): string {
  if (from.includes('<') && from.includes('>')) {
    const match = from.match(/<([^>]+)>/)
    return match ? match[1].toLowerCase() : from.toLowerCase()
  }
  return from.toLowerCase()
}

/**
 * Extract a display name from "Name <email@example.com>" format.
 */
export function extractName(from: string): string | null {
  if (from.includes('<')) {
    const name = from.split('<')[0].trim().replace(/["']/g, '')
    return name || null
  }
  return null
}

/**
 * Check if an email has already been processed (by gmail_message_id).
 */
async function isEmailProcessed(venueId: string, gmailMessageId: string): Promise<boolean> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('interactions')
    .select('id')
    .eq('venue_id', venueId)
    .eq('gmail_message_id', gmailMessageId)
    .limit(1)

  return (data?.length ?? 0) > 0
}

/**
 * Find an existing contact by email or create a new person + contact.
 * Returns { personId, weddingId, isNew }.
 */
export async function findOrCreateContact(
  venueId: string,
  email: string,
  name: string | null
): Promise<{ personId: string | null; weddingId: string | null; isNew: boolean }> {
  const supabase = createServiceClient()

  // 1. Direct match on people.email within this venue.
  const { data: byEmail } = await supabase
    .from('people')
    .select('id, wedding_id')
    .eq('venue_id', venueId)
    .ilike('email', email)
    .limit(1)

  if (byEmail && byEmail.length > 0) {
    return {
      personId: byEmail[0].id,
      weddingId: byEmail[0].wedding_id,
      isNew: false,
    }
  }

  // 2. Match through the contacts table. contacts has no venue_id column;
  // scope through people.venue_id via the FK join.
  const { data: byContact } = await supabase
    .from('contacts')
    .select('person_id, people!inner(id, wedding_id, venue_id)')
    .eq('type', 'email')
    .ilike('value', email)
    .eq('people.venue_id', venueId)
    .limit(1)

  if (byContact && byContact.length > 0) {
    const row = byContact[0] as unknown as {
      person_id: string
      people: { id: string; wedding_id: string | null } | null
    }
    return {
      personId: row.people?.id ?? row.person_id,
      weddingId: row.people?.wedding_id ?? null,
      isNew: false,
    }
  }

  // 3. Create a new person. Split the display name into first/last so the
  // inbox join (first_name, last_name, email) has something to render.
  // people.role must be one of the CHECK values; 'partner1' is the default
  // for an inquiry sender.
  const [firstName, ...rest] = (name ?? '').trim().split(/\s+/).filter(Boolean)
  const lastName = rest.join(' ') || null

  const { data: newPerson, error: personError } = await supabase
    .from('people')
    .insert({
      venue_id: venueId,
      role: 'partner1',
      first_name: firstName || email.split('@')[0],
      last_name: lastName,
      email,
    })
    .select('id')
    .single()

  if (personError || !newPerson) {
    console.error('[pipeline] Failed to create person:', personError?.message)
    return { personId: null, weddingId: null, isNew: true }
  }

  // 4. Mirror the email onto contacts so subsequent lookups that go through
  // contacts find it. contacts has no venue_id; tenancy is via person_id.
  await supabase.from('contacts').insert({
    person_id: newPerson.id,
    type: 'email',
    value: email,
    is_primary: true,
  })

  return { personId: newPerson.id, weddingId: null, isNew: true }
}

// ---------------------------------------------------------------------------
// Exported: processIncomingEmail
// ---------------------------------------------------------------------------

/**
 * Process a single incoming email through the full pipeline.
 *
 * Steps:
 *   1. Auto-ignore check (spam patterns)
 *   2. Classify with router brain
 *   3. Create interaction record
 *   4. Find or create contact
 *   5. If new inquiry -> create wedding + engagement event
 *   6. Route to appropriate brain for draft generation
 *   7. Check auto-send eligibility
 *   8. Return result
 */
export async function processIncomingEmail(
  venueId: string,
  email: IncomingEmail
): Promise<PipelineResult> {
  const supabase = createServiceClient()
  const fromEmail = extractEmailAddress(email.from)
  const fromName = extractName(email.from)

  // Step 1a: Universal auto-ignore — no-reply / bounces / postmasters.
  if (matchesUniversalIgnore(fromEmail)) {
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }

  // Step 1b: Self-loop protection — never process mail that came from this
  // venue's own Sage address (e.g. Sage CC'd on a thread, or an autoresponder
  // echoing our send). Per-venue lookup, no hard-coded addresses.
  const sageSelf = await venueSageEmail(venueId)
  if (sageSelf && fromEmail === sageSelf) {
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }

  // Step 1c: Per-venue filter rules (venue_email_filters).
  //   action='ignore'   → bail before classifier (saves tokens).
  //   action='no_draft' → classify + persist interaction, but don't draft.
  const filterHit = await matchFilter(venueId, fromEmail, email.labels ?? [])
  if (filterHit?.action === 'ignore') {
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }
  const skipDraft = filterHit?.action === 'no_draft'

  // Check if already processed
  const alreadyProcessed = await isEmailProcessed(venueId, email.messageId)
  if (alreadyProcessed) {
    return { interactionId: null, draftId: null, classification: 'skipped', autoSent: false }
  }

  // Step 2: Classify with router brain
  let classification: ClassificationResult
  try {
    classification = await classifyEmail(venueId, {
      from: fromEmail,
      subject: email.subject,
      body: email.body,
    })
  } catch (err) {
    console.error('[pipeline] Classification failed:', err)
    return { interactionId: null, draftId: null, classification: 'error', autoSent: false }
  }

  // Step 3: Find or create contact (skip for spam/ignore)
  let personId: string | null = null
  let weddingId: string | null = null
  let isNewContact = false

  if (classification.classification !== 'spam') {
    try {
      const contact = await findOrCreateContact(venueId, fromEmail, fromName)
      personId = contact.personId
      isNewContact = contact.isNew

      // Use wedding from contact if router didn't find one
      if (!weddingId) {
        weddingId = contact.weddingId
      }
    } catch (err) {
      console.error('[pipeline] Contact lookup failed:', err)
    }
  }

  // Step 4: Create interaction record. Always store the raw from_email /
  // from_name so the inbox can render a sender even when person_id is null
  // (per migration 063 — don't rely on the people join alone).
  const interactionPayload: Record<string, unknown> = {
    venue_id: venueId,
    wedding_id: weddingId,
    person_id: personId,
    type: 'email',
    direction: 'inbound',
    subject: email.subject,
    body_preview: email.body.slice(0, 300),
    full_body: email.body,
    from_email: fromEmail,
    from_name: fromName,
    gmail_message_id: email.messageId,
    gmail_thread_id: email.threadId,
    timestamp: email.date,
  }
  if (email.connectionId) {
    interactionPayload.gmail_connection_id = email.connectionId
  }

  const { data: interaction, error: interactionError } = await supabase
    .from('interactions')
    .insert(interactionPayload)
    .select('id')
    .single()

  if (interactionError) {
    console.error('[pipeline] Failed to create interaction:', interactionError.message)
    return { interactionId: null, draftId: null, classification: classification.classification, autoSent: false }
  }

  const interactionId = interaction.id as string

  // Step 5: If new inquiry, create wedding record and engagement event
  const detectedSource = classification.extractedData.source ?? 'direct'

  if (
    isNewContact &&
    !weddingId &&
    classification.classification === 'new_inquiry'
  ) {
    const { data: newWedding } = await supabase
      .from('weddings')
      .insert({
        venue_id: venueId,
        status: 'inquiry',
        source: detectedSource,
        inquiry_date: new Date().toISOString(),
        heat_score: 0,
        temperature_tier: 'cool',
      })
      .select('id')
      .single()

    if (newWedding) {
      weddingId = newWedding.id as string

      // Link person to wedding
      if (personId) {
        await supabase
          .from('people')
          .update({ wedding_id: weddingId })
          .eq('id', personId)
      }

      // Update interaction with wedding_id
      await supabase
        .from('interactions')
        .update({ wedding_id: weddingId })
        .eq('id', interactionId)

      // Create initial engagement event
      await supabase.from('engagement_events').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        event_type: 'initial_inquiry',
        points: 40,
        metadata: { source: detectedSource, subject: email.subject },
      })
    }
  }

  // Step 5b: Contract signing detection (notification only)
  // Scans the email body for phrases indicating the couple has signed/returned
  // a contract. If the wedding is in a pre-contract stage, flag the interaction
  // and insert an admin notification so the coordinator can confirm and move
  // the wedding to the Contracted stage.
  try {
    if (weddingId && detectContractSigning(email.body)) {
      const { data: weddingRow } = await supabase
        .from('weddings')
        .select('status')
        .eq('id', weddingId)
        .single()

      const currentStatus = weddingRow?.status as string | undefined
      if (
        currentStatus &&
        ['tour_completed', 'proposal_sent'].includes(currentStatus)
      ) {
        // Flag the interaction via intelligence_extractions
        await supabase.from('intelligence_extractions').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          interaction_id: interactionId,
          extraction_type: 'contract_signing_detected',
          value: { source: 'regex', from: fromEmail, subject: email.subject },
          confidence: 0.8,
        })

        // Build couple name for the notification body
        let coupleLabel = fromName || fromEmail
        try {
          const { data: peopleRows } = await supabase
            .from('people')
            .select('first_name, last_name, role')
            .eq('wedding_id', weddingId)
          const people = (peopleRows ?? []) as Array<{
            first_name: string | null
            last_name: string | null
            role: string | null
          }>
          const p1 = people.find((p) => p.role === 'partner1') ?? people[0]
          const p2 = people.find((p) => p.role === 'partner2')
          if (p1) {
            coupleLabel = p2
              ? `${p1.first_name ?? ''} & ${p2.first_name ?? ''}`.trim()
              : [p1.first_name, p1.last_name].filter(Boolean).join(' ')
          }
        } catch {
          /* best-effort */
        }

        await createNotification({
          venueId,
          weddingId,
          type: 'contract_signing_detected',
          title: 'Possible contract signing detected',
          body: `Email from ${coupleLabel} mentions signing. Review and confirm.`,
        })
      }
    }
  } catch (err) {
    console.error('[pipeline] Contract signing detection failed:', err)
  }

  // Step 6: Route to appropriate brain for draft generation
  let draftId: string | null = null
  let draftBody: string | null = null
  let confidenceScore: number | null = null
  let brainUsed: string | null = null

  const emailClassification = classification.classification

  // Per-venue no_draft filters short-circuit here. Interaction + contact/
  // wedding are already persisted (intel layer still sees it); we just skip
  // handing off to the brains so Sage doesn't reply.
  if (skipDraft) {
    return {
      interactionId,
      draftId: null,
      classification: emailClassification,
      autoSent: false,
    }
  }

  if (emailClassification === 'new_inquiry' || emailClassification === 'inquiry_reply') {
    try {
      const taskType = emailClassification === 'inquiry_reply' ? 'inquiry_reply' : 'new_inquiry'
      const inquiryResult = await generateInquiryDraft({
        venueId,
        contactEmail: fromEmail,
        inquiry: {
          from: fromEmail,
          subject: email.subject,
          body: email.body,
        },
        extractedData: {
          questions: classification.extractedData.questions,
          eventDate: classification.extractedData.eventDate,
          guestCount: classification.extractedData.guestCount,
        },
        taskType,
      })

      draftBody = inquiryResult.draft
      confidenceScore = inquiryResult.confidence
      brainUsed = 'inquiry'
    } catch (err) {
      console.error('[pipeline] Inquiry brain failed:', err)
    }
  } else if (emailClassification === 'client_message') {
    if (weddingId) {
      try {
        const clientResult = await generateClientDraft({
          venueId,
          contactEmail: fromEmail,
          weddingId,
          message: {
            from: fromEmail,
            subject: email.subject,
            body: email.body,
          },
          taskType: 'client_reply',
        })

        draftBody = clientResult.draft
        confidenceScore = clientResult.confidence
        brainUsed = 'client'
      } catch (err) {
        console.error('[pipeline] Client brain failed:', err)
      }
    }
  }
  // vendor, internal, other -> skip draft generation

  // Step 7: If draft generated, insert into drafts table
  let autoSent = false

  // Use "Re: <subject>" for replies, otherwise original subject
  const draftSubject = emailClassification === 'inquiry_reply' || emailClassification === 'client_message'
    ? `Re: ${email.subject}`
    : email.subject

  if (draftBody) {
    const contextType = brainUsed === 'client' ? 'client' : 'inquiry'

    const { data: draft } = await supabase
      .from('drafts')
      .insert({
        venue_id: venueId,
        wedding_id: weddingId,
        interaction_id: interactionId,
        to_email: fromEmail,
        subject: draftSubject,
        draft_body: draftBody,
        status: 'pending',
        context_type: contextType,
        brain_used: brainUsed,
        confidence_score: confidenceScore,
        auto_sent: false,
      })
      .select('id')
      .single()

    if (draft) {
      draftId = draft.id as string

      // Step 8: Check auto-send eligibility
      // Instead of sending immediately, create a pending auto-send notification
      // with a 5-minute delay. The next cron email_poll cycle will flush expired
      // pending sends. Coordinators can cancel via the notification UI.
      try {
        const { checkAutoSendEligible } = await import('@/lib/services/autonomous-sender')

        const eligibility = await checkAutoSendEligible(venueId, {
          contextType,
          confidenceScore: confidenceScore ?? 0,
          source: detectedSource,
        })

        if (eligibility.eligible) {
          // Mark draft as pending auto-send (not sent yet)
          const sendAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

          await supabase
            .from('drafts')
            .update({
              status: 'auto_send_pending',
              auto_sent: false,
              auto_send_source: detectedSource,
            })
            .eq('id', draftId)

          // Create a cancellable notification
          await createNotification({
            venueId,
            weddingId: weddingId ?? undefined,
            type: 'auto_send_pending',
            title: `Auto-sending to ${fromName || fromEmail} in 5 minutes`,
            body: JSON.stringify({
              draftId,
              toEmail: fromEmail,
              toName: fromName,
              subject: draftSubject,
              threadId: email.threadId,
              sendAt,
              confidenceScore,
              source: detectedSource,
            }),
          })

          // Mark as auto-sent for the pipeline result (pending)
          autoSent = true
        }
      } catch (err) {
        console.error('[pipeline] Auto-send check failed:', err)
      }
    }
  }

  return {
    interactionId,
    draftId,
    classification: classification.classification,
    autoSent,
  }
}

// ---------------------------------------------------------------------------
// Exported: processAllNewEmails
// ---------------------------------------------------------------------------

/**
 * Fetch all new emails from Gmail for a venue and process each through the
 * pipeline. Returns a summary of what happened.
 */
export async function processAllNewEmails(venueId: string): Promise<ProcessAllResult> {
  // Fresh filter snapshot per cron tick — picks up any rules the venue
  // added/removed since last run without waiting for the 1-minute TTL.
  clearFilterCache(venueId)

  const emails = await fetchNewEmails(venueId)

  const summary: ProcessAllResult = {
    processed: 0,
    skipped: 0,
    draftsGenerated: 0,
    autoSent: 0,
    errors: 0,
    results: [],
  }

  for (const email of emails) {
    try {
      const result = await processIncomingEmail(venueId, {
        messageId: email.messageId,
        threadId: email.threadId,
        from: email.from,
        to: email.to,
        subject: email.subject,
        body: email.body,
        date: email.date,
        connectionId: email.connectionId,
        labels: email.labels,
      })

      summary.results.push(result)

      if (result.classification === 'skipped') {
        summary.skipped++
      } else if (result.classification === 'error') {
        summary.errors++
      } else {
        summary.processed++
        if (result.draftId) summary.draftsGenerated++
        if (result.autoSent) summary.autoSent++
      }
    } catch (err) {
      console.error('[pipeline] Error processing email:', err)
      summary.errors++
      summary.results.push({
        interactionId: null,
        draftId: null,
        classification: 'error',
        autoSent: false,
      })
    }
  }

  console.log(
    `[pipeline] Processed ${summary.processed} emails for venue ${venueId} ` +
      `(${summary.draftsGenerated} drafts, ${summary.autoSent} auto-sent, ` +
      `${summary.skipped} skipped, ${summary.errors} errors)`
  )

  return summary
}

// ---------------------------------------------------------------------------
// Exported: flushPendingAutoSends
// ---------------------------------------------------------------------------

/**
 * Check for pending auto-send notifications that have passed their 5-minute
 * delay window. For each one that hasn't been cancelled, actually send the
 * email via Gmail and update the draft status.
 *
 * Called by the cron email_poll job after processing new emails.
 */
export async function flushPendingAutoSends(venueId: string): Promise<number> {
  const supabase = createServiceClient()
  let sentCount = 0

  // Find unread auto_send_pending notifications for this venue
  const { data: pendingNotifs } = await supabase
    .from('admin_notifications')
    .select('id, body, created_at')
    .eq('venue_id', venueId)
    .eq('type', 'auto_send_pending')
    .eq('read', false)
    .order('created_at', { ascending: true })

  if (!pendingNotifs || pendingNotifs.length === 0) return 0

  for (const notif of pendingNotifs) {
    try {
      // Parse the notification body for draft details
      const details = JSON.parse(notif.body as string) as {
        draftId: string
        toEmail: string
        subject: string
        threadId?: string
        sendAt: string
      }

      // Check if the delay has passed
      const sendAt = new Date(details.sendAt).getTime()
      if (Date.now() < sendAt) continue // Not yet time

      // Verify the draft is still in auto_send_pending status (not cancelled)
      const { data: draft } = await supabase
        .from('drafts')
        .select('id, status, draft_body, venue_id')
        .eq('id', details.draftId)
        .single()

      if (!draft || draft.status !== 'auto_send_pending') {
        // Draft was cancelled or already handled — mark notification as read
        await supabase
          .from('admin_notifications')
          .update({ read: true, read_at: new Date().toISOString() })
          .eq('id', notif.id)
        continue
      }

      // Send the email — enforce AI disclosure at the send boundary
      const disclosureCtx = await fetchDisclosureContext(venueId)
      const sentMessageId = await sendEmail(
        venueId,
        details.toEmail,
        details.subject,
        appendAIDisclosure(draft.draft_body as string, disclosureCtx),
        details.threadId
      )

      if (sentMessageId) {
        // Mark draft as sent
        await supabase
          .from('drafts')
          .update({
            status: 'sent',
            auto_sent: true,
            approved_at: new Date().toISOString(),
          })
          .eq('id', details.draftId)

        // Mark notification as read
        await supabase
          .from('admin_notifications')
          .update({ read: true, read_at: new Date().toISOString() })
          .eq('id', notif.id)

        sentCount++
      }
    } catch (err) {
      console.error('[pipeline] Failed to flush pending auto-send:', err)
    }
  }

  if (sentCount > 0) {
    console.log(`[pipeline] Flushed ${sentCount} pending auto-sends for venue ${venueId}`)
  }

  return sentCount
}

// ---------------------------------------------------------------------------
// Exported: approveDraft
// ---------------------------------------------------------------------------

/**
 * Approve a pending draft. Creates a feedback record for the learning loop.
 */
export async function approveDraft(draftId: string, userId: string): Promise<void> {
  const supabase = createServiceClient()

  // Fetch the draft
  const { data: draft, error: fetchError } = await supabase
    .from('drafts')
    .select('id, venue_id, draft_body, subject, context_type')
    .eq('id', draftId)
    .single()

  if (fetchError || !draft) {
    throw new Error(`Draft not found: ${draftId}`)
  }

  // Mark as approved
  await supabase
    .from('drafts')
    .update({
      status: 'approved',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq('id', draftId)

  // Create feedback record for learning
  await supabase.from('draft_feedback').insert({
    venue_id: draft.venue_id,
    draft_id: draftId,
    feedback_type: 'approved',
    original_subject: draft.subject ?? '',
    original_body: draft.draft_body ?? '',
    email_category: draft.context_type ?? 'inquiry',
  })

  // Track coordinator action for metrics
  if (draft.venue_id) {
    trackCoordinatorAction(draft.venue_id as string, userId, 'draft_approved').catch(console.error)

    // Track response time (time from draft creation to approval)
    const { data: draftRow } = await supabase
      .from('drafts')
      .select('created_at, approved_at')
      .eq('id', draftId)
      .single()
    if (draftRow?.created_at && draftRow?.approved_at) {
      const created = new Date(draftRow.created_at as string).getTime()
      const approved = new Date(draftRow.approved_at as string).getTime()
      const minutes = (approved - created) / (1000 * 60)
      trackResponseTime(draft.venue_id as string, userId, minutes).catch(console.error)
    }
  }
}

// ---------------------------------------------------------------------------
// Exported: rejectDraft
// ---------------------------------------------------------------------------

/**
 * Reject a draft with optional reason. Creates a feedback record so the AI
 * can learn what to avoid.
 */
export async function rejectDraft(
  draftId: string,
  userId: string,
  reason?: string
): Promise<void> {
  const supabase = createServiceClient()

  // Fetch the draft
  const { data: draft, error: fetchError } = await supabase
    .from('drafts')
    .select('id, venue_id, draft_body, subject, context_type')
    .eq('id', draftId)
    .single()

  if (fetchError || !draft) {
    throw new Error(`Draft not found: ${draftId}`)
  }

  // Mark as rejected
  await supabase
    .from('drafts')
    .update({
      status: 'rejected',
      feedback_notes: reason ?? null,
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq('id', draftId)

  // Create feedback record for learning
  await supabase.from('draft_feedback').insert({
    venue_id: draft.venue_id,
    draft_id: draftId,
    feedback_type: 'rejected',
    original_subject: draft.subject ?? '',
    original_body: draft.draft_body ?? '',
    rejection_reason: reason ?? null,
    email_category: draft.context_type ?? 'inquiry',
  })

  // Track coordinator action for metrics
  if (draft.venue_id) {
    trackCoordinatorAction(draft.venue_id as string, userId, 'draft_rejected').catch(console.error)
  }
}

// ---------------------------------------------------------------------------
// Exported: editAndApproveDraft
// ---------------------------------------------------------------------------

/**
 * Update a draft body with coordinator edits, mark as approved, and create
 * a feedback record with the original + edited versions for the learning loop.
 */
export async function editAndApproveDraft(
  draftId: string,
  userId: string,
  editedBody: string
): Promise<void> {
  const supabase = createServiceClient()

  // Fetch the draft (need original body for feedback)
  const { data: draft, error: fetchError } = await supabase
    .from('drafts')
    .select('id, venue_id, draft_body, subject, context_type')
    .eq('id', draftId)
    .single()

  if (fetchError || !draft) {
    throw new Error(`Draft not found: ${draftId}`)
  }

  const originalBody = draft.draft_body as string

  // Update draft body and mark as approved
  await supabase
    .from('drafts')
    .update({
      draft_body: editedBody,
      status: 'approved',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq('id', draftId)

  // Create feedback record with both original and edited
  await supabase.from('draft_feedback').insert({
    venue_id: draft.venue_id,
    draft_id: draftId,
    feedback_type: 'edited',
    original_subject: draft.subject ?? '',
    original_body: originalBody,
    edited_body: editedBody,
    email_category: draft.context_type ?? 'inquiry',
  })

  // Track coordinator action for metrics
  if (draft.venue_id) {
    trackCoordinatorAction(draft.venue_id as string, userId, 'draft_approved').catch(console.error)

    // Track response time
    const { data: draftRow } = await supabase
      .from('drafts')
      .select('created_at, approved_at')
      .eq('id', draftId)
      .single()
    if (draftRow?.created_at && draftRow?.approved_at) {
      const created = new Date(draftRow.created_at as string).getTime()
      const approved = new Date(draftRow.approved_at as string).getTime()
      const minutes = (approved - created) / (1000 * 60)
      trackResponseTime(draft.venue_id as string, userId, minutes).catch(console.error)
    }
  }
}

// ---------------------------------------------------------------------------
// Exported: sendApprovedDraft
// ---------------------------------------------------------------------------

/**
 * Send an approved draft via Gmail and update its status to 'sent'.
 */
export async function sendApprovedDraft(draftId: string): Promise<void> {
  const supabase = createServiceClient()

  // Fetch the draft
  const { data: draft, error: fetchError } = await supabase
    .from('drafts')
    .select('id, venue_id, to_email, subject, draft_body, status, interaction_id')
    .eq('id', draftId)
    .single()

  if (fetchError || !draft) {
    throw new Error(`Draft not found: ${draftId}`)
  }

  if (draft.status !== 'approved') {
    throw new Error(`Draft ${draftId} is not approved (status: ${draft.status})`)
  }

  // Get the thread ID from the original interaction (for reply threading)
  let threadId: string | undefined
  if (draft.interaction_id) {
    const { data: interaction } = await supabase
      .from('interactions')
      .select('gmail_thread_id')
      .eq('id', draft.interaction_id)
      .single()

    threadId = (interaction?.gmail_thread_id as string) ?? undefined
  }

  // Send via Gmail. Approved drafts MUST go through the venue's authenticated
  // Gmail — the whole product premise is that replies come from the
  // coordinator's own inbox. No transactional fallback here by design.
  // AI disclosure is enforced at the send boundary regardless of approval path.
  const disclosureCtx = await fetchDisclosureContext(draft.venue_id as string)
  const sentMessageId = await sendEmail(
    draft.venue_id as string,
    draft.to_email as string,
    draft.subject as string,
    appendAIDisclosure(draft.draft_body as string, disclosureCtx),
    threadId
  )

  if (!sentMessageId) {
    console.error(
      `[pipeline] Approved draft ${draftId} could not be sent: Gmail is not connected for venue ${draft.venue_id}. ` +
        `Approved drafts must go through the venue's authenticated Gmail (no transactional fallback). ` +
        `Reconnect Gmail in Settings → Agent to retry.`
    )
    throw new Error(`Failed to send email for draft ${draftId}`)
  }

  // Update draft status
  await supabase
    .from('drafts')
    .update({ status: 'sent' })
    .eq('id', draftId)

  // Create outbound interaction record
  await supabase.from('interactions').insert({
    venue_id: draft.venue_id,
    wedding_id: null, // Could link if needed
    type: 'email',
    direction: 'outbound',
    subject: draft.subject,
    body_preview: (draft.draft_body as string).slice(0, 300),
    full_body: draft.draft_body,
    to_email: draft.to_email,
    gmail_message_id: sentMessageId,
    gmail_thread_id: threadId ?? null,
    timestamp: new Date().toISOString(),
  })

  console.log(`[pipeline] Sent approved draft ${draftId} to ${draft.to_email}`)
}
