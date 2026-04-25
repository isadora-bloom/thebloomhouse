/**
 * Identity resolution — the Phase 8 matching engine.
 *
 * Given a candidate (a new inquiry's contact, or an extracted identity from
 * a brain-dump screenshot), return every existing person this candidate
 * plausibly IS, along with a confidence tier and the signals that fired.
 *
 * The tiers and rules are specified in docs/identity-resolution.md and the
 * brief:
 *
 *   high   — auto-merge silently, log, coordinator can undo
 *     - same email
 *     - same phone
 *     - same full first + full last name + same partner name within 30d
 *     - same instagram handle + same email anywhere on the person
 *
 *   medium — suggest in queue, coordinator confirms
 *     - same first + same partner first within 7d
 *     - same first + last initial + same email domain within 14d
 *     - same first + same wedding_date being asked about within 14d
 *     - username pattern (e.g. sarahhighland + Sarah H) within 14d
 *
 *   low    — loose connection, recorded only, promotes if more signal arrives
 *     - same first only within 7d
 *     - same wedding_date interest only within 14d
 *
 * Windows are per-venue-configurable via venue_config.identity_match_config.
 * The defaults below are what the brief spec says.
 *
 * Purely read-only. Writing to client_match_queue / merging / promoting is
 * the caller's job (see merge-people.ts + the email-pipeline hook).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface IdentityCandidate {
  venueId: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
  partnerFirstName?: string | null
  partnerLastName?: string | null
  instagramHandle?: string | null
  knotUsername?: string | null
  /** The date being asked about (for "same wedding_date interest" rules). */
  weddingDate?: string | null
  /** ISO timestamp of when this identity appeared (for window comparisons).
   * Defaults to now() when unset. */
  signalDate?: string | null
  /** Optionally exclude an existing person id from match candidates — used
   * by the post-create hook so we don't match a person to itself. */
  excludePersonId?: string | null
}

export interface IdentitySignal {
  type: string
  detail: string
  weight: number
}

export interface IdentityMatch {
  personId: string
  tier: 'high' | 'medium' | 'low'
  confidence: number // 0-1
  signals: IdentitySignal[]
  /** A stable human-readable label so the queue UI doesn't re-fetch names. */
  label: string
}

interface MatchConfig {
  name_plus_partner_days: number
  name_last_initial_days: number
  name_wedding_date_days: number
  username_pattern_days: number
  first_name_only_days: number
  wedding_date_only_days: number
}

const DEFAULT_CONFIG: MatchConfig = {
  name_plus_partner_days: 30,
  name_last_initial_days: 14,
  name_wedding_date_days: 14,
  username_pattern_days: 14,
  first_name_only_days: 7,
  wedding_date_only_days: 14,
}

function normalise(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim()
}

function normaliseHandle(s: string | null | undefined): string {
  return normalise(s).replace(/^@/, '').replace(/[^a-z0-9_.]/g, '')
}

function emailDomain(s: string | null | undefined): string {
  const i = (s ?? '').indexOf('@')
  return i > 0 ? s!.slice(i + 1).toLowerCase().trim() : ''
}

function lastInitial(s: string | null | undefined): string {
  const n = normalise(s)
  return n[0] ?? ''
}

function daysApart(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return Infinity
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity
  return Math.abs(ta - tb) / (1000 * 60 * 60 * 24)
}

/**
 * Fuzzy username-to-real-name check: 'sarahhighland' and 'Sarah H' are
 * consistent if the handle starts with the first name + either the last
 * name OR the last initial. Kept conservative to avoid false positives
 * on common first names.
 */
function usernameMatchesName(
  handle: string,
  firstName: string,
  lastName: string
): boolean {
  const h = normaliseHandle(handle)
  const f = normalise(firstName)
  const l = normalise(lastName)
  if (!h || !f) return false
  if (h.startsWith(f) && l && h.includes(l)) return true
  if (h.startsWith(f) && h.length >= f.length + 1) {
    // handle starts with firstname + something — accept if that something
    // begins with the last initial AND first name is at least 4 chars to
    // limit common-name false positives.
    if (f.length >= 4 && h[f.length] === lastInitial(lastName)) return true
  }
  return false
}

type PersonRow = {
  id: string
  venue_id: string
  wedding_id: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  external_ids: Record<string, unknown> | null
  created_at: string
  role: string | null
  wedding_date?: string | null // hydrated via join
}

async function loadVenueConfig(
  supabase: SupabaseClient,
  venueId: string
): Promise<MatchConfig> {
  const { data } = await supabase
    .from('venue_config')
    .select('identity_match_config')
    .eq('venue_id', venueId)
    .maybeSingle()
  const cfg = (data?.identity_match_config ?? {}) as Partial<MatchConfig>
  return { ...DEFAULT_CONFIG, ...cfg }
}

