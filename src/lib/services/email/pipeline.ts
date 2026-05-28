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
  shouldAutoIgnore,
  isMachineGenerated,
  type ClassificationResult,
} from '@/lib/services/brain/router'
import {
  classifyInboundRaw,
  intentToEmailClassification,
  stampInboundVerdict,
  synthVerdictForFormLead,
  type IntentVerdict,
} from '@/lib/services/intel/inbound-intent-classifier'
import { generateInquiryDraft, BRAIN_PROMPT_VERSION as INQUIRY_BRAIN_PROMPT_VERSION } from '@/lib/services/brain/inquiry'
import { generateClientDraft, BRAIN_PROMPT_VERSION as CLIENT_BRAIN_PROMPT_VERSION } from '@/lib/services/brain/client'
import { fetchNewEmails, sendEmail, type EmailAttachment, type ParsedEmail } from '@/lib/services/email/gmail'
import {
  matchAssetsForEmail,
  loadAssetBytes,
  filenameForAsset,
  type MatchedAsset,
} from '@/lib/services/intel/asset-matcher'
import { detectBookingSignal } from '@/lib/services/booking-signal'
import {
  detectSchedulingEvent,
  eventKindToEngagementType,
  eventKindToStatus,
  timeAwareTourKind,
  type SchedulingEvent,
  type SchedulingEventKind,
} from '@/lib/services/ingestion/scheduling-tool-parsers'
import { findIdentityMatches } from '@/lib/services/identity/resolution'
import { extractKnotPersonId } from '@/lib/services/identity/knot-sender-id'
import { mintWedding } from '@/lib/services/identity/mint-wedding'
import { recordKnowledgeGaps } from '@/lib/services/intel/knowledge-gaps'
import { applySignalInference } from '@/lib/services/attribution/signal-inference'
import { createNotification } from '@/lib/services/admin-notifications'
import { trackCoordinatorAction, trackResponseTime } from '@/lib/services/intel/consultant-tracking'
import { appendAIDisclosure, fetchDisclosureContext } from '@/lib/services/brain/ai-disclosure'
import { matchFilter, clearFilterCache, logFilterMatch } from '@/lib/services/email/inbox-filters'
import { parseFuzzyDate, parseGuestCount, validateEstimatedGuests } from '@/lib/services/fuzzy-date'
import { chooseEventTime, parseEventTime } from '@/lib/services/event-time'
import { detectFormRelay, type FormRelayLead } from '@/lib/services/ingestion/form-relay-parsers'
import {
  extractIdentityFromEmail,
  isRelayAddress,
  isSyntheticAddress,
  isUnsendableAddress,
} from '@/lib/services/identity/body-extract'
import { createLogger, logEvent, newCorrelationId } from '@/lib/observability/logger'
import { normalizeSource } from '@/lib/services/normalize-source'
import { recordEngagementEventsBatch } from '@/lib/services/heat-mapping'
import { updateThreadLifecycleFolder } from '@/lib/services/inbox/lifecycle'
import { detectLifecycleSignal } from '@/lib/services/lifecycle/signal-detector'
import { applyLifecycleSignal } from '@/lib/services/lifecycle/writer'
import { isLossSignal, isTerminalStatus, type WeddingStatus as LifecycleWeddingStatus } from '@/lib/services/lifecycle/wedding-lifecycle-engine'
import { classifySurface } from '@/lib/services/email/surface-classifier'

// ---------------------------------------------------------------------------
// Stream WWW (migration 205): UTM extraction from extracted_identity
// ---------------------------------------------------------------------------
//
// Some inbound relays (notably The Knot's outbound emails) carry UTM
// keys in their tracking links, and the body-identity-extract step
// stamps these into interactions.extracted_identity.utm_*. This helper
// reads them off a JSON-shaped extractedIdentity and returns a typed
// UTM bundle that the wedding-create + wedding-update paths use to
// stamp weddings.utm_* columns. Per the migration-205 column COMMENTs,
// the never-overwrite policy is enforced at the application layer
// (the caller checks existing UTM presence before patching).

interface UtmBundle {
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_term?: string | null
  utm_content?: string | null
}

const UTM_BUNDLE_KEYS: ReadonlyArray<keyof UtmBundle> = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
]

