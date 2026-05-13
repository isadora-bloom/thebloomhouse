// ---------------------------------------------------------------------------
// inbox/folder-ai-classifier.ts -- AI-driven lifecycle folder classifier.
// ---------------------------------------------------------------------------
//
// The rule chain in lifecycle.ts decides folder placement from structured
// signal: weddings.status, thread inbound/outbound counts, tour events,
// people.role, and an ADVERTISER_DOMAINS allow-list. That works well when
// the sender is already linked into the venue's CRM, but historically
// ~50% of Isadora's inbox lands in 'Other' because the rules can't see
// signal in the email body. Real vendors (Gibson Rental, Signature Event
// Rentals, Parts Town) aren't classified because they're not linked to
// people.role = 'vendor', and cold sales spam from random gmail accounts
// defaults to Other because the from-domain isn't on the advertiser list.
//
// classifyFolderAI reads the email content + sender + subject and asks
// Haiku to pick a folder directly. It's used as a fallback only -- the
// rule chain still runs first, and the AI signal is consulted only when
// the rules return 'other' AND no strong structured signal exists.
//
// Hard rules:
//   - Returns { folder: 'other', confidence: 0, ... } on any failure.
//     Never throws, never blocks the pipeline.
//   - Body slice capped at 2000 chars before sending to Haiku.
//   - maxTokens: 200 (small JSON response).
//   - Logged to api_costs with task_type=inbox_folder_classify so we can
//     audit cost per call and per-venue spend.
// ---------------------------------------------------------------------------

import { callAIJson } from '@/lib/ai/client'
import type { LifecycleFolder } from './lifecycle'
import { LIFECYCLE_FOLDERS } from './lifecycle'

/**
 * Logged to api_costs.prompt_version on every classifier call so cost +
 * accuracy regressions can be tracked per revision. Bump + add a row in
 * PROMPTS-CHANGELOG.md when the system prompt or response contract
 * changes meaningfully.
 */
export const BRAIN_INBOX_FOLDER_AI_PROMPT_VERSION = 'inbox-folder-ai.prompt.v1.1'

const BODY_SLICE_LIMIT = 2000

const VALID_FOLDERS: ReadonlySet<LifecycleFolder> = new Set(LIFECYCLE_FOLDERS)

const SYSTEM_PROMPT_LINES: string[] = [
  'You triage emails for a wedding-venue coordinator inbox. The inbox',
  'has six folders. You read one email and pick exactly one folder.',
  '',
  'Folder definitions:',
  '',
  '  new_inquiry: a couple inquiring about their wedding for the first',
  '    time. Includes Knot, Zola, WeddingWire relays, contact-form',
  '    submissions, direct-to-info inquiries. The couple has never',
  '    contacted the venue before this email.',
  '',
  '  potential_client: a couple who has been engaged with the venue',
  '    already. Tour booked, replied to follow-up, asked specific',
  '    questions, weighing decisions, comparing dates. Not yet booked.',
  '',
  '  client: a booked couple whose wedding is confirmed. They are',
  '    already on the calendar. Message is about logistics, vendors,',
  '    timeline, payments, day-of detail.',
  '',
  '  vendor: a wedding-vendor business reaching out about an event,',
  '    a quote, a delivery, a setup. Caterers, florists, rental',
  '    companies (tents, tables, linens, chairs), photographers,',
  '    videographers, DJs, bands, transportation, charters, shuttles,',
  '    officiants, planners, bakeries, parts suppliers, restoration,',
  '    cleaning, landscaping, HVAC. Includes event-rental confirmations',
  '    and quote emails. The sender works at a service business and is',
  '    coordinating real work, not selling software or ad space.',
  '',
  '  advertiser: cold outreach trying to sell the venue something or',
  '    get the venue listed somewhere. SaaS sales, SEO agencies,',
  '    lending offers, recruiter spam, listing-platform marketing',
  '    pitches, AI tools, marketing automation, prospecting tools,',
  '    job boards, generic agency outreach. The sender wants the venue',
  '    as a customer, not the other way around.',
  '',
  '  other: system mail (Google Calendar, daily digests, account',
  '    notifications), internal team chatter, friends, personal mail,',
  '    anything that does not fit the five above.',
  '',
  'Decision rules:',
  '  - Read the from address, the subject, and the body. The body',
  '    carries the strongest signal, especially for vendors.',
  '  - A real vendor coordinating an event delivery is "vendor", not',
  '    "advertiser", even if the from-domain looks generic.',
  '  - A SaaS sales pitch from a fancy domain is "advertiser", not',
  '    "vendor", even if it mentions "weddings".',
  '  - A first-time inquiry through Knot or Zola is "new_inquiry",',
  '    not "advertiser", because the platform is relaying a real',
  '    couple. Look at the body content, not just the sender domain.',
  '  - When you cannot tell, pick "other".',
  '',
  'Relay patterns to recognize (the From: address gets rewritten to the',
  'couple\'s actual email so the venue can reply directly — do NOT read',
  'a gmail.com From: as evidence the sender is the couple typing from',
  'scratch). Pick "new_inquiry" or "potential_client" not "vendor" /',
  '"advertiser" / "other" when you see these:',
  '',
  '  Knot Pro Inbox relay — subject contains "📩" emoji + "sent you a',
  '    new message", or body references "theknot.com" or "The Knot Pro".',
  '    These are real couples reaching out via Knot\'s pro-inbox channel.',
  '    Classify as "new_inquiry" unless body content shows the couple',
  '    has already toured / replied multiple times (then "potential_client").',
  '',
  '  Calendly notifications — subject starts with "New Event:" or',
  '    "Invitee:" or "Event scheduled", body links calendly.com. Means',
  '    a couple booked a tour or planning call. Classify as',
  '    "potential_client" (a tour is a stage past initial inquiry).',
  '    Reschedule / cancellation notifications from Calendly are also',
  '    "potential_client" — they\'re about an engaged couple\'s tour.',
  '',
  '  Acuity Scheduling — subject contains "New appointment" or',
  '    "Appointment scheduled", body links acuityscheduling.com.',
  '    Same rule as Calendly — classify as "potential_client".',
  '',
  '  WeddingWire / Here Comes The Guide / Zola relays — body references',
  '    the platform name, classify as "new_inquiry".',
  '',
  'Return a single JSON object with exactly this shape:',
  '  {',
  '    "folder": "<one of: new_inquiry|potential_client|client|vendor|advertiser|other>",',
  '    "confidence": <integer 0-100>,',
  '    "reason": "<one short sentence, no PII, max 140 chars>"',
  '  }',
  '',
  'No markdown, no code blocks, no extra fields.',
]

