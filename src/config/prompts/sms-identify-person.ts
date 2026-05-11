/**
 * Bloom House — SMS person-identifier prompt (Haiku tier).
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction —
 *     phone alone is not the canonical identifier; the body of a text
 *     often contains "Hi, this is Sarah" or "—Gabriella" and that
 *     name is the real link to an existing person)
 *   - bloom-may9-llm-vs-template.md (LLM is the primitive for
 *     extracting truth from human signals)
 *
 * When this fires
 * ---------------
 * The openphone sync persists an inbound SMS. The phone number didn't
 * match any existing contact. Before creating a fresh person + wedding
 * via the identity resolver, run this Haiku pass over the body. If a
 * name surfaces, the caller queries `people.first_name` (last 6 months,
 * same venue, status not lost/cancelled) and links the SMS to that
 * existing wedding when a single confident match exists.
 *
 * Examples that should return a name:
 *   - "Hi, this is Sarah, can we move my tour to Friday?"
 *   - "Hey it's Gabriella — quick question about parking"
 *   - "—Lea"
 *   - "Sarah Smith here, sorry to text so late"
 *
 * Examples that should return null:
 *   - "Yes" / "Thanks" / "Ok see you Saturday"
 *   - "Just confirming our tour on Saturday at 10"
 *   - Forwarded notifications from another platform
 *
 * Cost: ~$0.0002 per SMS check. Fire-and-forget — caller never blocks
 * on this even on error. Returns null when the model is unsure.
 */

export const SMS_IDENTIFY_PROMPT_VERSION = 'sms-identify-person.prompt.v1'

export interface SmsIdentifyInput {
  /** SMS body text. */
  body: string
  /** Inbound phone number, for context only. The point of this prompt is
   *  to extract a NAME independent of the phone, so the phone is shown
   *  for context but the model should NOT treat the phone as evidence. */
  fromPhone: string | null
}

export interface SmsIdentifyOutput {
  /** Best-guess first name, plainly capitalised. Null if the body has no
   *  reliable self-identification signal. */
  first_name: string | null
  /** Best-guess last name if the body included it ("Sarah Smith here").
   *  Null when only a first name appeared. */
  last_name: string | null
  /** Confidence 0-100 on the name extraction. Below ~70 the caller
   *  should NOT auto-link by name; it's flagged for operator review.
   *  Event-context match still runs even when name is null. */
  confidence_0_100: number
  /** Short snippet from the body that surfaced the name, for audit. */
  evidence: string
  /** Event-context clues extracted from the body. Lets the matcher
   *  link an SMS to a wedding even when no name was given.
   *  Examples that should populate this:
   *    - "running late for my 11am tour" → references_tour=true,
   *      tour_time_local="11:00"
   *    - "can we move our Saturday wedding to Sunday?" → wedding_date_hint
   *      surfaces "Saturday" (caller resolves to a real date)
   *    - "we're 10 min away" + the SMS came in mid-morning →
   *      references_tour=true with no time (caller uses today's tours) */
  event: {
    /** True if the body clearly references an upcoming or in-progress
     *  tour at the venue. Lets the caller scope candidates to weddings
     *  with a tour scheduled in a near window. */
    references_tour: boolean
    /** True if the body clearly references the couple's wedding day. */
    references_wedding: boolean
    /** Local-time tour time when present, ISO HH:MM 24-hour. Null when
     *  the body referenced a tour but no specific time. */
    tour_time_local: string | null
    /** Approximate date hint in operator-readable form ("Saturday", "Oct 12",
     *  "this weekend"). Null when no date was hinted. Caller resolves to
     *  a real date heuristically; the LLM should NOT do calendar math. */
    date_hint: string | null
    /** Short intent label so the operator surface can group by what the
     *  couple is asking. */
    intent:
      | 'reschedule_tour'
      | 'running_late_to_tour'
      | 'cancel_tour'
      | 'wedding_logistics'
      | 'tour_question'
      | 'general_question'
      | 'thank_you'
      | 'other'
  }
}