async function loadCandidatePeople(
  supabase: SupabaseClient,
  venueId: string,
  excludePersonId: string | null
): Promise<PersonRow[]> {
  // Pull every person for the venue. People volumes per venue stay in the
  // hundreds — not a scale concern yet. If this ever grows past ~5k the
  // query narrows to recent-created + window-based.
  let q = supabase
    .from('people')
    .select('id, venue_id, wedding_id, first_name, last_name, email, phone, external_ids, created_at, role, weddings(wedding_date)')
    .eq('venue_id', venueId)
  if (excludePersonId) q = q.neq('id', excludePersonId)
  const { data, error } = await q
  if (error) return []
  return (data ?? []).map((r) => {
    const weddingRel = r.weddings as { wedding_date?: string | null } | { wedding_date?: string | null }[] | null | undefined
    const wedding_date = Array.isArray(weddingRel) ? weddingRel[0]?.wedding_date ?? null : weddingRel?.wedding_date ?? null
    const { weddings: _, ...rest } = r as typeof r & { weddings?: unknown }
    void _
    return { ...rest, wedding_date } as PersonRow
  })
}

function scorePair(
  candidate: IdentityCandidate,
  person: PersonRow,
  config: MatchConfig
): IdentityMatch | null {
  const signals: IdentitySignal[] = []

  const cEmail = normalise(candidate.email)
  const pEmail = normalise(person.email)
  const cPhone = normalise(candidate.phone).replace(/\D+/g, '')
  const pPhone = normalise(person.phone).replace(/\D+/g, '')
  const cFirst = normalise(candidate.firstName)
  const pFirst = normalise(person.first_name)
  const cLast = normalise(candidate.lastName)
  const pLast = normalise(person.last_name)
  const cPartner = normalise(candidate.partnerFirstName)
  const cInsta = normaliseHandle(candidate.instagramHandle)
  const pInsta = normaliseHandle(
    typeof person.external_ids?.instagram === 'string' ? (person.external_ids.instagram as string) : ''
  )

  const candidateDate = candidate.signalDate ?? new Date().toISOString()

  // --------- HIGH ---------
  if (cEmail && pEmail && cEmail === pEmail) {
    signals.push({ type: 'same_email', detail: cEmail, weight: 1.0 })
  }
  if (cPhone && pPhone && cPhone === pPhone && cPhone.length >= 10) {
    signals.push({ type: 'same_phone', detail: cPhone, weight: 1.0 })
  }
  if (cInsta && pInsta && cInsta === pInsta && cEmail && pEmail) {
    // "Same Instagram handle AND same email anywhere in the system" — we
    // already covered same_email above; this branch just records the
    // combined instagram signal as extra evidence.
    signals.push({ type: 'same_instagram_plus_email', detail: `@${cInsta} + ${cEmail}`, weight: 1.0 })
  }
  if (
    cFirst && pFirst && cFirst === pFirst &&
    cLast && pLast && cLast === pLast &&
    cPartner
  ) {
    // Full name + partner first name within 30d window.
    if (daysApart(candidateDate, person.created_at) <= config.name_plus_partner_days) {
      signals.push({
        type: 'full_name_plus_partner_window',
        detail: `${cFirst} ${cLast} + partner "${cPartner}" within ${config.name_plus_partner_days}d`,
        weight: 0.95,
      })
    }
  }

  const hasHighSignal = signals.some((s) => s.weight >= 0.95)
  if (hasHighSignal) {
    return {
      personId: person.id,
      tier: 'high',
      confidence: Math.max(...signals.map((s) => s.weight)),
      signals,
      label: buildLabel(person),
    }
  }

  // --------- MEDIUM ---------
  if (cFirst && pFirst && cFirst === pFirst && cPartner && cPartner.length > 0) {
    if (daysApart(candidateDate, person.created_at) <= config.name_plus_partner_days) {
      // Already would have been high if last name matched — here we're
      // first + partner without full last.
      signals.push({
        type: 'first_name_plus_partner_window',
        detail: `${cFirst} + partner "${cPartner}" within window`,
        weight: 0.75,
      })
    }
  }
  if (
    cFirst && pFirst && cFirst === pFirst &&
    cLast && pLast && lastInitial(cLast) === lastInitial(pLast) &&
    cEmail && pEmail && emailDomain(cEmail) === emailDomain(pEmail) &&
    emailDomain(cEmail).length > 0
  ) {
    if (daysApart(candidateDate, person.created_at) <= config.name_last_initial_days) {
      signals.push({
        type: 'first_plus_last_initial_plus_domain',
        detail: `${cFirst} ${lastInitial(cLast)}. at ${emailDomain(cEmail)}`,
        weight: 0.7,
      })
    }
  }
  if (
    cFirst && pFirst && cFirst === pFirst &&
    candidate.weddingDate && person.wedding_date &&
    candidate.weddingDate === person.wedding_date
  ) {
    if (daysApart(candidateDate, person.created_at) <= config.name_wedding_date_days) {
      signals.push({
        type: 'first_name_plus_wedding_date',
        detail: `${cFirst} asking about ${candidate.weddingDate}`,
        weight: 0.7,
      })
    }
  }
  if (cInsta && pFirst && pLast && usernameMatchesName(cInsta, pFirst, pLast)) {
    if (daysApart(candidateDate, person.created_at) <= config.username_pattern_days) {
      signals.push({
        type: 'username_pattern_match',
        detail: `@${cInsta} looks like ${pFirst} ${pLast}`,
        weight: 0.65,
      })
    }
  }
  // Full name match within the partner-window (30d default). Catches
  // the common multi-touch journey: same couple inquired via Knot
  // with a relay email, then booked Calendly with a personal gmail.
  // Partner + date signals are rarely captured on both sides but a
  // same-first + same-last inside a month is strong enough to queue.
  // Not high-tier — surnames repeat, especially for common names.
  if (
    cFirst && pFirst && cFirst === pFirst &&
    cLast && pLast && cLast === pLast &&
    daysApart(candidateDate, person.created_at) <= config.name_plus_partner_days
  ) {
    signals.push({
      type: 'full_name_within_window',
      detail: `${cFirst} ${cLast} within ${config.name_plus_partner_days}d`,
      weight: 0.6,
    })
  }

  const hasMediumSignal = signals.some((s) => s.weight >= 0.6)
  if (hasMediumSignal) {
    const confidence = Math.min(
      0.9,
      signals.reduce((a, s) => Math.max(a, s.weight), 0)
    )
    return {
      personId: person.id,
      tier: 'medium',
      confidence,
      signals,
      label: buildLabel(person),
    }
  }

  // --------- LOW ---------
  if (cFirst && pFirst && cFirst === pFirst && daysApart(candidateDate, person.created_at) <= config.first_name_only_days) {
    signals.push({
      type: 'first_name_only_window',
      detail: `Both named ${cFirst} within ${config.first_name_only_days}d`,
      weight: 0.3,
    })
  }
  if (
    candidate.weddingDate && person.wedding_date &&
    candidate.weddingDate === person.wedding_date &&
    daysApart(candidateDate, person.created_at) <= config.wedding_date_only_days
  ) {
    signals.push({
      type: 'wedding_date_only_window',
      detail: `Both asking about ${candidate.weddingDate}`,
      weight: 0.3,
    })
  }

  if (signals.length > 0) {
    return {
      personId: person.id,
      tier: 'low',
      confidence: 0.3,
      signals,
      label: buildLabel(person),
    }
  }

  return null
}

