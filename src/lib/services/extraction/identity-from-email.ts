/**
 * Bloom House — LLM-driven identity extraction (Wave 3 — deep fix).
 *
 * Anchor docs:
 *   - IDENTITY-CAPTURE-DESIGN.md § 2 site #16-18
 *   - IDENTITY-EXTRACTION-V2.md
 *   - bloom-constitution.md
 *
 * Why this file exists
 * --------------------
 * The legacy `body-extract.ts` extractor is structurally blind:
 *
 *   - It cannot tell the SENDER (in the signature) from the ADDRESSEE
 *     (in the salutation) from a MENTIONED HUMAN (in the body).
 *   - It captures any "Capitalized Capitalized" pair, which lets
 *     greetings ("Hi Megan"), HTML residue ("<strong>Sage"), the venue's
 *     own name ("Rixey Manor") and signoffs without names ("Best,") all
 *     leak into `extracted_identity.names[]` as candidate prospect names.
 *   - It has no concept of "who is this email FROM" beyond the From: header,
 *     which on relay platforms (Knot, WW, Calendly) is the relay address,
 *     not the prospect.
 *
 * Wave 2.5 added a reject-list at the chokepoint
 * (`identity/name-capture.ts`) that catches greetings / HTML / venue-own
 * names AFTER they've been captured as evidence. That list stays as a
 * safety net but is no longer load-bearing — Wave 3's deep fix is
 * upstream:
 *
 *   1. `parseEmailAnatomy` (this directory's other file) splits the body
 *      into salutation / body / signature / forwarded blocks.
 *   2. `extractEmailIdentity` (THIS file) sends the structured payload
 *      to Claude Haiku with a tight prompt: "the SENDER lives in the
 *      signature primarily, the from_header secondarily. The ADDRESSEE
 *      in the salutation is NOT the sender. Reject the venue's own name
 *      and team members. List humans MENTIONED with relationship roles."
 *   3. Output is validated: every name in the response must appear
 *      verbatim in the input; the sender_identity domain must not match
 *      the venue's own outbound domain.
 *
 * The chokepoint reads the Wave 3 output as the highest-confidence per-
 * email signal AND retains the legacy `extracted_identity.names[]` for
 * back-compat. Wave 2.5's reject-list is a downstream safety net.
 *
 * Cost model
 * ----------
 * Haiku call: ~500 input tokens + ~150 output tokens per email →
 * ~$0.0002 per call. A venue with 1000 inbound emails per month spends
 * ~$0.20/month. Even a chatty Wedgewood-tier multi-venue (10K emails)
 * lands at $2/month per venue. Budgeted under T1-O AI cost ceiling.
 */

import { callAIJson } from '@/lib/ai/client'
import { parseEmailAnatomy, type ParsedEmailAnatomy } from './email-anatomy'

/**
 * Prompt revision identifier. Bumping the prompt requires updating this
 * constant + adding a row to PROMPTS-CHANGELOG.md.
 */
export const EMAIL_IDENTITY_EXTRACT_PROMPT_VERSION = 'email-identity-extract.v1'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SenderIdentitySource =
  | 'from_header'        // Sender's name pulled from the raw From: header
  | 'signature'          // Sender's name pulled from the signature block
  | 'body_self_reference' // Sender named themselves in the body ("This is Sarah,")
  | 'unknown'

export type MentionedHumanRole =
  | 'partner'
  | 'family'
  | 'planner'
  | 'vendor'
  | 'friend'
  | 'unclear'

export interface SenderIdentity {
  first: string | null
  last: string | null
  /** 0-100. The LLM's stated confidence. The chokepoint maps this to
   *  its own confidence ladder — "signature with last name" is treated
   *  as a `email_signature_extraction` source, "from_header alone" is
   *  treated as `gmail_from_name`. */
  confidence: number
  source: SenderIdentitySource
}

export interface MentionedHuman {
  /** The full name as it appears in the source text. Always populated. */
  name: string
  role: MentionedHumanRole
  /** Free-text sub-role descriptor when LLM extracted one — "mother of
   *  the bride", "groom's stepfather", "wedding planner from XYZ Co."
   *  Down-stream `wedding_relationships` writers map this to a
   *  structured role enum via `classifyParentheticalRole`. */
  sub_role?: string
  confidence: number
}

