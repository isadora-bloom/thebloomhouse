/**
 * Bloom House — Inbound intent classifier.
 *
 * Why this exists (Anja Putman / RM-1152, 2026-05-12):
 * Bloom currently assumes every inbound is a potentially-new inquiry
 * until proven otherwise. Anja's post-booking logistics chatter on
 * behalf of her daughter Kajlie minted a fresh wedding, scored heat=99,
 * and queued sequence drafts inviting her on a tour.
 *
 * The fix is one classifier that runs on every inbound (email, SMS,
 * call transcript, voicemail, Zoom transcript, brain-dump note) and
 * writes structured intent + an optional referenced couple name onto
 * interactions. Downstream consumers (heat scoring, Sage drafts,
 * sequence triggers, family-member-proxy resolver) read this instead
 * of re-inferring per-call.
 *
 * Mirror of inbound-haiku-classifier.ts (P5). Same fire-and-forget
 * post-insert + cron-drain pattern, just a different classifier.
 */

import { callAIJson, type ContentTier } from '@/lib/ai/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'

export const INBOUND_INTENT_PROMPT_VERSION = 'inbound-intent.v3'

export type IntentClass =
  | 'new_inquiry'
  | 'inquiry_followup'
  | 'client_logistics'
  | 'client_emotional'
  | 'family_member_proxy'
  | 'vendor_communication'
  | 'vendor_outreach'
  | 'spam_outreach'
  | 'auto_reply'
  | 'coordinator_internal'
  | 'unknown'

/**
 * Intents that should NEVER fire heat for a wedding. The Anja class
 * (logistics / vendor / spam / auto-reply / internal) accidentally
 * generated heat=99 on RM-1152 because every inbound got the default
 * +8 sms_received treatment. When the classifier verdicts one of these,
 * we retroactively zero the engagement_events points on this
 * interaction so the heat-view recompute reflects reality.
 *
 * client_emotional + family_member_proxy DO fire heat — they're real
 * post-booking signals that belong on the wedding's heat trajectory.
 * (Family-member-proxy gets resolved to the booked couple's wedding
 * via checkpoint 6, so the heat lands on the right row.)
 */
const NON_COUPLE_INTENTS: ReadonlySet<IntentClass> = new Set<IntentClass>([
  'client_logistics',
  'vendor_communication',
  'vendor_outreach',
  'spam_outreach',
  'auto_reply',
  'coordinator_internal',
])

const VALID_INTENT_CLASSES: ReadonlySet<IntentClass> = new Set([
  'new_inquiry',
  'inquiry_followup',
  'client_logistics',
  'client_emotional',
  'family_member_proxy',
  'vendor_communication',
  'vendor_outreach',
  'spam_outreach',
  'auto_reply',
  'coordinator_internal',
  'unknown',
])

export type BudgetSignal = 'within' | 'too_expensive' | null

export interface ExtractedFacts {
  /** All proper names mentioned in the body. Includes the sender's
   *  own name if stated, partners' names, family members, vendors. */
  names: string[]
  /** Wedding date as stated by the sender (ISO yyyy-mm-dd preferred,
   *  fall back to human-readable like "October 2027" if no day given). */
  wedding_date: string | null
  /** Guest count as stated. Integer, no string units. */
  guest_count: number | null
  /** Phone number found IN THE BODY (not the From: header). */
  phone: string | null
  /** Email address found IN THE BODY (not the From: header). */
  email: string | null
  /** Source mention as stated ("Instagram", "The Knot", "a friend's
   *  wedding", etc). null if no source named. */
  source_mentioned: string | null
  /** Explicit budget signal. 'within' = "this fits our budget" /
   *  "we can afford that". 'too_expensive' = "this is over our budget" /
   *  "too expensive". null when neither stated. */
  budget_signal: BudgetSignal
}

/**
 * 7-class email classification used by the draft pipeline to decide
 * which brain (inquiry / client) to invoke. Deterministically derived
 * from the 11-class `intent_class` — see intentToEmailClassification.
 *
 * Replaces the standalone classifyEmail Haiku call (router.ts) so
 * inbounds only pay for one classifier round trip, not two.
 */
export type EmailClassification =
  | 'new_inquiry'
  | 'inquiry_reply'
  | 'client_message'
  | 'vendor'
  | 'spam'
  | 'internal'
  | 'other'