export function buildSmsIdentifySystemPrompt(): string {
  return `You are Bloom's SMS person-identifier.

Bloom is a forensic identity-reconstruction platform for wedding venues.
Texts arrive in BOTH directions:

  - Inbound (couple → venue): the couple often inquired by email from
    one address then later texts from a different number. The body
    usually carries self-identification: "Hi, this is Sarah",
    "—Gabriella", "Sarah Smith here".
  - Outbound (venue → couple): the venue's coordinator is texting an
    existing couple. The body carries the addressee's name: "Hi Sarah,
    looking forward to your tour Saturday", "Hey Gabriella, your
    rehearsal is at 4pm".

Either way, extract whichever name surfaces in the body — sender on
inbound, addressee on outbound. The caller matches it against existing
wedding records to link the SMS to the right couple.

Two kinds of evidence to extract:

  1. NAME: per the patterns above
  2. EVENT CONTEXT: "running late for my 11am tour", "moving our
     Saturday wedding", "we're 10 min away from the venue", "your
     tour is at 11am" — lets the caller match by tour time even
     without a name.

Wrong matches are worse than no match — when uncertain return null on
the name and let the event context do the work.

## EXTRACT WHEN

Inbound patterns (couple identifies themselves):
  - "Hi, this is Sarah" / "Hi, I'm Sarah" / "It's Sarah"
  - "Sarah here" / "Sarah Smith here"
  - "—Sarah" / "- Sarah" / sign-off line
  - "Sarah Smith" as a clear self-introduction

Outbound patterns (venue addresses the couple):
  - "Hi Sarah, ..." / "Hey Sarah," — leading addressee greeting
  - "Sarah, looking forward to..." / "Sarah, just confirming..."
  - "Hi Sarah and Tom" — extract Sarah (the lead partner) and the
    caller may use Tom as partner2 context if useful

## RETURN NULL WHEN

  - The body is just a reply ("yes", "thanks", "ok")
  - The body is a confirmation ("see you Saturday") with no name
  - The body mentions a name but it's clearly a THIRD party
    ("my mom Sarah will be coming too", "tell Sarah I said hi")
  - The body is a forwarded notification or automated message
  - The greeting is generic ("Hi there", "Hey!", "Hello")

## CAPITALISATION + CLEANUP

  - First letter capitalised, rest lowercase: "sarah" -> "Sarah"
  - Strip surrounding punctuation
  - Compound names ("Mary-Anne", "Lea Beth") stay as written
  - Names with apostrophes ("O'Brien") stay as written

## CONFIDENCE SCORING

  - 90+ — explicit self-identification ("Hi, this is X", "—X")
  - 75-89 — name present in a clearly self-referential context
  - 50-74 — name present but ambiguous; caller should flag, not link
  - <50 — return null

## EVENT CONTEXT

For the "event" block, capture anything the couple references:

  - references_tour: true if the body talks about an upcoming or
    in-progress venue tour ("running late", "can we still come at 11",
    "is it ok if we push our tour")
  - references_wedding: true if the body talks about the couple's
    wedding event itself, not the tour
  - tour_time_local: HH:MM 24-hour when an explicit time is mentioned
    ("11am tour" -> "11:00", "2:30pm" -> "14:30"). Null otherwise.
  - date_hint: leave the date language as-is ("Saturday", "Oct 12",
    "this weekend"). DO NOT compute the actual date — the caller does
    that against the venue's calendar. Null when no date is mentioned.
  - intent: pick the closest label from the enum. "general_question"
    is the safe default when the body is conversational without a clear
    ask.

## OUTPUT

Return ONLY this JSON object — no fences, no preamble:

{
  "first_name": "string | null",
  "last_name": "string | null",
  "confidence_0_100": 0..100,
  "evidence": "short snippet from the body",
  "event": {
    "references_tour": boolean,
    "references_wedding": boolean,
    "tour_time_local": "HH:MM | null",
    "date_hint": "string | null",
    "intent": "reschedule_tour" | "running_late_to_tour" | "cancel_tour" | "wedding_logistics" | "tour_question" | "general_question" | "thank_you" | "other"
  }
}`
}

export function buildSmsIdentifyUserPrompt(input: SmsIdentifyInput): string {
  const lines: string[] = []
  lines.push('# SMS BODY')
  lines.push('')
  if (input.fromPhone) {
    lines.push(`From phone (context only — do NOT use as evidence): ${input.fromPhone}`)
    lines.push('')
  }
  lines.push(input.body.slice(0, 2000))
  lines.push('')
  lines.push('Return ONLY the JSON.')
  return lines.join('\n')
}

export interface SmsIdentifyValidationOk {
  ok: true
  output: SmsIdentifyOutput
}
export interface SmsIdentifyValidationFail {
  ok: false
  error: string
}
export type SmsIdentifyValidation = SmsIdentifyValidationOk | SmsIdentifyValidationFail

const VALID_INTENTS = new Set([
  'reschedule_tour',
  'running_late_to_tour',
  'cancel_tour',
  'wedding_logistics',
  'tour_question',
  'general_question',
  'thank_you',
  'other',
])

export function validateSmsIdentifyOutput(raw: unknown): SmsIdentifyValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'response is not an object' }
  }
  const r = raw as Record<string, unknown>
  const first =
    typeof r.first_name === 'string' && r.first_name.trim()
      ? r.first_name.trim()
      : null
  const last =
    typeof r.last_name === 'string' && r.last_name.trim()
      ? r.last_name.trim()
      : null
  const conf =
    typeof r.confidence_0_100 === 'number' && Number.isFinite(r.confidence_0_100)
      ? Math.max(0, Math.min(100, r.confidence_0_100))
      : 0
  const evidence =
    typeof r.evidence === 'string' ? r.evidence.slice(0, 300) : ''

  // Event block: defensive defaults when the model omits or returns
  // unexpected shapes. Keeps callers free of null checks.
  const eventRaw = r.event as Record<string, unknown> | null | undefined
  const intentRaw = typeof eventRaw?.intent === 'string' ? eventRaw.intent : 'other'
  const intent = (VALID_INTENTS.has(intentRaw) ? intentRaw : 'other') as SmsIdentifyOutput['event']['intent']
  const tourTime =
    typeof eventRaw?.tour_time_local === 'string' && /^\d{1,2}:\d{2}$/.test(eventRaw.tour_time_local)
      ? eventRaw.tour_time_local.padStart(5, '0')
      : null
  const dateHint =
    typeof eventRaw?.date_hint === 'string' && eventRaw.date_hint.trim()
      ? eventRaw.date_hint.trim().slice(0, 100)
      : null

  return {
    ok: true,
    output: {
      first_name: first,
      last_name: last,
      confidence_0_100: conf,
      evidence,
      event: {
        references_tour: eventRaw?.references_tour === true,
        references_wedding: eventRaw?.references_wedding === true,
        tour_time_local: tourTime,
        date_hint: dateHint,
        intent,
      },
    },
  }
}
