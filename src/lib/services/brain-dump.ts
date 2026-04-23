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
import { createNotification } from '@/lib/services/admin-notifications'

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

  const parsed = await callAIJson<BrainDumpParseResult>({
    systemPrompt,
    userPrompt,
    venueId,
    taskType: 'brain_dump_classify',
    maxTokens: 800,
  })

  return parsed
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
}> {
  const { venueId, entryId, submittedBy, parsed, rawText } = args
  const supabase = createServiceClient()
  const routedTo: Array<{ table: string; id: string | null; action: string }> = []

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

  // Client note: append to weddings.sage_context_notes.
  if (parsed.intent === 'client_note' && parsed.clientMatch?.weddingId) {
    const noteBody = parsed.note || rawText
    const { data: wRow } = await supabase
      .from('weddings')
      .select('sage_context_notes')
      .eq('id', parsed.clientMatch.weddingId)
      .single()
    const existing = Array.isArray(wRow?.sage_context_notes)
      ? (wRow!.sage_context_notes as Array<Record<string, unknown>>)
      : []
    const nextNotes = [
      ...existing,
      {
        body: noteBody,
        source: 'brain_dump',
        added_at: new Date().toISOString(),
        entry_id: entryId,
      },
    ]
    await supabase
      .from('weddings')
      .update({ sage_context_notes: nextNotes })
      .eq('id', parsed.clientMatch.weddingId)
    routedTo.push({
      table: 'weddings',
      id: parsed.clientMatch.weddingId,
      action: 'append_sage_context_note',
    })
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

  // Knowledge base import: additive, low-risk. Insert each Q/A row
  // directly into knowledge_base so Sage picks them up on the next draft.
  // No confirmation prompt — adding reference content is the additive side
  // of the destructive/additive rule.
  if (parsed.intent === 'knowledge_base_import' && parsed.knowledgeBase?.rows?.length) {
    const rows = parsed.knowledgeBase.rows
      .filter((r) => r.question?.trim() && r.answer?.trim())
      .map((r) => ({
        venue_id: venueId,
        question: r.question.trim(),
        answer: r.answer.trim(),
        category: (r.category ?? 'general').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40),
        priority: 50,
        is_active: true,
        source: 'csv',
      }))

    if (rows.length > 0) {
      // Dedupe against existing (venue_id, question) pairs so re-uploading
      // the same CSV doesn't multiply rows. knowledge_base has no unique
      // constraint, so we query first.
      const { data: existing } = await supabase
        .from('knowledge_base')
        .select('question')
        .eq('venue_id', venueId)
        .in('question', rows.map((r) => r.question))
      const existingSet = new Set((existing ?? []).map((r) => (r.question as string)))
      const toInsert = rows.filter((r) => !existingSet.has(r.question))

      if (toInsert.length > 0) {
        const { error } = await supabase.from('knowledge_base').insert(toInsert)
        if (!error) {
          routedTo.push({
            table: 'knowledge_base',
            id: null,
            action: `insert:${toInsert.length}`,
          })
        }
      }
      if (existingSet.size > 0) {
        routedTo.push({
          table: 'knowledge_base',
          id: null,
          action: `deduped:${existingSet.size}`,
        })
      }
    }
  }

  // Operational note: route to knowledge_gaps as a venue-level entry.
  // The question column holds the observation — keeps it surfaced in
  // /agent/knowledge-gaps where coordinators already triage.
  if (parsed.intent === 'operational_note') {
    const noteBody = parsed.note || rawText
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
      routedTo.push({ table: 'knowledge_gaps', id: inserted.id as string, action: 'insert' })
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