/**
 * Per-inbound signal payload formerly produced by classifyEmail's
 * extractedData. Used by the draft pipeline for heat signals + brain
 * prompts. v3 adds these to the unified Haiku call so the pipeline
 * doesn't need a second classifier round trip.
 */
export interface InboundSignals {
  /** Specific questions the sender asked. Empty array when none. */
  questions: string[]
  urgency_level: 'low' | 'medium' | 'high'
  sentiment: 'positive' | 'neutral' | 'negative'
  commitment_level: 'none' | 'considering' | 'decided'
  /** 0.0-1.0 — how specific the email is. 0.0 for "do you host
   *  weddings?", 1.0 for "we want July 18 2026, 140 guests, plated
   *  dinner, tour Saturday at 2pm". */
  specificity_score: number
  mentions_tour_request: boolean
  mentions_family_attending: boolean
  /** Acquisition source the sender names: "the_knot", "weddingwire",
   *  "google", "instagram", "referral", "website", "zola", "other", or
   *  null when not stated. Distinct from extracted_facts.source_mentioned
   *  (that one preserves the literal phrasing; this one normalizes to
   *  the canonical CRM source vocabulary). */
  source: string | null
  /** Sender's own name when stated in the body / signature. */
  sender_name: string | null
  /** Partner / fiance name when explicitly mentioned. */
  partner_name: string | null
  /** Wedding date as stated. ISO yyyy-mm-dd preferred. */
  event_date: string | null
  /** Guest count if stated. Integer 1-1000. */
  guest_count: number | null
}

export interface IntentVerdict {
  intent_class: IntentClass
  referenced_couple_name: string | null
  note: string | null
  /** Confidence in the intent_class verdict, 0-100. */
  confidence: number
  /** Structured payload extracted in the same Haiku call. null when
   *  the row was classified before mig 331 or when the body had
   *  nothing to surface. */
  extracted_facts: ExtractedFacts | null
  /** v3 (2026-05-12) — heat / brain signals merged in from classifyEmail. */
  signals: InboundSignals
}

/**
 * Derive the 7-class email classification (for draft routing) from
 * the 11-class intent. Deterministic — no second LLM call. The
 * classifier prompt instructs the model on the 11 classes; the
 * pipeline only needs the 7-class verdict for which brain to invoke.
 */
export function intentToEmailClassification(
  intent: IntentClass,
): EmailClassification {
  switch (intent) {
    case 'new_inquiry':
      return 'new_inquiry'
    case 'inquiry_followup':
      return 'inquiry_reply'
    case 'client_logistics':
    case 'client_emotional':
    case 'family_member_proxy':
      return 'client_message'
    case 'vendor_communication':
    case 'vendor_outreach':
      return 'vendor'
    case 'spam_outreach':
      return 'spam'
    case 'coordinator_internal':
      return 'internal'
    case 'auto_reply':
    case 'unknown':
      return 'other'
  }
}

export interface ClassifyIntentInput {
  interactionId: string
  body: string | null | undefined
  subject: string | null | undefined
  venueId: string
  /** Channel hint helps the classifier interpret the body shape (e.g. SMS
   *  bodies are casual / fragmented; email bodies have signatures). */
  channel: 'email' | 'sms' | 'call' | 'voicemail' | 'meeting' | 'brain_dump' | 'web_form' | 'other'
  /** From address (email channel only). Drives the deterministic
   *  short-circuit for form-relay / scheduling-tool senders. */
  fromEmail?: string | null
  supabase?: SupabaseClient
  correlationId?: string | null
}

const FALLBACK_SIGNALS: InboundSignals = {
  questions: [],
  urgency_level: 'low',
  sentiment: 'neutral',
  commitment_level: 'none',
  specificity_score: 0,
  mentions_tour_request: false,
  mentions_family_attending: false,
  source: null,
  sender_name: null,
  partner_name: null,
  event_date: null,
  guest_count: null,
}

const FALLBACK: IntentVerdict = {
  intent_class: 'unknown',
  referenced_couple_name: null,
  note: null,
  confidence: 0,
  extracted_facts: null,
  signals: { ...FALLBACK_SIGNALS },
}

