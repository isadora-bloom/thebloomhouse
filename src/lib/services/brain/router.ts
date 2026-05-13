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
import { callAIJson } from '@/lib/ai/client'

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

const CLASSIFICATION_SYSTEM_PROMPT = `You are an email classification engine for a wedding venue. Your job is to analyze inbound emails and determine:

1. **Classification** — What type of email is this?
   - "new_inquiry": A couple reaching out for the FIRST TIME about hosting their wedding. Usually mentions wedding date, guest count, interest in the venue, or comes from a wedding platform (The Knot, WeddingWire, Zola, etc.).
   - "inquiry_reply": A reply to an existing conversation with a lead/inquiry who has NOT yet booked. They're continuing a conversation about availability, pricing, tours, etc.
   - "client_message": A message from a couple who has ALREADY BOOKED the venue. They're asking about planning, vendors, timeline, logistics, or day-of details.
   - "vendor": An email from a vendor (caterer, photographer, DJ, florist, planner, etc.) about an upcoming event, partnership, or general vendor business.
   - "spam": Unsolicited commercial email, marketing, newsletters, or clearly irrelevant messages.
   - "internal": An email from within the venue team (staff, owner, coordinator).
   - "other": Anything that doesn't clearly fit the above categories.

2. **Extracted Data** — Pull out structured information:
   - senderName: The name of the person emailing (from the email body or signature, not just the from address)
   - partnerName: If they mention a partner/fiance name
   - eventDate: Any mentioned wedding date (return as ISO string YYYY-MM-DD if specific, or descriptive like "Fall 2026" if vague)
   - guestCount: Estimated guest count if mentioned (kept for legacy callers; same data as estimatedGuests)
   - estimatedGuests: Lead-side headcount estimate. Extract an integer when the email says any of:
       * "150 guests" / "around 200" / "about 100" / "120-130 people" / "150 attendees" / "100 head"
       * Numerical range ("120-150 people", "100 to 130") -> take the MIDPOINT and round to the nearest whole number
       * Approximate words ("around 150", "roughly 100") -> use the integer they gave
       * Mixed phrasing ("80 to 100 of our closest friends") -> take the midpoint
     Leave NULL when the couple uses qualitative language only:
       * "small wedding" / "large wedding" / "intimate" / "big" / "tiny" -> NULL (do NOT infer numbers from adjectives)
       * "we don't know yet" / "still figuring out the list" -> NULL
     Range gate: integers must be 1-1000. If the value is outside that, return NULL.
     The same number can be returned in both guestCount and estimatedGuests when present.
   - source: If identifiable (the_knot, wedding_wire, google, instagram, referral, website, zola, other)
   - questions: Array of specific questions they're asking (extract each distinct question)
   - urgencyLevel: "low" (general browsing), "medium" (actively planning, has a date), "high" (date is soon, needs quick response, or explicitly says urgent)
   - sentiment: "positive" (excited, enthusiastic), "neutral" (informational), "negative" (frustrated, concerned)
   - mentionsTourRequest: true if the sender explicitly asks to book / schedule / come see / tour the venue
   - mentionsFamilyAttending: true if parents, family, or wedding party are explicitly mentioned as involved/attending
   - commitmentLevel: "none" (just curious, browsing), "considering" (actively comparing / gathering info / asked pricing), "decided" (clear intent to book — "we want to book", "we're ready to move forward", date set and pushing to lock in)
   - specificityScore: 0.0 to 1.0, how specific this email is. 0.0 for "do you host weddings?". 0.5 for "we're thinking summer 2026 for around 120 guests". 1.0 for "we want July 18 2026 for 140 guests, plated dinner, we'd like to tour next Saturday at 2pm". Higher = more signal the couple has done their homework.

3. **Confidence** — How confident are you in the classification? (0-100)
   - 90-100: Very clear classification
   - 70-89: Likely correct but some ambiguity
   - 50-69: Best guess, human should verify
   - Below 50: Unclear, flag for human review

IMPORTANT DISTINCTIONS:
- New inquiry vs reply: new inquiries have NO prior conversation context. Replies reference previous emails or are part of an existing thread.
- Inquiry reply vs client message: inquiry replies are from people still DECIDING. Client messages are from people who have BOOKED.
- Platform emails (The Knot, WeddingWire, Zola): these forward inquiry details but the actual sender is the couple, not the platform.

RELAY PATTERNS — recognise these BEFORE you classify (the From: header gets rewritten to the couple's gmail address on most of these, so a gmail.com sender is NOT evidence the sender is a vendor or random outreach):

- Knot Pro Inbox relay: subject contains "📩" emoji AND "sent you a new message", OR body references "theknot.com" / "The Knot Pro Network". The couple's intake-form selections — e.g. "Interested Services: Tables and chairs, Linens, Lighting, Sound equipment" — is a SHOPPING LIST, not a booked-couple logistics conversation. Classify as new_inquiry.

- Calendly / Acuity notifications: subject starts with "New Event:" / "Invitee:" / "Event scheduled" / "New appointment" / "Rescheduled:" / "Canceled:", body links calendly.com or acuityscheduling.com. The invitee is the couple booking (or having previously booked + now rescheduling/canceling) a tour. Classify as inquiry_reply when there's prior thread context, otherwise new_inquiry. Boilerplate phrases like "amazing tour planned for you" are Calendly's copy, NOT vendor pitch language.

- WeddingWire / Here Comes The Guide / Zola intake forms: body references the platform name + a form-relay wrapper ("New Lead for...", "WeddingPro Inbox", "authsolic..."). Classify as new_inquiry.

- Pricing-calculator submissions: body contains "NEW CALCULATOR SUBMISSION" or "Your Rixey Manor estimate" / "<venue> estimate". The couple submitted the on-site calculator and got a price. Classify as inquiry_reply when there's prior conversation, otherwise new_inquiry.

Do NOT label any of these patterns as vendor / spam / other. The whole reason these platforms exist is to route real couples to venues; their content is by definition lead activity.

Return JSON matching this exact structure:
{
  "classification": "new_inquiry" | "inquiry_reply" | "client_message" | "vendor" | "spam" | "internal" | "other",
  "confidence": number,
  "extractedData": {
    "senderName": string | null,
    "partnerName": string | null,
    "eventDate": string | null,
    "guestCount": number | null,
    "estimatedGuests": number | null,
    "source": string | null,
    "questions": string[],
    "urgencyLevel": "low" | "medium" | "high",
    "sentiment": "positive" | "neutral" | "negative",
    "mentionsTourRequest": boolean,
    "mentionsFamilyAttending": boolean,
    "commitmentLevel": "none" | "considering" | "decided",
    "specificityScore": number
  }
}`

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
  const contextBlock = context
    ? `\n\nTHREAD CONTEXT:\n- Prior messages in this thread for this venue: ${context.priorInteractionCount ?? 0}\n- Venue has previously sent outbound on this thread: ${context.threadHasPriorOutbound ? 'yes' : 'no'}\n- Prior messages from this sender across all threads: ${context.priorInteractionsFromSender ?? 0}\n\nIf prior interactions > 0 OR prior outbound on thread = yes, this is almost\ncertainly NOT a new_inquiry — prefer inquiry_reply or client_message.`
    : ''

  const userPrompt = `Classify this email:

FROM: ${email.from}
SUBJECT: ${email.subject}

BODY:
${email.body.slice(0, 3000)}${contextBlock}`

  const result = await callAIJson<ClassificationResult>({
    systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 800,
    temperature: 0.1,
    venueId,
    taskType: 'email_classification',
    // Haiku tier per Playbook 19.8 — small label set (7 classification
    // values), bounded structured output, high volume. Sonnet was
    // 12x the cost for the same answer. OPS-21.4.2 enforcement.
    tier: 'haiku',
    promptVersion: BRAIN_PROMPT_VERSION,
    correlationId: context?.correlationId,
  })

  // Normalize and validate
  const validClassifications: EmailClassification[] = [
    'new_inquiry',
    'inquiry_reply',
    'client_message',
    'vendor',
    'spam',
    'internal',
    'other',
  ]

  if (!validClassifications.includes(result.classification)) {
    result.classification = 'other'
    result.confidence = Math.min(result.confidence, 50)
  }

  // Ensure extractedData has required fields
  result.extractedData = {
    ...result.extractedData,
    questions: result.extractedData?.questions ?? [],
    urgencyLevel: result.extractedData?.urgencyLevel ?? 'low',
    sentiment: result.extractedData?.sentiment ?? 'neutral',
  }

  // Clamp confidence
  result.confidence = Math.max(0, Math.min(100, result.confidence))

  return result
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
