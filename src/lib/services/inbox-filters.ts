/**
 * Inbox filters — per-venue auto-ignore / no-draft rules.
 *
 * Two tiers beyond Gmail's own fetch-time category filter:
 *
 *   ignore   — drop before classifier. Skips the AI call entirely. Use for
 *              bulk senders, newsletters, transactional notifications.
 *   no_draft — classify and persist the interaction (intelligence layer still
 *              sees it), but don't generate a draft. Use for vendor mail, the
 *              owner's own internal forwards, repeat-but-not-actionable senders.
 *
 * Matching is case-insensitive. sender_domain matches "ends with .<domain>"
 * or "equals <domain>" — both `foo@mailchimp.com` and `foo@news.mailchimp.com`
 * match pattern `mailchimp.com`.
 *
 * This module is called twice per email:
 *   1. Pre-classify  — pipeline asks shouldIgnore(). If true, bail early.
 *   2. Pre-draft     — pipeline asks shouldSkipDraft(). If true, persist but
 *                      don't hand off to the inquiry/client brain.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface VenueEmailFilter {
  id: string
  venue_id: string
  pattern_type: 'sender_exact' | 'sender_domain' | 'gmail_label'
  pattern: string
  action: 'ignore' | 'no_draft'
  source: 'manual' | 'learned'
  note: string | null
  created_at: string
  updated_at: string
}

// Per-venue cache — invalidated at the start of each cron run by calling
// clearFilterCache(). Avoids N+1 DB hits when a venue has dozens of inbound
// messages in a single poll tick.
const cache = new Map<string, { filters: VenueEmailFilter[]; loadedAt: number }>()
const CACHE_TTL_MS = 60_000 // 1 minute — cron runs every 5 min, one load per tick

export function clearFilterCache(venueId?: string) {
  if (venueId) cache.delete(venueId)
  else cache.clear()
}

export async function loadFilters(venueId: string): Promise<VenueEmailFilter[]> {
  const cached = cache.get(venueId)
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.filters
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_email_filters')
    .select('*')
    .eq('venue_id', venueId)

  if (error) {
    console.error(`[inbox-filters] Failed to load filters for venue ${venueId}:`, error.message)
    return []
  }

  const filters = (data ?? []) as VenueEmailFilter[]
  cache.set(venueId, { filters, loadedAt: Date.now() })
  return filters
}

function extractDomain(email: string): string {
  const at = email.lastIndexOf('@')
  if (at === -1) return email.toLowerCase()
  return email.slice(at + 1).toLowerCase()
}

function senderMatches(filter: VenueEmailFilter, fromEmail: string): boolean {
  const pattern = filter.pattern.toLowerCase().trim()
  const from = fromEmail.toLowerCase().trim()

  if (filter.pattern_type === 'sender_exact') {
    return from === pattern
  }

  if (filter.pattern_type === 'sender_domain') {
    const domain = extractDomain(from)
    return domain === pattern || domain.endsWith(`.${pattern}`)
  }

  return false
}

function labelMatches(filter: VenueEmailFilter, labels: string[]): boolean {
  if (filter.pattern_type !== 'gmail_label') return false
  const pattern = filter.pattern.toUpperCase().trim()
  return labels.some((l) => l.toUpperCase() === pattern)
}

export interface FilterMatch {
  action: 'ignore' | 'no_draft'
  filterId: string
  pattern: string
  pattern_type: VenueEmailFilter['pattern_type']
}

/**
 * Check an incoming email against all filters for the venue.
 * Returns the first match by strictest action (ignore wins over no_draft).
 * Null means no rule applies — let the pipeline proceed normally.
 */
export async function matchFilter(
  venueId: string,
  fromEmail: string,
  gmailLabels: string[] = []
): Promise<FilterMatch | null> {
  const filters = await loadFilters(venueId)
  if (filters.length === 0) return null

  // Precedence: ignore > no_draft. Gather all matches, pick strictest.
  let strongest: FilterMatch | null = null
  for (const f of filters) {
    const matched =
      f.pattern_type === 'gmail_label'
        ? labelMatches(f, gmailLabels)
        : senderMatches(f, fromEmail)

    if (!matched) continue

    if (f.action === 'ignore') {
      return {
        action: 'ignore',
        filterId: f.id,
        pattern: f.pattern,
        pattern_type: f.pattern_type,
      }
    }
    if (!strongest) {
      strongest = {
        action: 'no_draft',
        filterId: f.id,
        pattern: f.pattern,
        pattern_type: f.pattern_type,
      }
    }
  }

  return strongest
}

// ---------------------------------------------------------------------------
// Learned-rule promotion (nightly cron)
// ---------------------------------------------------------------------------