const SYSTEM_PROMPT = `You are a forensic classifier reading one inbound communication to a wedding venue. Your job is to identify WHAT the inbound is, surface any structured facts the body carries, AND emit the per-inbound signals the draft pipeline needs (urgency, sentiment, commitment, specificity, tour-request mention, family mention, source, sender/partner names, wedding date, guest count).

This output replaces TWO classifier round trips with one — there is no second Haiku call to fill in signals downstream.

Return ONLY a JSON object with exactly these six keys:

{
  "intent_class": one of the 11 classes below,
  "referenced_couple_name": string | null,
  "note": string | null,
  "confidence": integer 0-100,
  "extracted_facts": {
    "names": string[],
    "wedding_date": string | null,
    "guest_count": number | null,
    "phone": string | null,
    "email": string | null,
    "source_mentioned": string | null,
    "budget_signal": "within" | "too_expensive" | null
  },
  "signals": {
    "questions": string[],
    "urgency_level": "low" | "medium" | "high",
    "sentiment": "positive" | "neutral" | "negative",
    "commitment_level": "none" | "considering" | "decided",
    "specificity_score": number,
    "mentions_tour_request": boolean,
    "mentions_family_attending": boolean,
    "source": string | null,
    "sender_name": string | null,
    "partner_name": string | null,
    "event_date": string | null,
    "guest_count": number | null
  }
}

== Intent classes ==

new_inquiry
  A prospective couple making FIRST contact. They're shopping for a venue.
  Signals: "is your venue available", "we're getting married in [date]",
  generic discovery questions, no prior context, first-name introductions
  ("Hi I'm Sarah and my fiance and I are looking...").

  Platform relays (IMPORTANT — these rewrite the From: header so the
  sender looks like a normal gmail.com address; do NOT read a gmail
  From: as evidence the sender is the couple typing from scratch):
    - Knot Pro Inbox — subject contains "📩" + "sent you a new message",
      OR body references "theknot.com" / "The Knot Pro Network". The
      couple's intake-form selections (e.g. "Interested Services:
      Tables and chairs, Linens, Lighting, Sound equipment") are a
      SHOPPING LIST not logistics chatter. Classify as new_inquiry.
    - WeddingWire / Here Comes The Guide / Zola relays — body
      references the platform name + an intake form. new_inquiry.
    - Calendly / Acuity invitee notifications — subject "New Event:" /
      "Invitee:" / "New appointment", body links calendly.com or
      acuityscheduling.com. These are couples BOOKING a tour, not
      vendors pitching the venue. Phrases like "amazing tour planned
      for you" are Calendly boilerplate, not vendor language.
      Classify as new_inquiry.

inquiry_followup
  An existing inquiry-stage couple replying or following up. Same shape
  as new_inquiry but the language assumes prior conversation ("just
  checking in", "any update on the date").

client_logistics
  A BOOKED couple (or family member acting on their behalf) handling
  post-booking operations. Vocabulary is the giveaway:
    - garland, tablecloths, table sizes (132 vs 142), drop-off, delivery,
      rentals, "the rehearsal", "this weekend's wedding", set-up,
      vendor names (Sammy's, the florist), package deliveries,
      "did X come by", "we left X at the venue", floor plans, ribbon
      ties, chandeliers.
    - References to next weekend / this weekend / past weekend with
      possessive ("our wedding", "the wedding") imply the booking is
      already real.

client_emotional
  A booked couple sharing personal context, stress, planning concerns,
  family dynamics. Distinguished from logistics by emotional content
  (worried, grateful, asking for reassurance) rather than ops details.

family_member_proxy
  Someone OTHER than the booked couple, contacting on their behalf.
  Strong signals:
    - "This is [Name], [couple-name]'s mom / dad / planner / coordinator"
    - "Hi I'm [Name], I'm helping with [couple-name]'s wedding"
    - Different name in body than in From / phone. Helper role explicit.
  When this fires, extract the REFERENCED couple's first name into
  referenced_couple_name. Example: "This is Anja, Kajlie's mom" →
  referenced_couple_name = "Kajlie".

vendor_communication
  A vendor (florist, photographer, DJ, planner, baker, rental company,
  caterer, officiant) coordinating with the venue about a SPECIFIC
  couple's wedding. Their email signature or phrasing identifies them
  as a vendor: "this is [Name] from [Company]", "we'll be delivering",
  "we're shooting [couple's] wedding".
  When the referenced couple is named, extract into referenced_couple_name.

vendor_outreach
  A vendor or service pitching themselves to the venue. NOT about a
  specific couple. "We're a new florist in the area", "would love to
  introduce ourselves", "we offer professional photography for venues".

spam_outreach
  Generic business pitches not related to the venue's wedding operations.
  "Marketing services", "SEO outreach", cold solicitations,
  unsolicited investment / partnership pitches, lead-generation tools.

auto_reply
  Out-of-office, vacation responder, "do not reply", bounce-back
  messages, no-reply transactional confirmations from couples'
  third-party accounts.

coordinator_internal
  Venue staff (Isadora, assistants) communicating with the venue's own
  email / AI / forwarding to themselves. Includes test messages and
  any inbound that's actually outbound-from-venue routed back.

unknown
  Use sparingly. Only when the body genuinely doesn't fit ANY of the
  above — extremely short messages, garbled text, or ambiguous shapes
  the model genuinely cannot disambiguate. Default to most-likely class
  when reasonable; reserve unknown for true uncertainty.

== referenced_couple_name ==

Extract ONLY when the body explicitly names an existing couple the
sender is contacting on behalf of (family_member_proxy or
vendor_communication classes). Use the first name in possessive form:
  "Kajlie's mom" → "Kajlie"
  "Sarah and Tom's wedding" → "Sarah and Tom"
  "the Henderson wedding" → "Henderson"
For all other classes, return null.

== note ==

One short sentence (<=200 chars) explaining the call. Audit only;
coordinator may read this to understand why a row was classified the
way it was. Don't quote PII verbatim; describe the signal.

== extracted_facts ==

Surface structured facts the BODY carries. Be conservative — only fill
a field when the body states it explicitly. Empty list / null for
anything you'd have to guess.

  names
    All proper names mentioned in the body. Include the sender's own
    name if stated ("Hi, I'm Sarah"), partners ("my fiance Tom"),
    family members ("our daughter Kajlie"), vendors ("Sammy's florist").
    First-name-only is fine. Deduplicate within the list. Empty array
    when no names appear. Do NOT include the venue name, the venue's
    own staff, or generic role words ("the bride", "my partner").

  wedding_date
    Date as stated by the sender. Prefer ISO format (yyyy-mm-dd) when
    the body gives a full date; fall back to a human-readable string
    when only month + year are given ("October 2027" → "2027-10").
    null when not stated.

  guest_count
    Integer count of guests if stated ("about 120 guests" → 120,
    "between 80 and 100" → 90). null when not stated.

  phone
    Phone number found IN THE BODY (not the From: header). Strip
    formatting — output digits only ("(555) 123-4567" → "5551234567").
    Include country code if stated. null when no phone in body.

  email
    Email address found IN THE BODY (not the From: header). Useful
    when the sender writes "my email is ..." or signs off with a
    different address than the From: header. null when no body
    email found.

  source_mentioned
    The acquisition source the sender names ("found you on Instagram",
    "we saw you on The Knot", "a friend of ours got married here").
    Output a short normalized label: "Instagram", "The Knot",
    "WeddingWire", "Zola", "Google", "referral", "website", "walk-in",
    "Pinterest", or the literal name they gave. null when no source
    is named. Do NOT infer source from the channel (a Knot relay
    doesn't automatically mean source="The Knot" unless the BODY
    says so — Wave 7B's forensic role classifier decides canonical
    source).

  budget_signal
    Explicit budget framing.
      "within" — "this is in our budget", "we can afford that",
        "the price works", "fits our number".
      "too_expensive" — "this is over our budget", "out of range",
        "too expensive for us", "we can't afford".
    null when neither stated. Do not infer from indirect signals.

== signals ==

Per-inbound metadata the draft pipeline uses for brain selection +
heat scoring. Be conservative — only fill a field when the body
states it.

  questions
    Array of distinct questions the sender asked. Extract each
    separately. Empty array when none.

  urgency_level
    "low"    — general browsing, no time pressure.
    "medium" — actively planning, has a date in mind.
    "high"   — date is soon, explicit urgency ("need to book this
                week", "tour ASAP"), or wedding within 90 days.

  sentiment
    "positive" — excited, enthusiastic, warm.
    "neutral"  — informational, matter-of-fact.
    "negative" — frustrated, concerned, complaining.

  commitment_level
    "none"        — just curious, browsing, fact-finding.
    "considering" — actively comparing venues, has asked pricing,
                    gathering info.
    "decided"     — explicit "we want to book", "we're ready to move
                    forward", date set + pushing to lock in.

  specificity_score
    0.0 to 1.0 — how specific the email is.
    0.0 → "do you host weddings?"
    0.5 → "we're thinking summer 2026 for around 120 guests"
    1.0 → "July 18 2026, 140 guests, plated dinner, tour Saturday
           at 2pm". Higher = more signal the couple has done
           homework.

  mentions_tour_request
    true if the sender explicitly asks to book / schedule / come
    see / tour the venue. False for Calendly notifications (the
    booking already happened; the inbound is a system confirmation).

  mentions_family_attending
    true if parents, family, or wedding party are explicitly
    mentioned as involved/attending.

  source
    Canonical CRM source key derived from explicit mentions in the
    body OR from the relay channel. One of:
      "the_knot", "weddingwire", "google", "instagram", "referral",
      "website", "walk_in", "zola", "pinterest", "calendly",
      "wedding_pro", or "other".
    A Knot Pro Inbox relay → "the_knot". A Calendly notification
    on a brand-new email → "calendly". A "found you on Google" →
    "google". null when no canonical source is identifiable.
    Distinct from extracted_facts.source_mentioned (which preserves
    the literal phrase).

  sender_name
    Sender's name from the body / signature (NOT just the From
    header, which can be misleading on platform relays). null when
    not stated.

  partner_name
    Partner / fiance name when explicitly mentioned. null when not
    stated.

  event_date
    Wedding date as stated. ISO yyyy-mm-dd preferred; human-readable
    OK ("Fall 2026") when only month/season given. null when not
    stated. This may duplicate extracted_facts.wedding_date — that
    is fine; downstream consumers read from whichever they prefer.

  guest_count
    Integer guest count. Take the midpoint of ranges. Skip
    qualitative words ("small", "intimate"). 1-1000 range gate. null
    when not stated. May duplicate extracted_facts.guest_count.

Output ONLY the JSON object. No markdown, no commentary.`

