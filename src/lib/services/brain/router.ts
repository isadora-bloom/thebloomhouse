/**
 * Bloom House: Router Brain
 *
 * Email classification service. Determines what kind of email came in,
 * extracts structured data, and routes it to the correct brain.
 *
 * Responsibilities:
 * - Classify inbound emails (new inquiry, reply, client, vendor, spam, etc.)
 * - Extract sender info, partner names, event dates, guest counts, questions
 * - Find or create contacts in the database
 * - Filter auto-ignore patterns (out-of-office, newsletters, etc.)
 */

import { createServiceClient } from '@/lib/supabase/service'

/** Prompt revision identifier — see PROMPTS-CHANGELOG.md / OPS-21.5.1.
 *  v1.1 (T5-schema-gap, migration 165): added estimatedGuests extraction
 *  field with explicit guidance for ranges, approximate phrasing, and
 *  the "do not infer numbers from adjectives" gate. */
export const BRAIN_PROMPT_VERSION = 'router-brain.prompt.v1.2'
import {
  SPAM_KEYWORDS,
  checkSpam,
} from '@/config/escalation-keywords'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailClassification =
  | 'new_inquiry'
  | 'inquiry_reply'
  | 'client_message'
  | 'vendor'
  | 'spam'
  | 'internal'
  | 'other'

export interface ClassificationResult {
  classification: EmailClassification
  confidence: number
  extractedData: {
    senderName?: string
    partnerName?: string
    eventDate?: string
    guestCount?: number
    /**
     * T5-schema-gap: explicit lead-side headcount estimate. Lands in
     * `weddings.estimated_guests` (migration 165). Range 1-1000 enforced
     * downstream; the prompt instructs Claude to leave NULL when the
     * couple uses qualitative language like "small wedding" or
     * "intimate" — we don't infer numbers from adjectives.
     *
     * Maintained alongside `guestCount` (legacy field, same shape) for
     * backwards compatibility with the form-relay synth path that already
     * writes guestCount. Both feed `parseGuestCount` and `validateEstimatedGuests`.
     */
    estimatedGuests?: number
    source?: string
    questions: string[]
    urgencyLevel: 'low' | 'medium' | 'high'
    sentiment: 'positive' | 'neutral' | 'negative'
    // Heat signals — the classifier is already reading the body, so it
    // emits structured booleans here and the email-pipeline translates
    // them into engagement_events. Avoids regex duplication in
    // heat-mapping or the pipeline for the same phrases.
    mentionsTourRequest?: boolean
    mentionsFamilyAttending?: boolean
    /** 'none' (browsing), 'considering' (gathering info), 'decided' (strong intent — "we want to book"). */
    commitmentLevel?: 'none' | 'considering' | 'decided'
    /** 0-1 estimate of how specific the email is (named date + guest count + venue specifics = higher). */
    specificityScore?: number
  }
}

export interface FindOrCreateContactResult {
  personId: string
  weddingId: string | null
  isNew: boolean
}

// ---------------------------------------------------------------------------
// Auto-ignore patterns
// ---------------------------------------------------------------------------

const AUTO_IGNORE_SUBJECTS: string[] = [
  'out of office',
  'out-of-office',
  'automatic reply',
  'auto-reply',
  'autoreply',
  'delivery status notification',
  'undeliverable',
  'mailer-daemon',
  'postmaster',
  'do not reply',
  'do-not-reply',
  'noreply',
  'no-reply',
  // Scheduling / booking-tool confirmations (Calendly, Acuity, HoneyBook,
  // Dubsado). Belt-and-braces with the venue_email_filters seed in
  // migration 069 — if a platform variant ever strips List-Unsubscribe,
  // subject-based ignore keeps `startTime` out of wedding_date.
  'your tour is confirmed',
  'new event scheduled:',
  'event scheduled with',
  'has been scheduled',
  'calendar invite:',
  'invitation: ',
]

const AUTO_IGNORE_BODY_PATTERNS: string[] = [
  'i am currently out of the office',
  'i will be out of the office',
  'i\'m currently out of the office',
  'this is an automated response',
  'this is an automatic email',
  'this mailbox is not monitored',
  'unsubscribe from this list',
  'you are receiving this email because',
  'manage your email preferences',
  'view in browser',
  'email preferences',
  'update your preferences',
]