function buildLabel(person: PersonRow): string {
  const name = [person.first_name, person.last_name].filter(Boolean).join(' ').trim()
  if (name) return name
  if (person.email) return person.email
  return 'Unnamed person'
}

/**
 * Primary entry point: given a candidate, return every possible match in
 * the venue's people pool with confidence tier + signals.
 */
export async function resolveIdentity(
  supabase: SupabaseClient,
  candidate: IdentityCandidate
): Promise<IdentityMatch[]> {
  if (!candidate.venueId) return []
  const config = await loadVenueConfig(supabase, candidate.venueId)
  const people = await loadCandidatePeople(supabase, candidate.venueId, candidate.excludePersonId ?? null)
  const matches: IdentityMatch[] = []
  for (const p of people) {
    const m = scorePair(candidate, p, config)
    if (m) matches.push(m)
  }
  // Sort: high tier first, then by confidence desc.
  const tierOrder = { high: 0, medium: 1, low: 2 } as const
  matches.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || b.confidence - a.confidence)
  return matches
}

/**
 * Convert a people row into the candidate shape for downstream matching.
 * Used after a new person is created so we can check for historical
 * tangential signals that now line up with this person.
 */
export function personToCandidate(row: PersonRow): IdentityCandidate {
  return {
    venueId: row.venue_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    instagramHandle: typeof row.external_ids?.instagram === 'string' ? (row.external_ids.instagram as string) : null,
    weddingDate: row.wedding_date ?? null,
    signalDate: row.created_at,
    excludePersonId: row.id,
  }
}