interface RawVerdict {
  intent_class?: unknown
  referenced_couple_name?: unknown
  note?: unknown
  confidence?: unknown
  extracted_facts?: unknown
  signals?: unknown
}

function normalizeSignals(raw: unknown): InboundSignals {
  if (!raw || typeof raw !== 'object') return { ...FALLBACK_SIGNALS }
  const obj = raw as Record<string, unknown>

  const questions: string[] = Array.isArray(obj.questions)
    ? (obj.questions as unknown[])
        .filter((q): q is string => typeof q === 'string')
        .map((q) => q.trim())
        .filter((q) => q.length > 0 && q.length <= 300)
        .slice(0, 12)
    : []

  const urgencyRaw =
    typeof obj.urgency_level === 'string' ? obj.urgency_level.toLowerCase() : ''
  const urgency: InboundSignals['urgency_level'] =
    urgencyRaw === 'high' || urgencyRaw === 'medium' || urgencyRaw === 'low'
      ? urgencyRaw
      : 'low'

  const sentimentRaw =
    typeof obj.sentiment === 'string' ? obj.sentiment.toLowerCase() : ''
  const sentiment: InboundSignals['sentiment'] =
    sentimentRaw === 'positive' || sentimentRaw === 'negative' || sentimentRaw === 'neutral'
      ? sentimentRaw
      : 'neutral'

  const commitRaw =
    typeof obj.commitment_level === 'string' ? obj.commitment_level.toLowerCase() : ''
  const commitment: InboundSignals['commitment_level'] =
    commitRaw === 'decided' || commitRaw === 'considering' || commitRaw === 'none'
      ? commitRaw
      : 'none'

  const specificityRaw =
    typeof obj.specificity_score === 'number'
      ? obj.specificity_score
      : typeof obj.specificity_score === 'string'
        ? Number(obj.specificity_score)
        : NaN
  const specificity = Number.isFinite(specificityRaw)
    ? Math.max(0, Math.min(1, specificityRaw))
    : 0

  const sourceRaw =
    typeof obj.source === 'string' && obj.source.trim()
      ? obj.source.trim().toLowerCase().slice(0, 40)
      : null

  const senderName =
    typeof obj.sender_name === 'string' && obj.sender_name.trim()
      ? obj.sender_name.trim().slice(0, 120)
      : null

  const partnerName =
    typeof obj.partner_name === 'string' && obj.partner_name.trim()
      ? obj.partner_name.trim().slice(0, 120)
      : null

  const eventDate =
    typeof obj.event_date === 'string' && obj.event_date.trim()
      ? obj.event_date.trim().slice(0, 40)
      : null

  const guestCountRaw =
    typeof obj.guest_count === 'number'
      ? obj.guest_count
      : typeof obj.guest_count === 'string'
        ? Number(obj.guest_count)
        : NaN
  const guestCount =
    Number.isFinite(guestCountRaw) && guestCountRaw > 0 && guestCountRaw < 10000
      ? Math.round(guestCountRaw)
      : null

  return {
    questions,
    urgency_level: urgency,
    sentiment,
    commitment_level: commitment,
    specificity_score: specificity,
    mentions_tour_request: obj.mentions_tour_request === true,
    mentions_family_attending: obj.mentions_family_attending === true,
    source: sourceRaw,
    sender_name: senderName,
    partner_name: partnerName,
    event_date: eventDate,
    guest_count: guestCount,
  }
}

