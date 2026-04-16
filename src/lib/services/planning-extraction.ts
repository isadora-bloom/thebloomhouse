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
    category: note.category,
    content: note.content,
    source_message: note.source_message,
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