const SYSTEM_PROMPT = SYSTEM_PROMPT_LINES.join('\n')

interface ClassifierResponse {
  folder?: unknown
  confidence?: unknown
  reason?: unknown
}

const WHITESPACE_RE = /\s+/g

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  // Collapse runs of whitespace (incl. newlines) into single spaces so
  // the prompt stays compact. Body slice is 2000 chars after collapse.
  const trimmed = s.replace(WHITESPACE_RE, ' ').trim()
  return trimmed.length > max ? trimmed.slice(0, max) + '...' : trimmed
}

function buildUserPrompt(email: {
  from: string
  fromName?: string | null
  subject: string | null
  body: string | null
  direction: 'inbound' | 'outbound'
}): string {
  const lines: string[] = []
  lines.push('EMAIL TO CLASSIFY')
  lines.push('')
  lines.push('Direction: ' + email.direction)
  lines.push('From: ' + truncate(email.from, 200))
  if (email.fromName) {
    lines.push('From name: ' + truncate(email.fromName, 200))
  }
  lines.push('Subject: ' + truncate(email.subject, 200))
  lines.push('')
  lines.push('Body (first 2000 chars):')
  lines.push(truncate(email.body, BODY_SLICE_LIMIT))
  lines.push('')
  lines.push('Return JSON only.')
  return lines.join('\n')
}

function isValidFolder(value: unknown): value is LifecycleFolder {
  return typeof value === 'string' && VALID_FOLDERS.has(value as LifecycleFolder)
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  return Math.round(n)
}

/**
 * Classify which lifecycle folder an email belongs to using Haiku. Used
 * as a fallback when the structured rule chain in lifecycle.ts cannot
 * determine the folder from CRM signal alone.
 *
 * Defensive contract:
 *   - Never throws. Any AI failure (timeout, malformed JSON, unknown
 *     folder string, missing key) collapses to a safe default of
 *     { folder: 'other', confidence: 0, reason: '...' }.
 *   - Body is sliced to 2000 chars before sending. maxTokens=200.
 *   - tier='haiku', temperature=0.1, taskType='inbox_folder_classify'.
 */
export async function classifyFolderAI(
  venueId: string,
  email: {
    from: string
    fromName?: string | null
    subject: string | null
    body: string | null
    direction: 'inbound' | 'outbound'
  },
  options?: { correlationId?: string },
): Promise<{
  folder: LifecycleFolder
  confidence: number
  reason: string
}> {
  if (!email.from && !email.subject && !email.body) {
    return { folder: 'other', confidence: 0, reason: 'empty email payload' }
  }

  try {
    const userPrompt = buildUserPrompt(email)

    const response = await callAIJson<ClassifierResponse>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 200,
      temperature: 0.1,
      tier: 'haiku',
      taskType: 'inbox_folder_classify',
      contentTier: 2,
      promptVersion: BRAIN_INBOX_FOLDER_AI_PROMPT_VERSION,
      venueId,
      correlationId: options?.correlationId,
    })

    if (!isValidFolder(response?.folder)) {
      return { folder: 'other', confidence: 0, reason: 'unknown classifier output' }
    }

    const reason =
      typeof response.reason === 'string' && response.reason.trim().length > 0
        ? response.reason.trim().slice(0, 200)
        : 'no reason provided'

    return {
      folder: response.folder,
      confidence: clampConfidence(response.confidence),
      reason,
    }
  } catch (err) {
    // Best-effort. A failed AI call must never block a caller.
    return {
      folder: 'other',
      confidence: 0,
      reason:
        'classifier error: ' +
        (err instanceof Error ? err.message.slice(0, 120) : 'unknown'),
    }
  }
}