function normalizeFacts(raw: unknown): ExtractedFacts | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  const names: string[] = Array.isArray(obj.names)
    ? Array.from(
        new Set(
          (obj.names as unknown[])
            .filter((n): n is string => typeof n === 'string')
            .map((n) => n.trim())
            .filter((n) => n.length > 0 && n.length <= 120),
        ),
      ).slice(0, 20)
    : []

  const weddingDate =
    typeof obj.wedding_date === 'string' && obj.wedding_date.trim()
      ? obj.wedding_date.trim().slice(0, 40)
      : null

  const guestCountRaw =
    typeof obj.guest_count === 'number'
      ? obj.guest_count
      : typeof obj.guest_count === 'string'
        ? Number(obj.guest_count)
        : NaN
  const guestCount =
    Number.isFinite(guestCountRaw) && guestCountRaw > 0 && guestCountRaw < 10000
      ? Math.round(guestCountRaw)
      : null

  const phone =
    typeof obj.phone === 'string' && obj.phone.trim()
      ? obj.phone.replace(/[^\d+]/g, '').slice(0, 20) || null
      : null

  const email =
    typeof obj.email === 'string' && obj.email.includes('@')
      ? obj.email.trim().toLowerCase().slice(0, 120)
      : null

  const sourceMentioned =
    typeof obj.source_mentioned === 'string' && obj.source_mentioned.trim()
      ? obj.source_mentioned.trim().slice(0, 80)
      : null

  const budgetRaw =
    typeof obj.budget_signal === 'string' ? obj.budget_signal.trim().toLowerCase() : ''
  const budgetSignal: BudgetSignal =
    budgetRaw === 'within' || budgetRaw === 'too_expensive' ? budgetRaw : null

  // Surface null when literally nothing landed — saves a useless jsonb row.
  if (
    names.length === 0 &&
    !weddingDate &&
    guestCount === null &&
    !phone &&
    !email &&
    !sourceMentioned &&
    budgetSignal === null
  ) {
    return null
  }

  return {
    names,
    wedding_date: weddingDate,
    guest_count: guestCount,
    phone,
    email,
    source_mentioned: sourceMentioned,
    budget_signal: budgetSignal,
  }
}

