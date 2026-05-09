/**
 * Bloom House: Brain Dump AI Parser + Router
 *
 * Phase 2.5 Task 27. Takes a coordinator's free-text (or file-derived text)
 * submission and decides where it should land.
 *
 * Classification taxonomy (from the spec):
 *   - client_note      — observation about a specific couple. Routes to
 *                        weddings.sage_context_notes so Sage's next draft
 *                        sees it.
 *   - availability    — date cancelled / blocked / held / freed. DESTRUCTIVE:
 *                        never auto-applied; always creates an
 *                        admin_notifications clarification prompt first.
 *   - analytics       — "here's our WeddingWire stats for Q1". Flagged
 *                        for Phase 3 attribution import; parked as needs_clarification
 *                        until that pipeline ships.
 *   - staff_observation — "Sarah did a great job on Henderson". Routes to
 *                          consultant_metrics notes.
 *   - operational_note — "tent AC was flaky last weekend". Routes to
 *                        knowledge_gaps as a venue-level note.
 *   - ambiguous       — AI couldn't decide OR multiple entities match
 *                        (two Jamies). Asks ONE clarification question.
 *
 * Destructive-vs-additive rule: anything that CHANGES state requires
 * confirmation. Anything that ADDS information routes immediately.
 *
 * Multi-venue safety: every lookup and every write uses the venueId
 * passed in. A dump at Rixey can never route to Oakwood tables.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import type { BrainDumpParseResult as DiscriminatedParseResult } from '@/lib/services/brain-dump/parse-result-schema'

/**
 * Prompt revision identifier. Per Playbook OPS-21.5.1 / T1-E.
 * See PROMPTS-CHANGELOG.md for version history.
 */
export const BRAIN_DUMP_PROMPT_VERSION = 'brain-dump.prompt.v1.1'
import { createNotification } from '@/lib/services/admin-notifications'
import {
  patternSignature,
  evaluateGraduation,
  consumeGrantIfActive,
} from '@/lib/services/brain-dump/graduation'

export type BrainDumpIntent =
  | 'client_note'
  | 'availability'
  | 'analytics'
  | 'staff_observation'
  | 'operational_note'
  | 'knowledge_base_import'
  | 'help_question'
  | 'ambiguous'

export interface BrainDumpParseResult {
  intent: BrainDumpIntent
  confidence: number // 0-100
  // client_note specifics
  clientMatch?: {
    weddingId: string | null
    coupleLabel: string | null
    // If multiple candidates matched, ambiguous resolution needed
    ambiguousCandidates?: Array<{ weddingId: string; label: string }>
  }
  note?: string
  // availability specifics
  availability?: {
    date: string // YYYY-MM-DD
    action: 'cancel' | 'block' | 'hold' | 'release'
  }
  // staff_observation specifics
  staffName?: string
  // knowledge_base_import specifics — populated when the classifier sees
  // FAQ-shaped CSV content (Question/Answer columns or similar).
  knowledgeBase?: {
    rows: Array<{ question: string; answer: string; category?: string }>
  }
  // Clarification prompt when ambiguous
  clarificationQuestion?: string
}

/**
 * Build a specific clarification question for an ambiguous brain-dump
 * entry. Beats a generic "can you give me a little more detail" by
 * naming what the parser actually saw vs what it was unsure about.
 * Used by the ambiguous + low-confidence fallback when the classifier
 * did NOT supply its own clarificationQuestion.
 */
function synthesiseClarification(
  parsed: BrainDumpParseResult,
  rawText: string,
): string {
  const snippet = rawText.length > 80 ? `${rawText.slice(0, 80)}...` : rawText
  const candidates = parsed.clientMatch?.ambiguousCandidates ?? []
  if (candidates.length > 1) {
    const names = candidates
      .slice(0, 4)
      .map((c) => c.label)
      .filter(Boolean)
      .join(', ')
    return `Found multiple couple matches (${names}). Which couple is "${snippet}" about?`
  }
  if (parsed.intent === 'client_note' && !parsed.clientMatch?.weddingId) {
    return `Looks like a couple note but I could not find a matching wedding for "${snippet}". Add the couple name, or open the brain dump again with the couple's name spelled out.`
  }
  if (parsed.intent === 'staff_observation' && !parsed.staffName) {
    return `Looks like a staff observation but I could not pull a name from "${snippet}". Tell me which team member this is about.`
  }
  if (parsed.intent === 'availability') {
    return `Got an availability change but the date or action was not clear in "${snippet}". Try "block June 14, 2027" or "release Aug 7."`
  }
  if (parsed.intent === 'analytics') {
    return `Looks like marketing data but I could not pull source / metric / values cleanly. Try "Knot got 14 inquiries from $300 spend in May" so I can match a row to a column.`
  }
  if (parsed.intent === 'knowledge_base_import') {
    return `Looks like a Q/A list but I could not split it into question + answer pairs cleanly. Re-paste with each pair on its own block.`
  }
  // Pure ambiguous (low confidence, no specific signal): show the
  // snippet so the coordinator knows which entry the prompt is about.
  return `I am not sure how to file "${snippet}". Tell me if this is about a couple, a team member, the venue, a date, or something else.`
}

