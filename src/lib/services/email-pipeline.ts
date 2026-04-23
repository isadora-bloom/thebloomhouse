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
import {
  classifyEmail,
  shouldAutoIgnore,
  isMachineGenerated,
  type ClassificationResult,
} from '@/lib/services/router-brain'
import { generateInquiryDraft } from '@/lib/services/inquiry-brain'
import { generateClientDraft } from '@/lib/services/client-brain'
import { fetchNewEmails, sendEmail, type ParsedEmail } from '@/lib/services/gmail'
import { detectBookingSignal } from '@/lib/services/booking-signal'
import { recordKnowledgeGaps } from '@/lib/services/knowledge-gaps'
import { createNotification } from '@/lib/services/admin-notifications'
import { trackCoordinatorAction, trackResponseTime } from '@/lib/services/consultant-tracking'
import { appendAIDisclosure, fetchDisclosureContext } from '@/lib/services/ai-disclosure'
import { matchFilter, clearFilterCache } from '@/lib/services/inbox-filters'
import { parseFuzzyDate, parseGuestCount } from '@/lib/services/fuzzy-date'
import { detectFormRelay, type FormRelayLead } from '@/lib/services/form-relay-parsers'
import { normalizeSource } from '@/lib/services/normalize-source'
import { recordEngagementEventsBatch } from '@/lib/services/heat-mapping'

// ---------------------------------------------------------------------------
// Structured error logging
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget write to the error_logs table plus a console line. Used
 * in place of bare console.error at pipeline-stage boundaries so the Agent
 * → Errors page has a structured trail (venue_id, stage, context) instead
 * of relying on Vercel function logs.
 *
 * Never throws: if the insert fails, the original error is still logged to
 * console so the real pipeline never gets masked by a telemetry failure.
 */
async function logPipelineError(
  venueId: string | null,
  stage: string,
  err: unknown,
  context: Record<string, unknown> = {}
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : undefined
  // Local log first — keeps existing Vercel / dev behaviour.
  console.error(`[pipeline] ${stage}:`, message, context)
  try {
    const supabase = createServiceClient()
    await supabase.from('error_logs').insert({
      venue_id: venueId,
      error_type: `pipeline:${stage}`,
      message: message.slice(0, 2000),
      stack_trace: stack?.slice(0, 4000) ?? null,
      context,
    })
  } catch (insertErr) {
    console.error('[pipeline] logPipelineError insert failed:', insertErr)
  }
}

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
  /** RFC-2822 headers captured at fetch time (lowercase-keyed). Used by
   *  isMachineGenerated() to silence bulk-list / auto-submitted mail that
   *  the universal sender-regex can't catch (HoneyBook notifications,
   *  Zola vendor broadcasts, Cvent, Calendly, billing, etc.). May be
   *  undefined for legacy callers — treat missing as "no signal". */
  headers?: Record<string, string>
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

/**
 * Load every address this venue owns — the Sage relay plus every linked
 * Gmail connection. Used to classify direction (from-match → outbound)
 * and as a self-loop guard so the venue can never appear as its own lead.
 *
 * A single source of truth: any place in the pipeline that asks "is this
 * our own email?" should call this, not hardcode addresses or check
 * one config field.
 */
export async function venueOwnEmails(venueId: string): Promise<Set<string>> {
  const supabase = createServiceClient()
  const own = new Set<string>()
  const sage = await venueSageEmail(venueId)
  if (sage) own.add(sage)
  const { data: conns } = await supabase
    .from('gmail_connections')
    .select('email_address')
    .eq('venue_id', venueId)
  for (const c of (conns ?? []) as Array<{ email_address: string }>) {
    const e = (c.email_address || '').toLowerCase().trim()
    if (e) own.add(e)
  }
  return own
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
 * Check if an email has already been processed.
 *
 * Two-layer dedup:
 *  1) gmail_message_id exact match — catches the re-sync case where the
 *     same account returns the same message again.
 *  2) Content fingerprint (venue + from + subject + timestamp±60s) —
 *     catches the multi-connection case where a venue has several linked
 *     Gmail accounts (sage@, info@, hello@) and an email addressed to
 *     all of them lands once per account with a different Gmail API id.
 *     Without this guard, multi-account venues end up with triplicate
 *     inbox entries and duplicate pipeline cards.
 */
