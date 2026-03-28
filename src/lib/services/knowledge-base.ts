/**
 * Bloom House: Knowledge Base Service
 *
 * Manages FAQ and policy entries that Sage (the AI assistant) uses to answer
 * couple questions about venue details, pricing, policies, etc.
 *
 * Each entry has a question/answer pair, keywords for search matching,
 * a category for organization, and a priority for ranking relevance.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KBEntry {
  id: string
  venue_id: string
  category: string
  question: string
  answer: string
  keywords: string[]
  priority: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface CreateKBEntryInput {
  category: string
  question: string
  answer: string
  keywords: string[]
  priority?: number
}

export type UpdateKBEntryInput = Partial<{
  category: string
  question: string
  answer: string
  keywords: string[]
  priority: number
  is_active: boolean
}>

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Keyword-based search across the knowledge base.
 *
 * Splits the query into individual words and searches against:
 *   - keywords array (array contains)
 *   - question text (ilike)
 *   - answer text (ilike)
 *
 * Returns active entries ordered by priority desc, with best keyword
 * matches first.
 */
export async function searchKnowledgeBase(
  venueId: string,
  query: string
): Promise<KBEntry[]> {
  const supabase = createServiceClient()

  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)

  if (words.length === 0) {
    return getKnowledgeBase(venueId)
  }

  // Build OR conditions for each word against keywords, question, and answer
  const orConditions = words
    .flatMap((word) => [
      `keywords.cs.{${word}}`,
      `question.ilike.%${word}%`,
      `answer.ilike.%${word}%`,
    ])
    .join(',')

  const { data, error } = await supabase
    .from('knowledge_base')
    .select('*')
    .eq('venue_id', venueId)
    .eq('is_active', true)
    .or(orConditions)
    .order('priority', { ascending: false })

  if (error) throw error

  // Score results by number of matching words for relevance ranking
  const scored = (data ?? []).map((entry) => {
    let score = 0
    const entryText = `${entry.question} ${entry.answer}`.toLowerCase()
    const entryKeywords: string[] = entry.keywords ?? []

    for (const word of words) {
      // Keyword array match is highest value
      if (entryKeywords.some((kw: string) => kw.toLowerCase() === word)) {
        score += 3
      }
      // Question match
      if (entry.question.toLowerCase().includes(word)) {
        score += 2
      }
      // Answer match
      if (entryText.includes(word)) {
        score += 1
      }
    }

    return { entry: entry as KBEntry, score }
  })

  // Sort by score desc, then priority desc
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (b.entry.priority ?? 0) - (a.entry.priority ?? 0)
  })

  return scored.map((s) => s.entry)
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Get all KB entries for a venue, optionally filtered by category.
 * Returns entries ordered by priority descending.
 */
export async function getKnowledgeBase(
  venueId: string,
  category?: string
): Promise<KBEntry[]> {
  const supabase = createServiceClient()

  let query = supabase
    .from('knowledge_base')
    .select('*')
    .eq('venue_id', venueId)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })

  if (category) {
    query = query.eq('category', category)
  }

  const { data, error } = await query

  if (error) throw error
  return (data ?? []) as KBEntry[]
}

/**
 * Get distinct categories used by a venue's KB entries.
 */
export async function getKBCategories(venueId: string): Promise<string[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('knowledge_base')
    .select('category')
    .eq('venue_id', venueId)
    .order('category', { ascending: true })

  if (error) throw error

  // Extract unique categories
  const categories = new Set<string>()
  for (const row of data ?? []) {
    if (row.category) {
      categories.add(row.category as string)
    }
  }

  return Array.from(categories)
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Insert a new knowledge base entry for a venue.
 */
export async function createKBEntry(
  venueId: string,
  entry: CreateKBEntryInput
): Promise<KBEntry> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('knowledge_base')
    .insert({
      venue_id: venueId,
      category: entry.category,
      question: entry.question,
      answer: entry.answer,
      keywords: entry.keywords,
      priority: entry.priority ?? 0,
      is_active: true,
    })
    .select('*')
    .single()

  if (error) throw error
  return data as KBEntry
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update an existing knowledge base entry.
 */
export async function updateKBEntry(
  entryId: string,
  updates: UpdateKBEntryInput
): Promise<KBEntry> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('knowledge_base')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', entryId)
    .select('*')
    .single()

  if (error) throw error
  return data as KBEntry
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a knowledge base entry.
 */
export async function deleteKBEntry(entryId: string): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('knowledge_base')
    .delete()
    .eq('id', entryId)

  if (error) throw error
}