export interface ExtractedEmailIdentity {
  /** Best-effort identification of the sender. Null when the LLM cannot
   *  identify a sender at all (rare — usually only happens when the body
   *  is empty or contains only platform chrome). */
  sender_identity: SenderIdentity | null
  /** Other humans named in the body (partner, family, planner, vendor,
   *  friend). Used by the chokepoint to populate `wedding_relationships`
   *  and to inform partner2 detection. Empty array when none found. */
  mentioned_humans: MentionedHuman[]
  /** Names that MATCH the venue's identity (venue name, business name,
   *  AI assistant name, team member names). Recorded for audit so we
   *  can see what the LLM caught; downstream the chokepoint never
   *  treats these as prospect identity. Empty array when none found. */
  venue_side_echoes: string[]
  /** Tokens the LLM rejected as junk (greetings without a name, HTML
   *  residue, signoff phrases that didn't carry a name). Preserved for
   *  audit; never promoted. */
  rejected_tokens: string[]
}

// ---------------------------------------------------------------------------
// Inputs / config
// ---------------------------------------------------------------------------

export interface ExtractEmailIdentityArgs {
  venueId: string
  rawBody: string
  /** Original sender email — used for cross-validation against venue
   *  outbound domains. */
  fromEmail: string
  /** Raw "From:" header value, e.g. `"Madison Bryant" <madison@gmail.com>`.
   *  When the header carries only a smush handle like
   *  `"Erinhorrigan" <erin@gmail.com>`, the LLM is told to prefer the
   *  signature over the header. */
  fromHeader: string
  subject: string | null
  /** Threading context. Currently unused by the prompt but logged so
   *  audit can correlate per-thread. */
  inReplyTo?: string | null
  threadId?: string | null
  /** Venue identity context for cross-validation. The chokepoint already
   *  knows these but pass them in so the LLM gets to see them and can
   *  flag matches itself. */
  venueContext: {
    /** Display name from `venues.name`. */
    venueName: string | null
    /** Per-venue-config business name. Often identical to venueName but
     *  may differ for multi-property orgs. */
    businessName: string | null
    /** AI assistant name, e.g. "Sage". When the LLM sees "Sage" as a
     *  candidate sender it must reject as a venue echo. */
    aiName: string | null
    /** Set of venue-owned email addresses (from `venueOwnEmails`). When
     *  the from_email's domain matches any of these, the email is from
     *  the venue itself, not a prospect. */
    ownEmails: Set<string>
    /** Optional list of team member full names (from `user_profiles`).
     *  When passed, the LLM is told to flag matches as venue_echoes. */
    teamMemberNames?: string[]
  }
}

// ---------------------------------------------------------------------------
// Verbatim guard
// ---------------------------------------------------------------------------

/**
 * Numbers-guard: every name in the LLM output must appear verbatim in
 * the input. The classifier sometimes hallucinates a "James Smith" when
 * the body says "James" and the From-domain is "smith.com" — that's a
 * bridge we don't want to cross. This guard drops anything whose first
 * AND last token can't both be located in the source.
 *
 * Returns true when the name is verifiable in the source text.
 */