/**
 * Classify a brain-dump submission. Uses callAIJson against the text —
 * images/PDFs/CSVs should be preprocessed by the route before calling
 * this (OCR or JSON summary), then passed as rawText.
 */
export async function classifyBrainDump(args: {
  venueId: string
  rawText: string
}): Promise<BrainDumpParseResult> {
  const { venueId, rawText } = args
  const supabase = createServiceClient()

  // Pull the venue's active weddings + couple names so the classifier
  // can resolve "Jamie" to a specific wedding. Bug 3 fix (2026-05-09):
  // raise the cap from 500 to 2000 and order by wedding_date desc nulls
  // last, then created_at desc, so the most-relevant couples (upcoming
  // and recently inquired) sit at the head of the list. Pre-fix relied
  // on the implicit Postgres order plus a slice(0, 200) below, which
  // silently dropped older couples for venues like Rixey that carry
  // > 200 active records, causing client_note classifications to fall
  // through to ambiguous.
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, wedding_date, status, created_at, people(first_name, last_name, role)')
    .eq('venue_id', venueId)
    .in('status', ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed'])
    .order('wedding_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(2000)

  const coupleIndexAll = (weddings ?? []).map((w) => {
    const people = (w.people as Array<{ first_name: string | null; last_name: string | null; role: string | null }> | null) ?? []
    const p1 = people.find((p) => p.role === 'partner1') ?? people[0]
    const p2 = people.find((p) => p.role === 'partner2')
    const label = p1
      ? p2
        ? `${p1.first_name ?? ''} & ${p2.first_name ?? ''}`.trim()
        : [p1.first_name, p1.last_name].filter(Boolean).join(' ')
      : '(unknown)'
    // Capture raw lowercase first/last name tokens for the deterministic
    // pre-filter below. Done here rather than re-derived from `label`
    // because the human label collapses '&' joins ("Jamie & Pat").
    const tokens = new Set<string>()
    for (const p of people) {
      if (p.first_name) tokens.add(p.first_name.toLowerCase())
      if (p.last_name) tokens.add(p.last_name.toLowerCase())
    }
    return {
      weddingId: w.id as string,
      label,
      wedding_date: w.wedding_date as string | null,
      _tokens: tokens,
    }
  })

  // Deterministic name pre-filter (Bug 3, second prong). Tokenize the
  // rawText and only include couples whose first/last name appears
  // verbatim. If the pre-filter narrows enough we cap at 200 to keep the
  // prompt tight; if it returns zero matches we fall back to the top
  // 1000 (the safer fallback called for in the audit) so the classifier
  // still has venue-roster context for notes phrased entirely without
  // names ("the couple from last weekend wants a different photographer").
  const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'they', 'this', 'that', 'have',
    'has', 'had', 'was', 'were', 'will', 'would', 'about', 'their', 'them',
    'our', 'are', 'just', 'wedding', 'couple', 'bride', 'groom',
  ])
  const textTokens = new Set(
    rawText
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  )
  const matched = coupleIndexAll.filter((c) => {
    for (const tok of c._tokens) {
      if (textTokens.has(tok)) return true
    }
    return false
  })
  const coupleIndex = (matched.length > 0 ? matched.slice(0, 200) : coupleIndexAll.slice(0, 1000))
    .map((c) => ({
      weddingId: c.weddingId,
      label: c.label,
      wedding_date: c.wedding_date,
    }))

  const systemPrompt = `You classify free-text observations from a wedding venue coordinator.

Output JSON matching this exact shape:
{
  "intent": "client_note" | "availability" | "analytics" | "staff_observation" | "operational_note" | "knowledge_base_import" | "help_question" | "ambiguous",
  "confidence": 0-100,
  "clientMatch": { "weddingId": string | null, "coupleLabel": string | null, "ambiguousCandidates": [{"weddingId": "...", "label": "..."}] } | null,
  "note": string | null,
  "availability": { "date": "YYYY-MM-DD", "action": "cancel" | "block" | "hold" | "release" } | null,
  "staffName": string | null,
  "knowledgeBase": { "rows": [{"question": "...", "answer": "...", "category": "..."}] } | null,
  "clarificationQuestion": string | null
}

Intent rules:
- help_question: the coordinator is asking the platform a "where do I X" / "how do I X" / "I can't find Y" / "is there a way to Z" question. They want navigation help, not to file an observation. Question marks plus question-shaped phrasing are strong signals. When you classify as help_question, set confidence to at least 80 and leave the other fields null.
- client_note: observation about a specific couple. Look up in the COUPLES list below. If exactly one match, use it; if multiple possibles, intent MUST be "ambiguous" and list candidates.
- availability: a date changed (cancelled, held, blocked, released). Always classify this — the system handles the confirm-first flow.
- analytics: the observation looks like ad-platform data (impressions, clicks, spend, inquiries by source).
- staff_observation: explicit praise or critique of a named team member.
- operational_note: about the venue itself (AC, grounds, equipment) — not a couple, not a staff member.
- knowledge_base_import: the input contains FAQ-style Question/Answer pairs intended to seed the venue's Sage knowledge base. Typical signals: an attached CSV with Question and Answer columns, a list of "Q: ... A: ..." pairs, or a policies document. Extract each Q/A pair into knowledgeBase.rows. category should be a short lowercase bucket like "pricing", "capacity", "vendors", "decor", "logistics" derived from the question. Only use this intent when the pairs are clearly additive reference content, not a specific couple's message.
- ambiguous: confidence < 75 OR multiple entities match OR you can't tell what to do. Populate clarificationQuestion with a SINGLE specific question.

Help vs knowledge_base disambiguation: a single question from the coordinator about the platform itself is help_question; a list of Q/A pairs the coordinator wants Sage to learn for couples is knowledge_base_import. "Where do I upload reviews?" is help. "Q: What time does the venue close? A: 11pm." is knowledge_base_import.

COUPLES at this venue (JSON): ${JSON.stringify(coupleIndex)}

Rules:
- Never invent a weddingId. If you can't find one in the list, set clientMatch.weddingId to null and set intent="ambiguous".
- If the text is super short or vague, prefer ambiguous.
- For knowledge_base_import, return every Q/A pair you see — do not summarise or dedupe.
- Confidence reflects your certainty about the intent, not the accuracy of extracted data.`

  const userPrompt = `Observation: """${rawText}"""

Classify and extract according to the schema. Respond with JSON only.`

  // Cost-ceiling gate (T5-α.2). Brain-dump is coordinator-initiated
  // (they typed an observation and clicked submit) — refusing the
  // call would lose their input silently. The audit guidance is
  // "log a warning but still allow user-initiated calls". The
  // ceiling is still respected because callAIJson logs to api_costs
  // regardless; if the venue is over-ceiling the next CRON sweep
  // catches it. OPS-21.4.3.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    console.warn(
      `[brain-dump] proceeding despite cost-ceiling pause for venue ${venueId} (user-initiated)`,
    )
  }

  // Tier 1 content: brain-dump submissions can carry per-couple intel
  // paragraphs ("Just spoke with Maddie's mom on the phone — she's
  // the financial decision maker, prefers email, wants the contract
  // before approving the deposit"), client-confidence notes, family
  // context, payment-adjacent observations. OpenAI fallback uses
  // store:false; api_costs records the tier tag for the ZDR audit.
  // OPS-21.3.5.
  //
  // Haiku tier per Playbook 19.8 — Stage 1 is classification (one of
  // ~15 input categories). Specialised extractors run downstream and
  // can use Sonnet if their work is more nuanced. OPS-21.4.2.
  // 2026-05-08: maxTokens raised from 800 to 2500. The classifier's
  // JSON response includes parsed observations / details, which are
  // bounded by the input size. Coordinator pasting a multi-paragraph
  // review (or a Knot screenshot transcript) blew past the 800-token
  // cap and the response was truncated mid-string. Surfaced as
  // "Unterminated string in JSON at position 3321" — Haiku was
  // working, just cut off. 2500 covers ~5 pages of pasted text.
  const parsed = await callAIJson<BrainDumpParseResult>({
    systemPrompt,
    userPrompt,
    venueId,
    taskType: 'brain_dump_classify',
    maxTokens: 2500,
    contentTier: 1,
    tier: 'haiku',
    promptVersion: BRAIN_DUMP_PROMPT_VERSION,
  })

  return parsed
}

