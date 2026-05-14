/**
 * Voice DNA Gmail backfill. B6 (2026-05-08).
 *
 * Pulls a venue's historical sent email (last 12 months by default),
 * filters out auto-replies / calendar invites / system notifications,
 * and runs each through a phrase extractor, upserting into
 * review_language with source_type='gmail_backfill'.
 *
 * Designed as a generic onboarding feature — any venue with a Gmail
 * connection can trigger this from /sage/voice-dna. Not Rixey-specific.
 *
 * Per-run cap: 200 emails. Larger histories require multiple invocations
 * (deduplication on phrase text means re-runs are idempotent).
 */

import { callAIJson } from '@/lib/ai/client'
import { createServiceClient } from '@/lib/supabase/service'
import { getGmailClient, parseEmailBody } from '@/lib/services/email/gmail'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'

export const VOICE_GMAIL_BACKFILL_PROMPT_VERSION = 'voice.gmail-backfill.v1'

/** Per-invocation cap. Larger histories ride on multiple clicks. */
const MAX_MESSAGES_PER_RUN = 200

/** How many months of history to walk by default (B6.1 = 12). */
const DEFAULT_MONTHS_BACK = 12

/** Skip messages whose body is < this many chars (signatures-only). */
const MIN_BODY_CHARS = 80

const REVIEW_THEMES = [
  'coordinator', 'space', 'flexibility', 'value', 'experience',
  'process', 'pets', 'exclusivity', 'food_catering',
  'accommodation', 'ceremony', 'other',
] as const

type ReviewTheme = (typeof REVIEW_THEMES)[number]

const EMAIL_EXTRACTION_SYSTEM_PROMPT = `You extract distinctive phrases from a wedding venue operator's outbound emails. The goal is to capture the operator's authentic voice so an AI assistant can write in the same style.

Focus on:
- Phrases the OPERATOR wrote that capture their voice (tone, warmth, professionalism, humor)
- Specific, non-generic descriptions of the venue or process
- 5-25 word phrases that could be reused in future drafts
- Opening lines, sign-offs, transitions that feel personal to this operator

Skip:
- Generic boilerplate ("Best regards", "Looking forward to hearing from you")
- Pricing or logistics that change per couple
- Anything that quotes the couple back to themselves

Valid themes: ${REVIEW_THEMES.join(', ')}

Respond with valid JSON matching this structure:
{
  "phrases": [
    { "phrase": "we treat the barn as a blank canvas", "theme": "flexibility", "sentiment": 0.8 }
  ]
}

Rules:
- Extract 0-6 phrases per email (only what's genuinely distinctive)
- Each phrase 5-25 words
- sentiment is a float -1 to 1
- Use exact theme values; "other" if none fit
- Do not fabricate; only use language actually in the email
- Empty phrases array is a valid response when nothing distinctive surfaces`

interface ExtractedPhrase {
  phrase: string
  theme: ReviewTheme
  sentiment: number
}

interface ExtractionResult {
  phrases: Array<{ phrase: string; theme: string; sentiment: number }>
}

/**
 * Returns true if the email looks like an auto-reply, calendar invite,
 * or system notification. B6.2 = (a) safe filter.
 */
function shouldSkip(args: {
  subject: string
  fromEmail: string
  bodyChars: number
  headers: Record<string, string>
}): { skip: true; reason: string } | { skip: false } {
  const { subject, fromEmail, bodyChars, headers } = args

  if (bodyChars < MIN_BODY_CHARS) return { skip: true, reason: 'body_too_short' }

  // Auto-reply detection: explicit RFC 3834 header + subject heuristics.
  if (headers['auto-submitted'] && headers['auto-submitted'].toLowerCase() !== 'no') {
    return { skip: true, reason: 'auto_submitted_header' }
  }
  if (/^(auto[-_]?reply|automatic reply|out of office|vacation reply|away)/i.test(subject)) {
    return { skip: true, reason: 'auto_reply_subject' }
  }

  // Calendar invites: subject prefixed with status verbs Gmail/Outlook use.
  if (/^(invitation|accepted|declined|tentative|tentatively):/i.test(subject)) {
    return { skip: true, reason: 'calendar_invite' }
  }

  // System notifications: noreply/donotreply senders.
  if (/(no[-_.]?reply|do[-_.]?not[-_.]?reply)@/i.test(fromEmail)) {
    return { skip: true, reason: 'system_notification' }
  }

  return { skip: false }
}

interface RawEmail {
  id: string
  subject: string
  fromEmail: string
  body: string
  headers: Record<string, string>
}

async function extractFromEmail(
  venueId: string,
  email: RawEmail,
): Promise<ExtractedPhrase[]> {
  try {
    const result = await callAIJson<ExtractionResult>({
      systemPrompt: EMAIL_EXTRACTION_SYSTEM_PROMPT,
      userPrompt: `Extract distinctive phrases from this operator outbound email:\n\nSubject: ${email.subject}\n\nBody:\n"""\n${email.body.slice(0, 6000)}\n"""`,
      maxTokens: 700,
      temperature: 0.2,
      venueId,
      taskType: 'voice_gmail_backfill_extract',
      contentTier: 1,
      tier: 'haiku',
      promptVersion: VOICE_GMAIL_BACKFILL_PROMPT_VERSION,
    })

    return (result.phrases ?? [])
      .filter((p) => p.phrase && p.phrase.trim().length >= 5)
      .map((p) => {
        const theme = REVIEW_THEMES.includes(p.theme as ReviewTheme)
          ? (p.theme as ReviewTheme)
          : ('other' as ReviewTheme)
        const sentiment = Math.max(-1, Math.min(1, Number(p.sentiment) || 0))
        return { phrase: p.phrase.trim().slice(0, 240), theme, sentiment }
      })
  } catch (err) {
    console.warn(`[voice/gmail-backfill] extraction failed for ${email.id}:`, err)
    return []
  }
}