function isNameInSource(name: string, source: string): boolean {
  if (!name) return false
  const tokens = name.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  // Single-name: must appear as a whole word.
  if (tokens.length === 1) {
    const re = new RegExp(`\\b${escapeRegex(tokens[0])}\\b`, 'i')
    return re.test(source)
  }
  // Multi-token: ALL tokens must appear (need not be adjacent — handles
  // "Sarah Marie Smith" -> source had "Sarah" and "Smith").
  for (const t of tokens) {
    const re = new RegExp(`\\b${escapeRegex(t)}\\b`, 'i')
    if (!re.test(source)) return false
  }
  return true
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Domain-of-from-email == any venue own-email's domain → the sender is
 * the venue itself, not a prospect. The chokepoint already filters
 * inbound vs outbound by direction, but this is a belt-and-suspenders
 * check at the identity layer so a misclassified outbound that slips
 * into the inbound lane never gets stamped with a fake "prospect"
 * sender.
 */
function isSenderEmailVenueOwn(fromEmail: string, ownEmails: Set<string>): boolean {
  if (!fromEmail) return false
  const at = fromEmail.indexOf('@')
  if (at < 0) return false
  const domain = fromEmail.slice(at + 1).toLowerCase()
  for (const own of ownEmails) {
    const ownAt = own.indexOf('@')
    if (ownAt < 0) continue
    const ownDomain = own.slice(ownAt + 1).toLowerCase()
    if (domain === ownDomain) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a forensic identity extractor for a wedding venue inquiry pipeline.

Your job: identify the SENDER of an email and any HUMANS MENTIONED in the body, while rejecting venue-side echoes (the venue's own name, AI assistant name, team members) and junk (greetings without names, HTML residue, signoff phrases without names).

You receive a STRUCTURED email payload (already parsed into salutation / body / signature / forwarded blocks) plus venue identity context. Use the structure — do NOT re-flatten the email and search for capitalised pairs blindly.

# Sender identity

The sender is the person WRITING the email. To identify them, prefer signals in this order:

1. **Signature block** (signoff + name on the next line, e.g. "Cheers,\\nMike"). This is the strongest signal — it's the sender's stated identity.
2. **From header** when the signature is absent. Pull the display name from "Display Name <email@domain>". CAUTION: relay platforms (The Knot, WeddingWire, Calendly, HoneyBook) put a SMUSHED USERNAME or "User <hex>" in the display name slot — NOT a real name. When the from_header looks like a smush ("Erinhorrigan", "Catesbyandben") or a proxy ("User 89436314x..."), do not promote it to sender_identity; record it under rejected_tokens.
3. **Body self-reference** ("This is Sarah", "I'm Madison Bryant") — only when neither signature nor from_header gave a usable name.

Confidence guidance:
- Full first + last from a clear signature: 90+
- First-only from a clear signature: 70-85
- First + last from a clean from_header (clearly a real name, not a relay): 70-80
- Body self-reference: 50-70
- No usable signal: return sender_identity = null.

# Mentioned humans

Other people the sender NAMES in the body. Tag each with a role:
- "partner" — the fiancé/fiancée/spouse-to-be ("my fiancé James", "my partner Sarah")
- "family" — parent, sibling, in-law ("my mom Carol", "his stepdad Tom")
- "planner" — wedding planner, coordinator ("our planner Mary from XYZ Events")
- "vendor" — photographer, caterer, florist, DJ, etc.
- "friend" — friends and friends-of-friends helping plan
- "unclear" — when the body names someone but their relationship to the wedding isn't stated

Sub-role: free-text descriptor when one is given verbatim ("mother of the bride", "best man", "wedding coordinator from Acme Events").

# Venue-side echoes

When the body or signature contains the venue's own name, business name, AI assistant name, OR a team member name, list it under venue_side_echoes — DO NOT promote it to sender_identity or mentioned_humans. The venue context block tells you which strings to flag.

# Rejected tokens

Greetings without a name ("Hi,", "Hello there"), signoffs without a name ("Best,", "Cheers,"), HTML fragments ("<strong>", "</p>"), and obviously non-name tokens go under rejected_tokens for audit. These never become identity claims.

# Output schema (strict JSON)

{
  "sender_identity": { "first": string|null, "last": string|null, "confidence": number, "source": "from_header"|"signature"|"body_self_reference"|"unknown" } | null,
  "mentioned_humans": [ { "name": string, "role": "partner"|"family"|"planner"|"vendor"|"friend"|"unclear", "sub_role": string|null, "confidence": number } ],
  "venue_side_echoes": [ string ],
  "rejected_tokens": [ string ]
}

Hard rules:
- Every name string in the output MUST appear verbatim in the email (signature, from_header, body, or salutation). Do not invent or normalise capitalisation beyond what's in the source.
- The salutation addressee is who the email is WRITTEN TO. They are NOT the sender. If the salutation says "Hi Megan" and Megan is in the venue team list, list "Megan" under venue_side_echoes. If the addressee is unknown, ignore — do not guess they're a partner.
- When the from_email's domain matches a venue-owned domain, the sender_identity should be sourced from the body or signature (not the from_header) — the from_header is the venue, not the prospect.
- If you cannot identify a sender at all, return sender_identity = null. Do not guess.`

interface PromptInput {
  anatomy: ParsedEmailAnatomy
  fromEmail: string
  fromHeader: string
  subject: string | null
  venueContext: ExtractEmailIdentityArgs['venueContext']
}

function buildUserPrompt(input: PromptInput): string {
  const { anatomy, fromEmail, fromHeader, subject, venueContext } = input

  // Truncate the body to ~1500 chars to keep token cost predictable.
  // Real prospect content is typically 200-800 chars; the tail of long
  // bodies is mostly disclaimers / quoted history.
  const truncatedBody = anatomy.body.length > 1500
    ? anatomy.body.slice(0, 1500) + '\n[...truncated...]'
    : anatomy.body

  const teamLines = venueContext.teamMemberNames && venueContext.teamMemberNames.length > 0
    ? venueContext.teamMemberNames.slice(0, 25).map((n) => `  - ${n}`).join('\n')
    : '  (none provided)'

  const ownDomains = (() => {
    const set = new Set<string>()
    for (const e of venueContext.ownEmails) {
      const at = e.indexOf('@')
      if (at < 0) continue
      set.add(e.slice(at + 1).toLowerCase())
    }
    return Array.from(set).slice(0, 10)
  })()

  return `# Email payload

## From header (raw)
${fromHeader || '(empty)'}

## From email
${fromEmail || '(empty)'}

## Subject
${subject ?? '(empty)'}

## Salutation block
${anatomy.salutation ?? '(none detected)'}
addressee: ${anatomy.salutationName ?? '(none)'}

## Body block
${truncatedBody || '(empty)'}

## Signature block
${anatomy.signature ?? '(none detected)'}
parsed signoff name: ${anatomy.signoffName ?? '(none)'}

## Forwarded chain present
${anatomy.forwarded ? 'YES — extract the ORIGINAL sender from the forwarded body and signature, not the relay\'s' : 'no'}
${anatomy.forwarded ? `\n### Forwarded body (excerpt)\n${(anatomy.forwarded.body || '').slice(0, 800)}\n\n### Forwarded signature\n${anatomy.forwarded.signature ?? '(none)'}\nforwarded signoff name: ${anatomy.forwarded.signoffName ?? '(none)'}` : ''}

# Venue context (treat these as venue-side echoes — never as prospect identity)

- Venue name: ${venueContext.venueName ?? '(unknown)'}
- Business name: ${venueContext.businessName ?? '(unknown)'}
- AI assistant name: ${venueContext.aiName ?? '(unknown)'}
- Venue-owned email domains: ${ownDomains.length > 0 ? ownDomains.join(', ') : '(none)'}
- Team members:
${teamLines}

# Task

Return strict JSON matching the schema in the system prompt. Every name string in your output MUST appear verbatim in the email payload above.`
}

// ---------------------------------------------------------------------------
// Public extractor
// ---------------------------------------------------------------------------

interface RawAIResponse {
  sender_identity?: {
    first?: string | null
    last?: string | null
    confidence?: number
    source?: string
  } | null
  mentioned_humans?: Array<{
    name?: string
    role?: string
    sub_role?: string | null
    confidence?: number
  }>
  venue_side_echoes?: string[]
  rejected_tokens?: string[]
}

const VALID_SENDER_SOURCES = new Set<SenderIdentitySource>([
  'from_header',
  'signature',
  'body_self_reference',
  'unknown',
])

const VALID_HUMAN_ROLES = new Set<MentionedHumanRole>([
  'partner',
  'family',
  'planner',
  'vendor',
  'friend',
  'unclear',
])

/**
 * The Wave-3 deep-fix entry point. Runs structured anatomy parsing,
 * calls the LLM with venue context, validates every name appears
 * verbatim in the source, cross-checks the sender against the venue's
 * own outbound domain, and returns a clean ExtractedEmailIdentity.
 *
 * On any failure (LLM down, malformed JSON, all candidates rejected by
 * verbatim guard), returns an empty result with `sender_identity = null`
 * so the caller can fall back to legacy regex extraction. Never throws.
 */
export async function extractEmailIdentity(
  args: ExtractEmailIdentityArgs,
): Promise<ExtractedEmailIdentity> {
  const empty: ExtractedEmailIdentity = {
    sender_identity: null,
    mentioned_humans: [],
    venue_side_echoes: [],
    rejected_tokens: [],
  }

  const rawBody = args.rawBody ?? ''
  if (!rawBody.trim() && !args.fromHeader && !args.fromEmail) return empty

  const anatomy = parseEmailAnatomy(rawBody)

  // Build a verbatim source haystack for the numbers-guard. Includes
  // every input the LLM saw. We compare against this string when
  // validating output names.
  const verbatimSource = [
    args.fromHeader ?? '',
    args.fromEmail ?? '',
    args.subject ?? '',
    anatomy.salutation ?? '',
    anatomy.body ?? '',
    anatomy.signature ?? '',
    anatomy.forwarded?.body ?? '',
    anatomy.forwarded?.signature ?? '',
  ].join('\n')

  let response: RawAIResponse
  try {
    response = await callAIJson<RawAIResponse>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt({
        anatomy,
        fromEmail: args.fromEmail,
        fromHeader: args.fromHeader,
        subject: args.subject,
        venueContext: args.venueContext,
      }),
      maxTokens: 800,
      temperature: 0.0,
      venueId: args.venueId,
      taskType: 'email_identity_extract',
      tier: 'haiku',
      promptVersion: EMAIL_IDENTITY_EXTRACT_PROMPT_VERSION,
      contentTier: 1,
    })
  } catch (err) {
    // Don't fail the pipeline on identity-extractor errors. Caller
    // continues with legacy regex extraction.
    console.warn('[extract-email-identity] LLM call failed:', err instanceof Error ? err.message : err)
    return empty
  }

  // Validate sender_identity.
  let sender_identity: SenderIdentity | null = null
  if (response.sender_identity && (response.sender_identity.first || response.sender_identity.last)) {
    const first = (response.sender_identity.first ?? '').trim() || null
    const last = (response.sender_identity.last ?? '').trim() || null
    const source = (VALID_SENDER_SOURCES.has(response.sender_identity.source as SenderIdentitySource)
      ? response.sender_identity.source
      : 'unknown') as SenderIdentitySource
    const confidence = clampConfidence(response.sender_identity.confidence)

    // Verbatim guard. Each non-null token must appear in the source.
    const firstOk = !first || isNameInSource(first, verbatimSource)
    const lastOk = !last || isNameInSource(last, verbatimSource)

    if (firstOk && lastOk) {
      sender_identity = { first, last, confidence, source }
    }
  }

  // Cross-validate against the venue's own domain. If sender_identity
  // came from the from_header AND the from_email's domain matches the
  // venue's own outbound, we cannot trust it as the prospect.
  if (
    sender_identity &&
    sender_identity.source === 'from_header' &&
    isSenderEmailVenueOwn(args.fromEmail ?? '', args.venueContext.ownEmails)
  ) {
    sender_identity = null
  }

  // Validate mentioned_humans.
  const mentioned_humans: MentionedHuman[] = []
  for (const raw of response.mentioned_humans ?? []) {
    if (!raw || !raw.name || !raw.name.trim()) continue
    const name = raw.name.trim()
    const role = (VALID_HUMAN_ROLES.has(raw.role as MentionedHumanRole)
      ? raw.role
      : 'unclear') as MentionedHumanRole
    if (!isNameInSource(name, verbatimSource)) continue
    const sub_role = raw.sub_role ? raw.sub_role.trim() : undefined
    mentioned_humans.push({
      name,
      role,
      ...(sub_role ? { sub_role } : {}),
      confidence: clampConfidence(raw.confidence),
    })
  }

  // Pass through audit lists.
  const venue_side_echoes = (response.venue_side_echoes ?? [])
    .filter((s): s is string => typeof s === 'string' && !!s.trim())
    .map((s) => s.trim())
  const rejected_tokens = (response.rejected_tokens ?? [])
    .filter((s): s is string => typeof s === 'string' && !!s.trim())
    .map((s) => s.trim())

  return {
    sender_identity,
    mentioned_humans,
    venue_side_echoes,
    rejected_tokens,
  }
}

function clampConfidence(n: number | undefined | null): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 50
  if (n < 0) return 0
  if (n > 100) return 100
  return Math.round(n)
}