/**
 * Stable shape descriptor for graduation pattern matching (T4-E).
 * Records WHICH parser-output keys are present, not their values, so
 * unrelated occurrences of the same intent + same shape collide
 * deterministically. client_note routes always carry a coupleLabel
 * but we EXCLUDE it from the shape — even if every client-note is
 * about a different couple, the parsed shape is the same.
 */
function shapeOf(parsed: BrainDumpParseResult): Record<string, boolean> {
  return {
    has_clientMatch: Boolean(parsed.clientMatch),
    has_weddingId: Boolean(parsed.clientMatch?.weddingId),
    has_note: Boolean(parsed.note),
    has_availability: Boolean(parsed.availability),
    has_staffName: Boolean(parsed.staffName),
    has_kbRows: Boolean(parsed.knowledgeBase?.rows?.length),
  }
}

/** Categories that the playbook permits to graduate. client_note is
 *  EXCLUDED per INV-20.5.4-D — per-couple intel paragraphs are
 *  non-graduable forever. availability is destructive (date blocks);
 *  also excluded. analytics path is propose-only via a separate flow. */
const GRADUABLE_INTENTS: ReadonlySet<BrainDumpIntent> = new Set([
  'operational_note',
  'knowledge_base_import',
])

/**
 * Resolve a deep-link destination for a routed/parked brain-dump entry.
 *
 * 2026-05-08 (Isadora feedback): every actionable intent should give the
 * coordinator a "go to X" affordance after the bubble's success state.
 * Pre-fix the bubble said "Filed." with no link, so the coordinator
 * had to guess where the data landed. Per-intent map below mirrors the
 * resolve route's writers.
 */