// ---------------------------------------------------------------------------
// shouldAutoIgnore
// ---------------------------------------------------------------------------

/**
 * Check if an email should be automatically ignored without processing.
 * Catches out-of-office replies, newsletters, promotional emails, etc.
 */
export function shouldAutoIgnore(subject: string, body: string): boolean {
  const lowerSubject = subject.toLowerCase()
  const lowerBody = body.toLowerCase()

  // Check subject against auto-ignore patterns
  for (const pattern of AUTO_IGNORE_SUBJECTS) {
    if (lowerSubject.includes(pattern)) return true
  }

  // Check body against auto-ignore patterns
  for (const pattern of AUTO_IGNORE_BODY_PATTERNS) {
    if (lowerBody.includes(pattern)) return true
  }

  // Check against spam keywords from escalation config
  const spamCheck = checkSpam(`${subject} ${body}`)
  if (spamCheck.isSpam) return true

  return false
}

// ---------------------------------------------------------------------------
// Machine-generated mail detection (RFC headers)
// ---------------------------------------------------------------------------

/**
 * Detect machine-generated bulk/list/auto-submitted mail from its RFC-2822
 * headers. Pure header-based — does not look at subject or body, so callers
 * that want to keep real inquiries forwarded through platforms (The Knot,
 * Zola) must short-circuit this check when a form-relay parser already fired.
 *
 * Signals:
 *   - List-Unsubscribe present                → bulk list mail
 *   - List-Id present                         → mailing list
 *   - Precedence: bulk | list | junk          → mass mail
 *   - Auto-Submitted: anything other than 'no'→ auto-generated (RFC 3834)
 *
 * Returns the reason string (for logging) or null if the mail looks human.
 */
export function isMachineGenerated(headers?: Record<string, string>): string | null {
  if (!headers) return null
  const h = headers

  if (h['list-unsubscribe']) return 'list-unsubscribe header'
  if (h['list-id']) return 'list-id header'

  const precedence = (h['precedence'] || '').toLowerCase().trim()
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
    return `precedence: ${precedence}`
  }

  const autoSubmitted = (h['auto-submitted'] || '').toLowerCase().trim()
  // RFC 3834: "no" means a human authored the reply. Anything else
  // (auto-generated, auto-replied, ...) is machine.
  if (autoSubmitted && autoSubmitted !== 'no') {
    return `auto-submitted: ${autoSubmitted}`
  }

  return null
}

// ---------------------------------------------------------------------------
// classifyEmail
// ---------------------------------------------------------------------------

/**
 * Use AI to classify an inbound email and extract structured data.
 *
 * Understands wedding venue context: couples inquiring, booked clients,
 * vendors, platform forwarded emails, etc.
 *
 * When `context` is passed the classifier is given thread history signals
 * so it can distinguish "first time this sender appears" from "reply inside
 * an ongoing conversation". Without these signals the LLM was re-labelling
 * every thread reply as new_inquiry and the pipeline was minting duplicate
 * weddings on every round-trip.
 */
/**
 * Classify an inbound email + extract structured data.
 *
 * v2 (2026-05-12) — back-compat adapter over the unified inbound
 * classifier (`classifyInboundRaw` in
 * `lib/services/intel/inbound-intent-classifier.ts`). Routes the same
 * Haiku call that the email pipeline uses, deriving the 7-class
 * EmailClassification deterministically from the 11-class intent_class
 * and reading the signals payload for extractedData. Single source of
 * truth for the prompt + relay-pattern recognition.
 *
 * Existing callers (pipeline.ts, reprocess-orphans, etc.) keep working
 * unchanged — the signature is identical. New pipeline code can use
 * `classifyInboundRaw` directly to get the full verdict (intent_class +
 * extracted_facts + signals) without a second adapter hop.
 */