async function isEmailProcessed(
  venueId: string,
  gmailMessageId: string,
  fingerprint?: { fromEmail: string; subject: string; timestamp: string }
): Promise<boolean> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('interactions')
    .select('id')
    .eq('venue_id', venueId)
    .eq('gmail_message_id', gmailMessageId)
    .limit(1)
  if ((data?.length ?? 0) > 0) return true

  if (!fingerprint) return false

  // Content-level dedup. Timestamp compare is ±60s to absorb the small
  // drift between when each connected account received the same message.
  const t = new Date(fingerprint.timestamp).getTime()
  if (Number.isNaN(t)) return false
  const lo = new Date(t - 60_000).toISOString()
  const hi = new Date(t + 60_000).toISOString()

  const { data: fp } = await supabase
    .from('interactions')
    .select('id')
    .eq('venue_id', venueId)
    .eq('from_email', fingerprint.fromEmail)
    .eq('subject', fingerprint.subject)
    .gte('timestamp', lo)
    .lte('timestamp', hi)
    .limit(1)

  return (fp?.length ?? 0) > 0
}

/**
 * Find an existing contact by email or create a new person + contact.
 * Returns { personId, weddingId, isNew }.
 */
export async function findOrCreateContact(
  venueId: string,
  email: string,
  name: string | null,
  /**
   * Optional pre-computed ownEmails set. When processIncomingEmail already
   * loaded it upstream, pass it in to skip a second round-trip to
   * gmail_connections. Callers outside the pipeline (scripts, repair
   * endpoints) can omit it and the helper loads its own.
   */
  ownEmailsHint?: Set<string>
): Promise<{ personId: string | null; weddingId: string | null; isNew: boolean }> {
  const supabase = createServiceClient()

  // 0. Defense in depth: never create (or return) a person for one of the
  // venue's own addresses. The primary guard is in processIncomingEmail
  // self-loop check, but any direct caller of this helper must be safe
  // too — otherwise the venue itself becomes a lead.
  const ownEmails = ownEmailsHint ?? (await venueOwnEmails(venueId))
  const emailLower = email.toLowerCase().trim()
  if (ownEmails.has(emailLower)) {
    return { personId: null, weddingId: null, isNew: false }
  }

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

  // 5. Phase 8 identity resolution — run the matcher against the new
  // person. A high-confidence match auto-merges; medium/low lands in
  // client_match_queue for triage; matching tangential_signals get
  // linked. Fire-and-forget: a matching failure must never break ingest.
  let survivorId = newPerson.id
  try {
    const { enqueueIdentityMatches } = await import('@/lib/services/identity-enqueue')
    const result = await enqueueIdentityMatches({ supabase, venueId, newPersonId: newPerson.id })
    if (result.autoMergedIntoPersonId && result.autoMergedIntoPersonId !== newPerson.id) {
      survivorId = result.autoMergedIntoPersonId
    }
  } catch (err) {
    console.error('[pipeline] enqueueIdentityMatches failed:', err instanceof Error ? err.message : err)
  }

  if (survivorId !== newPerson.id) {
    const { data: survivor } = await supabase
      .from('people')
      .select('wedding_id')
      .eq('id', survivorId)
      .single()
    return { personId: survivorId, weddingId: (survivor?.wedding_id as string | null) ?? null, isNew: false }
  }

  return { personId: newPerson.id, weddingId: null, isNew: true }
}

/**
 * Build a synthetic ClassificationResult from a form-relay parse. The
 * parsers already give us the authoritative fields (we read them directly
 * from the form body), so we skip the LLM and hand those straight to the
 * rest of the pipeline. source maps to the shape router-brain uses so
 * downstream wedding.source / intelligence_extractions stay consistent.
 */