export function nextHrefFor(args: {
  intent: BrainDumpIntent | string
  weddingId?: string | null
}): { nextHref: string; nextLabel: string } | null {
  const { intent, weddingId } = args
  if (intent.endsWith('_preview')) {
    // CSV / vision previews: most land in /intel/sources (sources & ROI),
    // reviews land in /intel/reviews. Refine when shape is known.
    if (intent === 'reviews_preview') return { nextHref: '/intel/reviews', nextLabel: 'Open reviews' }
    if (intent === 'knowledge_base_qa_preview' || intent === 'knowledge_base_tc_preview') {
      return { nextHref: '/portal/kb', nextLabel: 'Open knowledge base' }
    }
    if (intent === 'tour_links_preview') return { nextHref: '/intel/tours', nextLabel: 'Open tours' }
    if (intent === 'leads_preview') return { nextHref: '/agent/leads', nextLabel: 'Open leads' }
    if (intent === 'storefront_analytics_preview') return { nextHref: '/intel/sources', nextLabel: 'Open sources' }
    return { nextHref: '/intel/sources', nextLabel: 'Open sources' }
  }
  switch (intent) {
    case 'client_note':
      return weddingId
        ? { nextHref: `/intel/clients/${weddingId}`, nextLabel: 'View couple' }
        : { nextHref: '/intel/clients', nextLabel: 'View couples' }
    case 'knowledge_base_import':
      return { nextHref: '/portal/kb', nextLabel: 'Open knowledge base' }
    case 'operational_note':
      return { nextHref: '/agent/knowledge-gaps', nextLabel: 'Open knowledge gaps' }
    case 'availability':
      return { nextHref: '/portal/availability', nextLabel: 'Open availability' }
    case 'analytics':
      return { nextHref: '/intel/sources', nextLabel: 'Open sources' }
    case 'staff_observation':
      return { nextHref: '/intel/team', nextLabel: 'Team performance' }
    case 'reviews_from_screenshot':
      return { nextHref: '/intel/reviews', nextLabel: 'Open reviews' }
    case 'identity_signals':
    case 'scraper_json_imported':
      return { nextHref: '/intel/candidates', nextLabel: 'Review candidates' }
    case 'imported':
      return { nextHref: '/intel/sources', nextLabel: 'Open sources' }
    default:
      return null
  }
}

/**
 * Route a parsed brain dump to the right destination(s).
 *
 * Returns the `routed_to` array to store on brain_dump_entries.
 * Destructive intents return an empty routed_to + a pending
 * clarification notification; the coordinator's confirmation later
 * completes the route.
 */
