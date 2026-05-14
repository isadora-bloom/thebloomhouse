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
  matchedLabel?: string
}

/**
 * Persist a filter decision so the TIER 5e audit endpoint has real
 * numbers for ignore + gmail_label rules. Fire-and-forget — never
 * blocks the pipeline, never throws. Migration 339.
 */
export async function logFilterMatch(
  venueId: string,
  match: FilterMatch,
  fromEmail: string,
): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase.from('venue_email_filter_matches').insert({
      venue_id: venueId,
      filter_id: match.filterId,
      pattern: match.pattern,
      pattern_type: match.pattern_type,
      action: match.action,
      from_email: fromEmail.toLowerCase().trim(),
      matched_label: match.matchedLabel ?? null,
    })
  } catch (err) {
    console.warn(`[inbox-filters] log write failed for venue ${venueId}:`, err)
  }
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
    const isLabel = f.pattern_type === 'gmail_label'
    const matched = isLabel ? labelMatches(f, gmailLabels) : senderMatches(f, fromEmail)
    if (!matched) continue

    // Capture the matched label so the audit row carries which Gmail
    // category triggered the rule (CATEGORY_PROMOTIONS vs CATEGORY_UPDATES).
    const matchedLabel = isLabel
      ? gmailLabels.find((l) => l.toUpperCase() === f.pattern.toUpperCase())
      : undefined

    if (f.action === 'ignore') {
      return {
        action: 'ignore',
        filterId: f.id,
        pattern: f.pattern,
        pattern_type: f.pattern_type,
        matchedLabel,
      }
    }
    if (!strongest) {
      strongest = {
        action: 'no_draft',
        filterId: f.id,
        pattern: f.pattern,
        pattern_type: f.pattern_type,
        matchedLabel,
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

  // 2026-05-13: own-domain guard. The venue's connected gmail addresses
  // produce a lot of looped-back inbound (auto-replies, contract receipts,
  // calculator notifications) that legitimately don't get drafts.
  // Auto-learning no_draft on this domain then vetoes REAL leads that
  // arrive FROM the venue's own domain (calculator-submit emails the
  // venue's own form sends with reply-to=couple). Bug discovered via
  // RM-Lyndsey-Rivera 2026-05-13: calculator-only inquiry got zero
  // drafts because rixeymanor.com had been auto-learned as no_draft.
  // Collect the set of own-domains here so the loop below skips them.
  const ownDomains = new Set<string>()
  try {
    const { data: conns } = await supabase
      .from('gmail_connections')
      .select('email_address')
      .eq('venue_id', venueId)
    for (const c of conns ?? []) {
      const email = (c as { email_address: string | null }).email_address
      if (!email) continue
      const dom = extractDomain(email.toLowerCase())
      if (dom) ownDomains.add(dom)
    }
  } catch (err) {
    console.warn(`[inbox-filters] gmail_connections lookup failed for ${venueId}:`, err)
  }
  // Belt + suspenders: also check venue_own_emails (manually-curated
  // alternate sending addresses).
  try {
    const { data: own } = await supabase
      .from('venue_own_emails')
      .select('email')
      .eq('venue_id', venueId)
    for (const c of own ?? []) {
      const email = (c as { email: string | null }).email
      if (!email) continue
      const dom = extractDomain(email.toLowerCase())
      if (dom) ownDomains.add(dom)
    }
  } catch {
    // venue_own_emails may not exist in older schemas — ignore.
  }

  // Look at inbound interactions from the last 60 days with a classification.
  // We rely on drafts.context_type + interactions.brain_used being set for
  // actionable mail; non-actionable mail has no draft. So a sender whose
  // interactions consistently produce no draft is a good promotion candidate.
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  // 2026-05-11: pre-existing schema mismatch fixed. Contacts table
  // (001_shared_tables): id, person_id, type, value, is_primary. There
  // is NO `venue_id` column on contacts and NO `contact_type` / `contact_value`
  // columns either — those names came from a different prior schema
  // (mig 063 flagged the divergence). The previous code queried columns
  // that don't exist, which made this whole sender-promotion sweep a
  // silent no-op. Venue scoping now flows through people.venue_id.
  const { data: rows } = await supabase
    .from('interactions')
    .select('id, person_id, direction, timestamp')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .gte('timestamp', since)
    .limit(2000)

  if (!rows || rows.length === 0) return 0

  // Pull the from addresses via contacts join. contacts.person_id ->
  // people.id; venue scoping happens on the join.
  const personIds = Array.from(
    new Set(rows.map((r) => (r as { person_id: string | null }).person_id).filter(Boolean) as string[])
  )

  if (personIds.length === 0) return 0

  const { data: contactRows } = await supabase
    .from('contacts')
    .select('person_id, value, people:person_id(venue_id)')
    .eq('type', 'email')
    .in('person_id', personIds)

  // Supabase returns embedded relations as arrays by default (it can't
  // assume one-to-one without an FK hint). Handle both shapes.
  const emailByPerson = new Map<string, string>()
  for (const c of contactRows ?? []) {
    const row = c as unknown as {
      person_id: string
      value: string
      people: { venue_id: string | null } | { venue_id: string | null }[] | null
    }
    const person = Array.isArray(row.people) ? row.people[0] : row.people
    if (person?.venue_id !== venueId) continue
    const pid = row.person_id
    const val = row.value
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
    // 2026-05-13: skip the venue's own domain — see ownDomains init
    // above. Auto-learning no_draft here vetoes calculator submissions +
    // any other legitimate-lead intake that arrives via reply-to spoof
    // from the venue's own form/calculator.
    if (ownDomains.has(domain)) continue

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
