/**
 * Bloom House: Phrase Selector
 * Selects phrases while preventing duplicates across venues for the same contact.
 *
 * This is the anti-duplication system that prevents couples shopping multiple
 * Bloom-powered venues from receiving identical-sounding emails.
 *
 * Ported from bloom-agent backend/services/phrase_selector.py
 */

import { PHRASE_LIBRARY } from '@/config/phrase-library'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelectPhraseOptions {
  venueId: string
  contactEmail: string
  category: string
  style: string
  fallbackStyle?: string
  templateVars?: Record<string, string>
}

// ---------------------------------------------------------------------------
// selectPhrase
// ---------------------------------------------------------------------------

/**
 * Select a phrase that hasn't been used recently with this contact.
 *
 * Prevents the same couple from receiving identical phrases from
 * different venues using Bloom Agent.
 */
export async function selectPhrase(options: SelectPhraseOptions): Promise<string> {
  const {
    venueId,
    contactEmail,
    category,
    style,
    fallbackStyle = 'warm',
    templateVars,
  } = options

  const supabase = createServiceClient()

  // Get phrase options for this category and style
  const categoryPhrases = (PHRASE_LIBRARY as Record<string, Record<string, string[]>>)[category] ?? {}
  let phraseOptions: string[] = categoryPhrases[style] ?? []

  // Fallback to default style if no phrases for requested style
  if (phraseOptions.length === 0) {
    phraseOptions = categoryPhrases[fallbackStyle] ?? []
  }

  // If still no options, return empty string
  if (phraseOptions.length === 0) {
    console.warn(`No phrases found for category=${category}, style=${style}`)
    return ''
  }

  // Check what's been used with this contact recently (across ALL venues)
  let usedPhrases = new Set<string>()
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('phrase_usage')
      .select('phrase_used')
      .eq('contact_email', contactEmail.toLowerCase())
      .eq('phrase_key', category)
      .gte('used_at', cutoff)

    if (data) {
      usedPhrases = new Set(data.map((r) => r.phrase_used))
    }
  } catch {
    // Table doesn't exist yet or query failed — continue without tracking
  }

  // Filter to unused options
  let available = phraseOptions.filter((p) => !usedPhrases.has(p))

  // If all phrases used, reset and use any
  if (available.length === 0) {
    available = phraseOptions
  }

  // Select randomly from available
  let selected = available[Math.floor(Math.random() * available.length)]

  // Record usage (if table exists)
  try {
    await supabase.from('phrase_usage').insert({
      contact_email: contactEmail.toLowerCase(),
      phrase_key: category,
      phrase_used: selected,
      venue_id: venueId,
    })
  } catch {
    // Don't fail the email if tracking fails
  }

  // Substitute template variables if provided
  if (templateVars) {
    for (const [key, value] of Object.entries(templateVars)) {
      selected = selected.replace(new RegExp(`\\{${key}\\}`, 'g'), value)
    }
  }

  return selected
}

// ---------------------------------------------------------------------------
// selectPhrasesForEmail
// ---------------------------------------------------------------------------

/**
 * Select multiple phrases for an email at once.
 */
export async function selectPhrasesForEmail(options: {
  style: string
  contactEmail: string
  venueId: string
  categories: string[]
  templateVars?: Record<string, string>
}): Promise<Record<string, string>> {
  const { style, contactEmail, venueId, categories, templateVars } = options

  const phrases: Record<string, string> = {}
  for (const category of categories) {
    phrases[category] = await selectPhrase({
      category,
      style,
      contactEmail,
      venueId,
      templateVars,
    })
  }

  return phrases
}

// ---------------------------------------------------------------------------
// cleanupOldPhraseUsage
// ---------------------------------------------------------------------------

/**
 * Remove phrase usage records older than specified days.
 * Returns number of records deleted.
 */
export async function cleanupOldPhraseUsage(days = 60): Promise<number> {
  const supabase = createServiceClient()

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('phrase_usage')
      .delete()
      .lt('used_at', cutoff)
      .select()

    return data?.length ?? 0
  } catch (e) {
    console.warn('Failed to cleanup phrase usage:', e)
    return 0
  }
}
