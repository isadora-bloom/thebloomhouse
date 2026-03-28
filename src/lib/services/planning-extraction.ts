/**
 * Bloom House: Planning Decision Extraction Service
 *
 * Extracts planning decisions from Sage conversations using keyword/pattern
 * matching (no AI calls — fast and free). Couples naturally share decisions
 * like "We booked Sarah's Florals" or "150 guests" during chat, and this
 * service captures those into the planning_notes table so coordinators
 * don't have to read every message.
 *
 * Ported from bloom-house-portal/server/index.js (extractPlanningNotes).
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanningNote {
  category: 'vendor' | 'guest_count' | 'decor' | 'checklist'
  content: string
  source_message: string
}

interface PlanningPattern {
  patterns: RegExp[]
  category: PlanningNote['category']
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
