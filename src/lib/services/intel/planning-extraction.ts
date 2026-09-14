/**
 * Bloom House: Planning Decision Extraction Service
 *
 * Two extraction layers:
 *   1. Regex-based (fast, free, synchronous) — catches obvious patterns like
 *      "We booked Sarah's Florals" or "150 guests".
 *   2. AI-based (richer, async, fire-and-forget) — uses Claude to extract
 *      structured planning insights across all 8 categories: vendor, guest_count,
 *      decor, checklist, cost, date, policy, note.
 *
 * Both layers write to the planning_notes table so coordinators see every
 * decision without reading every Sage message.
 *
 * Ported from bloom-house-portal/server/index.js (extractPlanningNotes)
 * and expanded with AI extraction inspired by the Rixey Portal approach.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'

/**
 * Prompt revision identifier. Per Playbook OPS-21.5.1 / T1-E.
 * See PROMPTS-CHANGELOG.md for version history.
 */
export const PLANNING_EXTRACTION_PROMPT_VERSION = 'planning-extraction.prompt.v1.0'

/**
 * Categories the `planning_notes` CHECK constraint accepts (migration 015
 * widened the original four). The AI is asked for one of these and is
 * mostly obedient, but an invented category fails the INSERT with 23514,
 * and `savePlanningNotes` logs that and carries on — so the note is lost
 * quietly. Anything unrecognised falls back to 'note' instead.
 */
const VALID_CATEGORIES: ReadonlySet<string> = new Set<PlanningCategory>([
  'vendor',
  'guest_count',
  'decor',
  'checklist',
  'cost',
  'date',
  'policy',
  'note',
])