export async function routeBrainDump(args: {
  venueId: string
  entryId: string
  submittedBy: string | null
  parsed: BrainDumpParseResult
  rawText: string
}): Promise<{
  routedTo: Array<{ table: string; id: string | null; action: string }>
  needsClarification: boolean
  clarificationQuestion: string | null
  /** Deep-link destination per intent. Bubble renders "[label] →"
   *  below the success card. */
  nextHref?: string | null
  nextLabel?: string | null
  /** Help-mode answer payload (intent='help_question'). */
  helpAnswer?: { body: string; links: Array<{ label: string; href: string }> } | null
  /** When >= REPEAT_THRESHOLD prior confirmations of this signature
   *  exist + no active grant, surface a graduation offer for the
   *  coordinator to accept on the next propose-and-confirm. */
  graduationOffer?: {
    signature: string
    intent: BrainDumpIntent
    confirmedCount: number
  }
}> {
  const { venueId, entryId, submittedBy, parsed, rawText } = args
  const supabase = createServiceClient()
  const routedTo: Array<{ table: string; id: string | null; action: string }> = []

  // Compute pattern signature up front so we can stamp it on every
  // brain_dump_entries update path + check graduation grants. Stamp
  // immediately so even early-return clarification paths carry the
  // signature for graduation-count purposes.
  const signature = patternSignature({ intent: parsed.intent, shape: shapeOf(parsed) })
  await supabase
    .from('brain_dump_entries')
    .update({ pattern_signature: signature })
    .eq('id', entryId)

  // GRADUATION AUTO-ROUTE: for graduable intents (operational_note +
  // knowledge_base_import per INV-20.5.4-D), check whether an active
  // grant covers this signature. If yes, bypass propose-and-confirm
  // and route directly. The grant's hit_count + last_used_at are
  // bumped fire-and-forget inside consumeGrantIfActive.
  let activeGrant: Awaited<ReturnType<typeof consumeGrantIfActive>> = null
  if (GRADUABLE_INTENTS.has(parsed.intent)) {
    activeGrant = await consumeGrantIfActive(supabase, venueId, signature)
  }

  // Help question: answer inline, no propose-and-confirm. The bubble
  // renders helpAnswer.body + clickable links instead of a Confirm
  // card. Stamp confirmed immediately so we don't pollute the
  // clarification queue with platform-help questions.
  if (parsed.intent === 'help_question') {
    try {
      const { answerHelpQuestion } = await import('@/lib/services/brain-dump/help')
      const helpAnswer = await answerHelpQuestion({
        venueId,
        question: rawText,
      })
      // Bug 11: discriminated parse_result for help-mode answer.
      const helpDU: DiscriminatedParseResult = {
        kind: 'help_answer',
        body: helpAnswer.body,
        links: helpAnswer.links,
      }
      await supabase
        .from('brain_dump_entries')
        .update({
          parse_status: 'confirmed',
          parsed_at: new Date().toISOString(),
          resolved_at: new Date().toISOString(),
          parse_result: {
            ...(parsed as unknown as Record<string, unknown>),
            ...helpDU,
            help_answer: helpAnswer,
          },
          routed_to: [{ table: 'help_answer', id: null, action: 'inline_help' }],
        })
        .eq('id', entryId)
      return {
        routedTo: [{ table: 'help_answer', id: null, action: 'inline_help' }],
        needsClarification: false,
        clarificationQuestion: null,
        helpAnswer,
      }
    } catch (err) {
      // Bug 5 fix (2026-05-09): when answerHelpQuestion throws (Anthropic
      // rate limit, network error, model refusal, etc.) the previous code
      // logged a warn and fell through. parse_status was still 'pending'
      // and the ambiguous handler below only fires when intent ===
      // 'ambiguous' — a help_question that errored has intent =
      // 'help_question', so the entry sat at 'pending' forever. Downgrade
      // the intent to 'ambiguous' and synthesise a clarification question
      // explaining the lookup failed; the existing ambiguous block then
      // takes over and parks the entry properly.
      console.warn('[brain-dump] help-mode failed; falling back to ambiguous:', err)
      parsed.intent = 'ambiguous'
      parsed.clarificationQuestion =
        'I tried to answer your help question but the lookup failed. Try rephrasing, or tell me what you wanted to file.'
    }
  }

  // Low-confidence or explicitly ambiguous → clarification prompt.
  if (parsed.intent === 'ambiguous' || parsed.confidence < 75) {
    // Bug 8 (2026-05-09): replace generic "can you give me a little
    // more detail" with a specific question keyed to what the parser
    // saw. The classifier's clarificationQuestion (when set) is
    // already specific; otherwise we synthesise one from the parsed
    // signals (saw a couple-name match? mentioned a date? looked like
    // analytics?). Coordinator sees what was confusing instead of
    // bouncing off a wall of vague copy.
    const q = parsed.clarificationQuestion || synthesiseClarification(parsed, rawText)
    await createNotification({
      venueId,
      type: 'brain_dump_needs_clarification',
      title: 'Brain-dump needs clarification',
      body: JSON.stringify({
        entryId,
        question: q,
        rawText,
        submittedBy,
      }),
      priority: 'high',
    })
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: q,
        parsed_at: new Date().toISOString(),
        parse_result: parsed as unknown as Record<string, unknown>,
      })
      .eq('id', entryId)
    return { routedTo: [], needsClarification: true, clarificationQuestion: q }
  }

  // Client note: PROPOSE-AND-CONFIRM. Per couple's intel paragraph
  // is part of their forensic record (Playbook INV-20.5.4-D —
  // non-graduable category). Auto-filing means the brain-dump
  // parser's interpretation of "what the coordinator meant" lands
  // on the wedding's permanent record without coordinator review,
  // which is exactly the case the playbook calls out as a
  // propose-and-confirm violation.
  //
  // Pre-fix: this path called weddings.update() directly. Now: route
  // to needs_clarification with the proposed note in parse_result;
  // /api/brain-dump/[id]/resolve writes the note on confirm.
  if (parsed.intent === 'client_note' && parsed.clientMatch?.weddingId) {
    const noteBody = parsed.note || rawText
    const proposed = {
      kind: 'client_note',
      weddingId: parsed.clientMatch.weddingId,
      noteBody,
      coupleLabel: (parsed.clientMatch as { coupleLabel?: string }).coupleLabel ?? null,
    }
    await createNotification({
      venueId,
      type: 'brain_dump_client_note_confirm',
      title: `Confirm client note${proposed.coupleLabel ? ` for ${proposed.coupleLabel}` : ''}`,
      body: JSON.stringify({
        entryId,
        weddingId: proposed.weddingId,
        noteBody,
        rawText,
      }),
      priority: 'high',
    })
    // Bug 11 (2026-05-09): write the discriminated `kind` so the
    // resolve route can narrow with isProposedClientNote() instead of
    // sniffing for a `proposed_client_note` key. Legacy sub-object
    // stays for back-compat reads of pre-Bug-11 rows in other code
    // paths.
    const proposedDU: DiscriminatedParseResult = {
      kind: 'proposed_client_note',
      weddingId: proposed.weddingId,
      noteBody: proposed.noteBody,
      coupleLabel: proposed.coupleLabel,
    }
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: `Add this note to ${proposed.coupleLabel ?? 'the couple'}'s record?`,
        parsed_at: new Date().toISOString(),
        parse_result: {
          ...(parsed as unknown as Record<string, unknown>),
          ...proposedDU,
          proposed_client_note: proposed,
        },
      })
      .eq('id', entryId)
    return {
      routedTo: [],
      needsClarification: true,
      clarificationQuestion: `Add this note to ${proposed.coupleLabel ?? 'the couple'}'s record?`,
    }
  }

  // Availability: DESTRUCTIVE — never auto-apply. Create confirmation
  // prompt instead. Coordinator resolves via the existing
  // booking_confirmation_prompt UI pattern.
  if (parsed.intent === 'availability' && parsed.availability) {
    const { date, action } = parsed.availability
    await createNotification({
      venueId,
      type: 'brain_dump_availability_confirm',
      title: `Confirm availability change for ${date}`,
      body: JSON.stringify({
        entryId,
        date,
        action,
        rawText,
      }),
      priority: 'high',
    })
    // Bug 11: discriminated parse_result for availability proposals.
    const availDU: DiscriminatedParseResult = {
      kind: 'proposed_availability',
      date,
      action,
    }
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: `Looking at "${rawText}", should I mark ${date} as ${action}?`,
        parsed_at: new Date().toISOString(),
        parse_result: {
          ...(parsed as unknown as Record<string, unknown>),
          ...availDU,
        },
      })
      .eq('id', entryId)
    return {
      routedTo: [],
      needsClarification: true,
      clarificationQuestion: `Confirm: ${action} ${date}?`,
    }
  }

  // Staff observation: PROPOSE-AND-CONFIRM. Bug 1 fix (2026-05-09).
  // Pre-fix this branch wrote directly to admin_notifications and
  // pushed to routedTo with no coordinator review, violating Playbook
  // INV-20.5.4-A (every brain-dump intent must propose, never silently
  // file). The brain-dump misreads happen — "Sage's draft was sloppy"
  // is about the AI not a person named Sage; "the new hire could push
  // harder on Knot leads" is feedback meant for the system not a
  // permanent note on someone's record. Mirror the client_note +
  // knowledge_base_import patterns: park as needs_clarification with
  // a proposed_staff_observation payload, fire a confirm notification,
  // and let Case H in /api/brain-dump/[id]/resolve do the staff lookup
  // and admin_notifications insert on confirm.
  if (parsed.intent === 'staff_observation' && parsed.staffName) {
    const trimmed = parsed.staffName.trim()
    const noteBody = parsed.note || rawText
    const proposed = {
      kind: 'staff_observation',
      staffName: trimmed,
      noteBody,
    }
    await createNotification({
      venueId,
      type: 'brain_dump_staff_observation_confirm',
      title: `Confirm note on ${trimmed}`,
      body: JSON.stringify({
        entryId,
        staffName: trimmed,
        noteBody,
        rawText,
      }),
      priority: 'high',
    })
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: `File this observation about ${trimmed}?`,
        parsed_at: new Date().toISOString(),
        parse_result: {
          ...(parsed as unknown as Record<string, unknown>),
          proposed_staff_observation: proposed,
        },
      })
      .eq('id', entryId)
    return {
      routedTo: [],
      needsClarification: true,
      clarificationQuestion: `File this observation about ${trimmed}?`,
    }
  }

  // Knowledge base import: PROPOSE-AND-CONFIRM. Pre-fix this auto-
  // inserted Q/A rows on the rationale "additive, low-risk", but
  // Playbook INV-20.5.4-A says always propose, never silently file —
  // even additive. The LLM occasionally extracts garbage Q/A pairs
  // from FAQ pages (header/footer text, navigation labels) and those
  // become permanent KB entries Sage will quote in real drafts.
  if (parsed.intent === 'knowledge_base_import' && parsed.knowledgeBase?.rows?.length) {
    const rows = parsed.knowledgeBase.rows
      .filter((r) => r.question?.trim() && r.answer?.trim())
      .map((r) => ({
        question: r.question.trim(),
        answer: r.answer.trim(),
        category: (r.category ?? 'general').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40),
      }))

    if (rows.length > 0) {
      // Auto-route via active grant: same dedup-on-question-text shape
      // as the resolve route Case E, but skips the propose step.
      if (activeGrant && activeGrant.intent === 'knowledge_base_import') {
        const stamped = rows.map((r) => ({
          venue_id: venueId,
          question: r.question,
          answer: r.answer,
          category: r.category,
          priority: 50,
          is_active: true,
          source: 'brain_dump_via_grant',
        }))
        const { data: existing } = await supabase
          .from('knowledge_base')
          .select('question')
          .eq('venue_id', venueId)
          .in('question', stamped.map((r) => r.question))
        const existingSet = new Set(((existing ?? []) as Array<{ question: string }>).map((r) => r.question))
        const toInsert = stamped.filter((r) => !existingSet.has(r.question))
        if (toInsert.length > 0) {
          await supabase.from('knowledge_base').insert(toInsert)
        }
        routedTo.push({
          table: 'knowledge_base',
          id: null,
          action: `insert_via_grant:${toInsert.length},deduped:${existingSet.size}`,
        })
        await supabase
          .from('brain_dump_entries')
          .update({
            parse_status: 'confirmed',
            parsed_at: new Date().toISOString(),
            resolved_at: new Date().toISOString(),
            parse_result: { ...(parsed as unknown as Record<string, unknown>), via_grant_id: activeGrant.id, inserted: toInsert.length, deduped: existingSet.size },
            routed_to: routedTo,
          })
          .eq('id', entryId)
        // Bug 6 (2026-05-09): see operational_note path above for the
        // why. Mirror the audit notification so KB-import grants are
        // visible in the bell + notifications feed.
        await createNotification({
          venueId,
          type: 'brain_dump_grant_fired',
          title: `Brain-dump auto-filed ${toInsert.length} Q/A row${toInsert.length === 1 ? '' : 's'} via standing rule`,
          body: JSON.stringify({
            entryId,
            signature,
            intent: 'knowledge_base_import',
            grantId: activeGrant.id,
            routedTable: 'knowledge_base',
            inserted: toInsert.length,
            deduped: existingSet.size,
          }),
          priority: 'low',
        })
        return { routedTo, needsClarification: false, clarificationQuestion: null }
      }

      // Standard propose-and-confirm path.
      await createNotification({
        venueId,
        type: 'brain_dump_kb_import_confirm',
        title: `Confirm ${rows.length} Q/A row${rows.length === 1 ? '' : 's'} for the knowledge base`,
        body: JSON.stringify({ entryId, rowCount: rows.length, sample: rows.slice(0, 3) }),
        priority: 'high',
      })
      // Bug 11: discriminated parse_result. Legacy proposed_kb_rows
      // key stays for back-compat with any reader that still sniffs.
      const kbDU: DiscriminatedParseResult = {
        kind: 'proposed_kb_rows',
        rows: rows.map((r) => ({
          question: r.question,
          answer: r.answer,
          category: r.category,
        })),
      }
      await supabase
        .from('brain_dump_entries')
        .update({
          parse_status: 'needs_clarification',
          clarification_question: `Add ${rows.length} Q/A row${rows.length === 1 ? '' : 's'} to the knowledge base?`,
          parsed_at: new Date().toISOString(),
          parse_result: {
            ...(parsed as unknown as Record<string, unknown>),
            ...kbDU,
            proposed_kb_rows: rows,
          },
        })
        .eq('id', entryId)

      const graduation = await evaluateGraduation(supabase, venueId, signature)
      return {
        routedTo: [],
        needsClarification: true,
        clarificationQuestion: `Add ${rows.length} Q/A row${rows.length === 1 ? '' : 's'} to the knowledge base?`,
        graduationOffer: graduation.shouldOfferGraduation
          ? { signature, intent: parsed.intent, confirmedCount: graduation.confirmedCount }
          : undefined,
      }
    }
  }

  // Operational note: PROPOSE-AND-CONFIRM by default. If an active
  // pattern grant covers this signature (T4-E graduation), bypass
  // the propose step and route directly to knowledge_gaps. The grant
  // is recorded fire-and-forget by consumeGrantIfActive.
  if (parsed.intent === 'operational_note') {
    const noteBody = parsed.note || rawText

    // Auto-route via active grant.
    if (activeGrant && activeGrant.intent === 'operational_note') {
      const { data: inserted } = await supabase
        .from('knowledge_gaps')
        .insert({
          venue_id: venueId,
          question: noteBody,
          category: 'operational',
          status: 'open',
        })
        .select('id')
        .single()
      if (inserted?.id) {
        routedTo.push({ table: 'knowledge_gaps', id: inserted.id as string, action: 'insert_via_grant' })
      }
      await supabase
        .from('brain_dump_entries')
        .update({
          parse_status: 'confirmed',
          parsed_at: new Date().toISOString(),
          resolved_at: new Date().toISOString(),
          parse_result: { ...(parsed as unknown as Record<string, unknown>), via_grant_id: activeGrant.id },
          routed_to: routedTo,
        })
        .eq('id', entryId)
      // Bug 6 (2026-05-09): grant-fire was previously silent. The
      // coordinator had no surface telling them an auto-route just
      // happened, so a forgotten months-old grant could create
      // surprise knowledge_gaps rows. Drop a low-priority audit
      // notification with entryId + signature + grantId so the bell
      // and the notifications listing both render the trail. JSON
      // body keeps it parseable for the notifications-page label.
      await createNotification({
        venueId,
        type: 'brain_dump_grant_fired',
        title: 'Brain-dump auto-filed via standing rule',
        body: JSON.stringify({
          entryId,
          signature,
          intent: 'operational_note',
          grantId: activeGrant.id,
          routedTable: 'knowledge_gaps',
          notePreview: noteBody.slice(0, 120),
        }),
        priority: 'low',
      })
      return { routedTo, needsClarification: false, clarificationQuestion: null }
    }

    // Standard propose-and-confirm path.
    await createNotification({
      venueId,
      type: 'brain_dump_operational_note_confirm',
      title: 'Confirm operational note',
      body: JSON.stringify({ entryId, noteBody, rawText }),
      priority: 'high',
    })
    // Bug 11: discriminated parse_result.
    const opDU: DiscriminatedParseResult = {
      kind: 'proposed_operational_note',
      noteBody,
    }
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: 'File this as an operational note in knowledge_gaps?',
        parsed_at: new Date().toISOString(),
        parse_result: {
          ...(parsed as unknown as Record<string, unknown>),
          ...opDU,
          proposed_operational_note: { noteBody },
        },
      })
      .eq('id', entryId)

    // Graduation offer: if this would be the 3rd+ confirm of this
    // shape, surface to caller so the resolve flow can prompt.
    const graduation = await evaluateGraduation(supabase, venueId, signature)
    return {
      routedTo: [],
      needsClarification: true,
      clarificationQuestion: 'File this as an operational note in knowledge_gaps?',
      graduationOffer: graduation.shouldOfferGraduation
        ? { signature, intent: parsed.intent, confirmedCount: graduation.confirmedCount }
        : undefined,
    }
  }

  // Analytics: route through the Phase 3 marketing-spend extractor. The
  // extractor uses an LLM pass to pull (source, month, amount) rows from
  // free text. If any rows parse we show them in a clarification prompt
  // for coordinator confirmation (CSV-style preview flow — never
  // auto-commit spend numbers).
  if (parsed.intent === 'analytics') {
    const { extractSpendFromText } = await import('@/lib/services/intel/marketing-spend')
    const extract = await extractSpendFromText({ venueId, text: rawText })
    if (extract.rows.length > 0) {
      await createNotification({
        venueId,
        type: 'brain_dump_spend_confirm',
        title: `Analytics detected — ${extract.rows.length} spend row${extract.rows.length === 1 ? '' : 's'} extracted`,
        body: JSON.stringify({
          entryId,
          rows: extract.rows,
          rawText,
        }),
        priority: 'high',
      })
      await supabase
        .from('brain_dump_entries')
        .update({
          parse_status: 'needs_clarification',
          clarification_question: `Extracted ${extract.rows.length} spend row${extract.rows.length === 1 ? '' : 's'}. Confirm to import into Sources intelligence.`,
          parsed_at: new Date().toISOString(),
          parse_result: { ...parsed, extractedSpendRows: extract.rows } as unknown as Record<string, unknown>,
        })
        .eq('id', entryId)
      return {
        routedTo: [],
        needsClarification: true,
        clarificationQuestion: `Confirm import of ${extract.rows.length} spend row(s).`,
      }
    }
    // Nothing parseable — fall back to the generic clarification.
    await createNotification({
      venueId,
      type: 'brain_dump_needs_clarification',
      title: 'Analytics text — couldn\'t extract spend rows',
      body: JSON.stringify({
        entryId,
        question: 'I classified this as analytics data but couldn\'t pull clean (source, month, amount) rows. Want to reclassify or import manually at /intel/sources?',
        rawText,
      }),
      priority: 'high',
    })
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: extract.errors.join('; ') || 'Could not extract spend rows.',
        parsed_at: new Date().toISOString(),
        parse_result: parsed as unknown as Record<string, unknown>,
      })
      .eq('id', entryId)
    return {
      routedTo: [],
      needsClarification: true,
      clarificationQuestion: 'Could not extract spend rows from text.',
    }
  }

  // Mark the entry parsed + store the routing decisions.
  await supabase
    .from('brain_dump_entries')
    .update({
      parse_status: 'parsed',
      parsed_at: new Date().toISOString(),
      parse_result: parsed as unknown as Record<string, unknown>,
      routed_to: routedTo,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', entryId)

  return { routedTo, needsClarification: false, clarificationQuestion: null }
}
