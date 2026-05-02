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

  // Check what's been used with this contact recently within the SAME
  // ORGANISATION (e.g., Crestwood Collection's 4 venues). Pre-fix this
  // was UNFILTERED (cross-tenant) — a violation of the multi-tenancy
  // rule "NO cross-venue retrieval ever" (Playbook 21.6.5 / OPS-21.6.3).
  // The cross-tenant lookup leaked the existence of "another Bloom
  // venue talked to this contact" even though only phrase_text strings
  // came back. Org-scoping preserves the anti-duplication intent
  // (couples seeing 4 Crestwood venues don't get identical phrases)
  // without leaking row existence to unrelated customers' venues.
  let usedPhrases = new Set<string>()
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Resolve the venue's org. Solo venues (org_id null) get strict
    // venue-scope; org-grouped venues get org-scope.
    const { data: venueRow } = await supabase
      .from('venues')
      .select('org_id')
      .eq('id', venueId)
      .maybeSingle()
    const orgId = (venueRow?.org_id as string | null) ?? null

    let scopedVenueIds: string[] = [venueId]
    if (orgId) {
      const { data: orgVenues } = await supabase
        .from('venues')
        .select('id')
        .eq('org_id', orgId)
      scopedVenueIds = ((orgVenues ?? []) as Array<{ id: string }>).map((v) => v.id)
      if (scopedVenueIds.length === 0) scopedVenueIds = [venueId]  // belt
    }

    const { data, error } = await supabase
      .from('phrase_usage')
      .select('phrase_text')
      .in('venue_id', scopedVenueIds)
      .eq('contact_email', contactEmail.toLowerCase())
      .eq('phrase_category', category)
      .gte('used_at', cutoff)
    if (error) {
      console.warn('[phrase-selector] phrase_usage read failed:', error.message)
    } else if (data) {
      usedPhrases = new Set(data.map((r) => r.phrase_text as string))
    }
  } catch (err) {
    console.warn('[phrase-selector] phrase_usage read threw:', (err as Error).message)
  }

  // Filter to unused options
  let available = phraseOptions.filter((p) => !usedPhrases.has(p))

  // If all phrases used, reset and use any
  if (available.length === 0) {
    available = phraseOptions
  }

  // Select randomly from available
  let selected = available[Math.floor(Math.random() * available.length)]

  // Record usage. Column names match migration 005.
  try {
    const { error } = await supabase.from('phrase_usage').insert({
      contact_email: contactEmail.toLowerCase(),
      phrase_category: category,
      phrase_text: selected,
      venue_id: venueId,
    })
    if (error) {
      console.warn('[phrase-selector] phrase_usage insert failed:', error.message)
    }
  } catch (err) {
    console.warn('[phrase-selector] phrase_usage insert threw:', (err as Error).message)
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