export interface GmailBackfillResult {
  ok: boolean
  scanned: number
  skipped_filter: number
  extracted_messages: number
  phrases_inserted: number
  phrases_deduped: number
  cost_ceiling_paused: boolean
  errors: string[]
}

interface GmailMessageHeader { name: string; value: string }
interface GmailMessage {
  id?: string | null
  payload?: { headers?: GmailMessageHeader[] }
}
interface GmailListResponse {
  data: { messages?: Array<{ id?: string }>; nextPageToken?: string }
}

export async function backfillGmailVoice(
  venueId: string,
  options: { monthsBack?: number } = {},
): Promise<GmailBackfillResult> {
  const result: GmailBackfillResult = {
    ok: false,
    scanned: 0,
    skipped_filter: 0,
    extracted_messages: 0,
    phrases_inserted: 0,
    phrases_deduped: 0,
    cost_ceiling_paused: false,
    errors: [],
  }

  // Cost-ceiling gate. Coordinator-initiated, but they can stack 200
  // messages = ~$2-4 per click. If venue is paused, we still proceed but
  // log the warning per the brain-dump pattern.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    result.cost_ceiling_paused = true
    console.warn(`[voice/gmail-backfill] proceeding despite cost-ceiling pause for venue ${venueId}`)
  }

  const gmail = await getGmailClient(venueId)
  if (!gmail) {
    result.errors.push('No Gmail connection available for this venue.')
    return result
  }

  const monthsBack = options.monthsBack ?? DEFAULT_MONTHS_BACK
  const since = new Date()
  since.setMonth(since.getMonth() - monthsBack)
  const sinceQuery = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`

  // Pull message IDs from the Sent label after the cutoff. Gmail caps at
  // 500 per response; we cap at MAX_MESSAGES_PER_RUN here.
  const messageIds: string[] = []
  let pageToken: string | undefined
  while (messageIds.length < MAX_MESSAGES_PER_RUN) {
    const remaining = MAX_MESSAGES_PER_RUN - messageIds.length
    const listResp = (await gmail.users.messages.list({
      userId: 'me',
      q: `in:sent after:${sinceQuery}`,
      maxResults: Math.min(100, remaining),
      pageToken,
    })) as GmailListResponse
    const ids = (listResp.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
    messageIds.push(...ids)
    pageToken = listResp.data.nextPageToken
    if (!pageToken || ids.length === 0) break
  }

  const supabase = createServiceClient()

  for (const id of messageIds) {
    result.scanned += 1
    try {
      const msg = (await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      })) as { data: GmailMessage }
      const payload = (msg.data.payload ?? {}) as Record<string, unknown>
      const headersArr = ((payload.headers ?? []) as GmailMessageHeader[])
      const headers = headersArr.reduce<Record<string, string>>((acc, h) => {
        acc[h.name.toLowerCase()] = h.value
        return acc
      }, {})
      const subject = headers['subject'] ?? ''
      const fromEmail = (headers['from'] ?? '').match(/<([^>]+)>/)?.[1] ?? headers['from'] ?? ''

      const body = parseEmailBody(payload as never)
      const filter = shouldSkip({ subject, fromEmail, bodyChars: body.length, headers })
      if (filter.skip) {
        result.skipped_filter += 1
        continue
      }

      const phrases = await extractFromEmail(venueId, {
        id,
        subject,
        fromEmail,
        body,
        headers,
      })
      if (phrases.length === 0) continue
      result.extracted_messages += 1

      // Dedup on (venue_id, phrase) — same phrase mined twice is a no-op.
      // Hit the table per phrase rather than batch since the unique
      // constraint isn't a real DB constraint; idempotency check happens
      // in code.
      for (const p of phrases) {
        const { data: existing } = await supabase
          .from('review_language')
          .select('id, frequency')
          .eq('venue_id', venueId)
          .eq('phrase', p.phrase)
          .limit(1)
          .maybeSingle()

        if (existing) {
          await supabase
            .from('review_language')
            .update({ frequency: ((existing.frequency as number | null) ?? 1) + 1 })
            .eq('id', existing.id)
          result.phrases_deduped += 1
        } else {
          const { error: insertErr } = await supabase.from('review_language').insert({
            venue_id: venueId,
            phrase: p.phrase,
            theme: p.theme,
            sentiment: p.sentiment,
            frequency: 1,
            source_type: 'gmail_backfill',
            source_reference: `gmail:${id}`,
          })
          if (insertErr) {
            result.errors.push(`insert ${p.phrase.slice(0, 30)}: ${insertErr.message}`)
            continue
          }
          result.phrases_inserted += 1
        }
      }
    } catch (err) {
      result.errors.push(`message ${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  result.ok = true
  console.log(`[voice/gmail-backfill] venue=${venueId} scanned=${result.scanned} extracted=${result.extracted_messages} inserted=${result.phrases_inserted} deduped=${result.phrases_deduped}`)
  return result
}