function normalize(raw: RawVerdict): IntentVerdict | null {
  const cls = typeof raw?.intent_class === 'string' ? raw.intent_class.toLowerCase() : ''
  if (!VALID_INTENT_CLASSES.has(cls as IntentClass)) return null
  const referenced =
    typeof raw?.referenced_couple_name === 'string' && raw.referenced_couple_name.trim()
      ? raw.referenced_couple_name.trim().slice(0, 120)
      : null
  const note =
    typeof raw?.note === 'string' && raw.note.trim()
      ? raw.note.trim().slice(0, 500)
      : null
  const confidenceRaw =
    typeof raw?.confidence === 'number'
      ? raw.confidence
      : typeof raw?.confidence === 'string'
        ? Number(raw.confidence)
        : NaN
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
    : 60
  const extractedFacts = normalizeFacts(raw?.extracted_facts)
  const signals = normalizeSignals(raw?.signals)
  return {
    intent_class: cls as IntentClass,
    referenced_couple_name: referenced,
    note,
    confidence,
    extracted_facts: extractedFacts,
    signals,
  }
}

/**
 * Pure LLM call — runs the unified classifier and returns a normalized
 * verdict. NO DB writes, NO idempotency gate. Use this when you need
 * the verdict BEFORE the interaction row exists (the email pipeline
 * runs this early to drive draft routing, then stamps the row after
 * insert with the cached result).
 *
 * NEVER throws. Returns FALLBACK on failure.
 */