function synthClassificationFromFormLead(lead: FormRelayLead): ClassificationResult {
  // guestCount field may be "101 - 150" / "85" / "100–150" — take the first
  // integer we can find so downstream parseGuestCount-style logic has a
  // usable value. The fuzzy parser does the rest.
  let guestCount: number | undefined
  if (lead.guestCount) {
    const m = lead.guestCount.match(/\d+/)
    if (m) guestCount = parseInt(m[0], 10)
  }

  return {
    classification: 'new_inquiry',
    confidence: 95,
    extractedData: {
      senderName: lead.leadName ?? undefined,
      partnerName: lead.partnerName ?? undefined,
      eventDate: lead.eventDate ?? undefined,
      guestCount,
      source: normalizeSource(lead.source),
      questions: [],
      urgencyLevel: 'medium',
      sentiment: 'positive',
    },
  }
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
  const rawFromEmail = extractEmailAddress(email.from)
  const rawFromName = extractName(email.from)

  // Step 1a: Universal auto-ignore — no-reply / bounces / postmasters.
  if (matchesUniversalIgnore(rawFromEmail)) {
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }

  // Step 1a.1: Early per-venue ignore rules on the RAW From. A coordinator
  // rule like "ignore @theknot.com" must fire before the form-relay parser
  // would otherwise rewrite From to the lead's personal email. Without
  // this, a venue that opts out of a marketplace wholesale still has every
  // inquiry from that marketplace flow through as a cold lead. Runs only
  // for action='ignore' at this stage — no_draft is handled post-rewrite
  // below so learned rules on the lead's own domain still work.
  const earlyFilterHit = await matchFilter(venueId, rawFromEmail, email.labels ?? [])
  if (earlyFilterHit?.action === 'ignore') {
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }

  // Step 1a.5: Form-relay detection. Platforms (The Knot, WeddingWire,
  // Here Comes The Guide, Zola) and the venue's own pricing calculator
  // mask the real prospect behind a relay / automation address. Run the
  // parsers BEFORE the self-loop guard: a calculator email's From is by
  // definition a venue-owned address, and without this step it would be
  // short-circuited as outbound and the prospect would vanish. When a
  // parser fires, we swap in the real lead's identity for the rest of
  // the pipeline and remember the original relay for logging.
  const ownEmails = await venueOwnEmails(venueId)
  const formLead = detectFormRelay(
    { from: email.from, to: email.to, subject: email.subject, body: email.body },
    ownEmails
  )
  const fromEmail = formLead?.leadEmail ?? rawFromEmail
  // When a form relay fires, the raw From display name is the platform /
  // venue name (e.g. "Rixey Manor", "Zola Vendor Communication"), not the
  // prospect. Falling back to that would stamp the venue's own name onto
  // the new lead. Use the parsed lead name or nothing.
  const fromName = formLead ? formLead.leadName ?? null : rawFromName

  // Step 1a.6: Content-based auto-ignore and machine-mail detection.
  // Runs only when no form-relay fired — Knot/Zola forwards legitimately
  // contain "view in browser" / List-Unsubscribe headers and we still
  // want those to flow through as inquiries.
  //
  //   - shouldAutoIgnore: subject/body patterns for out-of-office,
  //     "do not reply", automated responses, unsubscribe-flavoured
  //     newsletters. Was written but never wired until 2026-04-22.
  //   - isMachineGenerated: RFC-2822 header check for List-Unsubscribe,
  //     List-Id, Precedence: bulk/list/junk, Auto-Submitted. Catches
  //     HoneyBook, Cvent, Calendly, Stripe billing, Zola vendor
  //     broadcasts without needing one parser per SaaS.
  if (!formLead && shouldAutoIgnore(email.subject, email.body)) {
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }
  if (!formLead) {
    const machineReason = isMachineGenerated(email.headers)
    if (machineReason) {
      return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
    }
  }

  // Step 1b: Self-loop protection — when the sender is one of THIS venue's
  // own addresses (Sage relay or any linked gmail_connection), this is our
  // own outbound mail that Gmail returned alongside inbound in the same
  // thread. Record it as an outbound interaction so the thread stays
  // continuous, but short-circuit: no classification, no contact creation,
  // no wedding, no draft. Without this, sage@venue.com ends up as a
  // "couple" on the pipeline kanban. Skipped for form-relay matches —
  // those intentionally have a venue-owned From.
  if (!formLead && ownEmails.has(rawFromEmail)) {
    // Dedup: if we've already recorded this outbound (either this exact
    // Gmail-id or the same from/subject/time from a sibling connection),
    // skip the insert. Without this, a 3-connection venue gets 3 copies
    // of every sent email the venue sees in its own threads.
    const alreadySeen = await isEmailProcessed(venueId, email.messageId, {
      fromEmail: rawFromEmail,
      subject: email.subject,
      timestamp: email.date,
    })
    if (alreadySeen) {
      return { interactionId: null, draftId: null, classification: 'skipped', autoSent: false }
    }
    // Still persist so the inbox thread view is complete, but as outbound.
    const outboundPayload: Record<string, unknown> = {
      venue_id: venueId,
      type: 'email',
      direction: 'outbound',
      subject: email.subject,
      body_preview: email.body.slice(0, 300),
      full_body: email.body,
      from_email: fromEmail,
      from_name: fromName,
      gmail_message_id: email.messageId,
      gmail_thread_id: email.threadId,
      timestamp: email.date,
    }
    if (email.connectionId) outboundPayload.gmail_connection_id = email.connectionId
    await supabase.from('interactions').insert(outboundPayload)
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }

  // Step 1c: Per-venue filter rules (venue_email_filters) on the rewritten
  // fromEmail. The early pass above already caught ignore-rules against the
  // raw relay domain; this second pass catches rules written against the
  // lead's own address or domain (e.g. a learned no_draft on a repeat
  // vendor personal account). ignore here is still honoured for symmetry.
  //
  //   action='ignore'   → bail before classifier (saves tokens).
  //   action='no_draft' → classify + persist interaction, but don't draft.
  const filterHit = await matchFilter(venueId, fromEmail, email.labels ?? [])
  if (filterHit?.action === 'ignore') {
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }
  // Either filter can trigger no_draft; skipDraft is the union.
  const skipDraft =
    filterHit?.action === 'no_draft' || earlyFilterHit?.action === 'no_draft'

  // Check if already processed — by Gmail id AND by content fingerprint
  // so multi-connection venues don't triple-insert the same inbound email.
  const alreadyProcessed = await isEmailProcessed(venueId, email.messageId, {
    fromEmail,
    subject: email.subject,
    timestamp: email.date,
  })
  if (alreadyProcessed) {
    return { interactionId: null, draftId: null, classification: 'skipped', autoSent: false }
  }

  // Step 1d: Thread-history signals (Gap 2 + Gap 6).
  //
  // Boomerang problem: venue sends an outbound campaign/outreach to an
  // external list. A recipient replies. The reply's From is a cold
  // external address (not in ownEmails), so the self-loop guard doesn't
  // fire. With no prior context the LLM classifies it as new_inquiry,
  // findOrCreateContact mints a new person, and the wedding creation
  // gate below creates a brand-new "couple" — polluting the pipeline.
  //
  // Fix: measure the thread before classifying.
  //   - threadHasPriorOutbound: if the venue has sent on this thread
  //     before, this is a reply to us, not a cold lead. Gates wedding
  //     creation below AND is passed to the classifier as a hint.
  //   - priorInteractionCount / priorInteractionsFromSender: more
  //     context for the classifier so it stops re-labelling every
  //     thread reply as new_inquiry blind.
  let threadHasPriorOutbound = false
  let priorInteractionCount = 0
  let priorInteractionsFromSender = 0
  if (email.threadId) {
    const { count: outboundCount } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('gmail_thread_id', email.threadId)
      .eq('direction', 'outbound')
    threadHasPriorOutbound = (outboundCount ?? 0) > 0

    const { count: totalCount } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('gmail_thread_id', email.threadId)
    priorInteractionCount = totalCount ?? 0
  }
  {
    const { count: senderCount } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('from_email', fromEmail)
    priorInteractionsFromSender = senderCount ?? 0
  }

  // Step 2: Classify with router brain. Form-relay matches skip the LLM
  // classifier — we already know what these are (a prospect filling a web
  // form is a new inquiry by definition) and we already have structured
  // fields. Saves tokens and avoids the classifier mis-bucketing a
  // marketplace email as "vendor" or "other".
  let classification: ClassificationResult
  if (formLead) {
    classification = synthClassificationFromFormLead(formLead)
  } else {
    try {
      classification = await classifyEmail(
        venueId,
        {
          from: fromEmail,
          subject: email.subject,
          body: email.body,
        },
        {
          priorInteractionCount,
          threadHasPriorOutbound,
          priorInteractionsFromSender,
        }
      )
    } catch (err) {
      await logPipelineError(venueId, 'classify', err, {
        messageId: email.messageId,
        threadId: email.threadId,
        fromEmail,
        subject: email.subject?.slice(0, 200),
      })
      return { interactionId: null, draftId: null, classification: 'error', autoSent: false }
    }
  }

  // Step 3: Find or create contact (skip for spam/ignore)
  let personId: string | null = null
  let weddingId: string | null = null
  let isNewContact = false

  if (classification.classification !== 'spam') {
    try {
      const contact = await findOrCreateContact(venueId, fromEmail, fromName, ownEmails)
      personId = contact.personId
      isNewContact = contact.isNew

      // Use wedding from contact if router didn't find one
      if (!weddingId) {
        weddingId = contact.weddingId
      }
    } catch (err) {
      await logPipelineError(venueId, 'contact_lookup', err, {
        messageId: email.messageId,
        fromEmail,
      })
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
    await logPipelineError(venueId, 'insert_interaction', interactionError, {
      messageId: email.messageId,
      threadId: email.threadId,
      fromEmail,
      classification: classification.classification,
    })
    return { interactionId: null, draftId: null, classification: classification.classification, autoSent: false }
  }

  const interactionId = interaction.id as string

  // Step 5: If new inquiry, create wedding record and engagement event
  const extracted = classification.extractedData
  const detectedSource = normalizeSource(extracted.source ?? 'direct')
  const parsedEventDateObj = parseFuzzyDate(extracted.eventDate)
  const parsedEventDate = parsedEventDateObj?.iso ?? null
  const parsedGuestCount = parseGuestCount(extracted.guestCount)

  if (
    isNewContact &&
    !weddingId &&
    classification.classification === 'new_inquiry' &&
    // Boomerang guard (Gap 2): if the venue already sent outbound on this
    // thread, the incoming is a reply to our campaign/outreach — never a
    // cold new_inquiry, even if the classifier ranked it that way on body
    // cues alone. Without this gate, campaign replies become ghost couples.
    !threadHasPriorOutbound
  ) {
    const { data: newWedding } = await supabase
      .from('weddings')
      .insert({
        venue_id: venueId,
        status: 'inquiry',
        source: detectedSource,
        inquiry_date: new Date().toISOString(),
        wedding_date: parsedEventDate,
        wedding_date_precision: parsedEventDateObj?.precision ?? null,
        guest_count_estimate: parsedGuestCount,
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

      // Second partner: if classifier extracted a name, seed partner2 so
      // the detail/kanban has a couple label. Best-effort — skip silently
      // if a partner2 already exists (race on concurrent emails).
      if (extracted.partnerName) {
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

      // Phase 3 Task 35: record the first touchpoint in the multi-touch
      // journey table. Best-effort — failure here must not break inquiry
      // ingest. Subsequent replies don't add new touchpoints here; future
      // work captures UTM-bearing links and website visits separately.
      try {
        await supabase.from('wedding_touchpoints').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          source: detectedSource,
          medium: 'email',
          touch_type: 'inquiry',
          occurred_at: new Date().toISOString(),
          metadata: { subject: email.subject, fromEmail },
        })
      } catch (err) {
        console.warn('[pipeline] wedding_touchpoints insert failed:', err)
      }
    }
  } else if (weddingId && parsedEventDate) {
    // Existing wedding — backfill any extracted date / guest count that
    // wasn't already known. Never overwrite a manually-entered value.
    const { data: existingWedding } = await supabase
      .from('weddings')
      .select('wedding_date, guest_count_estimate')
      .eq('id', weddingId)
      .single()
    const patch: Record<string, unknown> = {}
    if (existingWedding && !existingWedding.wedding_date && parsedEventDate) {
      patch.wedding_date = parsedEventDate
      patch.wedding_date_precision = parsedEventDateObj?.precision ?? null
    }
    if (existingWedding && !existingWedding.guest_count_estimate && parsedGuestCount) {
      patch.guest_count_estimate = parsedGuestCount
    }
    if (Object.keys(patch).length > 0) {
      await supabase.from('weddings').update(patch).eq('id', weddingId)
    }
  }

  // Persist the full classifier blob for every email. This is the
  // source-of-truth for the /intel/clients/[id] AI-insights section and
  // the feed the intel layer learns from (urgency, sentiment, questions).
  await supabase.from('intelligence_extractions').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    interaction_id: interactionId,
    extraction_type: 'inquiry_classification',
    confidence: classification.confidence / 100,
    metadata: {
      classification: classification.classification,
      confidence: classification.confidence,
      extractedData: extracted,
      // Parsed date precision so the AI Insights UI can render "Fall 2026"
      // rather than "2026-10-01" when the classifier only gave us a season.
      parsedEventDate: parsedEventDateObj
        ? { iso: parsedEventDateObj.iso, precision: parsedEventDateObj.precision, raw: parsedEventDateObj.raw }
        : null,
      via: 'live-pipeline',
      subject: email.subject,
    },
  })

  // F6: classifier-derived heat signals. The router-brain already reads
  // the body, so we use its structured output instead of re-regexing for
  // tour requests, commitment phrases, or family mentions. Each fires as
  // an engagement_event with its own event_type so /agent/heat and the
  // intel attribution pages can see which signals actually moved the
  // score on booked weddings. Only runs for wedding-bearing productive
  // emails (new_inquiry / inquiry_reply); vendor / spam / internal skip.
  if (
    weddingId &&
    (classification.classification === 'new_inquiry' ||
      classification.classification === 'inquiry_reply')
  ) {
    const sharedMeta = { interaction_id: interactionId, subject: email.subject }
    const heatEvents: Array<{ eventType: string; metadata: Record<string, unknown> }> = []

    if (extracted.mentionsTourRequest) {
      heatEvents.push({ eventType: 'tour_requested', metadata: sharedMeta })
    }
    if (extracted.commitmentLevel === 'decided') {
      heatEvents.push({
        eventType: 'high_commitment_signal',
        metadata: { ...sharedMeta, commitmentLevel: extracted.commitmentLevel },
      })
    }
    if (extracted.mentionsFamilyAttending) {
      heatEvents.push({ eventType: 'family_mentioned', metadata: sharedMeta })
    }
    if (
      typeof extracted.specificityScore === 'number' &&
      extracted.specificityScore >= 0.7
    ) {
      heatEvents.push({
        eventType: 'high_specificity',
        metadata: { ...sharedMeta, specificityScore: extracted.specificityScore },
      })
    }

    if (heatEvents.length > 0) {
      try {
        await recordEngagementEventsBatch(venueId, weddingId, heatEvents)
      } catch (err) {
        // Heat signals are additive — never let a batch insert failure
        // break the pipeline. Log and continue.
        await logPipelineError(venueId, 'heat_signal_record', err, {
          interactionId,
          weddingId,
          events: heatEvents.map((e) => e.eventType),
        })
      }
    }
  }

  // Step 5a.5: Knowledge-gap capture. Every question the classifier
  // extracted gets recorded into knowledge_gaps so the /agent/knowledge-gaps
  // page shows a real backlog over time. Venue-scoped; normalises/dedupes
  // within the batch. Best-effort — never fails the pipeline.
  try {
    const qs = (extracted.questions as string[] | undefined) ?? []
    if (qs.length > 0) {
      await recordKnowledgeGaps({ venueId, questions: qs, weddingId })
    }
  } catch (err) {
    await logPipelineError(venueId, 'knowledge_gaps_record', err, {
      interactionId,
      weddingId,
    })
  }

  // Step 5b: Booking-confirmation detection (coordinator prompt, never
  // auto-marks the date booked). Scans for contract / deposit / "we're
  // official" language. If the wedding is in a pre-booking stage and has a
  // wedding_date, surface a structured notification with the slot math so
  // the coordinator can confirm or dismiss. Calendly/HoneyBook mail can't
  // reach this path — venue_email_filters short-circuits them before the
  // classifier (migration 069 + trigger in 072).
  try {
    const signal = weddingId ? detectBookingSignal(email.body) : { matched: false, phrase: null }
    if (weddingId && signal.matched) {
      const { data: weddingRow } = await supabase
        .from('weddings')
        .select('status, wedding_date, wedding_date_precision')
        .eq('id', weddingId)
        .single()

      const currentStatus = weddingRow?.status as string | undefined
      const weddingDate = weddingRow?.wedding_date as string | null
      const weddingDatePrecision = weddingRow?.wedding_date_precision as string | null

      if (
        currentStatus &&
        ['tour_completed', 'proposal_sent'].includes(currentStatus)
      ) {
        // Flag the interaction via intelligence_extractions — the audit
        // trail feeds future learning (which phrases correlate with real
        // bookings vs false positives).
        await supabase.from('intelligence_extractions').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          interaction_id: interactionId,
          extraction_type: 'booking_signal_detected',
          value: {
            source: 'regex',
            from: fromEmail,
            subject: email.subject,
            matched_phrase: signal.phrase,
          },
          confidence: 0.8,
        })

        // Build couple name for the card header.
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

        // Slot math — how many weddings are already booked on this date
        // at this venue, and what's the cap. Coordinator card renders
        // "X of Y slots would remain after confirming". Falls back to 1
        // when nothing explicit is configured.
        let currentBooked = 0
        let maxEvents = 1
        if (weddingDate) {
          const [{ data: availRow }, { data: cfgRow }] = await Promise.all([
            supabase
              .from('venue_availability')
              .select('booked_count, max_events')
              .eq('venue_id', venueId)
              .eq('date', weddingDate)
              .maybeSingle(),
            supabase
              .from('venue_config')
              .select('max_events_per_day')
              .eq('venue_id', venueId)
              .maybeSingle(),
          ])
          if (availRow) {
            currentBooked = (availRow.booked_count as number | null) ?? 0
            maxEvents = (availRow.max_events as number | null) ?? 1
          } else {
            maxEvents = (cfgRow?.max_events_per_day as number | null) ?? 1
          }
        }

        // Structured body — the card parses this. Keep the shape stable;
        // the confirm API and the UI card read the same fields.
        const body = JSON.stringify({
          weddingId,
          interactionId,
          coupleLabel,
          weddingDate,
          weddingDatePrecision,
          currentBooked,
          maxEvents,
          matchedPhrase: signal.phrase,
          fromEmail,
          subject: email.subject,
        })

        await createNotification({
          venueId,
          weddingId,
          type: 'booking_confirmation_prompt',
          title: weddingDate
            ? `Looks like ${coupleLabel} may have booked`
            : `Possible booking from ${coupleLabel}`,
          body,
        })
      }
    }
  } catch (err) {
    await logPipelineError(venueId, 'booking_signal_detect', err, {
      interactionId,
      weddingId,
    })
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
        // Surface the detected source (form-relay parser output or 'direct')
        // so first-touch replies can acknowledge the discovery channel
        // instead of treating every inquiry identically.
        source: detectedSource,
      })

      draftBody = inquiryResult.draft
      confidenceScore = inquiryResult.confidence
      brainUsed = 'inquiry'
    } catch (err) {
      await logPipelineError(venueId, 'inquiry_brain', err, {
        interactionId,
        fromEmail,
        classification: emailClassification,
      })
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
        await logPipelineError(venueId, 'client_brain', err, {
          interactionId,
          weddingId,
          fromEmail,
        })
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
          threadId: email.threadId,
        })

        if (eligibility.eligible) {
          // Mark draft as pending auto-send (not sent yet)
          const sendAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

          // Use .select() so Supabase returns the row on success and an
          // error on failure. Before migration 067, the drafts.status
          // CHECK rejected 'auto_send_pending' silently — the update
          // "succeeded" with zero rows affected and auto-send never
          // actually fired. Guard with an explicit error check so any
          // future CHECK drift fails loudly instead of going dark.
          const { error: autoSendUpdateErr } = await supabase
            .from('drafts')
            .update({
              status: 'auto_send_pending',
              auto_sent: false,
              auto_send_source: detectedSource,
              auto_send_attempts: 0,
            })
            .eq('id', draftId)
            .select('id')
            .single()

          if (autoSendUpdateErr) {
            await logPipelineError(venueId, 'autosend_stage_transition', autoSendUpdateErr, {
              draftId,
              interactionId,
            })
            // Do not create a notification or mark autoSent — the draft
            // stays in 'pending' for manual approval.
          } else {
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
        }
      } catch (err) {
        await logPipelineError(venueId, 'autosend_check', err, {
          draftId,
          interactionId,
        })
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
      await logPipelineError(venueId, 'process_email_unhandled', err, {
        messageId: email.messageId,
        threadId: email.threadId,
      })
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
 * Maximum send attempts before a draft is moved to auto_send_failed. Three
 * is chosen because our two known failure modes — transient Gmail 5xx and
 * expired refresh-token after manual re-auth — either resolve within one
 * retry or never resolve at all. Beyond three, spinning further risks
 * double-sending on partial-failure corner cases.
 */
const AUTO_SEND_MAX_ATTEMPTS = 3

/**
 * Check for pending auto-send notifications that have passed their 5-minute
 * delay window. For each one that hasn't been cancelled, actually send the
 * email via Gmail and update the draft status.
 *
 * Called by the cron email_poll job after processing new emails.
 *
 * Retry-loop guard (was: infinite retry, possible double-send).
 *
 * The previous version left a notification `read=false` whenever anything
 * went wrong — sendEmail returning null, JSON.parse throwing on a
 * malformed body, or the post-send DB update hiccuping after Gmail had
 * already accepted the message. Next cron tick would retry the same
 * notification, which at best wasted tokens and at worst sent the same
 * reply twice to the couple.
 *
 * Replacement flow per notification:
 *   1. Parse body defensively. Malformed → mark notif read, skip.
 *   2. Skip if sendAt hasn't elapsed.
 *   3. Atomic claim: transition status 'auto_send_pending' →
 *      'auto_send_sending' with a WHERE on the current status. If zero
 *      rows returned, some other tick beat us to it — skip without
 *      touching anything. This is the double-send guard.
 *   4. Call Gmail. Success (non-null messageId): status='sent',
 *      auto_sent=true, notif read. Failure (null or exception):
 *      increment auto_send_attempts, store last_error. If attempts
 *      reach the max, set status='auto_send_failed' and create a
 *      coordinator alert. Otherwise return status to 'auto_send_pending'
 *      for the next cron tick to pick up.
 *
 * sendEmail itself catches internally and returns null on any Gmail
 * error, so we treat null identically to a caught exception — both
 * are "this attempt failed".
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
    // Step 1: Defensive JSON parse. Malformed body (schema drift, old
    // notifications from a previous pipeline version) is not a retry
    // condition — mark it read and move on.
    let details: {
      draftId: string
      toEmail: string
      subject: string
      threadId?: string
      sendAt: string
    }
    try {
      details = JSON.parse(notif.body as string)
    } catch (parseErr) {
      await logPipelineError(venueId, 'autosend_flush_malformed', parseErr, {
        notificationId: notif.id,
      })
      await supabase
        .from('admin_notifications')
        .update({ read: true, read_at: new Date().toISOString() })
        .eq('id', notif.id)
      continue
    }

    // Step 2: Delay gate. Leave the notification unread so the next tick
    // re-evaluates it — this is the expected not-yet-time path.
    const sendAtMs = new Date(details.sendAt).getTime()
    if (!Number.isFinite(sendAtMs) || Date.now() < sendAtMs) continue

    try {
      // Step 3: Atomic claim. Only one flush tick can flip
      // auto_send_pending → auto_send_sending for a given draft.
      // Concurrent ticks see zero rows and skip — double-send guard.
      const { data: claimed, error: claimErr } = await supabase
        .from('drafts')
        .update({ status: 'auto_send_sending' })
        .eq('id', details.draftId)
        .eq('status', 'auto_send_pending')
        .select('id, draft_body, auto_send_attempts')

      if (claimErr) {
        await logPipelineError(venueId, 'autosend_claim', claimErr, {
          notificationId: notif.id,
          draftId: details.draftId,
        })
        continue // leave notif unread; transient DB errors retry next tick
      }
      if (!claimed || claimed.length === 0) {
        // Draft was cancelled, already sent, or claimed by a sibling
        // tick. Mark notif read so we stop considering it.
        await supabase
          .from('admin_notifications')
          .update({ read: true, read_at: new Date().toISOString() })
          .eq('id', notif.id)
        continue
      }

      const draft = claimed[0] as { id: string; draft_body: string; auto_send_attempts: number }
      const currentAttempts = draft.auto_send_attempts ?? 0

      // Step 4: Send. sendEmail catches internally and returns null on
      // any Gmail-side failure, so null === failed attempt here.
      let sentMessageId: string | null = null
      let sendError: unknown = null
      try {
        const disclosureCtx = await fetchDisclosureContext(venueId)
        sentMessageId = await sendEmail(
          venueId,
          details.toEmail,
          details.subject,
          appendAIDisclosure(draft.draft_body, disclosureCtx),
          details.threadId
        )
      } catch (err) {
        sendError = err
      }

      if (sentMessageId) {
        // Success path: commit the sent state and close the notification.
        // sent_at is the enforcement timestamp for the 24h thread cap
        // (autonomous-sender.getRecentThreadAutoSendCount queries it).
        const nowIso = new Date().toISOString()
        await supabase
          .from('drafts')
          .update({
            status: 'sent',
            auto_sent: true,
            approved_at: nowIso,
            sent_at: nowIso,
          })
          .eq('id', draft.id)

        await supabase
          .from('admin_notifications')
          .update({ read: true, read_at: new Date().toISOString() })
          .eq('id', notif.id)

        sentCount++
        continue
      }

      // Failure path: bump attempts, decide retry vs. give-up.
      const nextAttempts = currentAttempts + 1
      const reachedMax = nextAttempts >= AUTO_SEND_MAX_ATTEMPTS
      const lastError = sendError
        ? sendError instanceof Error
          ? sendError.message
          : String(sendError)
        : 'sendEmail returned null'

      await supabase
        .from('drafts')
        .update({
          status: reachedMax ? 'auto_send_failed' : 'auto_send_pending',
          auto_send_attempts: nextAttempts,
          auto_send_last_error: lastError.slice(0, 500),
        })
        .eq('id', draft.id)

      await logPipelineError(venueId, 'autosend_send_failed', sendError ?? new Error(lastError), {
        draftId: draft.id,
        notificationId: notif.id,
        attempts: nextAttempts,
        maxAttempts: AUTO_SEND_MAX_ATTEMPTS,
      })

      if (reachedMax) {
        // Retries exhausted — close this notification and raise a
        // coordinator-facing one so they know to handle the draft
        // manually.
        await supabase
          .from('admin_notifications')
          .update({ read: true, read_at: new Date().toISOString() })
          .eq('id', notif.id)

        await createNotification({
          venueId,
          type: 'auto_send_failed',
          title: `Auto-send failed after ${AUTO_SEND_MAX_ATTEMPTS} attempts`,
          body: JSON.stringify({
            draftId: draft.id,
            toEmail: details.toEmail,
            subject: details.subject,
            lastError: lastError.slice(0, 500),
          }),
        })
      }
      // Else: we left status='auto_send_pending' and the notification
      // unread. Next cron tick will retry. sendAt is in the past so
      // it'll fire immediately.
    } catch (err) {
      // Catch-all for anything above that slipped past the specific
      // handlers (e.g. notification update failing). Do not mark notif
      // read — if we landed here we don't know whether the email went
      // out, and leaving it unread means the claim guard + attempts
      // counter still protect against double-send on the next tick.
      await logPipelineError(venueId, 'autosend_flush', err, {
        notificationId: notif.id,
        draftId: details.draftId,
      })
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

  // Update draft status. sent_at is written on the coordinator-approved path
  // too so outbound activity timing is consistent across auto-send + manual.
  await supabase
    .from('drafts')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
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