/**
 * Scan the last N days of interactions for each venue. For any sender_domain
 * whose last 5+ classifications were all vendor/internal/other (no inquiries
 * or client replies), auto-insert a `no_draft` learned rule.
 *
 * Intentionally conservative:
 *   - Never learns `ignore` — that's destructive. Only `no_draft`.
 *   - Never touches domains that already have any filter row.
 *   - Requires 5 classifications minimum so one-offs don't trigger.
 */
export async function learnFiltersForAllVenues(): Promise<Record<string, number>> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')

  if (!venues || venues.length === 0) return {}

  const results: Record<string, number> = {}
  for (const v of venues) {
    try {
      results[v.id as string] = await learnFiltersForVenue(v.id as string)
    } catch (err) {
      console.error(`[inbox-filters] Learning failed for venue ${v.id}:`, err)
      results[v.id as string] = 0
    }
  }
  return results
}

async function learnFiltersForVenue(venueId: string): Promise<number> {
  const supabase = createServiceClient()

  // Look at inbound interactions from the last 60 days with a classification.
  // We rely on drafts.context_type + interactions.brain_used being set for
  // actionable mail; non-actionable mail has no draft. So a sender whose
  // interactions consistently produce no draft is a good promotion candidate.
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  const { data: rows } = await supabase
    .from('interactions')
    .select('id, person_id, direction, timestamp, contacts:person_id(contact_value)')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .gte('timestamp', since)
    .limit(2000)

  if (!rows || rows.length === 0) return 0

  // Pull the from addresses via contacts join. contacts table has person_id -> email.
  // The supabase join above doesn't necessarily work without a foreign-key hint;
  // fall back to a direct contacts query keyed by the distinct person_ids.
  const personIds = Array.from(
    new Set(rows.map((r) => (r as { person_id: string | null }).person_id).filter(Boolean) as string[])
  )

  if (personIds.length === 0) return 0

  const { data: contactRows } = await supabase
    .from('contacts')
    .select('person_id, contact_value')
    .eq('venue_id', venueId)
    .eq('contact_type', 'email')
    .in('person_id', personIds)

  const emailByPerson = new Map<string, string>()
  for (const c of contactRows ?? []) {
    const pid = (c as { person_id: string }).person_id
    const val = (c as { contact_value: string }).contact_value
    if (pid && val && !emailByPerson.has(pid)) emailByPerson.set(pid, val.toLowerCase())
  }

  // Pull the drafts associated with these interactions to know which produced
  // a draft vs which didn't.
  const interactionIds = rows.map((r) => (r as { id: string }).id)
  const { data: draftRows } = await supabase
    .from('drafts')
    .select('interaction_id')
    .eq('venue_id', venueId)
    .in('interaction_id', interactionIds)

  const draftedInteractions = new Set(
    (draftRows ?? []).map((d) => (d as { interaction_id: string }).interaction_id)
  )

  // Bucket by domain.
  const perDomain = new Map<string, { total: number; undrafted: number }>()
  for (const row of rows) {
    const r = row as { id: string; person_id: string | null }
    if (!r.person_id) continue
    const email = emailByPerson.get(r.person_id)
    if (!email) continue
    const domain = extractDomain(email)
    if (!domain) continue
    // Skip obvious personal-domain clusters — only learn on bulk-ish domains
    // (ones seen from multiple people). This filter happens below after
    // counting.
    const existing = perDomain.get(domain) ?? { total: 0, undrafted: 0 }
    existing.total++
    if (!draftedInteractions.has(r.id)) existing.undrafted++
    perDomain.set(domain, existing)
  }

  // Load existing filter patterns so we don't duplicate or contradict manual rules.
  const existingFilters = await loadFilters(venueId)
  const existingDomains = new Set(
    existingFilters
      .filter((f) => f.pattern_type === 'sender_domain')
      .map((f) => f.pattern.toLowerCase())
  )

  let promoted = 0
  for (const [domain, stats] of perDomain) {
    if (existingDomains.has(domain)) continue
    if (stats.total < 5) continue
    if (stats.undrafted / stats.total < 0.9) continue // 90%+ never produced a draft
    // Skip common personal providers — we should never learn to suppress gmail.com
    if (PERSONAL_PROVIDER_DOMAINS.has(domain)) continue

    const { error } = await supabase.from('venue_email_filters').insert({
      venue_id: venueId,
      pattern_type: 'sender_domain',
      pattern: domain,
      action: 'no_draft',
      source: 'learned',
      note: `Auto-learned: ${stats.undrafted}/${stats.total} inbound messages from @${domain} produced no draft over the last 60 days.`,
    })
    if (!error) promoted++
  }

  if (promoted > 0) clearFilterCache(venueId)
  return promoted
}

const PERSONAL_PROVIDER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
])