function coerceCategory(value: unknown): PlanningCategory {
  return typeof value === 'string' && VALID_CATEGORIES.has(value)
    ? (value as PlanningCategory)
    : 'note'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanningCategory =
  | 'vendor'
  | 'guest_count'
  | 'decor'
  | 'checklist'
  | 'cost'
  | 'date'
  | 'policy'
  | 'note'

export interface PlanningNote {
  category: PlanningCategory
  content: string
  source_message: string
  confidence?: number
  /**
   * The inbound interaction this note came out of, when the source was a
   * coordinator-venue conversation rather than a Sage chat message or a
   * contract. Migration 406 added the column. Null for the two older
   * writers, which have no interaction to point at.
   */
  source_interaction_id?: string | null
  /** 'email' | 'sms' | 'instagram' | ... Null for the older writers. */
  source_channel?: string | null
}

/** Shape returned by the AI extraction prompt. */
interface AIPlanningNote {
  category: PlanningCategory
  content: string
  confidence: number
}

interface PlanningPattern {
  patterns: RegExp[]
  category: PlanningCategory
}

// ---------------------------------------------------------------------------
// Detection patterns (regex only — no AI)
// ---------------------------------------------------------------------------

const PLANNING_PATTERNS: Record<string, PlanningPattern> = {
  vendor_booking: {
    patterns: [
      // "We booked / hired / chose / are going with [name] for [role]"
      /(?:we(?:'ve|'re| have| are)?|i(?:'ve|'m| have| am)?)\s+(?:booked|hired|going with|chose|chosen|decided on|using)\s+(.+?)(?:\s+(?:for|as)\s+(?:our\s+)?(.+?))?(?:\.|,|!|$)/i,
      // "Booking / hiring / going with [name] for [role]"
      /(?:def(?:initely)?|probably|actually)?\s*(?:booking|using|hiring|going with)\s+(.+?)(?:\s+(?:for|as)\s+(?:our\s+)?(.+?))?(?:\.|,|!|$)/i,
      // "We're going to book / hire / use [name]"
      /(?:we(?:'re)?|i(?:'m)?)\s+(?:going to|want to|planning to)\s+(?:book|hire|use|go with)\s+(.+?)(?:\s+(?:for|as)\s+(?:our\s+)?(.+?))?(?:\.|,|!|$)/i,
      // "Our photographer is [name]"
      /(?:our|my)\s+(florist|photographer|videographer|dj|caterer|planner|coordinator|officiant|band|baker|bartender|hair|makeup|flowers)\s+(?:is|will be|are)\s+(.+?)(?:\.|,|!|$)/i,
      // "Booked [name] for photographer"
      /(?:booked|hired|using)\s+(.+?)\s+(?:for|as)\s+(?:our\s+)?(florist|photographer|videographer|dj|caterer|planner|coordinator|officiant|band|baker|flowers?|photos?|video|music|food|catering)(?:\.|,|!|$)/i,
    ],
    category: 'vendor',
  },

  guest_count: {
    patterns: [
      // "150 guests" / "about 200 people"
      /(?:about|around|approximately|roughly|maybe|probably)?\s*(\d+)\s*(?:guests?|people|attendees?|attending|coming)/i,
      // "Guest count is 150" / "guest list: 200"
      /guest\s*(?:count|list)\s*(?:is|:)?\s*(\d+)/i,
      // "We're expecting 150"
      /(?:we(?:'re)?|i(?:'m)?)\s+(?:expecting|inviting|planning (?:for|on))\s+(?:about|around|roughly)?\s*(\d+)/i,
    ],
    category: 'guest_count',
  },

  decor: {
    patterns: [
      // "Our theme is [x]" / "The theme will be [x]"
      /(?:our|the)\s+theme\s+(?:is|will be)\s+(.+?)(?:\.|,|!|$)/i,
      // "Our colors are [x]" / "We chose [x] colors"
      /(?:our|the|we(?:'re)?\s+(?:using|doing|going with))\s+colors?\s+(?:are|is|will be)?\s*(.+?)(?:\.|,|!|$)/i,
      // "Our style is [x]"
      /(?:our|the)\s+style\s+(?:is|will be)\s+(.+?)(?:\.|,|!|$)/i,
      // "We're using / going with [x] for centerpieces / arbor / arch"
      /(?:we(?:'re|'ll)?|i(?:'m|'ll)?)\s+(?:using|going with|want|chose|choosing)\s+(?:the\s+)?(.+?)\s*(?:arbor|arch|backdrop|centerpieces?|flowers?|linens?|tablecloths?)/i,
      // "Want to do [x] for decor" / "Thinking [x] vibe"
      /(?:want to do|thinking|going for|leaning toward)\s+(?:a\s+)?(.+?)\s+(?:vibe|aesthetic|look|feel|decor|style|theme)(?:\.|,|!|$)/i,
    ],
    category: 'decor',
  },

  checklist: {
    patterns: [
      // "We've booked / finished / sent / ordered the [thing]"
      /(?:we've|i've|we)\s+(?:booked|hired|sent|ordered|finished|completed|finalized|done)\s+(?:the\s+)?(.+?)(?:\.|!|$)/i,
      // "Just booked / finally finished the [thing]"
      /(?:just|finally)\s+(?:booked|hired|sent|ordered|finished|completed)\s+(?:the\s+)?(.+?)(?:\.|!|$)/i,
      // "The [thing] is booked / done / complete"
      /(?:the\s+)?(.+?)\s+(?:is|are)\s+(?:booked|done|finished|ordered|sent|complete)(?:\.|!|$)/i,
    ],
    category: 'checklist',
  },
}

// ---------------------------------------------------------------------------
// extractPlanningDecisions
// ---------------------------------------------------------------------------

/**
 * Scans a couple's Sage chat message for planning decisions using keyword
 * and pattern matching. Returns an array of extracted notes (may be empty).
 */
export function extractPlanningDecisions(
  venueId: string,
  weddingId: string,
  message: string
): PlanningNote[] {
  if (!message || message.trim().length < 5) return []

  const notes: PlanningNote[] = []
  const sourceMessage = message.substring(0, 500)

  for (const [, config] of Object.entries(PLANNING_PATTERNS)) {
    for (const pattern of config.patterns) {
      const match = message.match(pattern)
      if (match) {
        let content = ''

        switch (config.category) {
          case 'vendor':
            content = match[2]
              ? `${match[2]}: ${match[1]}`
              : `Vendor: ${match[1]}`
            break
          case 'guest_count':
            // Find the capture group that has the number
            content = `Guest count: ${match[1] || match[2] || match[0]}`
            break
          case 'decor':
            content = `Decor: ${match[1]}`
            break
          case 'checklist':
            content = match[1] || match[0]
            break
        }

        content = content.trim()
        if (content.length > 0) {
          notes.push({
            category: config.category,
            content,
            source_message: sourceMessage,
          })
        }

        // Only one match per pattern group (avoid duplicates from overlapping patterns)
        break
      }
    }
  }

  return notes
}

// ---------------------------------------------------------------------------
// savePlanningNotes
// ---------------------------------------------------------------------------

/**
 * Inserts extracted planning notes into the planning_notes table.
 * Deduplicates by skipping notes where the same category + similar content
 * already exists within the last 24 hours.
 */
export async function savePlanningNotes(
  venueId: string,
  weddingId: string,
  notes: PlanningNote[]
): Promise<void> {
  if (notes.length === 0) return

  const supabase = createServiceClient()
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Load recent notes for this wedding to check for duplicates
  const { data: recentNotes } = await supabase
    .from('planning_notes')
    .select('category, content')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .gte('created_at', oneDayAgo)

  const existing = recentNotes || []

  const newNotes = notes.filter((note) => {
    // Skip if a note with the same category and very similar content exists
    return !existing.some(
      (e) =>
        e.category === note.category &&
        e.content.toLowerCase() === note.content.toLowerCase()
    )
  })

  if (newNotes.length === 0) return

  const rows = newNotes.map((note) => ({
    venue_id: venueId,
    wedding_id: weddingId,
    category: coerceCategory(note.category),
    content: note.content,
    source_message: note.source_message,
    source_interaction_id: note.source_interaction_id ?? null,
    source_channel: note.source_channel ?? null,
    status: 'pending',
  }))

  const { error } = await supabase.from('planning_notes').insert(rows)

  if (error) {
    console.error('[planning-extraction] Error saving notes:', error)
  } else {
    console.log(`[planning-extraction] Saved ${newNotes.length} note(s)`)
  }
}

// ---------------------------------------------------------------------------
// AI-powered extraction (richer, async)
// ---------------------------------------------------------------------------

const AI_EXTRACTION_PROMPT = `Extract any wedding planning decisions, preferences, or action items from this message.

For each insight, categorize as one of:
- vendor: A vendor mentioned, booked, or preferred (florist, photographer, DJ, caterer, etc.)
- guest_count: Guest count mentioned or updated
- decor: Decoration preference, color palette, theme, or style choice
- checklist: A task completed or a to-do item mentioned
- cost: Budget amount, payment mention, or cost discussion
- date: Date, deadline, or timeline mentioned (ceremony time, rehearsal date, etc.)
- policy: Venue policy question or clarification
- note: General planning note that doesn't fit other categories

Return a JSON array of objects with { category, content, confidence }.
- content: A concise summary of the insight (not the raw message).
- confidence: 0.0 to 1.0 — how confident you are this is a real planning decision vs. casual chat.
- Only include items with confidence >= 0.5.
- If the message contains no planning decisions, return an empty array [].
- Do NOT extract greetings, thanks, or small talk.`

/**
 * Uses Claude to extract structured planning notes from a Sage chat message.
 * Returns an array of notes with confidence scores. Only includes items with
 * confidence >= 0.5. Returns empty array on failure (never throws).
 */
export async function extractPlanningNotesAI(
  messageText: string,
  weddingContext?: string
): Promise<PlanningNote[]> {
  if (!messageText || messageText.trim().length < 10) return []

  try {
    const userPrompt = weddingContext
      ? `Wedding context: ${weddingContext}\n\nMessage:\n${messageText}`
      : messageText

    const aiNotes = await callAIJson<AIPlanningNote[]>({
      systemPrompt: AI_EXTRACTION_PROMPT,
      userPrompt,
      maxTokens: 1000,
      temperature: 0.1,
      taskType: 'planning_extraction',
      promptVersion: PLANNING_EXTRACTION_PROMPT_VERSION,
    })

    if (!Array.isArray(aiNotes)) return []

    const sourceMessage = messageText.substring(0, 500)

    return aiNotes
      .filter(
        (n) =>
          n &&
          typeof n.category === 'string' &&
          typeof n.content === 'string' &&
          n.content.trim().length > 0 &&
          (n.confidence ?? 0) >= 0.5
      )
      .map((n) => ({
        category: n.category,
        content: n.content.trim(),
        source_message: sourceMessage,
        confidence: n.confidence,
      }))
  } catch (err) {
    console.error('[planning-extraction] AI extraction failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Combined extraction (regex + AI, deduped)
// ---------------------------------------------------------------------------

/**
 * Runs AI extraction on a message and saves any NEW notes that weren't
 * already captured by the regex pass. Intended to be called fire-and-forget
 * after the regex extraction has already run.
 */
export async function extractAndSaveAINotes(
  venueId: string,
  weddingId: string,
  message: string
): Promise<void> {
  const aiNotes = await extractPlanningNotesAI(message)
  if (aiNotes.length === 0) return
  await savePlanningNotes(venueId, weddingId, aiNotes)
}

// ---------------------------------------------------------------------------
// Coordinator-venue conversations
// ---------------------------------------------------------------------------

/**
 * True when this interaction has already produced planning notes.
 *
 * The replay guard. Gmail backfills, the intent drain and the operator
 * reprocess scripts all run the same interaction through the pipeline
 * again, and without this the same sentence lands as a new note every
 * time. The 24-hour content dedup in `savePlanningNotes` does not cover
 * it: a replay six weeks later falls outside the window.
 *
 * Exported so callers can decline to spend a model call at all when the
 * answer is already on the table.
 */
export async function planningNotesExistForInteraction(
  venueId: string,
  interactionId: string,
): Promise<boolean> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('planning_notes')
    .select('id')
    .eq('venue_id', venueId)
    .eq('source_interaction_id', interactionId)
    .limit(1)

  // A failed read is not evidence of absence. Say "yes, they exist" so
  // the caller skips: a missed extraction is recoverable on the next
  // sweep, a duplicated one needs a human to clean up.
  if (error) return true

  return (data?.length ?? 0) > 0
}

/**
 * Planning notes from a coordinator-venue conversation.
 *
 * Until now `planning_notes` could only be fed by a couple's Sage chat
 * message or a contract PDF. But couples do not mostly talk to the
 * chatbot; they email the coordinator. "We're having a groom's cake"
 * arrives in a reply to a seating question, gets read, and is never
 * written down anywhere the day-of view can see it.
 *
 * This is the same AI layer the chatbot path uses, pointed at the body of
 * an inbound interaction. Category defaults to 'note' when nothing better
 * matches, which is most of the time — these are loose details, not
 * vendor bookings.
 *
 * Venue-scoped and idempotent per interaction id. Never throws: the
 * caller is a fire-and-forget hook on the inbound hot path and a failure
 * here must not cost the couple their reply.
 */
export async function extractVenueConversationNotes(args: {
  venueId: string
  weddingId: string
  interactionId: string
  channel: string
  text: string
  /** Extra notes to save alongside the AI ones, already categorised. */
  additionalNotes?: PlanningNote[]
}): Promise<{ saved: number; skipped: 'already_extracted' | 'empty' | null }> {
  const { venueId, weddingId, interactionId, channel, text } = args

  if (!text || text.trim().length < 10) return { saved: 0, skipped: 'empty' }

  if (await planningNotesExistForInteraction(venueId, interactionId)) {
    return { saved: 0, skipped: 'already_extracted' }
  }

  const aiNotes = await extractPlanningNotesAI(text)
  const extra = args.additionalNotes ?? []
  const all = [...aiNotes, ...extra]
  if (all.length === 0) return { saved: 0, skipped: null }

  const stamped = all.map((n) => ({
    ...n,
    category: coerceCategory(n.category),
    source_interaction_id: interactionId,
    source_channel: channel,
  }))

  await savePlanningNotes(venueId, weddingId, stamped)
  return { saved: stamped.length, skipped: null }
}

// ---------------------------------------------------------------------------
// getPlanningNotes
// ---------------------------------------------------------------------------

/**
 * Returns all planning notes for a wedding, ordered by most recent first.
 */
export async function getPlanningNotes(
  venueId: string,
  weddingId: string
): Promise<PlanningNote[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('planning_notes')
    .select('*')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[planning-extraction] Error fetching notes:', error)
    return []
  }

  return data || []
}