export async function classifyInboundRaw(input: {
  body: string | null | undefined
  subject: string | null | undefined
  venueId: string
  channel: ClassifyIntentInput['channel']
  fromEmail?: string | null
  /** Thread context — helps the classifier distinguish new_inquiry
   *  vs inquiry_followup vs client_message when prior conversation
   *  history is the only differentiator. */
  priorInteractionCount?: number
  threadHasPriorOutbound?: boolean
  correlationId?: string | null
}): Promise<IntentVerdict> {
  const { venueId, channel, correlationId } = input
  if (!venueId) return FALLBACK

  const subject = (input.subject ?? '').slice(0, 500)
  const body = (input.body ?? '').slice(0, 6000)
  if (!body.trim() && !subject.trim()) return FALLBACK

  const from = (input.fromEmail ?? '').trim().slice(0, 200)
  const threadBlock =
    typeof input.priorInteractionCount === 'number' ||
    typeof input.threadHasPriorOutbound === 'boolean'
      ? `\n\nTHREAD CONTEXT:\n- Prior messages on this thread: ${input.priorInteractionCount ?? 0}\n- Venue has already sent outbound on this thread: ${input.threadHasPriorOutbound ? 'yes' : 'no'}\n\nIf prior messages > 0 OR prior outbound = yes, this is almost certainly NOT a new_inquiry — prefer inquiry_followup or a client_* class.`
      : ''
  const userPrompt = `CHANNEL: ${channel}\nFROM: ${from || '(unknown)'}\nSUBJECT: ${subject || '(none)'}\n\nBODY:\n${body || '(empty)'}${threadBlock}`

  let raw: RawVerdict
  try {
    raw = await callAIJson<RawVerdict>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      // v3 returns intent + facts + signals + confidence — observed
      // payloads ~500-900 tokens. 1200 leaves headroom.
      maxTokens: 1200,
      temperature: 0.2,
      venueId,
      taskType: 'inbound_intent_classify',
      tier: 'haiku',
      contentTier: 2 as ContentTier,
      promptVersion: INBOUND_INTENT_PROMPT_VERSION,
      correlationId: correlationId ?? undefined,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'inbound_intent ai call failed (raw)',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: { error: err instanceof Error ? err.message : String(err) },
    })
    return FALLBACK
  }

  const verdict = normalize(raw)
  if (!verdict) {
    logEvent({
      level: 'warn',
      msg: 'inbound_intent invalid verdict (raw)',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: { sample: JSON.stringify(raw).slice(0, 300) },
    })
    return FALLBACK
  }

  return verdict
}

/**
 * Persist a previously-computed verdict onto the interactions row.
 * Idempotent: only stamps when intent_classified_at IS NULL. Returns
 * the verdict unchanged. NEVER throws.
 *
 * Use this from the pipeline when classifyInboundRaw fired BEFORE
 * the interaction insert — once the row exists, call stampInboundVerdict
 * to write the verdict + fire side effects (heat suppression,
 * referenced-couple resolver).
 */