function extractUtmFromExtractedIdentity(
  identity: object | null | undefined,
): UtmBundle {
  if (!identity || typeof identity !== 'object') return {}
  const out: UtmBundle = {}
  // Cast to the indexable shape since ExtractedIdentity itself doesn't
  // declare utm_* fields — those land via downstream extenders that
  // tee additional UTM keys onto the same JSONB column on the
  // interactions row. Reading by string key is safe because the
  // typeof guard above ensures it's an object, and we only accept
  // string values.
  const bag = identity as Record<string, unknown>
  for (const key of UTM_BUNDLE_KEYS) {
    const v = bag[key]
    if (typeof v === 'string' && v.trim().length > 0) {
      out[key] = v.trim()
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 2026-05-26 — Relay-resolved identity for cascade `linkSignal` writes.
// ---------------------------------------------------------------------------
//
// THE BUG (Glascow Tennille trace, operator-impact):
// For relay-resolved emails (venue_calculator submissions, Calendly-via-
// Gmail forwards, Zola/Knot/WW inquiries) the raw From header is the
// venue's OWN address. Feeding rawFromEmail/rawFromName into the
// cascade signal made the matcher score `primary_email='hello@<venue>.
// com'` + `primary_name='<Venue> Calculator'` — so the matcher had
// zero chance of unifying the calculator submission (signal A, email
// gtennilledpt@gmail.com via legacy resolver) with the Calendly tour
// notification for the SAME couple (signal B, email nupaminette@yahoo.
// com via legacy resolver). The legacy `findOrCreateContact` path
// correctly swaps in `formLead.leadEmail` / `schedulingEvent.
// inviteeEmail` at line ~1160; the cascade-side `linkSignal` call did
// NOT, so the two signals landed as two unbridged spine couples.
//
// THE FIX:
// Pass `resolvedEmail` / `resolvedName` / `resolvedPhone` +
// `channelOverride` + `actionTypeOverride` to the adapter at each
// inbound `linkSignal` call site so the cascade sees the prospect's
// real identity + the canonical relay channel.

/**
 * Canonical channel for a `FormRelayLead.source`. Matches the channel
 * taxonomy in `identity/sources/types.ts` and the keys
 * `progression.ts` dispatches on for new_channel_inquiry mapping
 * (`'knot' | 'weddingwire' | 'zola' | 'website'`). The Knot, WW, Zola
 * batch adapters use the single-token forms; venue_calculator is the
 * venue's own website form, so it maps to 'website' to align with
 * `progression.ts:174` ("if channel === 'website' && action ===
 * 'inquiry_form_submitted' → new_channel_inquiry"). HCTG is mapped
 * to 'here_comes_the_guide' as-is — there is no shorter canonical form
 * in the taxonomy yet, and progression.ts has no dispatch for it
 * (a fragment-routed signal with no progression event is the correct
 * pre-coverage behaviour).
 */
function formLeadSourceToChannel(source: FormRelayLead['source']): string {
  switch (source) {
    case 'the_knot':
      return 'knot'
    case 'wedding_wire':
      return 'weddingwire'
    case 'zola':
      return 'zola'
    case 'venue_calculator':
      return 'website'
    case 'here_comes_the_guide':
      return 'here_comes_the_guide'
    default:
      // Exhaustiveness — TS-narrowed to never. If a new source lands
      // without a mapping it falls back to the literal string so the
      // touchpoint still binds, just without a progression mapping.
      return source as string
  }
}

/**
 * Canonical action_type for a `FormRelayLead.source`. Picks the verb
 * that `progression.ts` already dispatches for the resolved channel:
 *   - venue_calculator → 'inquiry_form_submitted' (matches website
 *     mapping at progression.ts:174-175 → new_channel_inquiry).
 *     The Glascow Tennille trace shows this is the right doctrine
 *     fit — a calculator submission IS the venue's website inquiry
 *     form firing.
 *   - knot / weddingwire / zola → 'inquiry' (matches knot/weddingwire/
 *     zola mapping at progression.ts:168-170 → new_channel_inquiry).
 *   - here_comes_the_guide → 'inquiry' (no progression mapping yet
 *     but the verb is sensible; fragment-routed).
 */
function formLeadSourceToActionType(source: FormRelayLead['source']): string {
  switch (source) {
    case 'venue_calculator':
      return 'inquiry_form_submitted'
    case 'the_knot':
    case 'wedding_wire':
    case 'zola':
    case 'here_comes_the_guide':
      return 'inquiry'
    default:
      return 'inquiry'
  }
}

/**
 * Canonical action_type for a `SchedulingEventKind`. The schedulingEvent
 * is delivered via Gmail (Calendly/Acuity/HoneyBook/Dubsado all email
 * the venue when bookings happen) — without this override the cascade
 * would write `action_type:'reply'` on a Calendly tour_scheduled and
 * the matcher would miss the canonical 'tour_booked' progression event.
 *
 * Mapped against progression.ts:139-167:
 *   - tour_scheduled → 'tour_booked' (channel='calendly' dispatch)
 *   - tour_completed → 'tour_attended' (channel='calendly' dispatch)
 *   - tour_rescheduled → 'tour_rescheduled' (channel='calendly')
 *   - tour_cancelled → 'tour_cancelled' (verb is sensible; no
 *       progression mapping in current progression.ts — fragment-
 *       routed touchpoint with no progression event is the right
 *       pre-coverage behaviour, the legacy engagement_events write at
 *       pipeline.ts:~3743 already carries the cancellation signal)
 *   - contract_signed → 'contract_signed' (channel='honeybook')
 *   - contract_sent / payment_received / final_walkthrough /
 *     pre_wedding_event / planning_meeting → pass-through (no
 *     progression mapping today; touchpoint still records the truth)
 *   - honeybook_contract_signed → 'contract_signed' (CRM-tagged
 *     equivalent — DRY with the unprefixed verb)
 *   - honeybook_payment_received / honeybook_refund /
 *     honeybook_amendment → pass-through (no progression mapping yet)
 */
function schedulingEventKindToAction(kind: SchedulingEventKind): string {
  switch (kind) {
    case 'tour_scheduled':
      return 'tour_booked'
    case 'tour_completed':
      return 'tour_attended'
    case 'tour_rescheduled':
      return 'tour_rescheduled'
    case 'tour_cancelled':
      return 'tour_cancelled'
    case 'contract_signed':
    case 'honeybook_contract_signed':
      return 'contract_signed'
    case 'contract_sent':
      return 'contract_sent'
    case 'payment_received':
    case 'honeybook_payment_received':
      return 'payment_received'
    case 'final_walkthrough':
      return 'final_walkthrough'
    case 'pre_wedding_event':
      return 'pre_wedding_event'
    case 'planning_meeting':
      return 'planning_meeting'
    case 'honeybook_refund':
      return 'honeybook_refund'
    case 'honeybook_amendment':
      return 'honeybook_amendment'
    default:
      return kind
  }
}

// ---------------------------------------------------------------------------
// Sage email auto-attach: match + materialize attachments at the send boundary
// ---------------------------------------------------------------------------

/**
 * Build the EmailAttachment[] payload for a draft about to send. Runs the
 * asset matcher (gated by venue_config.auto_attach_photos), pulls bytes
 * for the matches, and returns base64 attachments. Always returns [] on
 * any failure — must NEVER block email send.
 *
 * Telemetry: emits one structured log event per call so coordinator
 * dashboards can track "how often Sage attached" and "average bytes".
 */
async function buildAutoAttachments(args: {
  venueId: string
  correlationId?: string | null
  inboundSubject: string | null
  inboundBody: string
  replyDraft: string
  maxAttachments?: number
}): Promise<EmailAttachment[]> {
  const { venueId, correlationId, inboundSubject, inboundBody, replyDraft } = args
  if (!venueId || !replyDraft) return []

  let matched: MatchedAsset[] = []
  try {
    matched = await matchAssetsForEmail(
      venueId,
      {
        subject: inboundSubject ?? '',
        body: inboundBody ?? '',
        replyDraft,
      },
      {
        maxAttachments: args.maxAttachments ?? 2,
        correlationId: correlationId ?? undefined,
      },
    )
  } catch {
    // matchAssetsForEmail is itself try/catch'd, but belt-and-suspenders
    // here so a future refactor can't accidentally make this throw.
    matched = []
  }

  if (matched.length === 0) {
    logEvent({
      level: 'info',
      msg: 'sage auto-attach matcher ran',
      venueId,
      correlationId: correlationId ?? undefined,
      actor: 'system',
      event_type: 'asset_match',
      outcome: 'ok',
      data: {
        eligible: 'unknown', // matcher gates internally; not exposed
        matched_count: 0,
        attached_count: 0,
        total_bytes: 0,
      },
    })
    return []
  }

  const built: EmailAttachment[] = []
  let totalBytes = 0
  for (const a of matched) {
    try {
      const bytes = await loadAssetBytes(a)
      if (!bytes) continue
      built.push({
        filename: filenameForAsset(a),
        mimeType: a.mimeType ?? 'image/jpeg',
        contentBase64: bytes.toString('base64'),
      })
      totalBytes += bytes.length
    } catch (err) {
      console.warn(
        '[pipeline] auto-attach: loadAssetBytes failed for asset',
        a.id,
        err instanceof Error ? err.message : err,
      )
    }
  }

  logEvent({
    level: 'info',
    msg: 'sage auto-attach matcher ran',
    venueId,
    correlationId: correlationId ?? undefined,
    actor: 'system',
    event_type: 'asset_match',
    outcome: 'ok',
    data: {
      matched_count: matched.length,
      attached_count: built.length,
      total_bytes: totalBytes,
    },
  })

  return built
}

// ---------------------------------------------------------------------------
// Stream EEEE: HUMAN REQUESTED escalation detection
// ---------------------------------------------------------------------------
//
// Sage's outbound footer (ai-disclosure v3) tells couples they can drop
// Sage entirely by replying with "HUMAN REQUESTED" in the subject. This
// regex detects that on inbound classification:
//
//   - Case-insensitive ("HUMAN REQUESTED", "human requested", "Human-Requested")
//   - Allows space, underscore, or dash between the two words
//   - Word-boundary anchored so a forwarded subject like
//     "Re: photos of human-requested locations" doesn't false-positive
//     (the boundary check passes for "human requested" but the second
//     word boundary is REQUIRED right after — `human-requested` lands
//     on a word char, so the trailing \b matches)
//
// When matched: the pipeline persists the inbound interaction (so the
// thread is complete in the inbox) but skips draft generation entirely
// (no LLM cost), fires an admin_notifications row so the coordinator
// sees the request immediately, and records an engagement_events row
// for the forensic trail.
// Legacy narrow pattern — kept for telemetry differentiation + back-compat.
export const HUMAN_REQUESTED_SUBJECT_PATTERN = /\bHUMAN[\s_-]+REQUESTED\b/i

// 2026-05-11: broadened detection. The footer no longer asks couples to
// type "HUMAN REQUESTED" as magic words (read adversarial; one couple
// snapped back with exactly that phrase). The visible escalation copy is
// now soft ("Just ask, or email <escalation>") and this pattern catches
// the natural-language version on inbound subject OR body. Matches:
//   - legacy magic-words form (still works on existing threads)
//   - "talk / speak / chat to a (real) person / human / someone"
//   - "is this / are you a bot / AI / real person"
//   - "stop the bot", "no more AI", "i want a human"
//   - "real human please", "human please"
// Word-boundary anchored so quoted phrases ("photos of human-requested
// locations") don't false-positive.
export const HUMAN_ESCALATION_PATTERN =
  /\bHUMAN[\s_-]+REQUESTED\b|\b(?:talk|speak|chat)\s+(?:to\s+)?(?:a\s+)?(?:real\s+)?(?:person|human|someone)\b|\b(?:is|are)\s+(?:you|this)\s+(?:a\s+)?(?:real\s+person|human|bot|an\s+ai|ai)\??\b|\b(?:stop|no\s+more)\s+(?:the\s+)?(?:bot|ai)\b|\b(?:i\s+(?:want|need)|just\s+(?:want|need))\s+(?:a\s+)?(?:real\s+)?(?:human|person)\b|\b(?:real\s+)?human\s+please\b/i

/** Pure helper — returns true when a subject contains the legacy magic-
 *  words marker. Kept for back-compat callers; new callers should use
 *  detectHumanEscalation which also accepts a body string and matches
 *  the broader natural-language pattern. */
export function detectHumanRequested(subject: string | null | undefined): boolean {
  if (!subject) return false
  return HUMAN_REQUESTED_SUBJECT_PATTERN.test(subject)
}

/** Broadened detector — checks both subject and body for any natural-
 *  language escalation request (or the legacy magic-words form). The
 *  pipeline routes this exactly like detectHumanRequested: persist the
 *  interaction, skip drafting, fire admin_notifications. */
export function detectHumanEscalation(
  subject: string | null | undefined,
  body?: string | null,
): boolean {
  const haystack = `${subject ?? ''}\n${body ?? ''}`
  if (!haystack.trim()) return false
  return HUMAN_ESCALATION_PATTERN.test(haystack)
}

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
  context: Record<string, unknown> = {},
  correlationId?: string | null
): Promise<void> {
  // Supabase PostgrestErrors aren't `instanceof Error` — they're plain
  // objects with { message, code, details, hint }. Stringifying them
  // naively produces "[object Object]". Serialize known shapes + fall
  // back to JSON so the error log actually contains diagnostic info.
  let message: string
  if (err instanceof Error) {
    message = err.message
  } else if (err && typeof err === 'object') {
    const pg = err as { message?: string; code?: string; details?: string; hint?: string }
    if (pg.message) {
      message = `${pg.message}${pg.code ? ` [${pg.code}]` : ''}${pg.details ? ` — ${pg.details}` : ''}${pg.hint ? ` (hint: ${pg.hint})` : ''}`
    } else {
      try { message = JSON.stringify(err) } catch { message = String(err) }
    }
  } else {
    message = String(err)
  }
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
      correlation_id: correlationId ?? null,
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
  // 2026-04-30: also include any from_email observed on a previously-
  // classified outbound interaction. Self-learns Sage's actual sending
  // address (e.g. sage@rixeymanor.com when only the primary connection
  // address sage@bloomhouse.app was registered). Without this, the
  // first time Sage sent from a new alias every reply slipped through
  // the self-loop guard as inbound from the customer.
  const { data: prevOutbounds } = await supabase
    .from('interactions')
    .select('from_email')
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
    .not('from_email', 'is', null)
    .limit(500)
  for (const row of (prevOutbounds ?? []) as Array<{ from_email: string | null }>) {
    const e = (row.from_email ?? '').toLowerCase().trim()
    if (e) own.add(e)
  }
  // Team member emails — user_profiles rows for this venue's team are
  // not leads. Prior versions of this guard caught sage@venue.com and
  // info@venue.com but missed team members with personal Gmails that
  // email the venue inbox (CC'ing themselves on replies, forwarding,
  // internal notes). Including them here prevents them being created
  // as ghost "couple" rows.
  const { data: team } = await supabase
    .from('user_profiles')
    .select('email')
    .eq('venue_id', venueId)
  for (const t of (team ?? []) as Array<{ email: string | null }>) {
    const e = (t.email || '').toLowerCase().trim()
    if (e) own.add(e)
  }
  // Venue's own calculator / form-relay senders recorded in
  // venue_config.automation_emails. Any custom automation that sends
  // from an external service (e.g. the Rixey pricing calculator at
  // contact@interactivecalculator.com) lands here so the self-loop
  // guard treats it like a venue-own address for direction purposes.
  // The form-relay parser still runs first and extracts the real
  // prospect — this guard only fires when no form-relay matched.
  const { data: config } = await supabase
    .from('venue_config')
    .select('automation_emails')
    .eq('venue_id', venueId)
    .maybeSingle()
  const autos = (config?.automation_emails as string[] | null) ?? []
  for (const a of autos) {
    const e = (a || '').toLowerCase().trim()
    if (e) own.add(e)
  }
  return own
}

// Wave 4 Phase 4 (2026-05-10): loadVenueIdentityContext removed — the
// only caller was the retired Wave-3 extractEmailIdentity. The chokepoint
// (identity/name-capture.ts) carries an equivalent venue-name guard via
// loadVenueOwnNames keyed by its own per-call cache.

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
 *
 * 2026-05-08: kept as a back-compat wrapper around the canonical identity
 * resolver (src/lib/services/identity/resolver.ts). Every entry path now
 * routes through resolveIdentity for deterministic match semantics; this
 * function preserves the legacy {personId, weddingId, isNew} shape that
 * processIncomingEmail and friends expect.
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
  ownEmailsHint?: Set<string>,
  /**
   * Optional extras captured by upstream parsers (Calendly invitee form,
   * The Knot intake) that the person row should carry from birth.
   * Persisting phone here lets identity-resolution match subsequent
   * signals from the same couple via different email addresses.
   */
  extras?: { phone?: string | null }
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

  // 1. Canonical resolver — runs the full match-chain (email exact /
  // canonical / phone). Returns the canonical person_id if the chain
  // matches anyone. We pass weddingDate=null because email-pipeline
  // creates the wedding itself based on classification.
  // Signals: email + phone + name. partner names not known at this stage.
  // Why this is here: the legacy body matched on `people.email` only,
  // which missed the Reem case (Knot relay arrived first with hotmail,
  // calculator arrived next with the same hotmail under different casing
  // / plus-addressing).
  try {
    const { findCanonicalPersonForEmail } = await import('@/lib/services/identity/resolver-helpers')
    const hit = await findCanonicalPersonForEmail(supabase, venueId, email, extras?.phone ?? null)
    if (hit) {
      return { personId: hit.personId, weddingId: hit.weddingId, isNew: false }
    }
  } catch (err) {
    // Never let the resolver kill ingest. Fall through to the legacy
    // contacts-table path; if that misses too we still create a new row.
    console.warn('[pipeline] canonical resolver pre-check failed, falling through:', err instanceof Error ? err.message : err)
  }

  // 2. Match through the contacts table (legacy fallback). contacts has
  // no venue_id column; scope through people.venue_id via the FK join.
  // Some venues have stragglers in contacts that didn't make it onto
  // people.email — keep this path to absorb them. tombstones are filtered.
  const { data: byContact } = await supabase
    .from('contacts')
    .select('person_id, people!inner(id, wedding_id, venue_id, merged_into_id)')
    .eq('type', 'email')
    .ilike('value', email)
    .eq('people.venue_id', venueId)
    .is('people.merged_into_id', null)
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

  // 3. Create a new person.
  //
  // M2 flip (PHASE-1-BATCH-1.md §3.3, 2026-05-22): the partner1 person
  // creation routes through the `mintPerson` chokepoint instead of a raw
  // `people.insert`. Only the *create* is rerouted — match steps 1
  // (canonical resolver) and 2 (contacts-table fallback) above already
  // ran and missed, so by the time we are here a fresh person is
  // genuinely needed. `mintPerson` re-runs its own identifier match
  // chain (email_exact → email_canonical → phone); on this no-match path
  // that chain also misses (same data), so it falls through to
  // `createPerson` — the create outcome is unchanged. The chokepoint
  // additionally: (a) routes the name through the name-capture
  // shape-classifier (no `Rosaliehoyle` from `rosaliehoyle@gmail.com` —
  // it replaces the old `placeholderFirst` email-local-part heuristic),
  // (b) fires the venue self-loop guard, (c) records source provenance.
  //
  // NOTE — divergence ruled minimal (PHASE-1-BATCH-1.md §3.3): the
  // contacts-table fallback (step 2) is NOT part of mintPerson's chain.
  // It is intentionally left as a pre-mintPerson match step here — it
  // absorbs `contacts` stragglers not on `people.email`. Routing only the
  // create through mintPerson keeps that fallback intact, so contact
  // resolution behaviour is unchanged; only the INSERT is at the
  // chokepoint.
  const { mintPerson } = await import('@/lib/services/identity/mint-person')
  const trimmedName = (name ?? '').trim()
  const mintResult = await mintPerson({
    venueId,
    signals: {
      email,
      phone: extras?.phone ?? null,
      fullName: trimmedName || null,
      weddingDate: null,
      partner1Name: null,
      partner2Name: null,
    },
    source: 'email_pipeline',
    reason: 'findOrCreateContact:partner1',
    ownEmailsHint: ownEmails,
    supabase,
  })

  // mintPerson never throws by contract. personId:null means the
  // self-loop guard fired (venue's own address — already filtered at
  // step 0, so unexpected here) or the resolver INSERT failed. Either
  // way there is no row to mirror or match; preserve the legacy
  // failure shape `{ personId:null, isNew:true }`.
  if (!mintResult.personId) {
    console.error(
      '[pipeline] findOrCreateContact: mintPerson returned null',
      `(matchedBy=${mintResult.matchedBy})`,
    )
    return { personId: null, weddingId: null, isNew: true }
  }
  const newPerson = { id: mintResult.personId }
  // `isNew` from mintPerson maps to `findOrCreateContact`'s isNewContact:
  // true only on a genuine `created_new`. If mintPerson's own match
  // chain matched an existing person (an identifier the steps above
  // somehow missed — e.g. a phone-only match), isNew is false and the
  // wedding-creation gate downstream correctly does NOT mint a couple.
  const mintIsNew = mintResult.isNew

  // 4. Mirror the email onto contacts so subsequent lookups that go through
  // contacts find it. contacts has no venue_id; tenancy is via person_id.
  //
  // M3 finding (PHASE-1-BATCH-1.md §3.3, 2026-05-22): this contacts-mirror
  // write is NOT redundant — verified that mintPerson / resolvePersonOnly /
  // createPerson do NOT write the `contacts` identifier mirror anywhere
  // (`merge-people.ts` only RE-POINTS existing `contacts.person_id` during
  // a merge; it does not create the row). So the mirror insert stays, but
  // it is now CO-LOCATED with the mintPerson call and guarded on
  // `mintIsNew` — only a genuinely fresh person needs a fresh contacts
  // row. When mintPerson matched an existing person, that person already
  // has its contacts mirror; inserting again would create a duplicate
  // identifier row. (The pre-M2 code always inserted because the raw
  // path always created — guarding on mintIsNew preserves that 1:1
  // create→mirror invariant now that the create can resolve to a match.)
  if (mintIsNew) {
    await supabase.from('contacts').insert({
      person_id: newPerson.id,
      type: 'email',
      value: email,
      is_primary: true,
    })
  } else {
    // M3 alias/pool-hit mirror (PHASE-1-BATCH-1 remediation, 2026-05-23 —
    // MEDIUM defect).
    //
    // When mintPerson resolved to an EXISTING person via the alias_emails
    // branch in `findByEmailExact` or the `findPersonByPoolIdentifier`
    // fallback, the INCOMING email is — by definition — an alias the
    // resolver knew about (it's in the historical pool / alias_emails
    // array) but may NOT yet be on the matched person's `contacts` table.
    // The post-flip M3 guard `if (mintIsNew)` skips the contacts insert in
    // exactly this case, leaving the new alias invisible to the next
    // inbound (which uses contacts as step 2 of its match chain).
    //
    // Fix: when the inbound email is genuinely NEW for the matched person
    // (not already on contacts), write the mirror. Conservative — checks
    // first to avoid creating duplicate identifier rows. The note
    // distinguishes this insert from the M3 mintIsNew path so audits can
    // tell the two cases apart.
    try {
      const { data: existing } = await supabase
        .from('contacts')
        .select('id')
        .eq('person_id', newPerson.id)
        .eq('type', 'email')
        .ilike('value', email)
        .limit(1)
      if (!existing || existing.length === 0) {
        await supabase.from('contacts').insert({
          person_id: newPerson.id,
          type: 'email',
          value: email,
          // Not the primary — the matched person already has one. This is
          // an alias discovered via the resolver's pool/alias chain.
          // (contacts has no `note` column to record that distinction;
          // the alias-discovery semantics live in this comment + the
          // resolver's pool/alias_emails source-of-truth.)
          is_primary: false,
        })
      }
    } catch (err) {
      // Mirror failure is non-fatal — the resolve already returned a
      // person; the next inbound for the same alias will hit the pool /
      // alias_emails branch again and resolve correctly even without
      // contacts. Log so the gap is auditable.
      console.warn(
        '[pipeline] M3 alias-mirror insert failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }
  if (mintIsNew) {
    // Bare-email display-handle fallback (PHASE-1-BATCH-1 remediation,
    // 2026-05-23 — MEDIUM defect).
    //
    // Pre-M2-flip, when a bare email arrived with no display name AND a
    // single-token local part (`bob@gmail.com`), `findOrCreateContact`'s
    // legacy `placeholderFirst = email.split('@')[0]` heuristic wrote
    // `first_name='bob'` so the inbox row at least said "Bob" instead of
    // the raw email. Post-flip:
    //   - The incoming `trimmedName` is empty (no display name on the
    //     From header).
    //   - `createPerson` (resolver.ts:805-831) tries `inferNameFromEmail`,
    //     which rejects single-token local parts at name-capture.ts:589-592
    //     ("no handle splitter"). No evidence is captured.
    //   - The picker leaves `first_name`/`display_handle` null.
    //   - Inbox display falls back to the raw email.
    //
    // The doctrine: do NOT pollute `first_name` with a username (the
    // `Rosaliehoyle` bug class). Populate `display_handle` instead — the
    // doctrinally-correct slot for "we have a handle but not a real name"
    // (already used by name-capture for username/proxy shape evidence,
    // name-capture.ts:1156-1162). Conservative: only fires when both
    // first_name AND display_handle are NULL on the freshly-minted row
    // (so a name-capture path that DID populate something — e.g. a
    // first.last email through `inferNameFromEmail` — is left untouched),
    // AND only when no incoming display name was provided.
    const incomingDisplay = (name ?? '').trim()
    if (!incomingDisplay) {
      try {
        const at = email.indexOf('@')
        const local = at > 0 ? email.slice(0, at) : ''
        // Only attempt for plausible single-token local parts. A digit-
        // heavy local part (`user12345@…`) or an empty one stays null.
        const looksLikeBareHandle =
          local.length >= 2 && local.length <= 40 && /^[a-z][a-z0-9._-]*$/i.test(local)
        if (looksLikeBareHandle) {
          // Capitalize first letter; leave the rest as-is (some handles
          // are camelCase + meaningful — `bobSmith` stays `BobSmith`).
          const handle = local.charAt(0).toUpperCase() + local.slice(1)
          const { data: cur } = await supabase
            .from('people')
            .select('first_name, display_handle')
            .eq('id', newPerson.id)
            .maybeSingle()
          const hasFirst = !!(cur?.first_name && String(cur.first_name).trim())
          const hasHandle = !!(cur?.display_handle && String(cur.display_handle).trim())
          if (!hasFirst && !hasHandle) {
            await supabase
              .from('people')
              .update({ display_handle: handle })
              .eq('id', newPerson.id)
          }
        }
      } catch (err) {
        // Never break ingest on the display-handle backfill. The legacy
        // path used to silently leave first_name=local-part on failure;
        // this path leaves display_handle null and the inbox falls back
        // to the email — strictly safer than corrupting first_name.
        console.warn(
          '[pipeline] bare-email display_handle backfill failed:',
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  // 5. Phase 8 identity resolution — run the matcher against the new
  // person. A high-confidence match auto-merges; medium/low lands in
  // client_match_queue for triage; matching tangential_signals get
  // linked. Fire-and-forget: a matching failure must never break ingest.
  //
  // M2 flip note (2026-05-22): the legacy code only ever reached this
  // step with a genuinely fresh INSERT, so the matcher always ran
  // against a new row. With mintPerson, the create path can instead
  // resolve to an EXISTING person via its identifier chain
  // (`mintIsNew === false`). The Phase-8 matcher (`enqueueIdentityMatches`)
  // is built for a brand-new row — running it against an already-merged
  // canonical person is a no-op at best and a spurious re-merge at
  // worst. Guard it on `mintIsNew` so behaviour matches the pre-flip
  // contract: matcher runs iff a fresh person was created.
  let survivorId = newPerson.id
  if (mintIsNew) {
    try {
      const { enqueueIdentityMatches } = await import('@/lib/services/identity/enqueue')
      const result = await enqueueIdentityMatches({ supabase, venueId, newPersonId: newPerson.id })
      if (result.autoMergedIntoPersonId && result.autoMergedIntoPersonId !== newPerson.id) {
        survivorId = result.autoMergedIntoPersonId
      }
    } catch (err) {
      console.error('[pipeline] enqueueIdentityMatches failed:', err instanceof Error ? err.message : err)
    }
  } else {
    // PHASE-1-BATCH-1 remediation (MEDIUM defect, 2026-05-23): when
    // mintPerson resolved to an EXISTING person via the alias_emails
    // branch / pool fallback, the auto-merge MUST stay skipped (no fresh
    // row to merge) BUT the tangential-signal promotion is legitimate
    // and was being skipped too as a side effect of the single
    // `if (mintIsNew)` guard. `enqueueIdentityMatches({skipAutoMerge:true})`
    // runs ONLY step 4 (promoteTangentialSignals) — it cross-references
    // the canonical person's identifiers against the unmatched
    // tangential_signals pool and links any that now resolve via the
    // newly-discovered alias. Same fire-and-forget contract.
    try {
      const { enqueueIdentityMatches } = await import('@/lib/services/identity/enqueue')
      await enqueueIdentityMatches({
        supabase,
        venueId,
        newPersonId: newPerson.id,
        skipAutoMerge: true,
      })
    } catch (err) {
      console.error(
        '[pipeline] enqueueIdentityMatches (tangential-only) failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  if (survivorId !== newPerson.id) {
    const { data: survivor } = await supabase
      .from('people')
      .select('wedding_id')
      .eq('id', survivorId)
      .single()
    return { personId: survivorId, weddingId: (survivor?.wedding_id as string | null) ?? null, isNew: false }
  }

  // C2 fix (PHASE-1-BATCH-1 remediation, 2026-05-23): when mintPerson
  // resolved to an EXISTING person via its identifier chain — alias_emails
  // branch in findByEmailExact, the pool fallback findPersonByPoolIdentifier,
  // or any other resolver-internal step that pre-flip we never reached
  // because the legacy path always inserted — `mintIsNew` is false and the
  // matched person already has a wedding_id we MUST carry through.
  //
  // Pre-flip, the only "matched existing" path was the post-INSERT
  // `enqueueIdentityMatches` auto-merge into a survivor, and the survivor-
  // wedding-id query above handled it. Post-flip, the survivor branch
  // doesn't fire on alias/pool hits (mintPerson already deduplicated, so
  // there's no NEW row to auto-merge from). Dropping the wedding_id at
  // this return makes the upstream gate at pipeline.ts:~2212 see
  // weddingId=null + isNewContact=false → wedding-creation skipped → the
  // inbound interaction lands wedding_id=null at the interaction level →
  // the email is orphaned. C2 closes that.
  //
  // mintIsNew=true → fresh person → no prior wedding to carry (legacy
  // behaviour); mintIsNew=false → query the matched person's wedding_id
  // (mirrors the survivor query above).
  let returnWeddingId: string | null = null
  if (!mintIsNew) {
    try {
      const { data: matched } = await supabase
        .from('people')
        .select('wedding_id')
        .eq('id', newPerson.id)
        .maybeSingle()
      returnWeddingId = (matched?.wedding_id as string | null) ?? null
    } catch (err) {
      // Query failure must not break ingest — degrade to weddingId=null
      // (the pre-C2 shape) so the rest of the pipeline still runs.
      console.warn(
        '[pipeline] findOrCreateContact: matched-person wedding_id lookup failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  // `isNew` is `mintIsNew`, not a hard-coded `true`: when mintPerson's
  // identifier match chain resolved to an existing person, this is NOT a
  // new contact and the downstream wedding-creation gate (which keys on
  // `isNewContact`) must not mint a fresh couple. When mintPerson created
  // a fresh row, `mintIsNew` is true — identical to the legacy contract.
  return { personId: newPerson.id, weddingId: returnWeddingId, isNew: mintIsNew }
}

/**
 * Build a synthetic ClassificationResult from a form-relay parse. The
 * parsers already give us the authoritative fields (we read them directly
 * from the form body), so we skip the LLM and hand those straight to the
 * rest of the pipeline. source maps to the shape router-brain uses so
 * downstream wedding.source / intelligence_extractions stay consistent.
 */
/**
 * Extract question sentences from a free-text note. Used by form-relay
 * synth classification (B-19) so /agent/knowledge-gaps no longer
 * systematically under-counts Knot/WW/Zola questions.
 *
 * Pattern: split on sentence boundaries, keep tokens that end with '?'
 * after trimming. Tolerates newlines and bullet-list shapes. Caps at
 * 5 questions to match the upstream classifier's typical output.
 *
 * Pure regex; the LLM classifier still owns nuance (rephrased
 * statements, indirect asks). For the form-relay path this is the
 * "good-enough at zero token cost" line — knowledge_gaps is a
 * coordinator-facing aggregate, not a precision-critical surface.
 */
function extractQuestionsFromNote(note: string | null | undefined): string[] {
  if (!note) return []
  // Split on terminator + whitespace to pick up "?", ".", "!" — then
  // keep the question-marked sentences. Newlines also delimit (forms
  // often format the note as bullet points without trailing punct).
  const candidates = note
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const questions: string[] = []
  for (const c of candidates) {
    if (!c.endsWith('?')) continue
    // Reject pathological captures: too long (a whole paragraph
    // ending in a single '?'), or too short to be a real question.
    if (c.length < 4 || c.length > 240) continue
    questions.push(c)
    if (questions.length >= 5) break
  }
  return questions
}

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
      // B-19: pull '?'-terminated sentences from the prospect's note
      // so /agent/knowledge-gaps surfaces what they actually asked.
      // Pre-fix this was hardcoded `[]`, systematically under-counting
      // questions on Knot/WW/Zola/calculator leads.
      questions: extractQuestionsFromNote(lead.note),
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
  email: IncomingEmail,
  opts?: { skipDraft?: boolean; correlationId?: string }
): Promise<PipelineResult> {
  const supabase = createServiceClient()
  const rawFromEmail = extractEmailAddress(email.from)
  const rawFromName = extractName(email.from)

  // Correlation ID per Playbook OPS-21.2.1 / T1-G. Generated at the
  // pipeline entry so every downstream LLM call (router-brain,
  // inquiry-brain, client-brain) and DB write (drafts, api_costs)
  // can be traced back to the originating inbound email with one ID.
  // Caller (cron / poll-incoming / replay) can pass an explicit ID to
  // tie a multi-step run together; otherwise a fresh uuid is minted.
  const correlationId = opts?.correlationId ?? newCorrelationId()
  const log = createLogger({
    venueId,
    correlationId,
    actor: 'email_pipeline',
  })

  // Normalise the email's Date header to ISO so Postgres can accept it
  // as timestamptz. Gmail returns RFC 2822 format on some senders
  // ("Fri, 24 Apr 2026 18:36:05 +0000 (UTC)") which Postgres rejects
  // with 22007. Calendly / Acuity emails in particular use this shape.
  // new Date() handles RFC 2822 + ISO 8601 + a handful of other forms;
  // toISOString() gives us what timestamptz wants.
  let emailDate: string
  try {
    const parsed = new Date(email.date)
    if (Number.isNaN(parsed.getTime())) throw new Error('unparseable')
    emailDate = parsed.toISOString()
  } catch {
    emailDate = new Date().toISOString()
  }
  // Replace in the incoming email object so ALL downstream uses
  // (interactions.timestamp, engagement_events.occurred_at, etc.) see
  // the normalised value. Keeping the original on the object meant
  // every INSERT touching email.date could fail the same way.
  email = { ...email, date: emailDate }

  // Step 1a.0: Scheduling-tool pre-check. Calendly / Acuity / HoneyBook /
  // Dubsado emails come from notifications@calendly.com and friends —
  // which matchesUniversalIgnore correctly flags as "no-reply/bounce" on
  // the RAW from. Running detectSchedulingEvent first lets us fall
  // through to the normal pipeline (where the parser below reroutes
  // contact to the real invitee) instead of silently dropping the
  // signal. detectSchedulingEvent is a pure function, ~microseconds —
  // cheap to always run first.
  const schedulingPreCheck = detectSchedulingEvent({
    from: email.from,
    subject: email.subject,
    body: email.body,
  })

  log.info('pipeline.start', {
    event_type: 'email_pipeline.start',
    data: { messageId: email.messageId, threadId: email.threadId },
  })

  // Step 1a: Universal auto-ignore — no-reply / bounces / postmasters.
  // Bypassed when a scheduling tool matched above; those use no-reply
  // addresses by design but carry meaningful event payload.
  if (!schedulingPreCheck && matchesUniversalIgnore(rawFromEmail)) {
    log.info('pipeline.ignored', {
      event_type: 'email_pipeline.ignore',
      outcome: 'skip',
      data: { reason: 'universal_ignore' },
    })
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }

  // Step 1a.1: Early per-venue ignore rules on the RAW From. A coordinator
  // rule like "ignore @theknot.com" must fire before the form-relay parser
  // would otherwise rewrite From to the lead's personal email. Without
  // this, a venue that opts out of a marketplace wholesale still has every
  // inquiry from that marketplace flow through as a cold lead. Runs only
  // for action='ignore' at this stage — no_draft is handled post-rewrite
  // below so learned rules on the lead's own domain still work.
  // Scheduling-tool senders bypass: the venue's venue_email_filters may
  // still have a stale ignore rule on calendly.com (the default before
  // 2026-04-24). We bypass it here because the scheduling-tool parser
  // fired — meaning there's real booking signal to capture.
  const earlyFilterHit = await matchFilter(venueId, rawFromEmail, email.labels ?? [])
  if (earlyFilterHit?.action === 'ignore' && !schedulingPreCheck) {
    // TIER 5e+ (mig 339): log the decision so the audit endpoint can
    // count ignore-rule hits. Fire-and-forget; never blocks the bail.
    void logFilterMatch(venueId, earlyFilterHit, rawFromEmail)
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

  // Universal body-identity extraction — runs on every email
  // regardless of whether a platform parser matched. Two purposes:
  //   1. Persisted on interactions.extracted_identity for future
  //      retroactive linkage scripts and downstream analytics.
  //   2. Provides a primary_email fallback for findOrCreateContact
  //      when no platform parser fired AND the From header is a
  //      venue-own alias or a generic shared relay (otherwise the
  //      venue itself becomes "the prospect" and the real prospect
  //      vanishes — Rixey 2026-04-30 calculator orphan pattern).
  const baseExtractedIdentity = extractIdentityFromEmail(
    { subject: email.subject, body: email.body },
    { ownEmails },
  )

  // Wave 4 Phase 4 (2026-05-10): the per-email Wave-3 LLM identity
  // extractor (extraction/identity-from-email.ts) is retired. The
  // per-couple Sonnet judge in identity/reconstruct.ts reads message
  // bodies directly to produce the canonical names + relationships +
  // emotional_truths on couple_identity_profile. profile-to-people-sync
  // back-writes the canonical names onto people rows. The chokepoint
  // here keeps the people row in a workable state at write-time using
  // the From-header / regex bootstrap; reconstruct.ts upgrades to the
  // forensic record asynchronously after enqueue.
  const extractedIdentity: Record<string, unknown> = { ...(baseExtractedIdentity as unknown as Record<string, unknown>) }

  // Step 1a.55: Scheduling-tool detection already ran at 1a.0 to bypass
  // the universal-ignore short-circuit. Reuse the same result here so
  // we don't double-parse the body.
  let schedulingEvent: SchedulingEvent | null = schedulingPreCheck

  // Step 1a.7: Forwarded-email detection. When a coordinator forwards a
  // client email from another inbox into the Bloom-connected address, the
  // From header is the coordinator's own address — which is in ownEmails.
  // Without this step the self-loop guard below would classify it as an
  // outbound and the entire inquiry would silently vanish (no draft, no
  // escalation, no interaction row). This check runs BEFORE 1b so that a
  // confirmed forwarded email is exempted from the self-loop test entirely
  // and routed into the normal inbound/inquiry brain path instead.
  //
  // Detection criteria (any one match is sufficient):
  //   1. Subject line begins with "Fwd:" or "FW:" (case-insensitive)
  //   2. Body contains the Gmail forwarding chrome:
  //      "---------- Forwarded message ----------"
  //   3. Body contains the Apple Mail / Outlook forwarding chrome:
  //      "Begin forwarded message:"
  //
  // When detected we also try to extract the original sender from the
  // forwarding headers embedded in the body (the "From: Name <email>"
  // line that appears after the chrome marker).
  const isForwardedEmail = (() => {
    const subjectLower = email.subject.toLowerCase().trim()
    if (subjectLower.startsWith('fwd:') || subjectLower.startsWith('fw:')) return true
    if (email.body.includes('---------- Forwarded message ----------')) return true
    if (email.body.includes('Begin forwarded message:')) return true
    return false
  })()

  // Extract the original sender from the forwarded body headers when
  // present. The forwarding chrome embeds a "From: Name <email>" line
  // immediately after the chrome marker. We look for that pattern in the
  // portion of the body that appears after the chrome marker (or across
  // the whole body for FW: subject-only forwards where the full original
  // headers may be at the top).
  let forwardedOriginalSender: string | null = null
  if (isForwardedEmail) {
    // Locate the chrome marker and scan from there; fall back to full body.
    const chromeMarkerGmail = '---------- Forwarded message ----------'
    const chromeMarkerApple = 'Begin forwarded message:'
    const gmailIdx = email.body.indexOf(chromeMarkerGmail)
    const appleIdx = email.body.indexOf(chromeMarkerApple)
    const scanFrom = gmailIdx !== -1
      ? gmailIdx + chromeMarkerGmail.length
      : appleIdx !== -1
        ? appleIdx + chromeMarkerApple.length
        : 0
    const bodySlice = email.body.slice(scanFrom)
    // Match "From: Display Name <email@example.com>" or "From: email@example.com"
    const fromLineMatch = bodySlice.match(/^From:\s*.+?<([^>]+)>/im)
      ?? bodySlice.match(/^From:\s*([\w.+%-]+@[\w.-]+\.[a-z]{2,})/im)
    if (fromLineMatch) {
      forwardedOriginalSender = fromLineMatch[1].trim().toLowerCase()
    }

    log.info('pipeline.forwarded_email_detected', {
      event_type: 'forwarded_email_detected',
      outcome: 'ok',
      data: {
        rawFrom: rawFromEmail,
        originalSender: forwardedOriginalSender,
        subject: email.subject,
      },
    })
  }

  // Identity priority:
  //   1. Form-relay parser's extracted lead email (Knot, WW, Zola,
  //      calculator) — most reliable when the parser fires
  //   2. Scheduling-event's invitee email (Calendly + friends)
  //   2.5 Forwarded-email original sender extracted from forwarding
  //      chrome headers (Step 1a.7). More reliable than the body
  //      extractor because it reads the explicit "From:" line in the
  //      forwarding block rather than scanning free text.
  //   3. Universal body-extracted primary email — used when the From
  //      header is a venue-own alias (the calculator orphan pattern)
  //      or a known shared relay; otherwise the From is the prospect
  //   4. Raw From header — default fallback
  const extractedPrimaryEmail = typeof extractedIdentity.primary_email === 'string'
    ? extractedIdentity.primary_email
    : null
  const useExtractedFallback =
    extractedPrimaryEmail !== null &&
    (ownEmails.has(rawFromEmail) || /^messages@(weddingwire|theknotww)\.com$/i.test(rawFromEmail))
  const fromEmail =
    formLead?.leadEmail ??
    schedulingEvent?.inviteeEmail ??
    forwardedOriginalSender ??
    (useExtractedFallback ? extractedPrimaryEmail! : rawFromEmail)
  // When a form relay, scheduling tool, or forwarded email fires, the
  // raw From display name is the platform / venue / coordinator name,
  // not the prospect. Falling back to that would stamp the wrong name
  // onto the new lead. Use the parsed name or nothing.
  const fromName = formLead?.leadName ?? schedulingEvent?.inviteeName ?? (formLead || schedulingEvent || isForwardedEmail ? null : rawFromName)

  // 2026-05-12 — Zack Hunter / WW trace:
  // For form-relay leads the `leadEmail` is the identity key (may be a
  // synthetic .invalid placeholder when the platform exposed neither a
  // personal email nor a per-prospect relay — WW's shared-relay path).
  // The ROUTABLE reply target is the platform relay itself
  // (`messages@weddingwire.com`, `*@member.theknot.com`) carried on
  // `formLead.replyToEmail`. Without this, drafts get stamped with the
  // .invalid placeholder and rot in pending forever (autonomous sender
  // refuses .invalid; humans see "Replying to authsolic-…invalid" in the
  // inbox). Threading still works because Gmail uses In-Reply-To headers
  // off the original message id.
  const replyTargetEmail =
    formLead?.replyToEmail ??
    schedulingEvent?.inviteeEmail ??
    forwardedOriginalSender ??
    fromEmail

  // Step 1a.6: Content-based auto-ignore and machine-mail detection.
  // Runs only when no form-relay or scheduling-event fired — these
  // legitimately contain "view in browser" / List-Unsubscribe headers
  // and we still want them to flow through.
  //
  //   - shouldAutoIgnore: subject/body patterns for out-of-office,
  //     "do not reply", automated responses, unsubscribe-flavoured
  //     newsletters.
  //   - isMachineGenerated: RFC-2822 header check for List-Unsubscribe,
  //     List-Id, Precedence: bulk/list/junk, Auto-Submitted. Calendly
  //     would otherwise be caught here — but we've identified the
  //     specific event type, so let it through.
  const bypassNoiseGuards = Boolean(formLead || schedulingEvent)
  if (!bypassNoiseGuards && shouldAutoIgnore(email.subject, email.body)) {
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }
  if (!bypassNoiseGuards) {
    const machineReason = isMachineGenerated(email.headers)
    if (machineReason) {
      return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
    }
  }

  // Step 1b: Self-loop protection — when the email is OUR OWN outbound
  // returned by Gmail alongside inbound in the same thread. Two-signal
  // detection (2026-04-30): the Gmail SENT label is authoritative — any
  // message tagged SENT was sent by this Gmail account, regardless of
  // from-address aliasing. Falls back to from-email matching against the
  // venue's known own addresses. Earlier code only checked the latter,
  // which silently broke when Sage sent from an address that wasn't yet
  // registered (Rixey Apr 2026: 5 of Ryan Schubert's 6 interactions
  // landed as direction='inbound' from twisters42@gmail.com — they were
  // actually Sage's outbounds, slipped through the guard, then signal-
  // inference fired tour_requested events on Sage's own marketing copy).
  // Skipped for form-relay matches — those intentionally have a venue-
  // owned From. Also skipped for forwarded emails (Step 1a.7) — those
  // have a venue-owned From by construction but carry a real client
  // inquiry that Sage must process as inbound.
  const isOwnOutbound = !formLead && !isForwardedEmail && (
    ownEmails.has(rawFromEmail)
    || (email.labels ?? []).some((l) => l.toUpperCase() === 'SENT')
  )
  if (isOwnOutbound) {
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
    // correlation_id (T5-eta.3): stamp the self-loop outbound row too
    // so the forensic chain spans the entire processIncomingEmail run.
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
      correlation_id: correlationId,
      // T5-Rixey-BBB: outbound venue-side emails are not lead signals.
      // signal-class-justified: outbound venue-side replies are not lead signals
      signal_class: 'unclassified',
    }
    if (email.connectionId) outboundPayload.gmail_connection_id = email.connectionId
    const { data: outboundRow } = await supabase
      .from('interactions')
      .insert(outboundPayload)
      .select('id')
      .single()

    // M6 flip (PHASE-1-BATCH-1.md §3.4, 2026-05-22): the cascade write
    // for the self-loop outbound interaction. This `isOwnOutbound` branch
    // `return`s here — it never reaches the inbound `linkSignal` call at
    // the end of `processIncomingEmail` — so the cascade equivalent must
    // be added inline. Dual-write: the legacy `interactions.insert` above
    // STAYS; this routes the same event through the Forwards Linker so
    // `couples`/`touchpoints` get the equivalent write in lockstep.
    //
    // `action_type:'venue_sent'` + `signal_tier:'medium'` — matches the
    // batch Gmail adapter (`identity/sources/gmail.ts`): outbound
    // venue-sent mail is NOT couple progression (doctrine §3), so the
    // Tracer's progression-event writer (which keys on `action_type`)
    // correctly skips it. Using the SAME `external_id` (email.messageId)
    // as the batch adapter also keeps the touchpoint rerun-safe — a later
    // batch sweep of the same Gmail id dedups against this live write.
    if (outboundRow?.id) {
      try {
        const { linkSignal } = await import('@/lib/services/identity/forwards-linker')
        const { emailToNormalizedSignal } = await import(
          '@/lib/services/identity/email-to-signal'
        )
        const linkResult = await linkSignal({
          supabase,
          venueId,
          signal: emailToNormalizedSignal({
            email,
            interactionId: outboundRow.id as string,
            emailDate,
            rawFromName,
            rawFromEmail,
            actionType: 'venue_sent',
            signalTier: 'medium',
          }),
          correlationId,
          source: 'live:email_outbound',
        })
        console.log(
          `[pipeline] cascade_link (self-loop outbound): action=${linkResult.action} ` +
            `couple=${linkResult.matched_couple_id ?? 'none'} ` +
            `touchpoint=${linkResult.touchpoint_id ?? 'none'}`,
        )
      } catch (err) {
        // Load-bearing dual-write, same contract as the inbound linkSignal
        // call: surface the failure to error_logs but never throw out of
        // the pipeline — the legacy interactions row stays source of truth.
        await logPipelineError(venueId, 'cascade_link', err, {
          interactionId: outboundRow.id,
        }, correlationId)
      }
    }
    // Recompute the thread's lifecycle folder so a venue-side outbound
    // captured via self-loop promotes the thread out of 'new_inquiry'
    // (any outbound makes the thread no longer a virgin first-touch).
    // Best-effort — the inbox folder must never block ingestion.
    try {
      await updateThreadLifecycleFolder({
        supabase,
        venueId,
        threadId: email.threadId ?? null,
      })
    } catch { /* swallow — non-fatal for ingest */ }
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
    void logFilterMatch(venueId, filterHit, fromEmail)
    return { interactionId: null, draftId: null, classification: 'ignore', autoSent: false }
  }
  if (filterHit?.action === 'no_draft' && !formLead) {
    // Log the no_draft hit too. The interaction WILL persist (intel
    // layer still sees it), but having a dedicated decision row lets
    // the audit show per-rule counts that match what the operator
    // configured, independent of pipeline-side schema drift.
    void logFilterMatch(venueId, filterHit, fromEmail)
  }
  if (earlyFilterHit?.action === 'no_draft' && !formLead) {
    void logFilterMatch(venueId, earlyFilterHit, rawFromEmail)
  }
  // Stream EEEE: human-escalation request. Detected on the raw subject
  // before any LLM work. When set, the pipeline will:
  //   1. Persist the interaction (the thread view stays complete)
  //   2. Skip draft generation entirely (no LLM tokens burned)
  //   3. Insert an engagement_events row of type 'human_requested'
  //   4. Fire an admin_notifications row so the coordinator sees it
  //      on their dashboard in real time
  // The detection runs AT THE SUBJECT level — couples explicitly opt
  // OUT of Sage by following the footer instructions, and we honour
  // that request loudly.
  // Migration 300 (2026-05-11): the visible footer no longer asks
  // couples to type magic words. Detection now runs in two stages:
  //   (a) Fast regex on subject (legacy magic-words form). Free, sync.
  //   (b) Haiku classifier on subject + body. ~$0.0002 per inbound,
  //       fire-and-forget. Covers natural-language requests like
  //       "can I talk to someone real?", "is this a bot?", "stop the AI".
  // Stage (b) runs lazily — only when stage (a) misses, so existing
  // explicit requests still short-circuit without LLM cost.
  const humanRequestedFastPath = detectHumanRequested(email.subject)
  let escalationRequested = humanRequestedFastPath
  let escalationReason: 'magic_words' | 'haiku_detected' | null = humanRequestedFastPath
    ? 'magic_words'
    : null
  if (!humanRequestedFastPath) {
    try {
      const { classifyEscalation } = await import('./escalation-classifier')
      const result = await classifyEscalation({
        venueId,
        aiName: 'Sage',
        subject: email.subject,
        body: email.body,
        correlationId,
      })
      escalationRequested = result.escalation_requested
      escalationReason = result.reason
    } catch (err) {
      console.warn('[pipeline] escalation classifier failed (non-fatal):', err)
    }
  }
  // Back-compat: keep the old name in scope so downstream branches that
  // referenced it don't all need to change.
  const humanRequested = escalationRequested

  // Either filter can trigger no_draft; skipDraft is the union. The
  // onboarding backfill path sets opts.skipDraft so 90-day historical
  // imports classify + score + persist without drafting a reply to
  // every old email. Scheduling-tool emails (Calendly etc.) always
  // skip draft — we never want Sage to reply to a Calendly confirmation.
  // escalationRequested also forces skipDraft — a couple who asked for
  // a real person doesn't get an autonomous reply anyway.
  //
  // Mig 303 (2026-05-11): the per-couple `weddings.ai_opted_out` flag
  // and the per-thread "operator-handling-thread" gate live in the
  // helper at draft-skip-gates.ts and are checked AFTER the interaction
  // insert (we need weddingId to be resolved first). The skipDraft
  // computation below covers the per-email reasons; gate results are
  // applied later in the flow as `gateSkipDraft`.
  // 2026-05-13: formLead-detected emails bypass the venue_email_filters
  // no_draft action. Calculator submissions arrive from the venue's own
  // domain (calculator notifications) and would otherwise be vetoed by
  // the auto-learned `rixeymanor.com -> no_draft` filter that's correct
  // for transactional venue mail (contract receipts, internal forwards)
  // but wrong for new-lead notifications. detectFormRelay already
  // confirmed this is a real intake — let the filter veto only the
  // ones the system has no other evidence for. schedulingEvent +
  // humanRequested + opts.skipDraft still hard-skip (those are
  // structural, not policy).
  // RM-Lyndsey-Rivera bug 2026-05-13: calculator-only inquiry had zero
  // drafts because both calculator emails (from rixeymanor.com) hit the
  // auto-learned filter. Bug class: a "real lead" signal arriving via
  // venue-own-domain envelope.
  const skipDraft =
    opts?.skipDraft === true ||
    (!formLead && filterHit?.action === 'no_draft') ||
    (!formLead && earlyFilterHit?.action === 'no_draft') ||
    Boolean(schedulingEvent) ||
    humanRequested

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
  //
  // Stream EEEE: humanRequested ALSO skips the classifier. The couple
  // explicitly opted out of Sage by following the footer instructions;
  // we owe them zero AI cost on this thread, including the router-brain
  // tokens. The synthesised classification keeps the rest of the
  // pipeline's contract intact (heat-mapping skips it because skipDraft
  // is true, but a deterministic value beats an LLM call we don't need).
  let classification: ClassificationResult
  // Holds the full IntentVerdict from classifyInboundRaw when the
  // pipeline takes the unified-classifier path. Used after the
  // interactions insert to stamp intent_class / extracted_facts /
  // referenced_couple_name + fire heat-suppression + family-member-
  // proxy resolver — replaces the old fire-and-forget
  // classifyInboundIntent call. Null on the synth + humanRequested
  // paths (no LLM ran, nothing to stamp).
  let unifiedVerdict: IntentVerdict | null = null
  if (humanRequested) {
    classification = {
      classification: 'inquiry_reply',
      confidence: 100,
      extractedData: {
        urgencyLevel: 'high',
        sentiment: 'neutral',
        questions: [],
        source: 'direct',
      },
    }
  } else if (formLead) {
    classification = synthClassificationFromFormLead(formLead)
    // 2026-05-27 — also synthesize the IntentVerdict so the row gets
    // intent_class='new_inquiry' stamped + the folder writer routes to
    // New Inquiries instead of falling through to the advertiser-domain
    // fallback (which was sending Knot/WW/Zola/HoneyBook leads to
    // Advertisers/Vendors). Before this line, formLead branch left
    // unifiedVerdict null → intentClassOverride was null → folder writer
    // hit `isAdvertiserDomain(senderDomain)` → wrong bucket.
    let guestCount: number | undefined
    if (formLead.guestCount) {
      const m = formLead.guestCount.match(/\d+/)
      if (m) guestCount = parseInt(m[0], 10)
    }
    unifiedVerdict = synthVerdictForFormLead({
      senderName: formLead.leadName ?? null,
      partnerName: formLead.partnerName ?? null,
      eventDate: formLead.eventDate ?? null,
      guestCount: guestCount ?? null,
      source: normalizeSource(formLead.source) ?? null,
      questions: extractQuestionsFromNote(formLead.note),
    })
  } else {
    // 2026-05-12 — unified classifier path. classifyInboundRaw returns the
    // full IntentVerdict (intent_class, extracted_facts, signals,
    // confidence) in ONE Haiku call. The legacy classifyEmail was a
    // second round trip emitting overlapping fields; we now derive the
    // 7-class email_classification deterministically from intent_class
    // and read the signals payload for the rest of ClassificationResult.
    // After the interaction row is inserted, stampInboundVerdict
    // persists the verdict + fires side effects (heat suppression,
    // referenced-couple resolver). This removes the previous fire-and-
    // forget classifyInboundIntent at the end of the pipeline — the
    // stamp happens inline now.
    try {
      const verdict = await classifyInboundRaw({
        body: email.body,
        subject: email.subject,
        venueId,
        channel: 'email',
        fromEmail,
        priorInteractionCount,
        threadHasPriorOutbound,
        correlationId,
      })
      unifiedVerdict = verdict
      classification = {
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
    } catch (err) {
      await logPipelineError(venueId, 'classify', err, {
        messageId: email.messageId,
        threadId: email.threadId,
        fromEmail,
        subject: email.subject?.slice(0, 200),
      }, correlationId)
      return { interactionId: null, draftId: null, classification: 'error', autoSent: false }
    }
  }

  // Step 2.5 — Calendly custom-questions source enrichment (2026-05-27).
  // When a Calendly notification carries a canonical source answer in its
  // Questions block ("Where did you first hear about us? → Google"), that
  // signal is STRONGER than whatever the LLM inferred from the body shape
  // (the LLM tends to attribute these to source='calendly' or null because
  // the body looks like a system notification, not a couple-typed inquiry).
  // We patch the unified verdict's signals.source + extracted_facts.
  // source_mentioned so when stampInboundVerdict runs after the row insert,
  // the canonical source lands on interactions.extracted_facts and the
  // downstream attribution surfaces (touchpoints, source_attribution
  // rollups, /intel/sources) see the Knot/Google/etc. instead of treating
  // every Calendly-direct couple as direct/unknown.
  //
  // Strict additive — only patches when the parser extracted a canonical
  // source AND the verdict didn't already carry one. Never overwrites.
  if (
    schedulingEvent?.source === 'calendly' &&
    schedulingEvent.extras?.sourceCanonical &&
    unifiedVerdict
  ) {
    const canonical = schedulingEvent.extras.sourceCanonical
    const literal = schedulingEvent.extras.source ?? canonical
    // Patch signals.source
    if (!unifiedVerdict.signals.source || unifiedVerdict.signals.source === 'calendly') {
      unifiedVerdict = {
        ...unifiedVerdict,
        signals: { ...unifiedVerdict.signals, source: canonical },
      }
    }
    // Patch extracted_facts.source_mentioned (literal answer)
    if (unifiedVerdict.extracted_facts) {
      if (!unifiedVerdict.extracted_facts.source_mentioned) {
        unifiedVerdict = {
          ...unifiedVerdict,
          extracted_facts: {
            ...unifiedVerdict.extracted_facts,
            source_mentioned: literal,
          },
        }
      }
    } else {
      // Synthesize a minimal extracted_facts payload so the source
      // attribution gets persisted even when the LLM returned null facts.
      unifiedVerdict = {
        ...unifiedVerdict,
        extracted_facts: {
          names: [],
          wedding_date: null,
          guest_count: null,
          phone: null,
          email: null,
          source_mentioned: literal,
          budget_signal: null,
        },
      }
    }
    // Also propagate to classification.extractedData.source so synchronous
    // consumers (heat scoring, draft routing) read the canonical key.
    if (classification.extractedData) {
      if (
        !classification.extractedData.source ||
        classification.extractedData.source === 'calendly'
      ) {
        classification = {
          ...classification,
          extractedData: { ...classification.extractedData, source: canonical },
        }
      }
    }
  }

  // Step 3: Find or create contact (skip for spam/ignore)
  let personId: string | null = null
  let weddingId: string | null = null
  let isNewContact = false

  if (classification.classification !== 'spam') {
    try {
      // Pass scheduling-event extras so the person row is born with phone
      // attached. Future identity resolution can then match this couple by
      // phone when they appear from a different email address (e.g. Knot
      // relay vs Calendly invitee email).
      const extras = schedulingEvent?.extras?.phone ? { phone: schedulingEvent.extras.phone } : undefined
      const contact = await findOrCreateContact(venueId, fromEmail, fromName, ownEmails, extras)
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
      }, correlationId)
    }
  }

  // Step 4: Create interaction record. Always store the raw from_email /
  // from_name so the inbox can render a sender even when person_id is null
  // (per migration 063 — don't rely on the people join alone).
  // correlation_id (T5-eta.3): stamp the inbound interaction with the
  // request-scoped correlation id so coordinators can chase the full
  // forensic chain (api_costs / drafts / engagement_events / interactions
  // / notifications / intelligence_insights) from one id.
  // T5-Rixey-BBB: classify the inbound email by from-domain so the
  // cluster-compute service can find source-class signals without a
  // post-hoc scan. Mirrors the spike classifier
  // (scripts/rixey-load/50-bbb-spike.ts) and the canonical map in
  // lead-source-derivation.ts. CRM relays (HoneyBook / Dubsado) get
  // 'crm'; scheduling-tool relays (Calendly / Acuity) get 'touchpoint';
  // platform listing relays (The Knot / WeddingWire / Zola / HCTG /
  // Wedsites) get 'source'. Anything else (consumer mail, unknown
  // domains) lands 'unclassified' — a body-extracted hear_source or
  // UTM in extracted_identity is also enough to credit 'source'.
  const fromDomainForClass = fromEmail.includes('@')
    ? fromEmail.split('@').pop()!.toLowerCase()
    : ''
  const inboundSignalClass: 'source' | 'touchpoint' | 'crm' | 'unclassified' = (() => {
    if (!fromDomainForClass) return 'unclassified'
    if (fromDomainForClass === 'honeybook.com' || fromDomainForClass.endsWith('.honeybook.com')
      || fromDomainForClass === 'dubsado.com' || fromDomainForClass.endsWith('.dubsado.com')) return 'crm'
    if (fromDomainForClass === 'calendly.com' || fromDomainForClass.endsWith('.calendly.com')
      || fromDomainForClass === 'acuityscheduling.com' || fromDomainForClass.endsWith('.acuityscheduling.com')) return 'touchpoint'
    if (fromDomainForClass === 'theknot.com' || fromDomainForClass.endsWith('.theknot.com')
      || fromDomainForClass === 'weddingwire.com' || fromDomainForClass.endsWith('.weddingwire.com')
      || fromDomainForClass === 'authsolic.com'
      || fromDomainForClass === 'zola.com' || fromDomainForClass.endsWith('.zola.com')
      || fromDomainForClass === 'herecomestheguide.com'
      || fromDomainForClass === 'wedsites.com') return 'source'
    if (extractedIdentity && typeof extractedIdentity === 'object'
      && (('hear_source' in extractedIdentity) || ('utm_source' in extractedIdentity))) return 'source'
    return 'unclassified'
  })()

  // Wave 9 root-cause guard (2026-05-10): before writing direction='inbound',
  // double-check that the FINAL persisted from_email isn't one of the venue's
  // own sending addresses. The Step 1b self-loop guard above only inspects
  // rawFromEmail; if a downstream rewrite (extractedPrimaryEmail fallback,
  // forwarded original sender, etc.) leaves fromEmail as a venue-own
  // address, the original guard misses it and we write a misclassified
  // inbound. The data-integrity invariant direction_from_venue_own catches
  // these post-hoc; this guard prevents new writes from accumulating.
  // Anchor: bloom-data-integrity-sweep.md (the original Apr-30 sweep had
  // 48 of these on Rixey; Wave 9 closes the residual hole at the write
  // site so the remediation surface in src/lib/services/data-integrity/
  // remediation/direction-from-venue-own.ts only ever has to clean up
  // pre-existing rows, never new ones).
  const wave9InboundFromOwn = ownEmails.has((fromEmail ?? '').toLowerCase().trim())
  if (wave9InboundFromOwn) {
    log.warn('pipeline.wave9_inbound_from_own', {
      event_type: 'email_pipeline.direction_correction',
      outcome: 'ok',
      data: {
        messageId: email.messageId,
        threadId: email.threadId,
        fromEmail,
        rawFromEmail,
        reason: 'final_fromEmail_in_ownEmails',
        action: 'flipped_to_outbound',
      },
    })
  }
  const interactionPayload: Record<string, unknown> = {
    venue_id: venueId,
    wedding_id: weddingId,
    person_id: personId,
    type: 'email',
    direction: wave9InboundFromOwn ? 'outbound' : 'inbound',
    subject: email.subject,
    body_preview: email.body.slice(0, 300),
    full_body: email.body,
    from_email: fromEmail,
    from_name: fromName,
    gmail_message_id: email.messageId,
    gmail_thread_id: email.threadId,
    timestamp: email.date,
    correlation_id: correlationId,
    // Universal body-identity payload — populated on every email
    // regardless of parser match. Coordinator UIs and retroactive
    // linkage scripts read interactions.extracted_identity rather
    // than re-parsing.
    extracted_identity: extractedIdentity,
    // T5-Rixey-BBB: see inboundSignalClass derivation above. When the
    // Wave 9 guard flips direction to outbound, the signal_class for
    // signal-inference purposes is no longer meaningful (we're not a
    // lead signal); pin to 'unclassified' to match the Step 1b
    // self-loop outbound payload.
    signal_class: wave9InboundFromOwn ? 'unclassified' : inboundSignalClass,
    // Wave 27 (mig 293): author_class. Outbound from venue-own = 'operator'
    // by default (sage if auto_sent — the draft writer flips this).
    // Inbound starts 'unknown'; the Haiku classifier in
    // src/lib/services/email/author-classifier.ts runs post-insert and
    // updates the row. Backfill cron handles legacy rows.
    author_class: wave9InboundFromOwn ? 'operator' : 'unknown',
    // Wave 28 (mig 294): surface. Default 'inbox' for couple conversations.
    // Pipeline rules below the insert route system_notification by from-
    // domain (Calendly/HoneyBook/no-reply senders). CRM adapters set
    // 'crm_attribution' on synthetic rows.
    surface: 'inbox',
    // Migration 300 (2026-05-11): persist escalation state on the row so
    // every downstream consumer (knowledge-gap detector, heat scoring,
    // classifier health %) can filter uniformly without re-running
    // detection. escalation_reason is 'magic_words' for fast-path regex
    // hits, 'haiku_detected' for the Haiku judgment path.
    escalation_requested: escalationRequested,
    escalation_reason: escalationRequested ? escalationReason : null,
    escalation_decided_at: escalationRequested ? new Date().toISOString() : null,
  }
  if (email.connectionId) {
    interactionPayload.gmail_connection_id = email.connectionId
  }
  // Preserve the RFC-2822 headers captured at fetch time. They were
  // read once during classification and then discarded; storing the
  // full set keeps cc / bcc / reply-to / List-Unsubscribe / DKIM
  // recoverable for audit + future retroactive classification
  // (migration 354). Same raw-preservation principle as raw_import_row.
  if (email.headers && Object.keys(email.headers).length > 0) {
    interactionPayload.rfc2822_headers = email.headers
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
    }, correlationId)
    return { interactionId: null, draftId: null, classification: classification.classification, autoSent: false }
  }

  const interactionId = interaction.id as string

  // Wave 27 (mig 293): post-write author-class upgrade. Inbound rows
  // landed at author_class='unknown' (outbound is synchronously set in
  // the payload above). The Haiku classifier promotes to one of
  // couple/operator/sage/platform_system/vendor so downstream metrics
  // (knowledge-gap detect, classifier health %, heat scoring, draft
  // training) can separate real human signals from Calendly/HoneyBook
  // notification noise.
  //
  // Fire-and-forget: classifyAuthor never throws and persists its own
  // result. Failure here mustn't block the rest of the pipeline. We
  // skip the outbound path (wave9InboundFromOwn) since those rows are
  // already 'operator' / 'sage' from the synchronous backfill.
  if (!wave9InboundFromOwn) {
    void (async () => {
      try {
        const { classifyAuthor } = await import('@/lib/services/email/author-classifier')
        await classifyAuthor({
          venueId,
          interactionId,
          from_email: fromEmail,
          from_name: fromName,
          subject: email.subject,
          body: email.body,
          extracted_identity: extractedIdentity,
          correlationId,
        })
      } catch (authorErr) {
        log.warn('pipeline.author_class_failed', {
          event_type: 'author_class.classify',
          outcome: 'fail',
          data: {
            interactionId,
            error: authorErr instanceof Error ? authorErr.message : String(authorErr),
          },
        })
      }
    })()
  }

  // Wave 28 (mig 294): post-write surface upgrade. The row landed as
  // surface='inbox' (default). For inbound emails from known SaaS-tool
  // senders (Calendly, HoneyBook notifications, no-reply@*, donotreply@*)
  // we promote to 'system_notification' so /agent/inbox doesn't show
  // them as couple-facing conversations. Lead-detail timelines aggregate
  // every surface so the row still shows up where it should.
  //
  // Fire-and-forget: the update is best-effort. A failure here must
  // never block draft generation. Outbound rows (wave9InboundFromOwn)
  // skip the check entirely — they're our own sends.
  if (!wave9InboundFromOwn) {
    const computedSurface = classifySurface({
      fromEmail,
      type: 'email',
      crmSource: null,
      signalClass: inboundSignalClass,
    })
    if (computedSurface !== 'inbox') {
      void (async () => {
        try {
          await supabase
            .from('interactions')
            .update({ surface: computedSurface })
            .eq('id', interactionId)
        } catch (surfaceErr) {
          log.warn('pipeline.surface_upgrade_failed', {
            event_type: 'surface_upgrade',
            outcome: 'fail',
            data: {
              interactionId,
              fromEmail,
              attemptedSurface: computedSurface,
              error: surfaceErr instanceof Error ? surfaceErr.message : String(surfaceErr),
            },
          })
        }
      })()
    }
  }

  // Pattern 5 (mig 315): inbound Haiku dimensions — sentiment / urgency /
  // family_mentioned land on the interactions row so downstream brain
  // prompts read the cached judgment instead of re-inferring from raw
  // body text. Fire-and-forget; the cron drain (inbound_haiku_drain) is
  // the safety net for misses. Outbound rows (wave9InboundFromOwn) skip —
  // the dimensions are about how the couple sounds, not how we sound.
  if (!wave9InboundFromOwn) {
    void (async () => {
      try {
        const mod = await import('@/lib/services/intel/inbound-haiku-classifier')
        await mod.classifyInboundInteraction({
          interactionId,
          body: email.body,
          subject: email.subject,
          venueId,
          supabase,
          correlationId,
        })
      } catch (err) {
        console.warn('[pipeline] haiku-classify non-fatal:', err)
      }
    })()

    // Stamp the unified-classifier verdict onto the row (mig 327 +
    // mig 331). v3 (2026-05-12): the verdict was already computed
    // synchronously by classifyInboundRaw when classification ran;
    // we just persist it here + fire the side effects (heat
    // suppression for non-couple intents, family-member-proxy
    // resolver). When unifiedVerdict is null (synth/humanRequested
    // paths), nothing to stamp. Fire-and-forget; cron drain catches
    // misses for any future pipeline branches that bypass the
    // unified path.
    if (unifiedVerdict) {
      const verdictForStamp = unifiedVerdict
      void (async () => {
        try {
          await stampInboundVerdict(interactionId, verdictForStamp, {
            venueId,
            supabase,
            correlationId,
          })
        } catch (err) {
          console.warn('[pipeline] intent-stamp non-fatal:', err)
        }
      })()
    }
  }

  // Wave 4 Phase 4 (2026-05-10): Wave-3 per-email sender_identity capture
  // retired. The Sonnet judge in identity/reconstruct.ts is the source of
  // truth for canonical names; profile-to-people-sync writes them onto
  // people rows. The chokepoint here keeps the row workable at write-time
  // via Gmail from-name + handle inference; reconstruct.ts upgrades it.

  // Inbox lifecycle folder (migration 242). Decided per-thread, written
  // to every interaction on the thread so the inbox tab counts move
  // atomically when the boundary flips (e.g. couple's first reply
  // promotes the thread from 'new_inquiry' to 'potential_client').
  // Best-effort: failure here mustn't block draft generation. Wrapped
  // in try/catch so a folder mis-classification can't fail the pipeline.
  try {
    await updateThreadLifecycleFolder({
      supabase,
      venueId,
      threadId: email.threadId ?? null,
      interactionId,
      // Doctrine fix (2026-05-12): intent_class from the unified
      // classifier IS the LLM judgment. updateThreadLifecycleFolder
      // reads it + wedding state to deterministically pick the
      // folder — no second Haiku call. Pass the verdict's
      // intent_class directly so the lookup doesn't race the
      // fire-and-forget stampInboundVerdict.
      intentClassOverride: unifiedVerdict?.intent_class ?? null,
      correlationId,
    })
  } catch (folderErr) {
    log.warn('pipeline.lifecycle_folder_failed', {
      event_type: 'lifecycle_folder_update',
      outcome: 'fail',
      data: {
        interactionId,
        threadId: email.threadId,
        error: folderErr instanceof Error ? folderErr.message : String(folderErr),
      },
    })
  }

  // ---------------------------------------------------------------------
  // Lifecycle signal detection (migration 246).
  // ---------------------------------------------------------------------
  //
  // The router brain classifies "what kind of email is this" (new
  // inquiry / reply / vendor / spam). The lifecycle detector is a
  // separate, narrower question: "does this email carry a state-machine
  // signal -- decline, going-with-other, platform close, tour cancelled,
  // tour completed, contract signed, deposit paid?".
  //
  // Splitting the two prompts keeps each one's job sharp. The router
  // already has 7 buckets to balance; adding 7 more lifecycle signals
  // would dilute its accuracy on the bucket it cares most about
  // (new_inquiry vs inquiry_reply, the bug-source of half the
  // misclassifications historically). Detector runs only when there's
  // a wedding link -- a signal without a wedding has nothing to
  // transition.
  //
  // Side effects:
  //   - stamps interactions.lifecycle_signal so the auto-draft gate can
  //     check the most recent inbound on the thread,
  //   - calls applyLifecycleSignal which UPDATEs weddings.status (when
  //     legal) and INSERTs a wedding_lifecycle_events row.
  //
  // Best-effort wrapper: any failure here logs and continues; never
  // blocks the main path.
  let lifecycleSignalDetected: string | null = null
  if (weddingId) {
    try {
      const { data: w } = await supabase
        .from('weddings')
        .select('status')
        .eq('id', weddingId)
        .maybeSingle()
      const currentStatus = ((w?.status as string | undefined) ?? null) as LifecycleWeddingStatus | null

      const detected = await detectLifecycleSignal(
        venueId,
        {
          from: fromEmail,
          subject: email.subject,
          body: email.body,
          direction: 'inbound',
        },
        {
          currentStatus,
          threadInboundCount: priorInteractionCount,
        },
        { correlationId },
      )

      if (detected.signal) {
        lifecycleSignalDetected = detected.signal
        // Persist the per-message signal so the auto-draft gate (and
        // any future surface) can reason about it without re-running
        // the AI call. Best-effort.
        try {
          await supabase
            .from('interactions')
            .update({ lifecycle_signal: detected.signal })
            .eq('id', interactionId)
        } catch (sigErr) {
          log.warn('pipeline.lifecycle_signal_stamp_failed', {
            event_type: 'lifecycle_signal_stamp',
            outcome: 'fail',
            data: {
              interactionId,
              error: sigErr instanceof Error ? sigErr.message : String(sigErr),
            },
          })
        }

        // Apply the engine. Returns { applied, from, to, violation }.
        // We don't fail the pipeline on a violation -- the writer
        // already logged it, and a violation is informational
        // (coordinator drift), not fatal.
        await applyLifecycleSignal({
          supabase,
          venueId,
          weddingId,
          signal: detected.signal,
          detectedBy: 'ai',
          sourceInteractionId: interactionId,
          confidence: detected.confidence,
        })
      }
    } catch (lifeErr) {
      log.warn('pipeline.lifecycle_detect_failed', {
        event_type: 'lifecycle_detect',
        outcome: 'fail',
        data: {
          interactionId,
          weddingId,
          error: lifeErr instanceof Error ? lifeErr.message : String(lifeErr),
        },
      })
    }
  }

  // Resolve the email address of the Gmail connection that received this
  // email. Used to populate receivedAtAddress in the brain prompts so
  // Sage knows which inbox the inquiry landed in (multi-Gmail venues).
  // Best-effort — failure leaves receivedAtAddress undefined, which is
  // safe (the brain falls back to no inbox context).
  let receivedAtAddress: string | undefined
  if (email.connectionId) {
    try {
      const { data: connRow } = await supabase
        .from('gmail_connections')
        .select('email_address')
        .eq('id', email.connectionId)
        .maybeSingle()
      receivedAtAddress = (connRow?.email_address as string) ?? undefined
    } catch {
      // Non-fatal — skip inbox context on failure.
    }
  }

  // Stream EEEE: human-escalation fast-path. The interaction is now
  // persisted (the inbox thread is complete), so we record the
  // forensic trail (engagement_event + admin_notification) and
  // return — skipping intelligence_extractions, signal_inference,
  // booking_signal, heat_signal_record, and draft generation. The
  // coordinator owns the response from here.
  //
  // engagement_events: type 'human_requested', direction 'inbound',
  // metadata carries the interaction reference so the dashboard can
  // jump straight to the email. Best-effort — a notification failure
  // mustn't lose the interaction.
  //
  // admin_notifications: type 'human_requested' so coordinator UIs
  // can filter / pin / colour-code distinctly from the auto-send
  // pending stream. Title surfaces sender + thread; body carries the
  // interaction id + subject excerpt for the click-through.
  if (humanRequested) {
    try {
      // direction='inbound' — couple sent us this email asking for a
      // human. correlation_id stamps the forensic chain.
      if (weddingId) {
        await recordEngagementEventsBatch(
          venueId,
          weddingId,
          [
            {
              eventType: 'human_requested',
              metadata: {
                interaction_id: interactionId,
                subject: email.subject,
                from_email: fromEmail,
                from_name: fromName,
                via: 'subject_marker',
              },
            },
          ],
          'inbound',
          email.date,
          correlationId
        )
      } else {
        // No wedding yet (cold sender): write the engagement_event
        // directly, weddingless, so the trail still exists.
        const ePayload: Record<string, unknown> = {
          venue_id: venueId,
          wedding_id: null,
          event_type: 'human_requested',
          direction: 'inbound',
          points: 0,
          occurred_at: email.date,
          metadata: {
            interaction_id: interactionId,
            subject: email.subject,
            from_email: fromEmail,
            from_name: fromName,
            via: 'subject_marker',
          },
        }
        if (correlationId) ePayload.correlation_id = correlationId
        await supabase.from('engagement_events').insert(ePayload)
      }
    } catch (err) {
      await logPipelineError(venueId, 'human_requested_event', err, {
        interactionId,
        weddingId,
      }, correlationId)
    }

    // M9 flip (PHASE-1-BATCH-1.md §3 item 6, 2026-05-22; doctrine fix
    // 2026-05-23 — see "Pressure-test findings" in PHASE-1-BATCH-1.md):
    // the cascade write for the human-escalation email. This
    // `humanRequested` block `return`s at the end (below) BEFORE the
    // inbound `linkSignal` call at the end of `processIncomingEmail` —
    // so a human-request email (BOTH the `weddingId`-set arm and the
    // weddingless cold-sender arm above) never reached the Forwards
    // Linker and produced no spine touchpoint. The cascade equivalent
    // is therefore added inline here, positioned AFTER the
    // engagement-event write and BEFORE the `return`, so it runs for
    // both arms of the `if (weddingId)` block.
    //
    // Dual-write: the legacy `engagement_events` write above STAYS
    // untouched (it is a heat-table write the cascade has no
    // relationship to — NOT an M-site). This routes the SAME inbound
    // email through `linkSignal` so `couples`/`touchpoints` get the
    // equivalent write in lockstep.
    //
    // `action_type:'human_requested'` — a human-escalation email is an
    // inbound, couple-driven signal AND the truth of what the couple
    // did. `signal_tier` keeps the adapter's 'high' default (inbound
    // email carries full identity — email + often a signed name/phone;
    // M6/M7's 'medium' was for venue-SENT mail and is wrong here).
    //
    // Pre-fix this site passed `action_type:'reply'` and stashed the
    // escalation in `raw_payload.escalation` because progression.ts's
    // `progressionEventTypeFor` only mapped `'reply'`/`'inquiry'`/
    // `'inbound_followup'` for gmail — a bare `'human_requested'` would
    // return null and silently drop the progression record. The
    // pressure-test flagged this as a quiet downgrade: a touchpoint
    // reader sees `action_type:'reply'` for a human-escalation and has
    // to grep payload to recover the truth. Migration 368 + the
    // progression.ts mapping fix (gmail/`human_requested` →
    // `'inbound_human_request'`) close the loop: the honest action_type
    // can now flow end-to-end AND produce a progression row.
    //
    // DEPLOY ORDER caveat: this code requires migration 368 to be
    // applied first. Without 368, a `'inbound_human_request'`
    // event_type insert into `couple_progression_events` fails the
    // CHECK constraint (PG error 23514). `recordProgressionIfEligible`
    // (progression.ts:124-130) catches the insert error and returns
    // `{recorded: false}` silently — so a misordered deploy degrades
    // to "no progression row, no clock bump" rather than a pipeline
    // crash. The touchpoint write itself still succeeds. The legacy
    // `engagement_events` dual-write above is unaffected. But the
    // intent is for migration 368 to land first so progression rows
    // DO get written for human-escalations.
    //
    // The `raw_payload.escalation:'human_requested'` workaround is
    // RETIRED — action_type now carries the truth.
    //
    // Using the same `external_id` (email.messageId, via the adapter)
    // as the batch Gmail adapter keeps the touchpoint rerun-safe — a
    // later Tracer sweep of the same Gmail id dedups against this
    // live write.
    //
    // Both arms covered: for a wedding-bound email `weddingId` is passed
    // as the matcher's `legacy_wedding_id` anchor — the cascade couple
    // already exists and `linkSignal` attaches via the legacy-wedding
    // fast path (idempotent). For the weddingless cold-sender arm
    // `weddingId` is null and the linker resolves identity / routes to a
    // fragment itself — the correct cascade outcome for a cold signal.
    if (interactionId) {
      try {
        const { linkSignal } = await import('@/lib/services/identity/forwards-linker')
        const { emailToNormalizedSignal } = await import(
          '@/lib/services/identity/email-to-signal'
        )
        // 2026-05-26 — relay-resolved identity override (operator-impact
        // fix). When the human-escalation email arrived via a form relay
        // (calculator/Knot/WW/Zola) or a Calendly-via-Gmail forward,
        // raw From is the venue's own address — feeding that into the
        // matcher is the Glascow Tennille bug. Prefer formLead /
        // schedulingEvent identity when present; channelOverride routes
        // the touchpoint to the canonical relay channel. Genuine inbound
        // (no relay) leaves resolvedEmail/Name null and keeps legacy
        // raw-From behaviour byte-identical.
        const signal = emailToNormalizedSignal({
          email,
          interactionId,
          emailDate,
          rawFromName,
          rawFromEmail,
          weddingId,
          actionType: 'human_requested',
          // formLead wins over schedulingEvent (matches the identity-
          // priority order at pipeline.ts:1277-1281 for fromEmail).
          resolvedEmail: formLead?.leadEmail ?? schedulingEvent?.inviteeEmail ?? null,
          resolvedName: formLead?.leadName ?? schedulingEvent?.inviteeName ?? null,
          resolvedPhone: schedulingEvent?.extras?.phone ?? null,
          // Channel override: if a relay fired, tag the cascade
          // touchpoint with that channel. The action_type stays
          // 'human_requested' (the escalation truth) — the channel
          // describes *where* the escalation came in. For scheduling-
          // tool forwards we pass the source through directly (the
          // SchedulingToolSource values 'calendly' | 'acuity' |
          // 'honeybook' | 'dubsado' are valid channel taxonomy keys —
          // 'calendly' + 'honeybook' both used by batch adapters in
          // identity/sources/).
          channelOverride: formLead
            ? formLeadSourceToChannel(formLead.source)
            : schedulingEvent
              ? schedulingEvent.source
              : undefined,
        })
        const linkResult = await linkSignal({
          supabase,
          venueId,
          signal,
          correlationId,
          source: 'live:email_human_requested',
        })
        console.log(
          `[pipeline] cascade_link (human_requested): action=${linkResult.action} ` +
            `couple=${linkResult.matched_couple_id ?? 'none'} ` +
            `touchpoint=${linkResult.touchpoint_id ?? 'none'}`,
        )
      } catch (err) {
        // Load-bearing dual-write, same contract as the M1/M6/M7
        // linkSignal calls: surface the failure to error_logs but never
        // throw out of the pipeline — the legacy engagement_events /
        // interactions rows stay source of truth during dual-write.
        await logPipelineError(venueId, 'cascade_link', err, {
          interactionId,
          weddingId,
        }, correlationId)
      }
    }

    try {
      await createNotification({
        venueId,
        weddingId: weddingId ?? undefined,
        type: 'human_requested',
        title: `Human requested: ${fromName || fromEmail}`,
        body: JSON.stringify({
          interactionId,
          weddingId,
          fromEmail,
          fromName,
          threadId: email.threadId,
          subject: email.subject,
          excerpt: email.body.slice(0, 240),
        }),
        correlationId,
      })
    } catch (err) {
      await logPipelineError(venueId, 'human_requested_notification', err, {
        interactionId,
      }, correlationId)
    }

    log.info('pipeline.human_requested', {
      event_type: 'email_pipeline.human_requested',
      outcome: 'skip',
      data: { messageId: email.messageId, interactionId, reason: 'human_requested' },
    })

    return {
      interactionId,
      draftId: null,
      classification: classification.classification,
      autoSent: false,
    }
  }

  // Step 5a: Spam early-return. Per Playbook 10.2 step 6, spam falls
  // out of the pipeline before any intelligence work runs. The
  // interaction row above is the audit trail; everything below
  // (intelligence_extractions, signal_inference, booking_signal,
  // knowledge_gaps, draft generation, auto-send eligibility) costs
  // tokens or DB work that the spam path does not justify.
  // Pre-fix the spam branch only skipped findOrCreateContact — every
  // other downstream step still ran on spam payloads.
  if (classification.classification === 'spam') {
    return {
      interactionId,
      draftId: null,
      classification: 'spam',
      autoSent: false,
    }
  }

  // Step 5: If new inquiry, create wedding record and engagement event
  const extracted = classification.extractedData
  const detectedSource = normalizeSource(extracted.source ?? 'direct')
  const parsedEventDateObj = parseFuzzyDate(extracted.eventDate)
  const parsedEventDate = parsedEventDateObj?.iso ?? null
  const parsedGuestCount = parseGuestCount(extracted.guestCount)

  // T5-schema-gap (migration 165): land the lead-side estimate in
  // weddings.estimated_guests. Prefer the dedicated `estimatedGuests`
  // field when the classifier returned one; fall back to the legacy
  // guestCount path so emails processed before the prompt bump still
  // populate the column. validateEstimatedGuests gates the result on
  // the column's CHECK constraint (1..1000) so a hallucinated 50000
  // never reaches the DB.
  const parsedEstimatedGuests =
    validateEstimatedGuests(
      (extracted as { estimatedGuests?: unknown }).estimatedGuests
    ) ?? validateEstimatedGuests(extracted.guestCount) ?? null

  // Post-zero identifier gate (B-17 / Constitution Part-Zero): a wedding
  // row encodes a couple that has REACHED Point Zero — name plus a
  // reachable identifier. Synthetic per-prospect tokens
  // (e.g. `authsolic-{hash}@weddingwire.bloom-relay.invalid` minted by
  // form-relay-parsers when the platform exposes no real personal email)
  // and known-relay senders (theknot.com, weddingwire.com, …) do NOT
  // satisfy that bar — neither lets the venue actually email the couple
  // back. Pre-fix, both shapes minted weddings with non-routable
  // synthetic emails. The fix lands them in candidate_identities
  // instead, awaiting a real identifier surfacing on a follow-up
  // signal. The interaction row above is preserved as the audit trail
  // either way.
  const subZeroIdentifier =
    classification.classification === 'new_inquiry' &&
    (!fromEmail || isSyntheticAddress(fromEmail) || isRelayAddress(fromEmail))

  if (
    isNewContact &&
    !weddingId &&
    classification.classification === 'new_inquiry' &&
    // Boomerang guard (Gap 2): if the venue already sent outbound on this
    // thread, the incoming is a reply to our campaign/outreach — never a
    // cold new_inquiry, even if the classifier ranked it that way on body
    // cues alone. Without this gate, campaign replies become ghost couples.
    !threadHasPriorOutbound &&
    // Post-zero identifier gate — see subZeroIdentifier comment above.
    !subZeroIdentifier
  ) {
    // 2026-04-30: inquiry_date used to be `new Date().toISOString()` —
    // wall-clock NOW. That stamped every wedding to the moment the
    // pipeline processed the message, not when the email actually
    // arrived. On a Gmail history backfill (e.g. Rixey 2026-04-24),
    // 77 weddings of varying real ages all collapsed to the same
    // import day, breaking ±72h cross-platform matching against
    // platform-side candidate timelines. For the cold-inquiry path
    // (no scheduling event, no form-relay) the email arrival IS the
    // inquiry, so email.date is the right anchor; NOW() stays as the
    // last-resort fallback when the Date header is missing or
    // unparseable.
    const inquiryDateValue = chooseEventTime(email.date) ?? new Date().toISOString()
    // Stream WWW (migration 205): mine extracted_identity for UTM
    // parameters. Some inbound relays (notably The Knot's outbound
    // emails) carry UTM keys in their tracking links, and the
    // body-extraction step on every email pulls these into
    // extracted_identity.utm_*. Stamp them onto the wedding row at
    // create time. The never-overwrite policy applies to UPDATE paths
    // below — at INSERT, no prior value exists.
    const utmFromIdentity = extractUtmFromExtractedIdentity(extractedIdentity)
    const hasUtmAtCreate = !!(utmFromIdentity.utm_source || utmFromIdentity.utm_medium
      || utmFromIdentity.utm_campaign || utmFromIdentity.utm_term || utmFromIdentity.utm_content)

    // G2 closure (2026-05-13): migrated from direct .from('weddings')
    // .insert(...) to mintWedding. The chokepoint enforces venue-scoped
    // resolveIdentity match chain, fires the P2 identity cascade, writes
    // mint_wedding_telemetry, and unlocks Wave 2C re-engagement-after-
    // loss linking (previous_wedding_id) for the email path — historically
    // pipeline.ts always minted fresh, even when the matched person had
    // a terminal prior wedding. After this change the resolver's Branch
    // B fires correctly here.
    //
    // mintWedding sets the core columns (venue_id, status='inquiry',
    // inquiry_date, wedding_date, source_provenance='identity_resolver').
    // Pipeline-specific columns (wedding_date_precision, estimated_guests,
    // legacy source, UTM keys) are written by the post-mint UPDATE below.
    let newWedding: { id: string } | null = null
    let mintedIsNew = false
    try {
      const extractedPhone =
        typeof extractedIdentity?.phone === 'string'
          ? (extractedIdentity.phone as string)
          : null
      const minted = await mintWedding({
        venueId,
        source: 'email_pipeline',
        signals: {
          email: fromEmail,
          phone: extractedPhone,
          fullName: fromName ?? null,
          weddingDate: parsedEventDate,
          inquiryDate: inquiryDateValue,
        },
        reason: 'fresh_inquiry',
        supabase,
        correlationId,
      })
      newWedding = { id: minted.weddingId }
      mintedIsNew = minted.isNew
      // mintWedding's resolveIdentity may have minted a NEW person if the
      // match chain missed everything findOrCreateContact saw. That's a
      // rare race; reconcile by adopting the resolver's personId so all
      // downstream writes go to the canonical row.
      if (!personId || personId !== minted.personId) {
        personId = minted.personId
      }
    } catch (mintErr) {
      console.error(
        '[pipeline] mintWedding (fresh_inquiry) failed:',
        mintErr instanceof Error ? mintErr.message : mintErr,
      )
    }

    if (newWedding) {
      weddingId = newWedding.id

      // Post-mint UPDATE — apply pipeline-specific fields the resolver
      // doesn't know about: legacy source column (Wave 7B classifier
      // recomputes canonical source from attribution_events; this column
      // remains as a display-tier fallback per the source-attribution
      // doctrine), wedding_date_precision, lead-side guest estimates,
      // and the UTM keys mined from extracted_identity.
      //
      // GUARD (G2 correctness fix): only apply on a freshly-minted
      // wedding. mintWedding's resolveIdentity can attach to an EXISTING
      // non-terminal wedding via Branch A (e.g., phone-match against a
      // person who has an active wedding) — overwriting status/source/UTM
      // on that row would clobber coordinator-set state. The pre-migration
      // direct INSERT couldn't hit this because it always minted fresh;
      // the migration introduces the new branch and we honour the
      // never-overwrite rule on attach.
      if (mintedIsNew) {
        try {
          await supabase
            .from('weddings')
            .update({
              source: detectedSource,
              wedding_date_precision: parsedEventDateObj?.precision ?? null,
              guest_count_estimate: parsedGuestCount,
              estimated_guests: parsedEstimatedGuests,
              utm_source: utmFromIdentity.utm_source ?? null,
              utm_medium: utmFromIdentity.utm_medium ?? null,
              utm_campaign: utmFromIdentity.utm_campaign ?? null,
              utm_term: utmFromIdentity.utm_term ?? null,
              utm_content: utmFromIdentity.utm_content ?? null,
              utm_first_seen_at: hasUtmAtCreate ? inquiryDateValue : null,
            })
            .eq('id', weddingId)
        } catch (err) {
          console.warn('[pipeline] post-mint pipeline-fields UPDATE failed:', err)
        }
      }

      // Cascade Pattern 2 (migration 314): synchronous pre-zero identity
      // match for anonymous storefront signals (Knot CSV, IG screenshots).
      // Distinct from mintWedding's built-in triggerIdentityCascade which
      // walks candidate_identities + tangential_signals from the resolver
      // angle; this one binds inquiry-anchored storefront candidates that
      // pre-date Point Zero. Fire-and-forget; idempotent.
      void (async () => {
        try {
          const { triggerNewInquiryCascade } = await import(
            '@/lib/services/cascades/on-new-inquiry'
          )
          await triggerNewInquiryCascade({
            venueId,
            weddingId: newWedding!.id,
            supabase,
          })
        } catch (err) {
          console.warn('[pipeline] new-inquiry cascade non-fatal:', err)
        }
      })()

      // people.wedding_id is already attached by resolveIdentity Branch
      // C (resolver.ts:962-964). Skip the redundant update.

      // Second partner: if classifier extracted a name, seed partner2 so
      // the detail/kanban has a couple label. Best-effort — skip silently
      // if a partner2 already exists (race on concurrent emails).
      //
      // Wave 4 Phase 4 (2026-05-10): synchronous phantom-partner heuristic
      // retired. The Sonnet judge in reconstruct.ts now emits
      // `is_phantom_partner_relationship` on couple_identity_profile, and
      // profile-to-people-sync tombstones phantom partner2 rows after the
      // job completes. We still insert partner2 from the LLM-extracted
      // sign-off so the people row exists for the chokepoint; if it's
      // a phantom, sync removes it post-reconstruction.
      if (extracted.partnerName) {
        const { captureNameEvidence } = await import('@/lib/services/identity/name-capture')
        const trimmedP2 = extracted.partnerName.trim()
        const [p2First] = trimmedP2.split(/\s+/)

        if (p2First) {
          // M4 flip (PHASE-1-BATCH-1.md §3.2, 2026-05-22): route the
          // partner2 mint through the `mintPerson` chokepoint instead of
          // a raw `people.insert`. mintPerson's partner2 invariant
          // (P2) does the wedding-scoped enrich-or-skip — an existing
          // partner2 on this wedding is enriched in place, never
          // duplicated. The partner2's name is the `signals.fullName`
          // (from mintPerson's view this person IS the subject —
          // `enrichExistingPartner2` and `createPerson` both read the
          // incoming name from `signals.fullName`). Phantom tombstoning
          // is still handled async by profile-to-people-sync after
          // reconstruct.ts judges the wedding.
          let p2Id: string | null = null
          try {
            const { mintPerson } = await import('@/lib/services/identity/mint-person')
            const p2Result = await mintPerson({
              venueId,
              weddingId,
              role: 'partner2',
              signals: {
                email: null,
                phone: null,
                fullName: trimmedP2,
                weddingDate: null,
                partner1Name: null,
                partner2Name: null,
              },
              source: 'email_pipeline',
              reason: 'partner2',
              supabase,
            })
            p2Id = p2Result.personId
          } catch (err) {
            // mintPerson never throws by contract; this catch is a
            // belt for an unexpected import/runtime failure.
            await logPipelineError(venueId, 'partner2_mint', err, {
              weddingId,
              interactionId,
            }, correlationId)
          }
          // mintPerson returns personId:null on a resolver error — and,
          // once migration 367's partial unique index is applied, a
          // concurrent-race loser routing through the create path hits
          // the unique violation → resolver_error → null. Either way the
          // correct recovery is the same: a partner2 already exists on
          // this wedding (the TS enrich-or-skip is the guard when 367 is
          // absent; the index is the guard when present). Re-query for
          // the live partner2 row and use it rather than treating it as
          // a hard failure.
          if (!p2Id) {
            try {
              const { data: existingP2 } = await supabase
                .from('people')
                .select('id')
                .eq('venue_id', venueId)
                .eq('wedding_id', weddingId)
                .eq('role', 'partner2')
                .is('merged_into_id', null)
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle()
              if (existingP2?.id) p2Id = existingP2.id as string
            } catch (err) {
              console.warn('[pipeline] partner2 re-query after null mint failed:', err instanceof Error ? err.message : err)
            }
          }
          if (p2Id) {
            try {
              await captureNameEvidence(supabase, p2Id, {
                full: trimmedP2,
                source: 'partner_mention_in_body',
                interactionId,
              })
            } catch (err) {
              console.warn('[pipeline] name-capture (partner2 from body) failed:', err instanceof Error ? err.message : err)
            }
          }
        }
      }

      // Update interaction with wedding_id
      await supabase
        .from('interactions')
        .update({ wedding_id: weddingId })
        .eq('id', interactionId)

      // Sweep prior orphan interactions for this person and attach
      // them to the new wedding. 2026-04-30: Ryan Schubert at Rixey
      // had a calculator estimate (Apr 15, $14,663) sitting orphan
      // because the calculator parser failed to fire; the eventual
      // wedding creation 8 days later didn't pick it up. Without
      // this sweep, calculator submissions / brain-dump CSV imports
      // / classification-misses that happen before the wedding gets
      // created stay invisible to coordinators forever.
      if (personId) {
        try {
          await supabase
            .from('interactions')
            .update({ wedding_id: weddingId })
            .eq('person_id', personId)
            .is('wedding_id', null)
        } catch (err) {
          console.warn('[email-pipeline] orphan-sweep failed for person', personId, ':', err)
        }
      }

      // Notify coordinators of the new inquiry so the bell shows it.
      // Priority 'normal' — not urgent, but coordinators should see every
      // new lead. The 5-minute dedup window in createNotification handles
      // accidental double-fires on the same email.
      try {
        await createNotification({
          venueId,
          weddingId,
          type: 'inquiry_received',
          title: 'New inquiry',
          body: `New inquiry from ${fromName ?? fromEmail}`,
          priority: 'normal',
          correlationId,
        })
      } catch (err) {
        await logPipelineError(venueId, 'inquiry_received_notification', err, {
          weddingId,
          interactionId,
        }, correlationId)
      }

      // Create initial engagement event + trigger heat recalculation.
      // Without the recalc, weddings.heat_score sat at 0 despite the
      // +40 initial_inquiry event existing — leads page hid them behind
      // `.gt('heat_score', 0)`. The F6 heat-signal batch call later
      // would recalc ONLY if the classifier emitted signals; plain
      // inquiries (no tour request, no commitment) never recalculated.
      // Use the wrapper so every new_inquiry immediately lands with
      // heat ~40 + tier='cool'.
      try {
        await recordEngagementEventsBatch(
          venueId,
          weddingId,
          [
            {
              eventType: 'initial_inquiry',
              metadata: { source: detectedSource, subject: email.subject },
            },
          ],
          // Direction: inbound. The couple sent us this email. Per
          // INV-13 every engagement_event ships with direction at
          // write time.
          'inbound',
          email.date,
          correlationId
        )
      } catch (err) {
        await logPipelineError(venueId, 'initial_inquiry_record', err, {
          weddingId,
          interactionId,
        }, correlationId)
      }

      // Multi-touch journey: record the inquiry as the first touchpoint.
      // Routed through the centralized touchpoints service so dedup +
      // schema choices stay in one place. occurred_at is the email's
      // real timestamp (not now()), so journey ordering matches reality.
      try {
        const { recordTouchpoint } = await import('@/lib/services/attribution/touchpoints')
        await recordTouchpoint({
          venueId,
          weddingId,
          touchType: 'inquiry',
          source: detectedSource,
          medium: 'email',
          occurredAt: email.date,
          metadata: { subject: email.subject, fromEmail, interaction_id: interactionId },
        })
      } catch (err) {
        console.warn('[pipeline] inquiry touchpoint insert failed:', err)
      }

      // Source-attribution self-heal at create time: if a scheduling
      // tool ended up as the wedding's first-touch source, immediately
      // search Gmail for the upstream Knot/WW/etc. relay email. A
      // high-confidence match auto-applies (weddings.source flips to
      // the real channel + audit trail says backtraced_by='auto').
      // Fire-and-forget — Gmail latency must not block the pipeline.
      void (async () => {
        try {
          const { backtraceOneWedding, WEAK_FIRST_TOUCH_SOURCES } = await import('@/lib/services/attribution/source-backtrace')
          if (weddingId && WEAK_FIRST_TOUCH_SOURCES.has(detectedSource)) {
            await backtraceOneWedding(venueId, weddingId)
          }
        } catch (err) {
          console.warn('[pipeline] create-time backtrace failed:', err)
        }
      })()

      // Connective tissue (gap A — 2026-04-30): Phase B resolver
      // hook on lead create. The new wedding may be the missing
      // match for an unresolved candidate — Sarah viewed Knot 5
      // days ago, finally emails today, the candidate has been
      // sitting unresolved waiting for someone to inquire. Without
      // this, the match waits up to 24h for the nightly sweep.
      // Fire-and-forget — resolver runtime must not block the
      // pipeline. Best-effort, errors logged.
      void (async () => {
        try {
          const { resolveForWedding } = await import('@/lib/services/identity/candidate-resolver')
          if (weddingId) {
            await resolveForWedding({ supabase, weddingId })
          }
        } catch (err) {
          console.warn('[pipeline] create-time candidate resolve failed:', err)
        }
      })()

      // T5-Rixey-CCC (2026-05-02): retroactive storefront backtrack on
      // every new wedding. The candidate-resolver above scans candidates
      // unresolved-as-of-now; backtrack additionally scans every
      // unresolved storefront candidate (Knot/WW/IG/Pinterest/...) within
      // the [-90d, +14d] inquiry window for first_name + last_initial +
      // state matches. This catches the "Sarah viewed Knot 6 weeks ago,
      // finally emails today" case that the candidate-resolver alone
      // misses because the candidate's first_seen falls outside the
      // resolver's tier-1 ±72h window. Fire-and-forget, never blocks.
      void (async () => {
        try {
          const { runBacktrackForWedding } = await import('@/lib/services/identity/backtrack')
          if (weddingId) {
            await runBacktrackForWedding(supabase, weddingId)
          }
        } catch (err) {
          console.warn('[pipeline] create-time identity backtrack failed:', err)
        }
      })()
    }
  } else if (
    isNewContact &&
    !weddingId &&
    !threadHasPriorOutbound &&
    subZeroIdentifier
  ) {
    // Sub-point-zero new_inquiry: insert a candidate_identities row
    // instead of a wedding. Constitution Part-Zero — the couple has a
    // name candidate but no reachable identifier, so they are still
    // pre-Point-Zero. The candidate clusterer / resolver will promote
    // them to a wedding when a real identifier (personal email,
    // phone, platform handle) surfaces on a future signal.
    try {
      // Best-effort name parse from senderName (classifier output) or
      // fromName (raw From header). When neither produces anything,
      // signal_count + email + source_platform alone are enough for the
      // resolver to pin the candidate later.
      //
      // Wave 2A: pre-classify the shape via the chokepoint helpers so a
      // username/proxy "fromName" (Knot relays carry "User <hex>" or
      // smushed "erinhorrigan") never lands on candidate_identities.
      // first_name. The candidate row has no `name_evidence` column
      // (Phase 1 mig 255 only added evidence to `people`), so we drop
      // junk silently here — the resolver will pull a real signal off
      // a future interaction. NOT shaped to call captureNameEvidence
      // (no person row yet); instead we use the classifier helpers
      // directly to get a shape verdict and reject the bad shapes.
      const { classifyNameShape } = await import('@/lib/services/identity/name-capture')
      const rawName =
        (typeof extracted.senderName === 'string' && extracted.senderName.trim().length > 0
          ? extracted.senderName.trim()
          : null)
        ?? (typeof fromName === 'string' && fromName.trim().length > 0
          ? fromName.trim()
          : null)
      let subZeroFirstName: string | null = null
      let subZeroLastName: string | null = null
      if (rawName) {
        const shape = classifyNameShape(rawName)
        if (shape !== 'username' && shape !== 'proxy') {
          const nameParts = rawName.split(/\s+/)
          subZeroFirstName = nameParts[0] ?? null
          subZeroLastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null
        }
      }

      const sourcePlatform = detectedSource
      await supabase.from('candidate_identities').insert({
        venue_id: venueId,
        source_platform: sourcePlatform,
        first_name: subZeroFirstName,
        last_initial: subZeroFirstName ? null : null,
        last_name: subZeroLastName,
        email: fromEmail,
        phone: schedulingEvent?.extras?.phone ?? null,
        signal_count: 1,
        funnel_depth: 1,
        action_counts: { email_inquiry: 1 },
        first_seen: email.date,
        last_seen: email.date,
        review_status: 'needs_review',
      })
    } catch (err) {
      console.warn('[pipeline] sub-zero candidate insert failed:', err)
    }
  } else if (weddingId && parsedEventDate) {
    // Existing wedding — backfill any extracted date / guest count that
    // wasn't already known. Never overwrite a manually-entered value.
    // Stream WWW (migration 205): same never-overwrite rule for
    // utm_*. If the wedding already carries any UTM (e.g. a prior
    // form submission stamped it), a later email's extracted UTM
    // does NOT replace it — the original acquisition channel wins.
    const { data: existingWedding } = await supabase
      .from('weddings')
      .select('wedding_date, wedding_date_locked_by_operator, wedding_date_evidence, guest_count_estimate, estimated_guests, utm_source, utm_medium, utm_campaign, utm_term, utm_content')
      .eq('id', weddingId)
      .single()
    const patch: Record<string, unknown> = {}
    // Sticky-state Pattern 1 (migration 306): wedding_date_evidence is
    // append-only. Every parsed date signal — including ones we don't
    // promote into the wedding_date column — gets a forensic row so
    // conflicts are inspectable on the coordinator side. The column
    // itself only updates when (a) it's empty today and (b) the operator
    // hasn't locked it.
    if (existingWedding && parsedEventDate) {
      const existingEvidence = Array.isArray(existingWedding.wedding_date_evidence)
        ? (existingWedding.wedding_date_evidence as Array<Record<string, unknown>>)
        : []
      const newEvidence = {
        source: 'email_body_extraction',
        value: parsedEventDate,
        precision: parsedEventDateObj?.precision ?? 'day',
        confidence: 60,
        captured_at: email.date ?? new Date().toISOString(),
        interaction_id: interactionId,
        actor_id: null,
      }
      patch.wedding_date_evidence = [...existingEvidence, newEvidence]
    }
    const dateLocked = existingWedding?.wedding_date_locked_by_operator === true
    if (existingWedding && !existingWedding.wedding_date && parsedEventDate && !dateLocked) {
      patch.wedding_date = parsedEventDate
      patch.wedding_date_precision = parsedEventDateObj?.precision ?? null
    }
    if (existingWedding && !existingWedding.guest_count_estimate && parsedGuestCount) {
      patch.guest_count_estimate = parsedGuestCount
    }
    // T5-schema-gap (165): backfill estimated_guests on the same
    // never-overwrite contract. If the coordinator already typed a
    // value (NOT NULL), the LLM never wins — same rule as the dates.
    if (
      existingWedding &&
      (existingWedding as { estimated_guests?: number | null }).estimated_guests == null &&
      parsedEstimatedGuests
    ) {
      patch.estimated_guests = parsedEstimatedGuests
    }
    // Stream WWW: backfill UTM only when EVERY existing column is
    // NULL. Per-column "fill if NULL" would let a partial second-
    // signal corrupt a coherent first signal (e.g. a knot-Email's
    // utm_medium overwriting a Google-Ads campaign's blank
    // utm_medium). Treat the UTM bundle as an atomic unit.
    const existingHasAnyUtm = !!(existingWedding && (
      (existingWedding as { utm_source?: string | null }).utm_source
      || (existingWedding as { utm_medium?: string | null }).utm_medium
      || (existingWedding as { utm_campaign?: string | null }).utm_campaign
      || (existingWedding as { utm_term?: string | null }).utm_term
      || (existingWedding as { utm_content?: string | null }).utm_content
    ))
    if (!existingHasAnyUtm) {
      const utmFromIdentity = extractUtmFromExtractedIdentity(extractedIdentity)
      const hasNewUtm = !!(utmFromIdentity.utm_source || utmFromIdentity.utm_medium
        || utmFromIdentity.utm_campaign || utmFromIdentity.utm_term || utmFromIdentity.utm_content)
      if (hasNewUtm) {
        patch.utm_source = utmFromIdentity.utm_source ?? null
        patch.utm_medium = utmFromIdentity.utm_medium ?? null
        patch.utm_campaign = utmFromIdentity.utm_campaign ?? null
        patch.utm_term = utmFromIdentity.utm_term ?? null
        patch.utm_content = utmFromIdentity.utm_content ?? null
        patch.utm_first_seen_at = chooseEventTime(email.date) ?? new Date().toISOString()
      }
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

  // 2026-05-09 user mandate: "no names should be just one name if they
  // have inquired or sent an email". The Knot relay hands us "Jen B" on
  // first inquiry; the calculator email (and email signatures, contract
  // signers, etc.) carry the full "Jennifer Biaksangi" later. Without
  // a promotion service the people row stays at "Jen B" forever.
  // Fire-and-forget — runtime must not block the pipeline. Best-effort,
  // errors logged. The service itself skips tombstoned people rows and
  // refuses to upgrade across last-name conflicts (different humans).
  if (weddingId) {
    void (async () => {
      try {
        const { upgradePeopleNameFromTouchpoints } = await import('@/lib/services/identity/name-upgrade')
        await upgradePeopleNameFromTouchpoints(weddingId)
      } catch (err) {
        console.warn('[pipeline] name-upgrade failed:', err instanceof Error ? err.message : err)
      }
    })()
  }

  // 2026-05-09 user mandate: continuous profile enrichment + soft-context
  // notes. Sister service to name-upgrade. Picks up the BROADER profile
  // fields (phone, employer, hometown, dietary_summary, family_context,
  // guest_count_estimate refinements) AND the soft-context layer (life
  // mentions, mood, vendor preferences). Cost-ceiling gated inside the
  // service; tier-1 PII; never blocks the pipeline.
  //
  // Fire-and-forget after name-upgrade so the enrichment service sees
  // the upgraded names if/when name-upgrade promoted any. The two run in
  // sequence because they share the same wedding row; we don't want
  // them racing on the people row update.
  if (weddingId) {
    void (async () => {
      try {
        const { enrichProfileFromTouchpoints } = await import('@/lib/services/identity/profile-enrichment')
        await enrichProfileFromTouchpoints(weddingId, {
          trigger: 'pipeline_email',
          correlationId: correlationId ?? null,
        })
      } catch (err) {
        console.warn('[pipeline] profile-enrichment failed:', err instanceof Error ? err.message : err)
      }
    })()
  }

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

    // 2026-05-01 heat-map fix: tour_requested + high_commitment_signal +
    // family_mentioned + high_specificity are FIRE-ONCE-PER-WEDDING. The
    // classifier re-emits the booleans on every inbound reply (a reply
    // discussing tour logistics still has mentionsTourRequest=true), so
    // pre-fix a couple's 4-reply coordination thread fired 4× +15
    // tour_requested events. Fetch existing events once and skip the
    // firing if the type already exists for this wedding.
    const { data: priorHeatRows } = await supabase
      .from('engagement_events')
      .select('event_type')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .in('event_type', ['tour_requested', 'high_commitment_signal', 'family_mentioned', 'high_specificity'])
    const priorHeatTypes = new Set(((priorHeatRows ?? []) as Array<{ event_type: string }>).map((r) => r.event_type))

    if (extracted.mentionsTourRequest && !priorHeatTypes.has('tour_requested')) {
      heatEvents.push({ eventType: 'tour_requested', metadata: sharedMeta })
    }
    if (extracted.commitmentLevel === 'decided' && !priorHeatTypes.has('high_commitment_signal')) {
      heatEvents.push({
        eventType: 'high_commitment_signal',
        metadata: { ...sharedMeta, commitmentLevel: extracted.commitmentLevel },
      })
    }
    if (extracted.mentionsFamilyAttending && !priorHeatTypes.has('family_mentioned')) {
      heatEvents.push({ eventType: 'family_mentioned', metadata: sharedMeta })
    }
    if (
      typeof extracted.specificityScore === 'number' &&
      extracted.specificityScore >= 0.7 &&
      !priorHeatTypes.has('high_specificity')
    ) {
      heatEvents.push({
        eventType: 'high_specificity',
        metadata: { ...sharedMeta, specificityScore: extracted.specificityScore },
      })
    }

    if (heatEvents.length > 0) {
      try {
        // Heat events derived from inbound classifier output — couple
        // signaled tour interest, commitment, family context, etc.
        // INV-13 / INV-14: direction='inbound' so the events count
        // toward the wedding's heat score.
        await recordEngagementEventsBatch(venueId, weddingId, heatEvents, 'inbound', email.date, correlationId)
        // Mirror attribution-relevant events to wedding_touchpoints so
        // /intel/sources can compute multi-touch journey + funnel.
        // engagementToTouchType returns null for heat-internal signals
        // (high_specificity / family_mentioned) — those don't appear in
        // the funnel.
        const { recordTouchpointsForEngagementEvents } = await import('@/lib/services/attribution/touchpoints')
        await recordTouchpointsForEngagementEvents(
          venueId,
          weddingId,
          heatEvents.map((e) => ({
            eventType: e.eventType,
            source: detectedSource,
            occurredAt: email.date,
            metadata: e.metadata,
          }))
        )
      } catch (err) {
        // Heat signals are additive — never let a batch insert failure
        // break the pipeline. Log and continue.
        await logPipelineError(venueId, 'heat_signal_record', err, {
          interactionId,
          weddingId,
          events: heatEvents.map((e) => e.eventType),
        }, correlationId)
      }
    }
  }

  // Step 6a.5: Scheduling-tool event. If this email is a Calendly / Acuity
  // / HoneyBook / Dubsado confirmation / contract / payment, fire the
  // matching engagement event + advance status. We've already rerouted
  // contact resolution to the invitee above, so weddingId (if set) is
  // the RIGHT wedding — not a ghost for the tool's sender address.
  //
  // If weddingId is NULL and we have a scheduling event, FIRST try to
  // resolve identity against rich signals from the scheduling event
  // (partner name, phone, wedding date) before creating a new wedding.
  // Couples often inquire via one email (Knot relay, partner's address)
  // and book Calendly with a different email. Matching on phone or
  // name+partner catches these cases without creating duplicates. This
  // path extends to future ingest sources (Instagram DM extracts, Knot
  // direct feed) — same engine, different caller.
  // Resolve the *actual* kind given when the tour happens vs now. A
  // "Rixey Manor Venue Tour" booked for last week is a completed tour;
  // we mark it tour_completed instead of tour_scheduled so the leads
  // surface reflects what already happened.
  //
  // 2026-05-01 heat-map fix: cancellation guard. If we have a wedding
  // and a tour_cancelled event already exists for it whose
  // metadata.event_datetime matches this scheduling event's
  // eventDatetime, the auto-promotion to tour_completed is wrong —
  // the tour was cancelled, not held. Pre-fix a Calendly cancel email
  // arrived Apr 3 firing tour_cancelled (-15), then the original
  // booking email's tour_scheduled (eventDatetime=Apr 5) was re-
  // processed Apr 5+, time-aware-promoted to tour_completed (+20),
  // and the wedding's heat netted +5 instead of -15.
  // Cancellation guard flag — when set, the scheduling-event handler
  // below skips the engagement_event + status-advance writes. The
  // cancellation event has already fired for this tour instance; re-
  // processing the original booking email shouldn't double-write.
  // 2026-05-01 (review pass 1): cancellation guard.
  //
  // When timeAwareTourKind would auto-promote tour_scheduled →
  // tour_completed because eventDatetime has passed, check whether
  // this tour instance has already been cancelled. If so, suppress
  // the engagement-event write; re-processing the original booking
  // email shouldn't fire +20 tour_completed when the cancellation
  // already fired -15 for the same tour.
  //
  // Three matching strategies (any one is sufficient):
  //   1. gmail_thread_id linkage — strongest. A cancel email replying
  //      on the same thread as the original booking confirms it's
  //      the same tour instance. Robust to date format drift.
  //   2. metadata.event_datetime equality (or within 14 days). The
  //      cancel email's parsed scheduling event_datetime stamps to
  //      the original tour's scheduled time. Pre-fix the tolerance
  //      was 6h — too tight. Real cancellations arrive 1-3 days
  //      before the tour, sometimes more. Widened to 14 days to
  //      cover the realistic cancel-arrival → tour-datetime gap.
  //   3. occurred_at on the cancel row close to this tour's
  //      eventDatetime — same TOUR_HAPPENED_KINDS stamping rule.
  //      Tolerance 14 days for the same reason.
  let suppressBecauseCancelled = false
  if (schedulingEvent) {
    const adjustedKind = timeAwareTourKind(schedulingEvent.kind, schedulingEvent.eventDatetime)
    if (
      adjustedKind === 'tour_completed' &&
      weddingId &&
      schedulingEvent.eventDatetime
    ) {
      // Pull the current interaction's gmail_thread_id so we can match
      // on thread linkage. The interaction was inserted earlier in
      // the pipeline.
      let currentThreadId: string | null = null
      if (interactionId) {
        const { data: ix } = await supabase
          .from('interactions')
          .select('gmail_thread_id')
          .eq('id', interactionId)
          .maybeSingle()
        currentThreadId = (ix?.gmail_thread_id as string | null) ?? null
      }

      const { data: cancelRows } = await supabase
        .from('engagement_events')
        .select('metadata, occurred_at')
        .eq('venue_id', venueId)
        .eq('wedding_id', weddingId)
        .eq('event_type', 'tour_cancelled')
        .limit(20)

      const evtDt = schedulingEvent.eventDatetime
      const evtMs = Date.parse(evtDt)
      const TOLERANCE_MS = 14 * 24 * 60 * 60 * 1000  // 14 days
      const cancelMatchesThisTour = ((cancelRows ?? []) as Array<{
        metadata: Record<string, unknown> | null
        occurred_at: string | null
      }>).some((row) => {
        const md = (row.metadata ?? {}) as Record<string, unknown>
        // Strategy 1: thread_id linkage (cancel email's interaction
        // was on the same gmail_thread_id as this booking).
        const cancelInteractionId = (md.interaction_id as string | undefined) ?? null
        if (cancelInteractionId && currentThreadId) {
          // Resolved synchronously below by a separate fetch; here
          // we just flag that a thread-id match is possible.
          // (See thread-match block after this loop.)
        }
        // Strategy 2: event_datetime equality / proximity.
        const mdDt = (md.event_datetime as string | undefined) ?? null
        if (mdDt && Number.isFinite(evtMs)) {
          if (mdDt === evtDt) return true
          const a = Date.parse(mdDt)
          if (Number.isFinite(a) && Math.abs(a - evtMs) < TOLERANCE_MS) return true
        }
        // Strategy 3: occurred_at proximity.
        if (row.occurred_at && Number.isFinite(evtMs)) {
          const a = Date.parse(row.occurred_at)
          if (Number.isFinite(a) && Math.abs(a - evtMs) < TOLERANCE_MS) return true
        }
        return false
      })

      // Strategy 1 (thread-id linkage) — requires a join across
      // engagement_events.metadata.interaction_id → interactions
      // .gmail_thread_id. Only run if the proximity check missed
      // (cheap optimisation).
      let threadMatched = false
      if (!cancelMatchesThisTour && currentThreadId) {
        const cancelInteractionIds = ((cancelRows ?? []) as Array<{
          metadata: Record<string, unknown> | null
        }>)
          .map((r) => (r.metadata as Record<string, unknown> | null)?.interaction_id)
          .filter((v): v is string => typeof v === 'string')
        if (cancelInteractionIds.length > 0) {
          const { data: ixRows } = await supabase
            .from('interactions')
            .select('gmail_thread_id')
            .in('id', cancelInteractionIds)
          threadMatched = ((ixRows ?? []) as Array<{ gmail_thread_id: string | null }>)
            .some((r) => r.gmail_thread_id === currentThreadId)
        }
      }

      if (cancelMatchesThisTour || threadMatched) {
        suppressBecauseCancelled = true
      }
    }
    if (!suppressBecauseCancelled && adjustedKind !== schedulingEvent.kind) {
      schedulingEvent = { ...schedulingEvent, kind: adjustedKind }
    }
  }
  // Positive kinds that should create a wedding when none exists. Excludes
  // tour_completed because a completed tour without prior wedding is too
  // weak a signal — coordinator should be involved before we manifest a
  // wedding from a single past event with no accompanying inquiry.
  const POSITIVE_KINDS = new Set([
    'tour_scheduled',
    'contract_sent', 'contract_signed', 'payment_received',
    'final_walkthrough', 'pre_wedding_event', 'planning_meeting',
    // T2-F: HoneyBook lifecycle. Signed + payment manifest a wedding
    // when none exists (HoneyBook contract signed = booked couple
    // with no prior Bloom inquiry on file). Refund + amendment do
    // NOT manifest — they imply an existing wedding the coordinator
    // is amending or refunding.
    'honeybook_contract_signed', 'honeybook_payment_received',
  ])
  if (schedulingEvent && !weddingId) {
    const extras = schedulingEvent.extras
    const partnerParts = (extras?.partnerName ?? '').trim().split(/\s+/)
    const inviteeParts = (schedulingEvent.inviteeName ?? '').trim().split(/\s+/)
    try {
      const matches = await findIdentityMatches(supabase, {
        venueId,
        email: schedulingEvent.inviteeEmail,
        firstName: inviteeParts[0] || null,
        lastName: inviteeParts.slice(1).join(' ') || null,
        phone: extras?.phone ?? null,
        partnerFirstName: partnerParts[0] || null,
        partnerLastName: partnerParts.slice(1).join(' ') || null,
        signalDate: email.date,
        excludePersonId: personId, // don't match the just-created ghost
        // D6 cascade (§C.5): pass the inbound email body so cascade
        // stages 6-8 (body cross-reference, paired-name + corroborator,
        // family-name + date) can fire. A scheduling-tool notification
        // body often carries Susan's mention of Tim's email / phone in
        // the invitee-notes; this is where Q36 false-positives get
        // caught.
        bodyText:
          [email.subject ?? null, email.body ?? null]
            .filter(Boolean)
            .join('\n\n') || null,
      })
      const high = matches.find((m) => m.tier === 'high')
      if (high) {
        // Find the high-match person's wedding and link us there.
        const { data: matchPerson } = await supabase
          .from('people')
          .select('id, wedding_id, first_name, last_name')
          .eq('id', high.personId)
          .maybeSingle()
        const resolvedWid = (matchPerson?.wedding_id as string | null) ?? null
        if (resolvedWid) {
          weddingId = resolvedWid
          // If we already created a ghost person for the Calendly invitee,
          // merge it into the resolved person so interactions + drafts
          // consolidate. Silently skip if personId already matches.
          if (personId && personId !== high.personId) {
            try {
              const { mergePeople } = await import('@/lib/services/identity/merge-people')
              await mergePeople({
                supabase, venueId,
                keepPersonId: high.personId,
                mergePersonId: personId,
                tier: 'high',
                signals: high.signals,
                confidence: high.confidence,
              })
              personId = high.personId
            } catch (err) {
              console.error('[pipeline] merge after scheduling identity match failed:', err)
            }
          }
          // Re-link interaction onto the resolved wedding/person
          await supabase
            .from('interactions')
            .update({ wedding_id: weddingId, person_id: personId })
            .eq('id', interactionId)
        }
      }
    } catch (err) {
      await logPipelineError(venueId, 'scheduling_identity_resolve', err, {
        interactionId, inviteeEmail: schedulingEvent.inviteeEmail,
      }, correlationId)
    }
  }

  if (schedulingEvent && !weddingId && POSITIVE_KINDS.has(schedulingEvent.kind)) {
    try {
      const targetStatus = eventKindToStatus(schedulingEvent.kind) ?? 'tour_scheduled'
      // 2026-04-30 corrected: a Calendly notification arriving Mar 29
      // about a tour for Apr 13 carries TWO distinct timestamps that
      // serve different fields:
      //   email.date (Mar 29)           = when the booking happened
      //                                    (when the customer clicked
      //                                    Book in Calendly, ≈ when
      //                                    they inquired)
      //   eventDatetime (Apr 13 6pm)    = when the tour actually
      //                                    happens / happened
      // wedding.inquiry_date and tour-booking touchpoints take
      // email.date. Only the tour itself (tour_date, tour_conducted)
      // takes eventDatetime. Earlier sweep (a9b48ed) wrongly unified
      // these on eventDatetime — caused journeys where the tour
      // appeared completed BEFORE the inquiry was received.
      const inquiryDateForSchedulingEvent =
        chooseEventTime(email.date) ?? new Date().toISOString()
      // G2 closure (2026-05-13): migrated to mintWedding. Same shape as
      // the fresh-inquiry path above: resolver creates person if missing
      // (replacing the synth-person block below), enforces venue-scoped
      // match chain, fires the P2 cascade + telemetry. Post-mint UPDATE
      // applies status=targetStatus + tour_date + source — fields the
      // resolver doesn't carry.
      let newWedding: { id: string } | null = null
      let mintedSchedIsNew = false
      try {
        const inviteeEmail = schedulingEvent.inviteeEmail ?? null
        const inviteeName = (schedulingEvent.inviteeName ?? '').trim() || null
        const invitePhone = schedulingEvent.extras?.phone ?? null
        if (!inviteeEmail && !invitePhone) {
          // No identifier on the scheduling event — can't mint. Pre-fix
          // this path also bailed (the synth-person block requires
          // inviteeEmail). Drop to fall-through.
          throw new Error('scheduling_event missing inviteeEmail and phone')
        }
        const minted = await mintWedding({
          venueId,
          source: 'email_pipeline',
          signals: {
            email: inviteeEmail,
            phone: invitePhone,
            fullName: inviteeName,
            weddingDate: null,
            inquiryDate: inquiryDateForSchedulingEvent,
          },
          reason: `scheduling_event:${schedulingEvent.kind}`,
          supabase,
          correlationId,
        })
        newWedding = { id: minted.weddingId }
        mintedSchedIsNew = minted.isNew
        // Adopt resolver's personId — replaces the synth-person block.
        if (!personId || personId !== minted.personId) {
          personId = minted.personId
        }
      } catch (mintErr) {
        console.error(
          '[pipeline] mintWedding (scheduling_event) failed:',
          mintErr instanceof Error ? mintErr.message : mintErr,
        )
      }
      if (newWedding) {
        weddingId = newWedding.id

        // Post-mint UPDATE — apply scheduling-specific columns. Status
        // upgrade from resolver's default 'inquiry' to the targetStatus
        // (tour_scheduled / tour_completed / etc.) derived from the
        // schedulingEvent.kind. tour_date is the actual event datetime,
        // distinct from inquiry_date (the moment the couple clicked Book).
        //
        // GUARD (G2 correctness fix): same as fresh-inquiry path. Only
        // overwrite status/source/tour_date on a freshly-minted wedding.
        // If resolver attached to an existing wedding (e.g., the matched
        // person already had an active wedding in status='booked'), do
        // NOT overwrite — coordinator-set state wins.
        if (mintedSchedIsNew) {
          try {
            // 2026-05-27 — when the Calendly Questions block carried a
            // canonical source ("Where did you first hear about us? →
            // Google" → 'google'), prefer that over the channel name
            // ('calendly'). The channel name is the WORST attribution
            // signal because every Calendly booking would otherwise be
            // logged as direct/unknown. Falls back to the channel name
            // when no canonical source was extracted.
            const formCanonicalSource =
              (schedulingEvent.source === 'calendly' &&
                schedulingEvent.extras?.sourceCanonical) ||
              null
            const sourceToStamp = formCanonicalSource ?? schedulingEvent.source
            await supabase
              .from('weddings')
              .update({
                status: targetStatus,
                source: sourceToStamp,
                tour_date: parseEventTime(schedulingEvent.eventDatetime),
              })
              .eq('id', weddingId)
          } catch (err) {
            console.warn('[pipeline] post-mint scheduling-event UPDATE failed:', err)
          }
        } else {
          // Attached to existing wedding. Stamp tour_date only when the
          // existing wedding has no tour_date yet — a real tour scheduled
          // event arriving for a wedding that didn't have one is genuine
          // new information, not a clobber. Status + source are left
          // alone (never-overwrite policy).
          try {
            await supabase
              .from('weddings')
              .update({ tour_date: parseEventTime(schedulingEvent.eventDatetime) })
              .eq('id', weddingId)
              .is('tour_date', null)
          } catch (err) {
            console.warn('[pipeline] attach-path tour_date stamp failed:', err)
          }
        }

        // personId is already attached to weddingId by resolveIdentity
        // Branch C (resolver.ts:962-964). The old synth-person block +
        // the `else if (personId)` re-attach were both replaced by the
        // mintWedding call above.
        await supabase.from('interactions').update({ wedding_id: weddingId, person_id: personId }).eq('id', interactionId)

        // Same orphan sweep as the new-inquiry path. A scheduling-
        // event wedding (Calendly tour booking → wedding creation)
        // routinely picks up prior calculator-submission / form-relay
        // orphans for the same person.
        if (personId) {
          try {
            await supabase
              .from('interactions')
              .update({ wedding_id: weddingId })
              .eq('person_id', personId)
              .is('wedding_id', null)
          } catch (err) {
            console.warn('[email-pipeline] scheduling-path orphan-sweep failed:', err)
          }
        }

        // Seed partner2 from the Calendly extras if present — most
        // Calendly booking forms capture the second partner's name.
        //
        // Wave 4 Phase 4 (2026-05-10): synchronous phantom-partner heuristic
        // retired. Reconstruct.ts + profile-to-people-sync handle phantoms
        // post-judge. We always insert if partner2 first-name is present.
        if (schedulingEvent.extras?.partnerName) {
          const { captureNameEvidence } = await import('@/lib/services/identity/name-capture')
          const trimmedP2 = schedulingEvent.extras.partnerName.trim()
          const [p2First] = trimmedP2.split(/\s+/)
          const p2Email = schedulingEvent.extras.partnerEmail ?? null
          const p2Phone = schedulingEvent.extras.phone ?? null
          if (p2First) {
            // M5 flip (PHASE-1-BATCH-1.md §3.2, 2026-05-22): route the
            // Calendly/scheduling partner2 mint through `mintPerson`.
            // Same enrich-or-skip invariant as M4. M5 carries the
            // partner2's email + phone from the booking form — pass them
            // in `signals` so the resolver match chain + enrich both
            // see them. The partner2's name is `signals.fullName`.
            let p2Id: string | null = null
            try {
              const { mintPerson } = await import('@/lib/services/identity/mint-person')
              const p2Result = await mintPerson({
                venueId,
                weddingId,
                role: 'partner2',
                signals: {
                  email: p2Email,
                  phone: p2Phone,
                  fullName: trimmedP2,
                  weddingDate: null,
                  partner1Name: null,
                  partner2Name: null,
                },
                source: 'email_pipeline',
                reason: 'partner2',
                supabase,
              })
              p2Id = p2Result.personId
            } catch (err) {
              // mintPerson never throws by contract; belt for an
              // unexpected import/runtime failure.
              await logPipelineError(venueId, 'partner2_mint', err, {
                weddingId,
                interactionId,
              }, correlationId)
            }
            // null result → resolver error OR (once migration 367 is
            // applied) a concurrent-race unique-violation. Both mean a
            // partner2 already exists on this wedding — re-query and use
            // the live row instead of failing hard.
            if (!p2Id) {
              try {
                const { data: existingP2 } = await supabase
                  .from('people')
                  .select('id')
                  .eq('venue_id', venueId)
                  .eq('wedding_id', weddingId)
                  .eq('role', 'partner2')
                  .is('merged_into_id', null)
                  .order('created_at', { ascending: true })
                  .limit(1)
                  .maybeSingle()
                if (existingP2?.id) p2Id = existingP2.id as string
              } catch (err) {
                console.warn('[pipeline] partner2 re-query after null mint failed:', err instanceof Error ? err.message : err)
              }
            }
            if (p2Id) {
              try {
                // form_relay confidence — Calendly forms are coordinator-
                // approved structured data, slightly stronger than a
                // body-mention but weaker than calculator/contract.
                await captureNameEvidence(supabase, p2Id, {
                  full: trimmedP2,
                  email: p2Email,
                  source: 'form_relay',
                })
              } catch (err) {
                console.warn('[pipeline] name-capture (scheduling partner2) failed:', err instanceof Error ? err.message : err)
              }
            }
          }
        }
        // Seed the initial_inquiry event so baseline heat exists on
        // par with weddings that entered via an email inquiry. Without
        // this a Calendly-only couple sits at heat=0 until a reply arrives.
        // Direction: inbound — couple booked the tour via the scheduling
        // tool, that's a couple-side action.
        //
        // 2026-05-27: when the Questions block surfaced a canonical
        // source, attribute the initial_inquiry to that (Google / Knot /
        // etc.) rather than the channel name ('calendly'). Carries both
        // for forensic completeness.
        const initialSourceCanonical =
          schedulingEvent.extras?.sourceCanonical ?? null
        await recordEngagementEventsBatch(
          venueId,
          weddingId,
          [{
            eventType: 'initial_inquiry',
            metadata: {
              source: initialSourceCanonical ?? schedulingEvent.source,
              via: 'scheduling_tool',
              channel: schedulingEvent.source,
              source_literal: schedulingEvent.extras?.source ?? null,
              source_from_calendly_questions: Boolean(initialSourceCanonical),
            },
          }],
          'inbound',
          email.date,
          correlationId
        )

        // Source-attribution self-heal: same back-trace fire as the
        // form-relay wedding-create path. Calendly is the OBVIOUS
        // case — wedding was just born with source='calendly' and
        // there's a 70%+ chance the couple actually came from Knot
        // or the venue website. Async, never blocks.
        const newWeddingId = weddingId
        void (async () => {
          try {
            const { backtraceOneWedding } = await import('@/lib/services/attribution/source-backtrace')
            await backtraceOneWedding(venueId, newWeddingId)
          } catch (err) {
            console.warn('[pipeline] scheduling-tool create-time backtrace failed:', err)
          }
        })()
      }
    } catch (err) {
      await logPipelineError(venueId, 'scheduling_tool_wedding_create', err, {
        interactionId, fromEmail, inviteeName: schedulingEvent.inviteeName,
      }, correlationId)
    }
  }

  // Calendly-provided name hygiene: when the scheduling parser extracted
  // a clean full name from the "Invitee:" label, route it through the
  // name-capture chokepoint. Wave 2A: REMOVED the legacy "looksLikeSalvage"
  // ternary at lines 2509-2515 — that heuristic had a logical bug
  // (the ternary returned !curLast regardless of the casing branch) AND
  // forced the pipeline to make decisions about overwrite ordering that
  // the picker now owns. The chokepoint records this as a Calendly
  // gmail_from_name signal; the picker promotes it over weaker email-
  // local-part-derived first names automatically based on shape +
  // confidence.
  if (schedulingEvent?.inviteeName && personId) {
    try {
      const { captureNameEvidence } = await import('@/lib/services/identity/name-capture')
      await captureNameEvidence(supabase, personId, {
        full: schedulingEvent.inviteeName.trim(),
        email: schedulingEvent.inviteeEmail ?? null,
        source: 'gmail_from_name',
      })
    } catch (err) {
      console.warn('[pipeline] name-capture (Calendly invitee hygiene) failed:', err instanceof Error ? err.message : err)
    }
  }

  // 2026-05-12 — Zack Hunter trace: same hygiene for form-relay parsed
  // names. findOrCreateContact only captures evidence on the INSERT
  // branch; when canonical resolver returns an existing person row the
  // parsed leadName silently dropped on the floor. So the first WW
  // inbound for a prospect created a row with first_name=email-local-
  // part placeholder (`authsolic-XXX`), and every subsequent inbound
  // carrying the real "Zack Hunter" subject left the placeholder in
  // place forever. Routing through the chokepoint here re-promotes the
  // placeholder to the real name on the next inbound. The picker's
  // confidence rules guard against weaker signals overwriting stronger
  // ones, so this is safe to fire even when the existing row already
  // has a high-confidence name (calculator / contract).
  if (formLead?.leadName && personId) {
    try {
      const { captureNameEvidence } = await import('@/lib/services/identity/name-capture')
      await captureNameEvidence(supabase, personId, {
        full: formLead.leadName.trim(),
        email: formLead.leadEmail ?? null,
        source: 'gmail_from_name',
      })
    } catch (err) {
      console.warn('[pipeline] name-capture (form-relay leadName hygiene) failed:', err instanceof Error ? err.message : err)
    }
  }

  if (schedulingEvent && weddingId && !suppressBecauseCancelled) {
    try {
      const eventType = eventKindToEngagementType(schedulingEvent.kind)
      // 2026-04-30 corrected: which timestamp depends on what the
      // event represents:
      //   tour_scheduled / contract_sent / payment_received   →
      //     these are "the booking action happened" — use email.date
      //     (the moment the customer's action surfaced to us).
      //   tour_completed / tour_cancelled / final_walkthrough /
      //   pre_wedding_event / planning_meeting / contract_signed →
      //     these are "the event itself happened" — use the
      //     scheduledDatetime (when the tour / walkthrough / meeting
      //     actually takes place).
      // Earlier sweep (a9b48ed) used eventDatetime for everything
      // which produced "Tour booked Apr 13" (wrong — booking
      // happened Mar 29 when the customer clicked Book in Calendly).
      const TOUR_HAPPENED_KINDS = new Set([
        'tour_completed', 'tour_cancelled', 'final_walkthrough',
        'pre_wedding_event', 'planning_meeting', 'contract_signed',
        // T2-F: HoneyBook lifecycle "happened" events use eventDatetime
        // (when the contract was actually signed / payment cleared /
        // refund issued / amendment took effect) rather than email
        // arrival. Pre-fix this would have stamped occurred_at to the
        // moment Bloom processed the HoneyBook notification.
        'honeybook_contract_signed', 'honeybook_payment_received',
        'honeybook_refund', 'honeybook_amendment',
      ])
      const useEventDatetime = TOUR_HAPPENED_KINDS.has(schedulingEvent.kind)
      const schedulingOccurredAt = useEventDatetime
        ? (chooseEventTime(schedulingEvent.eventDatetime, email.date) ?? new Date().toISOString())
        : (chooseEventTime(email.date) ?? new Date().toISOString())
      // Direction: inbound. Tour booked / completed / final walkthrough
      // / contract signed are all couple-side actions or events the
      // couple committed to. Per Playbook 21.4.3 every engagement_event
      // ships with explicit direction at write time.
      await recordEngagementEventsBatch(venueId, weddingId, [{
        eventType,
        metadata: {
          interaction_id: interactionId,
          source: schedulingEvent.source,
          scheduling_kind: schedulingEvent.kind,
          event_datetime: schedulingEvent.eventDatetime,
          email_arrival: email.date,
        },
      }], 'inbound', schedulingOccurredAt, correlationId)

      // Mirror to wedding_touchpoints. Source is the scheduling tool
      // ('calendly' / 'acuity' / etc.), not the wedding's first-touch
      // source — touchpoints record the channel of THIS touch, not the
      // wedding's overall attribution. /intel/sources can decide how to
      // weight that.
      try {
        const { recordTouchpointsForEngagementEvents } = await import('@/lib/services/attribution/touchpoints')
        await recordTouchpointsForEngagementEvents(venueId, weddingId, [{
          eventType,
          source: schedulingEvent.source,
          occurredAt: schedulingOccurredAt,
          metadata: {
            interaction_id: interactionId,
            scheduling_kind: schedulingEvent.kind,
            event_datetime: schedulingEvent.eventDatetime,
            email_arrival: email.date,
          },
        }])
      } catch (err) {
        console.warn('[pipeline] scheduling-event touchpoint write failed:', err)
      }

      // Status advance ladder:
      //   inquiry → tour_scheduled → proposal_sent → booked
      // Never downgrade. Never overwrite terminal (lost/cancelled).
      const targetStatus = eventKindToStatus(schedulingEvent.kind)
      if (targetStatus) {
        const STATUS_RANK: Record<string, number> = {
          inquiry: 0, tour_scheduled: 1, tour_completed: 2, proposal_sent: 3, booked: 4,
          completed: 5, lost: 99, cancelled: 99,
        }
        const { data: currentRow } = await supabase
          .from('weddings')
          .select('status')
          .eq('id', weddingId)
          .maybeSingle()
        const current = (currentRow?.status as string | undefined) ?? 'inquiry'
        const currentRank = STATUS_RANK[current] ?? 0
        const targetRank = STATUS_RANK[targetStatus] ?? 0
        if (currentRank < 99 && targetRank > currentRank) {
          await supabase.from('weddings').update({ status: targetStatus }).eq('id', weddingId)
          // Status-change touchpoint safety net — final_walkthrough /
          // planning_meeting events advance to 'booked' but don't fire
          // a contract_signed engagement event. Without this, /intel/
          // sources can't count a booking against this wedding's source.
          try {
            const { recordStatusChangeTouchpoint } = await import('@/lib/services/attribution/touchpoints')
            await recordStatusChangeTouchpoint(venueId, weddingId, targetStatus, {
              source: schedulingEvent.source,
              occurredAt: schedulingOccurredAt,
              medium: 'email',
              metadata: { interaction_id: interactionId, scheduling_kind: schedulingEvent.kind, email_arrival: email.date },
            })
          } catch (err) {
            console.warn('[pipeline] status-change touchpoint failed:', err)
          }
          // Data-bridge hook (2026-05-26): the mintWedding fire-and-
          // forget mirror only runs on the initial mint. When a wedding
          // later progresses INTO a booked-class status, the couples row
          // either (a) doesn't exist (pre-mirror weddings — 47% gap on
          // prod) or (b) carries the stale lifecycle_state. Re-fire the
          // mirror so the couples bridge stays consistent with the
          // weddings.status ladder. Mirror is idempotent + skips merged-
          // away weddings; safe to fire-and-forget.
          if (
            targetStatus === 'booked' ||
            targetStatus === 'completed' ||
            targetStatus === 'tour_completed'
          ) {
            void (async () => {
              try {
                const { mirrorCoupleFromWedding } = await import(
                  '@/lib/services/identity/mirror-couple'
                )
                await mirrorCoupleFromWedding({
                  venueId,
                  weddingId,
                  supabase,
                  correlationId,
                })
              } catch {
                // Mirror never throws (its contract). Belt-and-braces.
              }
            })()
          }
        }
      }

      // T2-F: HoneyBook refund side effect. Append a friction tag so
      // coordinators see the signal in the kanban friction view and
      // /intel/sources reflects it as a friction hit. Status is NOT
      // auto-flipped to 'lost' (some refunds are partial / followed by
      // re-booking). Coordinator decides via the existing 'lost' flow
      // if appropriate. Idempotent — never duplicates the tag.
      if (schedulingEvent.kind === 'honeybook_refund' && weddingId) {
        try {
          const { data: w } = await supabase
            .from('weddings')
            .select('friction_tags')
            .eq('id', weddingId)
            .maybeSingle()
          const existing = Array.isArray(w?.friction_tags) ? (w!.friction_tags as string[]) : []
          if (!existing.includes('honeybook_refund_received')) {
            await supabase
              .from('weddings')
              .update({ friction_tags: [...existing, 'honeybook_refund_received'] })
              .eq('id', weddingId)
          }
        } catch (err) {
          console.warn('[pipeline] honeybook_refund friction-tag write failed:', err)
        }
      }

      // 2026-05-01 heat-map fix: coordinator alert when a scheduling-
      // tool emits tour_cancelled (Calendly / Acuity / HoneyBook /
      // Dubsado cancel email). Mirrors the signal-inference text-
      // pattern alert. Idempotent via createNotification's 5-minute
      // dedup window per (venue, wedding, type).
      if (schedulingEvent.kind === 'tour_cancelled' && weddingId) {
        try {
          const { createNotification } = await import('@/lib/services/admin-notifications')
          await createNotification({
            venueId,
            weddingId,
            type: 'lead_at_risk',
            title: 'Lead at risk: tour cancelled',
            body:
              `${schedulingEvent.source} reported a tour cancellation. ` +
              `Heat dropped by 15 points. Open the lead and decide next steps ` +
              `(reschedule attempt, re-engagement sequence, or close out).`,
          })
        } catch (err) {
          console.warn('[pipeline] tour_cancelled notification failed:', err)
        }

        // T5-schema-gap (migration 166): flip the matching tours row's
        // outcome to 'cancelled' AND record a structured cancellation
        // reason. Engagement-event side already fired (-15 heat); this
        // closes the loop on the tours table so /intel/tours filters +
        // intel-brain.ts cancellation aggregates see it.
        //
        // Best-effort: never blocks the pipeline. Default reason is
        // 'other' if extraction can't bucket the email body — per spec,
        // don't go overboard on the auto-detection path.
        try {
          const {
            findCancellableTour,
            extractCancellationReason,
          } = await import('@/lib/services/tour/cancellation-reason')
          const tourRow = await findCancellableTour(supabase, {
            venueId,
            weddingId,
            eventDatetime: schedulingEvent.eventDatetime ?? null,
          })
          if (tourRow) {
            const reason = await extractCancellationReason({
              venueId,
              subject: email.subject ?? null,
              body: email.body ?? null,
            })
            await supabase
              .from('tours')
              .update({
                outcome: 'cancelled',
                cancellation_reason: reason,
              })
              .eq('id', tourRow.id)
          }
        } catch (err) {
          console.warn('[pipeline] tours.outcome cancel write failed:', err)
        }
      }
    } catch (err) {
      await logPipelineError(venueId, 'scheduling_tool_event', err, {
        interactionId,
        weddingId,
        schedulingSource: schedulingEvent.source,
        kind: schedulingEvent.kind,
      }, correlationId)
    }
  }

  // Step 6b: Signal inference on the full thread. The classifier is
  // conservative and misses plain-worded tour confirmations, HoneyBook
  // notifications, and contract/payment language — especially when
  // emails come from CRM relays that don't read like natural couple
  // email. applySignalInference runs deterministic regex patterns over
  // every interaction on this wedding and fires any matching events +
  // advances status (inquiry → tour_scheduled → proposal_sent → booked).
  // Idempotent via metadata.source markers so re-running doesn't
  // duplicate events. Best-effort — never block the pipeline on failure.
  if (weddingId) {
    try {
      await applySignalInference(venueId, weddingId)
    } catch (err) {
      await logPipelineError(venueId, 'signal_inference', err, {
        interactionId,
        weddingId,
      }, correlationId)
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
    }, correlationId)
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
    }, correlationId)
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
    // Mig 303 (2026-05-11): when this email fired escalation_requested
    // AND the inbound is tied to a wedding, promote the per-email
    // signal into a sticky per-couple opt-out. The next inbound from
    // this couple gets gated regardless of its content. Also cancels
    // any pending drafts.
    if (escalationRequested && weddingId) {
      try {
        const { markWeddingAiOptedOut } = await import('./draft-skip-gates')
        const result = await markWeddingAiOptedOut({
          supabase,
          weddingId,
          reason: escalationReason
            ? `escalation:${escalationReason}`
            : 'escalation_detected',
        })
        log.info('pipeline.ai_opted_out_set', {
          event_type: 'escalation.couple_opt_out',
          outcome: 'ok',
          data: {
            weddingId,
            updated: result.updated,
            draftsCancelled: result.draftsCancelled,
            reason: escalationReason,
          },
        })
      } catch (err) {
        console.warn('[pipeline] mark ai_opted_out failed (non-fatal):', err)
      }
    }

    // Tour-welcome draft for Calendly / Acuity tour bookings (2026-05-12).
    // The Calendly notification itself is a system email — we correctly
    // skip drafting a reply to notifications@calendly.com. But the
    // *couple* booking the tour deserves a warm welcome + prep email
    // to their actual address. Trigger that here (only for the positive
    // tour_scheduled kind — not for cancels or reschedules). Inquiry-
    // brain v1.4 reads the CURRENT TOUR STATE block from engagement_events
    // so the draft references the upcoming tour by date rather than
    // suggesting "book a tour".
    if (
      schedulingEvent &&
      weddingId &&
      schedulingEvent.kind === 'tour_scheduled' &&
      schedulingEvent.inviteeEmail
    ) {
      const inviteeEmail = schedulingEvent.inviteeEmail
      const inviteeName = (schedulingEvent.inviteeName ?? '').trim() || null
      // Synthetic inquiry body conveying the booking action in the
      // couple's voice. Inquiry-brain treats this as fresh outreach
      // from the couple; the CURRENT TOUR STATE line carries the real
      // date/time signal so the draft anchors to the booked visit
      // rather than re-pitching the tour.
      const synthBody = inviteeName
        ? `Hi Rixey Manor! This is ${inviteeName} — I just booked a venue tour through your Calendly. Looking forward to seeing the space!`
        : `Hi Rixey Manor! I just booked a venue tour through your Calendly. Looking forward to seeing the space!`
      const synthSubject = 'Tour booked'

      try {
        const result = await generateInquiryDraft({
          venueId,
          contactEmail: inviteeEmail,
          inquiry: {
            from: inviteeEmail,
            subject: synthSubject,
            body: synthBody,
          },
          extractedData: {
            questions: [],
          },
          taskType: 'new_inquiry',
          source: schedulingEvent.source ?? detectedSource,
          receivedAtAddress,
          weddingId,
          correlationId,
        })

        if (result.draft && result.draft.trim().length > 0) {
          const { data: draftRow, error: draftErr } = await supabase
            .from('drafts')
            .insert({
              venue_id: venueId,
              wedding_id: weddingId,
              interaction_id: interactionId,
              to_email: inviteeEmail,
              subject: `Welcome — your Rixey Manor tour`,
              draft_body: result.draft,
              original_sage_body: result.draft,
              confidence_score: result.confidence,
              status: 'pending',
              context_type: 'inquiry',
              brain_used: 'inquiry',
              prompt_version_used: INQUIRY_BRAIN_PROMPT_VERSION,
              correlation_id: correlationId,
              auto_sent: false,
            })
            .select('id')
            .single()

          if (draftErr) {
            log.warn('pipeline.tour_welcome_draft_insert_failed', {
              event_type: 'tour_welcome',
              outcome: 'fail',
              data: {
                interactionId,
                weddingId,
                inviteeEmail,
                error: draftErr.message,
              },
            })
          } else {
            log.info('pipeline.tour_welcome_draft_created', {
              event_type: 'tour_welcome',
              outcome: 'ok',
              data: {
                interactionId,
                weddingId,
                inviteeEmail,
                draftId: draftRow?.id,
                confidence: result.confidence,
              },
            })
          }
        }
      } catch (err) {
        log.warn('pipeline.tour_welcome_draft_failed', {
          event_type: 'tour_welcome',
          outcome: 'fail',
          data: {
            interactionId,
            weddingId,
            inviteeEmail,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }

    return {
      interactionId,
      draftId: null,
      classification: emailClassification,
      autoSent: false,
    }
  }

  // Mig 303 (2026-05-11): pre-brain skip gates — sticky per-couple
  // ai_opted_out + per-thread operator-handling check. Runs AFTER the
  // interaction is persisted (so the intel layer still sees the inbound)
  // but BEFORE the brain is dispatched (so we don't burn tokens on a
  // draft we'd reject anyway). Gate decisions are logged + can surface
  // on the lead detail page.
  try {
    const { evaluateDraftSkipGates } = await import('./draft-skip-gates')
    const gateDecision = await evaluateDraftSkipGates({
      supabase,
      venueId,
      weddingId,
      gmailThreadId: email.threadId ?? null,
    })
    if (gateDecision.skip) {
      log.info('pipeline.draft_skip_gate', {
        event_type: 'draft.skip_gate',
        outcome: 'ok',
        data: {
          weddingId,
          threadId: email.threadId,
          reason: gateDecision.reason,
          message: gateDecision.message,
          triggeringOutboundAt: gateDecision.triggeringOutboundAt,
        },
      })
      return {
        interactionId,
        draftId: null,
        classification: emailClassification,
        autoSent: false,
      }
    }
  } catch (err) {
    console.warn('[pipeline] draft skip-gate evaluation failed (non-fatal):', err)
  }

  // ---------------------------------------------------------------------
  // Lifecycle gate (migration 246).
  // ---------------------------------------------------------------------
  //
  // Two ways an outbound draft is suppressed:
  //
  //   (1) The wedding row is in a terminal state (lost / cancelled /
  //       completed). Replying to a couple who has explicitly closed
  //       the door produces the Naina Davidar regression -- a chirpy
  //       "I'd love to learn more about your celebration!" answer to a
  //       "decided to close the conversation" message. Skip the draft
  //       entirely. The interaction row is preserved (intel still
  //       counts the message) but Sage stays silent.
  //
  //   (2) The most recent inbound on the thread carries a loss signal
  //       (lead_declined / going_with_other / silent_close), even if
  //       the wedding row hasn't yet transitioned. The detector + writer
  //       are eventually-consistent: if the AI just emitted
  //       'lead_declined' and the engine accepted the transition, the
  //       row IS lost by the time we reach this gate. But we still
  //       hand-check the per-message signal so a partial failure
  //       (UPDATE failed, event log succeeded) doesn't ship a draft.
  //
  // Skip is logged but does NOT affect classification / heat / intel --
  // those layers still process the message normally. The skip is
  // strictly about the outbound side.
  if (weddingId) {
    try {
      const { data: w } = await supabase
        .from('weddings')
        .select('status')
        .eq('id', weddingId)
        .maybeSingle()
      const currentStatus = (w?.status as string | undefined) ?? null
      if (isTerminalStatus(currentStatus)) {
        log.info('pipeline.draft_gated_terminal_status', {
          event_type: 'lifecycle_gate',
          outcome: 'skip',
          data: { interactionId, weddingId, currentStatus },
        })
        return {
          interactionId,
          draftId: null,
          classification: emailClassification,
          autoSent: false,
        }
      }
    } catch {
      // Read failure on the gate is fatal for safety -- if we can't
      // verify the wedding is non-terminal, skip the draft. Better to
      // miss a reply than to ship one to a closed lead.
      log.warn('pipeline.draft_gate_read_failed', {
        event_type: 'lifecycle_gate',
        outcome: 'fail',
        data: { interactionId, weddingId },
      })
      return {
        interactionId,
        draftId: null,
        classification: emailClassification,
        autoSent: false,
      }
    }
  }
  if (lifecycleSignalDetected && isLossSignal(lifecycleSignalDetected)) {
    log.info('pipeline.draft_gated_loss_signal', {
      event_type: 'lifecycle_gate',
      outcome: 'skip',
      data: {
        interactionId,
        weddingId,
        signal: lifecycleSignalDetected,
      },
    })
    return {
      interactionId,
      draftId: null,
      classification: emailClassification,
      autoSent: false,
    }
  }

  // ---------------------------------------------------------------------
  // Knot per-prospect personId draft-suppression gate (2026-05-27).
  // ---------------------------------------------------------------------
  //
  // Operator-reported (Tara Simpson + 6 others): The Knot sends 3+
  // separate emails per inquiry, each in its own Gmail thread, from
  //   <name>.<seq>.<personId>(.reminder)?@member.theknot.com
  // The personId is stable across all variants of the same prospect.
  // The identity cascade now stage-1b-matches on that token, but in
  // practice some Knot reminders still arrive before the legacy people
  // row has been alias-merged (the merge sweep runs on cron), and the
  // pipeline would otherwise generate a fresh draft for every variant
  // — flooding the operator inbox with duplicate Sage replies.
  //
  // Suppress: if the inbound is from a recognised Knot per-prospect
  // relay, AND we already have a draft (pending / approved / sent /
  // auto-send-pending) to THIS personId in the last 7 days, skip the
  // brain call. The first draft from the initial inquiry is the one
  // the operator acts on; the reminders are platform-side noise that
  // should not earn additional Sage replies.
  //
  // The 7-day window is shorter than `OPERATOR_HANDLING_WINDOW_DAYS`
  // (also 7d in draft-skip-gates.ts) on purpose: Knot reminders trail
  // the initial inquiry by 2-5 days; anything beyond a week probably
  // IS a fresh prospect inquiry from the same person and deserves a
  // fresh reply.
  const knotPersonId = extractKnotPersonId(rawFromEmail)
  if (knotPersonId) {
    try {
      const sevenDaysAgoIso = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString()
      const { data: knotPriorDrafts } = await supabase
        .from('drafts')
        .select('id, to_email, status, created_at')
        .eq('venue_id', venueId)
        .in('status', ['pending', 'approved', 'auto_send_pending', 'sent'])
        .gte('created_at', sevenDaysAgoIso)
        .or(
          // Knot relay variants end in @member.theknot.com. Filter at
          // the DB layer to keep the candidate set tiny; the personId
          // equality is enforced in-process below.
          `to_email.like.%@member.theknot.com,to_email.like.%.${knotPersonId}@member.theknot.com,to_email.like.%.${knotPersonId}.reminder@member.theknot.com`,
        )
        .limit(50)
      const samePersonDraft = (knotPriorDrafts ?? []).find((row) => {
        const toEmail = (row.to_email as string | null) ?? null
        return extractKnotPersonId(toEmail) === knotPersonId
      })
      if (samePersonDraft) {
        log.info('pipeline.draft_suppressed_knot_person_id', {
          event_type: 'draft_gate',
          outcome: 'skip',
          data: {
            interactionId,
            weddingId,
            knotPersonId,
            sender: rawFromEmail,
            priorDraftId: (samePersonDraft as { id: string }).id,
            priorDraftStatus:
              (samePersonDraft as { status: string }).status,
            priorDraftCreatedAt:
              (samePersonDraft as { created_at: string }).created_at,
            reason:
              'Knot per-prospect personId already has a recent draft; suppressing duplicate Sage reply on a Knot reminder/nudge variant.',
          },
        })
        return {
          interactionId,
          draftId: null,
          classification: emailClassification,
          autoSent: false,
        }
      }
    } catch (err) {
      // Non-fatal: a query failure must not block the legitimate draft
      // path for non-Knot prospects. Log and fall through.
      console.warn(
        '[pipeline] knot person-id dedup check failed (non-fatal):',
        err instanceof Error ? err.message : err,
      )
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
        // Tell Sage which inbox received the inquiry so it can reference
        // the correct address for multi-Gmail venues.
        receivedAtAddress,
        // Wave 1A (2026-05-09): pass the wedding so inquiry-brain can
        // load wedding_auto_context and reflect any soft-context the
        // venue has already learned about this couple in their first
        // reply. Optional in the InquiryDraftOptions contract — the
        // test harness and admin entry points may invoke without one.
        weddingId,
        correlationId,
      })

      draftBody = inquiryResult.draft
      confidenceScore = inquiryResult.confidence
      brainUsed = 'inquiry'
    } catch (err) {
      await logPipelineError(venueId, 'inquiry_brain', err, {
        interactionId,
        fromEmail,
        classification: emailClassification,
      }, correlationId)
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
          // Tell Sage which inbox received the message.
          receivedAtAddress,
          correlationId,
          // Wave 27: thread the inbound interaction id into the draft
          // pipeline so the knowledge-gap detector can skip platform_system
          // / sage authored inbounds.
          interactionId,
        })

        draftBody = clientResult.draft
        confidenceScore = clientResult.confidence
        brainUsed = 'client'
      } catch (err) {
        await logPipelineError(venueId, 'client_brain', err, {
          interactionId,
          weddingId,
          fromEmail,
        }, correlationId)
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
    // 2026-05-12 — refuse to mint a draft when the reply target is
    // unsendable. Before this guard, WW shared-relay inbounds (no
    // personal email + no per-prospect relay) generated drafts to
    // `authsolic-…@weddingwire.bloom-relay.invalid` that sat in pending
    // forever — autonomous sender refused `.invalid` at send time, but
    // the inbox UI still surfaced "Replying to authsolic-…invalid" on
    // every visit (Zack Hunter, May 12). Better to skip the draft and
    // surface a coordinator nudge to reply via the platform dashboard.
    if (isUnsendableAddress(replyTargetEmail)) {
      log.info('pipeline.draft_skipped_unsendable_target', {
        event_type: 'draft_gate',
        outcome: 'skip',
        data: {
          interactionId,
          weddingId,
          replyTargetEmail,
          source: detectedSource,
        },
      })
      return {
        interactionId,
        draftId: null,
        classification: emailClassification,
        autoSent: false,
      }
    }
    const contextType = brainUsed === 'client' ? 'client' : 'inquiry'

    const promptVersionUsed =
      brainUsed === 'client' ? CLIENT_BRAIN_PROMPT_VERSION : INQUIRY_BRAIN_PROMPT_VERSION
    // Dual-route Cc (mig 378, 2026-05-28): form-relay parsers may surface
    // BOTH a personal email and a per-prospect platform relay (Knot is the
    // primary case — body carries "Personal email:" alongside the
    // <prospect>.<slug>@member.theknot.com From). The primary recipient
    // (to_email) is the personal email when known, and the relay rides
    // on cc_emails so the conversation also lands in the platform's
    // dashboard inbox for the couple.
    const ccEmailsForInsert: string[] | null =
      formLead?.ccEmails && formLead.ccEmails.length > 0 ? formLead.ccEmails : null

    const { data: draft } = await supabase
      .from('drafts')
      .insert({
        venue_id: venueId,
        wedding_id: weddingId,
        interaction_id: interactionId,
        to_email: replyTargetEmail,
        cc_emails: ccEmailsForInsert,
        subject: draftSubject,
        draft_body: draftBody,
        // Wave 26 (mig 292): preserve the LLM's first-pass output so a
        // subsequent operator edit can be diffed against it. Stamped
        // only on the initial INSERT; never overwritten downstream.
        original_sage_body: draftBody,
        status: 'pending',
        context_type: contextType,
        brain_used: brainUsed,
        confidence_score: confidenceScore,
        auto_sent: false,
        prompt_version_used: promptVersionUsed,
        correlation_id: correlationId,
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
        const { checkAutoSendEligible } = await import('@/lib/services/email/autonomous-sender')
        const { containsInjectionAttempt } = await import('@/lib/security/prompt-sanitize')

        // Round-2 audit follow-up #36: detect prompt-injection on the
        // raw inbound. inquiry-brain.ts already wraps the body for
        // model safety, but a hostile inquirer could still try to
        // hijack the auto-reply. Pass the signal through to the
        // eligibility check, which blocks auto-send when set.
        const subjectInjection = containsInjectionAttempt(email.subject)
        const bodyInjection = containsInjectionAttempt(email.body)
        const injectionSuspected = subjectInjection || bodyInjection

        // Round-3 audit follow-up #48: persist the signal on the
        // wedding so follow-up sequences (which fire later, on a
        // schedule, with no fresh inbound) also block auto-send.
        // Stamp once — leave existing value alone if already set
        // (multiple injection-flagged inbounds shouldn't overwrite
        // the original timestamp / reason).
        if (injectionSuspected && weddingId) {
          const reason = subjectInjection ? 'injection_subject' : 'injection_body'
          await supabase
            .from('weddings')
            .update({
              auto_send_blocked_at: new Date().toISOString(),
              auto_send_block_reason: reason,
            })
            .eq('id', weddingId)
            .is('auto_send_blocked_at', null)
        }

        // Confidence scale conversion now happens INSIDE
        // checkAutoSendEligible (Repair K, 2026-05-01). Pass raw
        // brain output; the function normalises 0-100 → 0.0-1.0
        // automatically.
        const eligibility = await checkAutoSendEligible(venueId, {
          contextType,
          confidenceScore: confidenceScore ?? 0,
          source: detectedSource,
          threadId: email.threadId,
          // Direction is required (Repair K). Always 'inbound' on this
          // path — the calling site only fires for inbound classifications.
          direction: 'inbound',
          weddingId: weddingId ?? undefined,
          injectionSuspected,
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
            }, correlationId)
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
                // Pass the inbound connectionId so flushPendingAutoSends
                // can reply FROM the same Gmail account that received the
                // inquiry (multi-Gmail fix).
                connectionId: email.connectionId ?? null,
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
        }, correlationId)
      }
    }
  }

  // Wave 4 Phase 2 — signal-driven identity reconstruction enqueue.
  // After every successful pipeline tick that resolved a wedding_id,
  // enqueue a reconstruction job (24h dedupe per wedding lives inside
  // the helper). The cron sweep at /api/cron?job=identity_judge_sweep
  // drains the queue. trigger_signal=calculator_submit when the form-
  // relay parser identified a calculator submission, otherwise
  // new_email — gives the operability dashboards a per-signal
  // breakdown of "what kicks the most rebuilds".
  //
  // Fire-and-forget contract: enqueueIdentityReconstruction never
  // throws; we still wrap in try/catch as belt-and-suspenders so any
  // future regression cannot fail the email-pipeline response.
  if (weddingId) {
    try {
      const triggerSignal =
        formLead?.source === 'venue_calculator' ? 'calculator_submit' : 'new_email'
      const { enqueueIdentityReconstruction } = await import(
        '@/lib/services/identity/enqueue-reconstruction'
      )
      await enqueueIdentityReconstruction({
        weddingId,
        venueId,
        triggerSignal,
      })
    } catch (err) {
      console.warn(
        '[pipeline] identity-reconstruction enqueue failed (non-fatal):',
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Phase C Forwards Linker — the cascade write into the new identity
  // schema (couples/touchpoints/fragments). Doctrine anchor:
  // IDENTITY-FIRST-ARCHITECTURE.md §4. Phase 1 §1.1 / §P5 PROMOTION
  // (2026-05-22): this was shadow — its LinkResult was discarded and
  // every error was swallowed. It is now LOAD-BEARING: the result is
  // captured + observable and a failure is surfaced to error_logs.
  // It still does NOT throw out of the pipeline — during the Phase 1
  // dual-write window the legacy tables remain the source of truth, so
  // a cascade hiccup must not fail the email tick. Divergence between
  // the cascade binding and the legacy weddingId is the job of the
  // shadow-compare harness (scripts/shadow-compare.ts), not this path.
  if (interactionId) {
    try {
      const { linkSignal } = await import('@/lib/services/identity/forwards-linker')
      const { emailToNormalizedSignal } = await import(
        '@/lib/services/identity/email-to-signal'
      )
      // 2026-05-26 — relay-resolved identity override (operator-impact
      // fix, Glascow Tennille trace). M1 main inbound write. For
      // relay-resolved emails (calculator submissions, Calendly-via-
      // Gmail forwards, Knot/WW/Zola inquiries) the raw From header
      // is the venue's OWN address — feeding that into the matcher
      // collapsed unrelated prospects under one venue-self identity.
      // Prefer formLead / schedulingEvent identity when present;
      // channelOverride + actionTypeOverride route the cascade
      // touchpoint to the canonical relay channel + verb. Genuine
      // inbound (no relay) leaves resolved* null and keeps legacy
      // raw-From behaviour byte-identical.
      const linkResult = await linkSignal({
        supabase,
        venueId,
        signal: emailToNormalizedSignal({
          email,
          interactionId,
          emailDate,
          rawFromName,
          rawFromEmail,
          draftId,
          weddingId,
          // formLead wins over schedulingEvent (matches the identity-
          // priority order at pipeline.ts:1277-1281 for fromEmail).
          resolvedEmail: formLead?.leadEmail ?? schedulingEvent?.inviteeEmail ?? null,
          resolvedName: formLead?.leadName ?? schedulingEvent?.inviteeName ?? null,
          resolvedPhone: schedulingEvent?.extras?.phone ?? null,
          // Channel + verb override for relay-resolved signals so
          // progression.ts dispatches the right event_type (a Calendly
          // tour_booked under channel='calendly' lands as
          // 'tour_booked'; a calculator submission under
          // channel='website' + action='inquiry_form_submitted' lands
          // as 'new_channel_inquiry'). For schedulingEvent, the
          // SchedulingToolSource values 'calendly'|'acuity'|'honeybook'
          // |'dubsado' map directly to channel taxonomy keys; the
          // event-kind→action mapping below covers tour_scheduled vs
          // contract_signed vs final_walkthrough etc.
          channelOverride: formLead
            ? formLeadSourceToChannel(formLead.source)
            : schedulingEvent
              ? schedulingEvent.source
              : undefined,
          actionTypeOverride: formLead
            ? formLeadSourceToActionType(formLead.source)
            : schedulingEvent
              ? schedulingEventKindToAction(schedulingEvent.kind)
              : undefined,
        }),
        correlationId,
        source: 'live:email',
      })
      console.log(
        `[pipeline] cascade_link: action=${linkResult.action} ` +
          `couple=${linkResult.matched_couple_id ?? 'none'} ` +
          `tier=${linkResult.tier ?? 'none'} touchpoint=${linkResult.touchpoint_id ?? 'none'}`,
      )
    } catch (err) {
      // Promotion: the cascade write is load-bearing — a failure is
      // surfaced to error_logs (not just the linker's tracer_run_events
      // row) so it shows in pipeline error telemetry. Still caught: the
      // legacy path must not break on a linker hiccup during dual-write.
      await logPipelineError(venueId, 'cascade_link', err, { interactionId }, correlationId)
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

  // Cost-ceiling circuit breaker (OPS-21.4.3). If autonomous_paused
  // flipped between draft creation and now, refuse to flush — drafts
  // remain queued and the coordinator either approves manually or
  // resumes the venue. Eligibility check at draft-time also blocks
  // new auto_send_pending creation; this catches the in-flight case.
  const { isAutonomousPaused } = await import('@/lib/services/cost-ceiling')
  if (await isAutonomousPaused(venueId)) {
    return 0
  }

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
      connectionId?: string | null
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

        // Sage email auto-attach (migration 244). Wrapped so a matcher
        // failure cannot block the autonomous send. The function gates
        // on venue_config.auto_attach_photos itself.
        let attachments: EmailAttachment[] = []
        try {
          // Pull the inbound body off the draft's interaction so the
          // matcher can reason about what the couple actually asked.
          const { data: draftRow } = await supabase
            .from('drafts')
            .select('interaction_id, correlation_id')
            .eq('id', draft.id)
            .maybeSingle()
          let inboundBody = ''
          let inboundSubject: string | null = details.subject ?? null
          if (draftRow?.interaction_id) {
            const { data: interaction } = await supabase
              .from('interactions')
              .select('full_body, body_preview, subject')
              .eq('id', draftRow.interaction_id)
              .maybeSingle()
            inboundBody = (interaction?.full_body as string)
              ?? (interaction?.body_preview as string)
              ?? ''
            inboundSubject = (interaction?.subject as string) ?? inboundSubject
          }

          attachments = await buildAutoAttachments({
            venueId,
            correlationId: (draftRow?.correlation_id as string | null) ?? null,
            inboundSubject,
            inboundBody,
            replyDraft: draft.draft_body,
            maxAttachments: 2,
          })
        } catch (matchErr) {
          console.warn(
            '[pipeline] auto-attach build failed (continuing without attachments):',
            matchErr instanceof Error ? matchErr.message : matchErr,
          )
          attachments = []
        }

        // 2026-05-11: pre-flight synthetic-address gate. Mark draft
        // `needs_real_address` so the operator sees it on the pending
        // tab with a "fix the address" banner. Status stays 'pending' —
        // the auto-send loop won't retry (the flag is checked above), and
        // the manual /agent/send path will surface the 422 specifically.
        if (isUnsendableAddress(details.toEmail)) {
          await supabase
            .from('drafts')
            .update({ needs_real_address: true })
            .eq('id', draft.id)
          sendError = new Error('needs_real_address')
        } else {
          sentMessageId = await sendEmail(
            venueId,
            details.toEmail,
            details.subject,
            appendAIDisclosure(draft.draft_body, disclosureCtx),
            details.threadId,
            // Use the inbound connection so the reply comes from the
            // same Gmail account that received the original inquiry.
            details.connectionId ?? undefined,
            attachments.length > 0 ? attachments : undefined,
          )
        }
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

        // C3 fix (PHASE-1-BATCH-1 remediation, 2026-05-23): the autonomous
        // send is the THIRD outbound codepath that produces a venue-sent
        // email — alongside M6 (`isOwnOutbound` self-loop) and M7
        // (`sendApprovedDraft`). The Batch-1 worklist enumerated 9 MIGRATE
        // sites but missed this one; both writes are added here.
        //
        // (1) LEGACY interactions row (pre-existing gap, NOT just a Batch-1
        //     miss): flushPendingAutoSends previously wrote draft
        //     status='sent' but produced NO `interactions` row. Multiple
        //     readers depend on outbound interactions to function
        //     correctly:
        //       - `follow-up-sequences.ts:179` queries the latest
        //         outbound interaction for `daysSinceContact` — without
        //         this row a venue's nurture cron re-fires day-0
        //         follow-ups after an autonomous send.
        //       - `signal-inference.ts:388` reads `direction='outbound'`
        //         to dedup signals against the venue's own sends.
        //       - `voice-dna-extract.ts:153` filters outbound rows for
        //         the coordinator-voice corpus (the existing subject-
        //         heuristic anti-Sage filter already accounts for this
        //         row's eventual presence).
        //       - `intel/clients/[id]` thread view shows outbound rows
        //         in the email timeline.
        //     The legacy direct write here matches M7 (`sendApprovedDraft`
        //     :5169-5186) byte-for-byte except for `auto_sent` semantics
        //     (M7 is operator-approved, not auto). `signal_class:
        //     'unclassified'` matches both M6 and M7's outbound rule.
        //     wedding_id stays null (M7 also writes null) — the cascade
        //     write (2) carries the couple-binding context separately.
        //
        // (2) CASCADE linkSignal (Batch-1 miss): mirrors M6/M7's pattern
        //     — pull the parent inbound interaction's `wedding_id` +
        //     `correlation_id` to anchor the touchpoint to the same
        //     couple the draft was written for. `action_type:
        //     'venue_sent'` + `signal_tier:'medium'` per the M7 doctrine
        //     comment (outbound venue mail is not couple progression).
        //     `external_id` = the Gmail message id so a later Tracer
        //     sweep dedups against this live touchpoint.
        //
        // Both writes catch + logPipelineError; never throw out of the
        // flush loop. The draft status='sent' update above already
        // committed, so a cascade/legacy failure here is a telemetry hole
        // (auditable via error_logs) but does not double-send.
        let parentWeddingId: string | null = null
        let parentCorrelationId: string | null = null
        let parentInteractionId: string | null = null
        try {
          const { data: draftRow } = await supabase
            .from('drafts')
            .select('interaction_id')
            .eq('id', draft.id)
            .maybeSingle()
          parentInteractionId = (draftRow?.interaction_id as string | null) ?? null
          if (parentInteractionId) {
            const { data: parent } = await supabase
              .from('interactions')
              .select('wedding_id, correlation_id')
              .eq('id', parentInteractionId)
              .maybeSingle()
            parentWeddingId = (parent?.wedding_id as string | null) ?? null
            parentCorrelationId = (parent?.correlation_id as string | null) ?? null
          }
        } catch (err) {
          // Parent-context lookup is best-effort. A miss degrades both
          // writes to "unbound outbound" (legacy: wedding_id:null, same
          // shape as M7; cascade: linker resolves identity itself).
          console.warn(
            '[pipeline] flushPendingAutoSends: parent-interaction lookup failed:',
            err instanceof Error ? err.message : err,
          )
        }

        // (1) Legacy interactions row — outbound mirror.
        let outboundInteractionId: string | null = null
        try {
          const outboundPayload: Record<string, unknown> = {
            venue_id: venueId,
            wedding_id: null,
            type: 'email',
            direction: 'outbound',
            subject: details.subject,
            body_preview: (draft.draft_body as string).slice(0, 300),
            full_body: draft.draft_body,
            to_email: details.toEmail,
            gmail_message_id: sentMessageId,
            gmail_thread_id: details.threadId ?? null,
            timestamp: nowIso,
            signal_class: 'unclassified',
          }
          if (parentCorrelationId) outboundPayload.correlation_id = parentCorrelationId
          const { data: outboundRow } = await supabase
            .from('interactions')
            .insert(outboundPayload)
            .select('id')
            .single()
          outboundInteractionId = (outboundRow?.id as string | null) ?? null
        } catch (err) {
          await logPipelineError(venueId, 'autosend_outbound_interaction', err, {
            draftId: draft.id,
            sentMessageId,
            notificationId: notif.id,
          }, parentCorrelationId ?? undefined)
        }

        // (2) Cascade write — same shape as M6/M7. Skips when the legacy
        //     write failed (no interactionId to thread through the
        //     adapter's raw_payload); the cascade still works without it
        //     but losing the linkage is worse than losing the telemetry,
        //     so we prefer to fail loud via the logPipelineError above.
        if (outboundInteractionId) {
          try {
            const { linkSignal } = await import('@/lib/services/identity/forwards-linker')
            const { emailToNormalizedSignal } = await import(
              '@/lib/services/identity/email-to-signal'
            )
            const linkResult = await linkSignal({
              supabase,
              venueId,
              signal: emailToNormalizedSignal({
                email: {
                  messageId: sentMessageId,
                  threadId: details.threadId ?? null,
                  subject: details.subject ?? null,
                },
                interactionId: outboundInteractionId,
                emailDate: nowIso,
                // Outbound: no inbound sender identity. The couple is
                // resolved via the parent wedding anchor hint.
                rawFromName: null,
                rawFromEmail: null,
                draftId: draft.id,
                weddingId: parentWeddingId,
                actionType: 'venue_sent',
                signalTier: 'medium',
              }),
              correlationId: parentCorrelationId ?? undefined,
              source: 'live:autosend_flush',
            })
            console.log(
              `[pipeline] cascade_link (autosend flush): action=${linkResult.action} ` +
                `couple=${linkResult.matched_couple_id ?? 'none'} ` +
                `touchpoint=${linkResult.touchpoint_id ?? 'none'}`,
            )
          } catch (err) {
            // Load-bearing dual-write, same contract as M1/M6/M7
            // linkSignal calls: surface to error_logs but never throw —
            // the draft status='sent' update + the legacy interactions
            // row above remain source of truth during dual-write.
            await logPipelineError(venueId, 'cascade_link', err, {
              interactionId: outboundInteractionId,
              draftId: draft.id,
            }, parentCorrelationId ?? undefined)
          }
        }

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

  // Create feedback record for learning. Schema reality (per migration
  // 002 + 156): action / original_body / edited_body / rejection_reason
  // / coordinator_edits / metadata (jsonb). Subject + email category go
  // in metadata. T5-α.1 fix: previous writer used non-existent columns
  // and silently failed.
  await supabase.from('draft_feedback').insert({
    venue_id: draft.venue_id,
    draft_id: draftId,
    action: 'approved',
    original_body: draft.draft_body ?? '',
    metadata: {
      original_subject: draft.subject ?? '',
      email_category: draft.context_type ?? 'inquiry',
    },
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

  // Create feedback record for learning. T5-α.1 fix: schema columns
  // are action / original_body / rejection_reason / metadata (jsonb).
  await supabase.from('draft_feedback').insert({
    venue_id: draft.venue_id,
    draft_id: draftId,
    action: 'rejected',
    original_body: draft.draft_body ?? '',
    rejection_reason: reason ?? null,
    metadata: {
      original_subject: draft.subject ?? '',
      email_category: draft.context_type ?? 'inquiry',
    },
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

  // Fetch the draft (need original body for feedback + analyzer baseline).
  // Wave 26: read original_sage_body so the diff analyzer compares
  // against Sage's first output, not whatever draft_body currently holds
  // (which might already include earlier operator edits in legacy
  // pre-Wave-26 flows).
  const { data: draft, error: fetchError } = await supabase
    .from('drafts')
    .select('id, venue_id, draft_body, original_sage_body, subject, context_type, interaction_id')
    .eq('id', draftId)
    .single()

  if (fetchError || !draft) {
    throw new Error(`Draft not found: ${draftId}`)
  }

  const originalBody = draft.draft_body as string
  // For the Wave 26 analyzer baseline, prefer the preserved
  // original_sage_body. Legacy rows without it fall back to the
  // current draft_body (which means: nothing to learn yet; the
  // analyzer will skip).
  const sageBaseline =
    (draft.original_sage_body as string | null | undefined) ?? originalBody

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

  // Create feedback record with both original and edited. T5-α.1 fix:
  // schema columns are action / original_body / edited_body / metadata
  // (jsonb). Previous writer used non-existent feedback_type +
  // original_subject + email_category and silently failed every time.
  await supabase.from('draft_feedback').insert({
    venue_id: draft.venue_id,
    draft_id: draftId,
    action: 'edited',
    original_body: originalBody,
    edited_body: editedBody,
    metadata: {
      original_subject: draft.subject ?? '',
      email_category: draft.context_type ?? 'inquiry',
    },
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

  // Wave 26 — fire the diff analyzer. Best-effort: never block the
  // approve flow on LLM failure. Insights land in draft_edit_insights
  // and (when appropriate) voice_preferences / knowledge_captures. The
  // operator-facing toast reads from draft_edit_insights via the
  // /api/agent/drafts/[id]/insights endpoint.
  if (sageBaseline && sageBaseline !== editedBody && draft.venue_id) {
    try {
      const { analyzeAndPersistDraftEdit } = await import(
        '@/lib/services/draft-learning/analyze-edit'
      )
      await analyzeAndPersistDraftEdit({
        draftId,
        venueId: draft.venue_id as string,
        originalSageBody: sageBaseline,
        editedBody,
        inboundSubject: (draft.subject as string) ?? null,
      })
    } catch (err) {
      console.warn(
        '[pipeline] Wave 26 analyzer failed (continuing approve flow):',
        err instanceof Error ? err.message : err,
      )
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
    .select('id, venue_id, to_email, cc_emails, subject, draft_body, status, interaction_id')
    .eq('id', draftId)
    .single()

  if (fetchError || !draft) {
    throw new Error(`Draft not found: ${draftId}`)
  }

  if (draft.status !== 'approved') {
    throw new Error(`Draft ${draftId} is not approved (status: ${draft.status})`)
  }

  // Get the thread ID and inbound connectionId from the original interaction.
  // The connectionId ensures the reply goes out FROM the same Gmail account
  // that received the inquiry (multi-Gmail fix).
  //
  // M7 flip (2026-05-22): also pull the original interaction's
  // `wedding_id` + `correlation_id` here so the cascade write below can
  // (a) anchor the outbound touchpoint to the couple via the legacy
  // wedding binding and (b) thread the same correlation id through the
  // linker's telemetry. `sendApprovedDraft` itself writes the new
  // outbound interaction with `wedding_id:null`, but the draft's PARENT
  // inbound interaction is wedding-bound — that is the context to carry.
  let threadId: string | undefined
  let inboundConnectionId: string | undefined
  let parentWeddingId: string | null = null
  let parentCorrelationId: string | null = null
  if (draft.interaction_id) {
    const { data: interaction } = await supabase
      .from('interactions')
      .select('gmail_thread_id, gmail_connection_id, wedding_id, correlation_id')
      .eq('id', draft.interaction_id)
      .single()

    threadId = (interaction?.gmail_thread_id as string) ?? undefined
    inboundConnectionId = (interaction?.gmail_connection_id as string) ?? undefined
    parentWeddingId = (interaction?.wedding_id as string | null) ?? null
    parentCorrelationId = (interaction?.correlation_id as string | null) ?? null
  }

  // Send via Gmail. Approved drafts MUST go through the venue's authenticated
  // Gmail — the whole product premise is that replies come from the
  // coordinator's own inbox. No transactional fallback here by design.
  // AI disclosure is enforced at the send boundary regardless of approval path.
  const disclosureCtx = await fetchDisclosureContext(draft.venue_id as string)

  // Sage email auto-attach (migration 244). Wrapped so a matcher failure
  // cannot block coordinator-approved sends. The matcher gates on
  // venue_config.auto_attach_photos itself.
  let attachments: EmailAttachment[] = []
  try {
    let inboundBody = ''
    let inboundSubject: string | null = (draft.subject as string) ?? null
    let approvedCorrelationId: string | null = null
    if (draft.interaction_id) {
      const { data: interaction } = await supabase
        .from('interactions')
        .select('full_body, body_preview, subject, correlation_id')
        .eq('id', draft.interaction_id)
        .maybeSingle()
      inboundBody = (interaction?.full_body as string)
        ?? (interaction?.body_preview as string)
        ?? ''
      inboundSubject = (interaction?.subject as string) ?? inboundSubject
      approvedCorrelationId = (interaction?.correlation_id as string) ?? null
    }
    attachments = await buildAutoAttachments({
      venueId: draft.venue_id as string,
      correlationId: approvedCorrelationId,
      inboundSubject,
      inboundBody,
      replyDraft: draft.draft_body as string,
      maxAttachments: 2,
    })
  } catch (matchErr) {
    console.warn(
      '[pipeline] auto-attach build failed for approved draft (continuing without):',
      matchErr instanceof Error ? matchErr.message : matchErr,
    )
    attachments = []
  }

  // 2026-05-11: pre-flight synthetic-address gate. The gmail sendEmail
  // chokepoint also refuses, but here we can give the operator a more
  // specific signal: mark the draft `needs_real_address` so it surfaces
  // on the drafts page as "fix the address" rather than failing silently.
  if (isUnsendableAddress(draft.to_email as string)) {
    await supabase
      .from('drafts')
      .update({ needs_real_address: true })
      .eq('id', draftId)
    console.warn(
      `[pipeline] Approved draft ${draftId} flagged needs_real_address (to_email=${draft.to_email}). ` +
        `Skipping send — operator must resolve a routable address before sending.`,
    )
    throw new Error(`Draft ${draftId} has an unroutable address; flagged for operator review`)
  }

  // Cc routing (mig 378, 2026-05-28): when the draft carries cc_emails
  // (form-relay parser surfaced BOTH personal email + per-prospect
  // platform relay), include them on the outbound so the reply lands in
  // the prospect's direct inbox AND surfaces in the platform dashboard.
  // The gmail chokepoint filters any unsendable Ccs and dedups against
  // the To.
  const ccList =
    Array.isArray(draft.cc_emails) && draft.cc_emails.length > 0
      ? (draft.cc_emails as string[])
      : null

  const sentMessageId = await sendEmail(
    draft.venue_id as string,
    draft.to_email as string,
    draft.subject as string,
    appendAIDisclosure(draft.draft_body as string, disclosureCtx),
    threadId,
    inboundConnectionId,
    attachments.length > 0 ? attachments : undefined,
    ccList,
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
  // signal-class-justified: outbound venue-side sends are not lead signals
  const outboundSentAt = new Date().toISOString()
  const { data: outboundInteraction } = await supabase
    .from('interactions')
    .insert({
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
      timestamp: outboundSentAt,
      signal_class: 'unclassified',
    })
    .select('id')
    .single()

  // M7 flip (PHASE-1-BATCH-1.md §3.4, 2026-05-22): the cascade write for
  // the approved-draft outbound interaction. `sendApprovedDraft` is a
  // SEPARATE function from `processIncomingEmail` — it had no `linkSignal`
  // call today — so the cascade equivalent is added here. Dual-write: the
  // legacy `interactions.insert` above STAYS (it still writes
  // `wedding_id:null`); this routes the same outbound event through the
  // Forwards Linker so `couples`/`touchpoints` get the equivalent write.
  //
  // The legacy row is `wedding_id:null` (unbound); the cascade does NOT
  // need that — `linkSignal` resolves the couple itself. We additionally
  // pass `weddingId` = the PARENT inbound interaction's wedding (the
  // draft's `interaction_id` chain) as the matcher's `legacy_wedding_id`
  // anchor hint, so the outbound touchpoint binds to the same couple the
  // draft was written for without re-running the full matcher.
  //
  // `action_type:'venue_sent'` + `signal_tier:'medium'` — identical to
  // M6 and the batch Gmail adapter: outbound venue mail is not couple
  // progression. `external_id` = the Gmail message id (sentMessageId) so
  // a later batch sweep dedups against this live touchpoint.
  if (outboundInteraction?.id) {
    try {
      const { linkSignal } = await import('@/lib/services/identity/forwards-linker')
      const { emailToNormalizedSignal } = await import(
        '@/lib/services/identity/email-to-signal'
      )
      const linkResult = await linkSignal({
        supabase,
        venueId: draft.venue_id as string,
        signal: emailToNormalizedSignal({
          email: {
            messageId: sentMessageId,
            threadId: threadId ?? null,
            subject: (draft.subject as string) ?? null,
          },
          interactionId: outboundInteraction.id as string,
          emailDate: outboundSentAt,
          // Outbound: no inbound sender identity. The couple is resolved
          // via the parent wedding anchor hint, not a From header.
          rawFromName: null,
          rawFromEmail: null,
          weddingId: parentWeddingId,
          actionType: 'venue_sent',
          signalTier: 'medium',
        }),
        correlationId: parentCorrelationId ?? undefined,
        source: 'live:approved_draft',
      })
      console.log(
        `[pipeline] cascade_link (approved draft): action=${linkResult.action} ` +
          `couple=${linkResult.matched_couple_id ?? 'none'} ` +
          `touchpoint=${linkResult.touchpoint_id ?? 'none'}`,
      )
    } catch (err) {
      // Load-bearing dual-write, same contract as the M1/M6 linkSignal
      // calls: surface the failure but never throw — the legacy
      // interactions row stays source of truth during the dual-write
      // window. logPipelineError builds its own service client.
      await logPipelineError(
        draft.venue_id as string,
        'cascade_link',
        err,
        { interactionId: outboundInteraction.id, draftId },
        parentCorrelationId ?? undefined,
      )
    }
  }

  // Refresh the thread's lifecycle folder — the freshly-sent reply
  // pushes a new_inquiry thread to potential_client (outbound>=1 +
  // inbound>=2 once the couple writes back, or right now if a tour
  // event already exists). Best-effort.
  try {
    await updateThreadLifecycleFolder({
      supabase,
      venueId: draft.venue_id as string,
      threadId: threadId ?? null,
    })
  } catch { /* swallow — non-fatal */ }

  console.log(`[pipeline] Sent approved draft ${draftId} to ${draft.to_email}`)
}
