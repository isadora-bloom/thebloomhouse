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

/**
 * Prompt revision identifier. Per Playbook OPS-21.5.1 / T1-E.
 * See PROMPTS-CHANGELOG.md for version history.
 */
export const BRAIN_DUMP_PROMPT_VERSION = 'brain-dump.prompt.v1.0'
import { createNotification } from '@/lib/services/admin-notifications'
import {
  patternSignature,
  evaluateGraduation,
  consumeGrantIfActive,
} from '@/lib/services/brain-dump-graduation'

export type BrainDumpIntent =
  | 'client_note'
  | 'availability'
  | 'analytics'
  | 'staff_observation'
  | 'operational_note'
  | 'knowledge_base_import'
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
  // can resolve "Jamie" to a specific wedding. Keep the list tight —
  // active = inquiry/tour_completed/proposal_sent/booked/completed.
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, wedding_date, status, people(first_name, last_name, role)')
    .eq('venue_id', venueId)
    .in('status', ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed'])
    .limit(500)

  const coupleIndex = (weddings ?? []).map((w) => {
    const people = (w.people as Array<{ first_name: string | null; last_name: string | null; role: string | null }> | null) ?? []
    const p1 = people.find((p) => p.role === 'partner1') ?? people[0]
    const p2 = people.find((p) => p.role === 'partner2')
    const label = p1
      ? p2
        ? `${p1.first_name ?? ''} & ${p2.first_name ?? ''}`.trim()
        : [p1.first_name, p1.last_name].filter(Boolean).join(' ')
      : '(unknown)'
    return {
      weddingId: w.id as string,
      label,
      wedding_date: w.wedding_date as string | null,
    }
  })

  const systemPrompt = `You classify free-text observations from a wedding venue coordinator.

Output JSON matching this exact shape:
{
  "intent": "client_note" | "availability" | "analytics" | "staff_observation" | "operational_note" | "knowledge_base_import" | "ambiguous",
  "confidence": 0-100,
  "clientMatch": { "weddingId": string | null, "coupleLabel": string | null, "ambiguousCandidates": [{"weddingId": "...", "label": "..."}] } | null,
  "note": string | null,
  "availability": { "date": "YYYY-MM-DD", "action": "cancel" | "block" | "hold" | "release" } | null,
  "staffName": string | null,
  "knowledgeBase": { "rows": [{"question": "...", "answer": "...", "category": "..."}] } | null,
  "clarificationQuestion": string | null
}

Intent rules:
- client_note: observation about a specific couple. Look up in the COUPLES list below. If exactly one match, use it; if multiple possibles, intent MUST be "ambiguous" and list candidates.
- availability: a date changed (cancelled, held, blocked, released). Always classify this — the system handles the confirm-first flow.
- analytics: the observation looks like ad-platform data (impressions, clicks, spend, inquiries by source).
- staff_observation: explicit praise or critique of a named team member.
- operational_note: about the venue itself (AC, grounds, equipment) — not a couple, not a staff member.
- knowledge_base_import: the input contains FAQ-style Question/Answer pairs intended to seed the venue's Sage knowledge base. Typical signals: an attached CSV with Question and Answer columns, a list of "Q: ... A: ..." pairs, or a policies document. Extract each Q/A pair into knowledgeBase.rows. category should be a short lowercase bucket like "pricing", "capacity", "vendors", "decor", "logistics" derived from the question. Only use this intent when the pairs are clearly additive reference content, not a specific couple's message.
- ambiguous: confidence < 75 OR multiple entities match OR you can't tell what to do. Populate clarificationQuestion with a SINGLE specific question.

COUPLES at this venue (JSON): ${JSON.stringify(coupleIndex.slice(0, 200))}

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
  const parsed = await callAIJson<BrainDumpParseResult>({
    systemPrompt,
    userPrompt,
    venueId,
    taskType: 'brain_dump_classify',
    maxTokens: 800,
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

  // Low-confidence or explicitly ambiguous → clarification prompt.
  if (parsed.intent === 'ambiguous' || parsed.confidence < 75) {
    const q = parsed.clarificationQuestion
      || 'I can\'t tell what this observation should be filed under. Can you give me a little more detail?'
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
    })
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: `Add this note to ${proposed.coupleLabel ?? 'the couple'}'s record?`,
        parsed_at: new Date().toISOString(),
        parse_result: { ...(parsed as unknown as Record<string, unknown>), proposed_client_note: proposed },
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
    })
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: `Looking at "${rawText}" — should I mark ${date} as ${action}?`,
        parsed_at: new Date().toISOString(),
        parse_result: parsed as unknown as Record<string, unknown>,
      })
      .eq('id', entryId)
    return {
      routedTo: [],
      needsClarification: true,
      clarificationQuestion: `Confirm: ${action} ${date}?`,
    }
  }

  // Staff observation: append to consultant_metrics notes if we can
  // resolve the name; otherwise operational_note fallback.
  if (parsed.intent === 'staff_observation' && parsed.staffName) {
    // Try to find a user_profiles row whose first_name/last_name matches.
    const trimmed = parsed.staffName.trim()
    const { data: match } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name')
      .eq('venue_id', venueId)
      .or(`first_name.ilike.%${trimmed}%,last_name.ilike.%${trimmed}%`)
      .limit(1)
      .maybeSingle()

    const noteBody = parsed.note || rawText
    // consultant_metrics may not have a text notes column; store as a
    // row in admin_notifications instead so the Intel Team view picks
    // it up, and track the routing target.
    await createNotification({
      venueId,
      type: 'staff_observation',
      title: match ? `Note on ${match.first_name ?? trimmed}` : `Staff observation — ${trimmed}`,
      body: noteBody,
    })
    routedTo.push({
      table: 'admin_notifications',
      id: null,
      action: `staff_observation:${match?.id ?? 'unresolved'}`,
    })
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
        return { routedTo, needsClarification: false, clarificationQuestion: null }
      }

      // Standard propose-and-confirm path.
      await createNotification({
        venueId,
        type: 'brain_dump_kb_import_confirm',
        title: `Confirm ${rows.length} Q/A row${rows.length === 1 ? '' : 's'} for the knowledge base`,
        body: JSON.stringify({ entryId, rowCount: rows.length, sample: rows.slice(0, 3) }),
      })
      await supabase
        .from('brain_dump_entries')
        .update({
          parse_status: 'needs_clarification',
          clarification_question: `Add ${rows.length} Q/A row${rows.length === 1 ? '' : 's'} to the knowledge base?`,
          parsed_at: new Date().toISOString(),
          parse_result: { ...(parsed as unknown as Record<string, unknown>), proposed_kb_rows: rows },
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
      return { routedTo, needsClarification: false, clarificationQuestion: null }
    }

    // Standard propose-and-confirm path.
    await createNotification({
      venueId,
      type: 'brain_dump_operational_note_confirm',
      title: 'Confirm operational note',
      body: JSON.stringify({ entryId, noteBody, rawText }),
    })
    await supabase
      .from('brain_dump_entries')
      .update({
        parse_status: 'needs_clarification',
        clarification_question: 'File this as an operational note in knowledge_gaps?',
        parsed_at: new Date().toISOString(),
        parse_result: { ...(parsed as unknown as Record<string, unknown>), proposed_operational_note: { noteBody } },
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
    const { extractSpendFromText } = await import('@/lib/services/marketing-spend')
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