export async function classifyEmail(
  venueId: string,
  email: { from: string; subject: string; body: string },
  context?: {
    /** Count of prior interactions (in or out) on the same thread_id for this venue. */
    priorInteractionCount?: number
    /** True if the venue has previously sent an outbound message on this thread. */
    threadHasPriorOutbound?: boolean
    /** Count of prior interactions from this exact sender address across all threads. */
    priorInteractionsFromSender?: number
    /** Correlation id from upstream pipeline (T1-G). */
    correlationId?: string
  }
): Promise<ClassificationResult> {
  // Lazy import to avoid a circular dependency through pipeline.ts.
  const { classifyInboundRaw, intentToEmailClassification } = await import(
    '@/lib/services/intel/inbound-intent-classifier'
  )

  const verdict = await classifyInboundRaw({
    body: email.body,
    subject: email.subject,
    venueId,
    channel: 'email',
    fromEmail: email.from,
    priorInteractionCount: context?.priorInteractionCount,
    threadHasPriorOutbound: context?.threadHasPriorOutbound,
    correlationId: context?.correlationId ?? null,
  })

  return {
    classification: intentToEmailClassification(verdict.intent_class),
    confidence: verdict.confidence,
    extractedData: {
      senderName: verdict.signals.sender_name ?? undefined,
      partnerName: verdict.signals.partner_name ?? undefined,
      eventDate: verdict.signals.event_date ?? undefined,
      guestCount: verdict.signals.guest_count ?? undefined,
      estimatedGuests: verdict.signals.guest_count ?? undefined,
      source: verdict.signals.source ?? undefined,
      questions: verdict.signals.questions,
      urgencyLevel: verdict.signals.urgency_level,
      sentiment: verdict.signals.sentiment,
      mentionsTourRequest: verdict.signals.mentions_tour_request,
      mentionsFamilyAttending: verdict.signals.mentions_family_attending,
      commitmentLevel: verdict.signals.commitment_level,
      specificityScore: verdict.signals.specificity_score,
    },
  }
}

// ---------------------------------------------------------------------------
// findOrCreateContact
// ---------------------------------------------------------------------------

/**
 * Look up an existing person by email in the contacts table.
 * If not found, creates a new person + contact record.
 *
 * Returns the person ID, associated wedding ID (if any), and whether
 * this is a new contact.
 */
export async function findOrCreateContact(
  venueId: string,
  email: string,
  name?: string
): Promise<FindOrCreateContactResult> {
  const supabase = createServiceClient()
  const normalizedEmail = email.toLowerCase().trim()

  // Look up existing contact by email value
  const { data: existingContacts } = await supabase
    .from('contacts')
    .select('person_id')
    .eq('type', 'email')
    .eq('value', normalizedEmail)

  if (existingContacts && existingContacts.length > 0) {
    const personId = existingContacts[0].person_id as string

    // Get the person to find their wedding
    const { data: person } = await supabase
      .from('people')
      .select('id, wedding_id, venue_id')
      .eq('id', personId)
      .single()

    // Verify this person belongs to this venue
    if (person && person.venue_id === venueId) {
      return {
        personId: person.id as string,
        weddingId: (person.wedding_id as string) ?? null,
        isNew: false,
      }
    }

    // Person exists but for a different venue — check if there's one for this venue
    const { data: venueContacts } = await supabase
      .from('contacts')
      .select('person_id, people!inner(id, venue_id, wedding_id)')
      .eq('type', 'email')
      .eq('value', normalizedEmail)
      .eq('people.venue_id', venueId)

    if (venueContacts && venueContacts.length > 0) {
      const raw = venueContacts[0] as unknown as {
        person_id: string
        people: Array<{ id: string; wedding_id: string | null }>
      }
      const personMatch = Array.isArray(raw.people) ? raw.people[0] : null
      return {
        personId: raw.person_id,
        weddingId: personMatch?.wedding_id ?? null,
        isNew: false,
      }
    }
  }

  // No existing contact for this venue — create new person + contact
  const firstName = name?.split(' ')[0] ?? null
  const lastName = name?.split(' ').slice(1).join(' ') || null

  const { data: newPerson, error: personError } = await supabase
    .from('people')
    .insert({
      venue_id: venueId,
      role: 'partner1',
      first_name: firstName,
      last_name: lastName,
      email: normalizedEmail,
    })
    .select('id')
    .single()

  if (personError) throw personError

  const personId = newPerson.id as string

  // Create contact record
  const { error: contactError } = await supabase.from('contacts').insert({
    person_id: personId,
    type: 'email',
    value: normalizedEmail,
    is_primary: true,
  })

  if (contactError) {
    console.error('[router-brain] Failed to create contact:', contactError.message)
  }

  return {
    personId,
    weddingId: null,
    isNew: true,
  }
}
