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

export const INBOUND_INTENT_PROMPT_VERSION = 'inbound-intent.v2'

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

export interface IntentVerdict {
  intent_class: IntentClass
  referenced_couple_name: string | null
  note: string | null
  /** Structured payload extracted in the same Haiku call. null when
   *  the row was classified before mig 331 or when the body had
   *  nothing to surface. */
  extracted_facts: ExtractedFacts | null
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

const FALLBACK: IntentVerdict = {
  intent_class: 'unknown',
  referenced_couple_name: null,
  note: null,
  extracted_facts: null,
}

const SYSTEM_PROMPT = `You are a forensic classifier reading one inbound communication to a wedding venue. Your job is to identify WHAT the inbound is — not who it's from or how to respond — AND surface any structured facts the body carries (names, dates, counts, contact info, source mention, budget signal).

Return ONLY a JSON object with exactly these four keys:

{
  "intent_class": one of the 11 classes below,
  "referenced_couple_name": string | null,
  "note": string | null,
  "extracted_facts": {
    "names": string[],
    "wedding_date": string | null,
    "guest_count": number | null,
    "phone": string | null,
    "email": string | null,
    "source_mentioned": string | null,
    "budget_signal": "within" | "too_expensive" | null
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

Output ONLY the JSON object. No markdown, no commentary.`

interface RawVerdict {
  intent_class?: unknown
  referenced_couple_name?: unknown
  note?: unknown
  extracted_facts?: unknown
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
  const extractedFacts = normalizeFacts(raw?.extracted_facts)
  return {
    intent_class: cls as IntentClass,
    referenced_couple_name: referenced,
    note,
    extracted_facts: extractedFacts,
  }
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
        extracted_facts:
          (existing.extracted_facts as ExtractedFacts | null) ?? null,
      }
    }
  } catch {
    // Soft-fail the precheck.
  }

  const subject = (input.subject ?? '').slice(0, 500)
  const body = (input.body ?? '').slice(0, 6000)
  if (!body.trim() && !subject.trim()) return FALLBACK

  const from = (input.fromEmail ?? '').trim().slice(0, 200)
  const userPrompt = `CHANNEL: ${channel}\nFROM: ${from || '(unknown)'}\nSUBJECT: ${subject || '(none)'}\n\nBODY:\n${body || '(empty)'}`

  let raw: RawVerdict
  try {
    raw = await callAIJson<RawVerdict>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      // v2 returns the extraction payload alongside intent; the names
      // array + signal fields push the response budget. 700 leaves
      // headroom; observed payloads are ~250-400 tokens.
      maxTokens: 700,
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
      msg: 'inbound_intent ai call failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: {
        interactionId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return FALLBACK
  }

  const verdict = normalize(raw)
  if (!verdict) {
    logEvent({
      level: 'warn',
      msg: 'inbound_intent invalid verdict',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: {
        interactionId,
        sample: JSON.stringify(raw).slice(0, 300),
      },
    })
    return FALLBACK
  }

  try {
    await supabase
      .from('interactions')
      .update({
        intent_class: verdict.intent_class,
        intent_referenced_couple_name: verdict.referenced_couple_name,
        intent_classifier_note: verdict.note,
        intent_classified_at: new Date().toISOString(),
        extracted_facts: verdict.extracted_facts,
      })
      .eq('id', interactionId)
      .is('intent_classified_at', null)
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'inbound_intent persist failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'inbound_intent.classify',
      outcome: 'fail',
      data: {
        interactionId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return verdict
  }

  // Family-member-proxy + vendor-communication resolver (checkpoint 6).
  // The classifier extracted a referenced couple name (e.g. "Kajlie"
  // from "Kajlie's mom"). Look up the venue's recent weddings by fuzzy
  // partner1/partner2 first-name match. If a confident match exists,
  // reattach this interaction to that wedding via mintWedding's merge
  // path so the conversation lands on the booked couple's row.
  //
  // Fire-and-forget. If no match is found, the interaction stays on
  // its own wedding (or the orphan path) and a coordinator can
  // manually re-link via the lead-detail panel.
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

  // Heat suppression: when intent is in the non-couple set, zero the
  // points on this interaction's engagement_events. The heat-as-view
  // (mig 316) sums points * decay; setting points=0 makes the row
  // invisible to the trajectory without losing the audit history.
  //
  // Fire-and-forget — failure here doesn't unwind the classification.
  // The cron drain (when it lands) can re-attempt suppression on rows
  // that missed.
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
        } else {
          logEvent({
            level: 'info',
            msg: 'inbound_intent suppressed heat',
            venueId,
            correlationId: correlationId ?? null,
            actor: 'system',
            event_type: 'inbound_intent.suppress',
            outcome: 'ok',
            data: { interactionId, intent_class: verdict.intent_class },
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
    msg: 'inbound_intent classified',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'inbound_intent.classify',
    outcome: 'ok',
    data: {
      interactionId,
      channel,
      intent_class: verdict.intent_class,
      referenced_couple_name: verdict.referenced_couple_name,
    },
  })

  return verdict
}