export async function stampInboundVerdict(
  interactionId: string,
  verdict: IntentVerdict,
  options: {
    venueId: string
    supabase?: SupabaseClient
    correlationId?: string | null
    /** When true, overwrites intent_class even if it was previously
     *  stamped. Used by the admin reclass endpoint to force a fresh
     *  verdict on rows that landed before a prompt revision. Default
     *  false preserves idempotency for the live fire-and-forget path. */
    forceOverwrite?: boolean
  },
): Promise<void> {
  const { venueId, correlationId, forceOverwrite } = options
  const supabase = options.supabase ?? createServiceClient()
  if (!interactionId || !venueId) return

  try {
    let q = supabase
      .from('interactions')
      .update({
        intent_class: verdict.intent_class,
        intent_referenced_couple_name: verdict.referenced_couple_name,
        intent_classifier_note: verdict.note,
        intent_classified_at: new Date().toISOString(),
        extracted_facts: verdict.extracted_facts,
      })
      .eq('id', interactionId)
    if (!forceOverwrite) {
      q = q.is('intent_classified_at', null)
    }
    await q
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'inbound_intent stamp failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: { interactionId, error: err instanceof Error ? err.message : String(err) },
    })
    return
  }

  // Family-member-proxy + vendor-communication resolver (checkpoint 6).
  if (
    verdict.referenced_couple_name &&
    (verdict.intent_class === 'family_member_proxy' ||
      verdict.intent_class === 'vendor_communication')
  ) {
    void (async () => {
      try {
        const { resolveReferencedCouple } = await import(
          './referenced-couple-resolver'
        )
        await resolveReferencedCouple({
          supabase,
          venueId,
          interactionId,
          referencedName: verdict.referenced_couple_name as string,
          intentClass: verdict.intent_class,
          correlationId,
        })
      } catch (err) {
        logEvent({
          level: 'warn',
          msg: 'referenced_couple_resolve failed',
          venueId,
          correlationId: correlationId ?? null,
          actor: 'system',
          event_type: 'inbound_intent.resolve_referenced',
          outcome: 'fail',
          data: {
            interactionId,
            referenced: verdict.referenced_couple_name,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    })()
  }

  // Heat suppression for non-couple intents.
  if (NON_COUPLE_INTENTS.has(verdict.intent_class)) {
    void (async () => {
      try {
        const { error: suppErr } = await supabase
          .from('engagement_events')
          .update({ points: 0 })
          .filter('metadata->>interaction_id', 'eq', interactionId)
          .neq('points', 0)
        if (suppErr) {
          logEvent({
            level: 'warn',
            msg: 'inbound_intent suppress failed',
            venueId,
            correlationId: correlationId ?? null,
            actor: 'system',
            event_type: 'inbound_intent.suppress',
            outcome: 'fail',
            data: { interactionId, error: suppErr.message },
          })
        }
      } catch (err) {
        logEvent({
          level: 'warn',
          msg: 'inbound_intent suppress threw',
          venueId,
          correlationId: correlationId ?? null,
          actor: 'system',
          event_type: 'inbound_intent.suppress',
          outcome: 'fail',
          data: {
            interactionId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    })()
  }

  logEvent({
    level: 'info',
    msg: 'inbound_intent stamped',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'inbound_intent.classify',
    outcome: 'ok',
    data: {
      interactionId,
      intent_class: verdict.intent_class,
      referenced_couple_name: verdict.referenced_couple_name,
    },
  })
}

/**
 * Run the intent classifier on one inbound interaction. Idempotent:
 * skipped when intent_classified_at IS NOT NULL. NEVER throws.
 */
export async function classifyInboundIntent(
  input: ClassifyIntentInput,
): Promise<IntentVerdict> {
  const { interactionId, venueId, channel, correlationId } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!interactionId || !venueId) return FALLBACK

  // Idempotency gate.
  try {
    const { data: existing } = await supabase
      .from('interactions')
      .select('intent_classified_at, intent_class, intent_referenced_couple_name, intent_classifier_note, extracted_facts')
      .eq('id', interactionId)
      .single()
    if (existing?.intent_classified_at) {
      return {
        intent_class: (existing.intent_class as IntentClass) ?? FALLBACK.intent_class,
        referenced_couple_name:
          (existing.intent_referenced_couple_name as string | null) ?? null,
        note: (existing.intent_classifier_note as string | null) ?? null,
        confidence: 0, // pre-existing rows don't carry confidence; fall back
        extracted_facts:
          (existing.extracted_facts as ExtractedFacts | null) ?? null,
        signals: { ...FALLBACK_SIGNALS },
      }
    }
  } catch {
    // Soft-fail the precheck.
  }

  // Delegate the LLM call to the pure helper, then stamp the row.
  const verdict = await classifyInboundRaw({
    body: input.body,
    subject: input.subject,
    venueId,
    channel,
    fromEmail: input.fromEmail ?? null,
    correlationId,
  })

  if (verdict.intent_class === 'unknown' && verdict.confidence === 0) {
    // FALLBACK — nothing to persist or side-effect.
    return verdict
  }

  await stampInboundVerdict(interactionId, verdict, {
    venueId,
    supabase,
    correlationId,
  })

  return verdict
}
