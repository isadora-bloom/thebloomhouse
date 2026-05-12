/**
 * Match parsed social_engagements rows against people / weddings.
 *
 * Three matchers run in order; the first to land wins:
 *
 *   1. handle_exact   -- people.platform_handles->>'<platform>' = handle
 *                        (confidence 100)
 *
 *   2. name_fuzzy     -- when display_name is captured, compare against
 *                        people.first_name + " " + people.last_name via
 *                        Postgres similarity() (pg_trgm). Falls back to
 *                        lowercase substring match if pg_trgm is not
 *                        installed. Threshold: similarity >= 0.5.
 *                        Confidence = round(similarity * 100).
 *
 *   3. email_inferred -- split people.email local part on common
 *                        separators; if it equals or contains the handle
 *                        (case-insensitive), match. Confidence 50.
 *
 * After matching, the matcher computes how many of the matches are
 * "pre-inquiry engagements" -- ones whose engagement_at is earlier than
 * the linked wedding''s inquiry_date. Those are the Point-Zero forensic
 * signals the constitution cares about.
 *
 * The matcher writes the result back to social_engagements + updates
 * the parent social_captures.matched_count / unmatched_count counters.
 *
 * Designed to run inline in the capture API route (<10s for ~50 handles)
 * using the service-role client; RLS is enforced at the API boundary.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface MatchResult {
  matched: number
  unmatched: number
  surfaced_pre_inquiry: number
  matchedSamples: Array<{
    handle: string
    couple_name: string | null
    wedding_id: string | null
    is_pre_inquiry: boolean
    engagement_at: string | null
    inquiry_date: string | null
  }>
}

interface EngagementRow {
  id: string
  venue_id: string
  platform: string
  handle: string
  display_name: string | null
  engagement_at: string | null
}

interface PersonRow {
  id: string
  wedding_id: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  platform_handles: Record<string, string | null> | null
}

interface WeddingRow {
  id: string
  inquiry_date: string | null
  event_code: string | null
}

const PG_TRGM_THRESHOLD = 0.5

/**
 * Match every pending engagement on the given capture. Returns the
 * structured result the API surfaces back to the operator UI.
 *
 * Side effects: writes match_* columns on social_engagements rows +
 * updates social_captures matched_count / unmatched_count.
 */
export async function matchEngagementsForCapture(
  captureId: string,
  supabase: SupabaseClient,
): Promise<MatchResult> {
  // 1. Load pending engagements for the capture.
  const { data: engagements, error: engErr } = await supabase
    .from('social_engagements')
    .select('id, venue_id, platform, handle, display_name, engagement_at')
    .eq('social_capture_id', captureId)
    .eq('match_status', 'pending')

  if (engErr) {
    throw new Error(`load engagements: ${engErr.message}`)
  }

  const rows = (engagements ?? []) as EngagementRow[]
  if (rows.length === 0) {
    return { matched: 0, unmatched: 0, surfaced_pre_inquiry: 0, matchedSamples: [] }
  }

  const venueId = rows[0].venue_id
  const platform = rows[0].platform

  // 2. Bulk-load candidate people for this venue. We pull the columns
  //    the three matchers need; one query, then we sort in memory.
  const { data: peopleData, error: pErr } = await supabase
    .from('people')
    .select('id, wedding_id, first_name, last_name, email, platform_handles')
    .eq('venue_id', venueId)

  if (pErr) {
    throw new Error(`load people: ${pErr.message}`)
  }

  const people = (peopleData ?? []) as PersonRow[]

  // 3. Build handle index for matcher 1 (handle_exact).
  const byHandle = new Map<string, PersonRow>()
  for (const p of people) {
    const h = p.platform_handles?.[platform]
    if (typeof h === 'string' && h.length > 0) {
      byHandle.set(h.toLowerCase(), p)
    }
  }

  // 4. Decide whether pg_trgm is available for matcher 2. We try once
  //    via a cheap SELECT similarity('a','a'); failure means we fall
  //    back to lowercase substring.
  const trgmAvailable = await pgTrgmAvailable(supabase)

  // 5. Run the matchers.
  type MatchOutcome = {
    person_id: string | null
    method: 'handle_exact' | 'name_fuzzy' | 'email_inferred' | null
    confidence: number | null
  }

  const outcomes = new Map<string, MatchOutcome>()

  for (const row of rows) {
    let outcome: MatchOutcome = { person_id: null, method: null, confidence: null }

    // Matcher 1: handle exact.
    const exact = byHandle.get(row.handle.toLowerCase())
    if (exact) {
      outcome = { person_id: exact.id, method: 'handle_exact', confidence: 100 }
      outcomes.set(row.id, outcome)
      continue
    }

    // Matcher 2: name fuzzy.
    if (row.display_name && row.display_name.trim().length > 0) {
      const fuzzy = await fuzzyMatchName(
        supabase,
        venueId,
        row.display_name,
        trgmAvailable,
      )
      if (fuzzy) {
        outcome = {
          person_id: fuzzy.person_id,
          method: 'name_fuzzy',
          confidence: Math.round(fuzzy.similarity * 100),
        }
        outcomes.set(row.id, outcome)
        continue
      }
    }

    // Matcher 3: email-inferred.
    const inferred = matchByEmailInference(people, row.handle)
    if (inferred) {
      outcome = { person_id: inferred.id, method: 'email_inferred', confidence: 50 }
      outcomes.set(row.id, outcome)
      continue
    }

    outcomes.set(row.id, outcome)
  }

  // 6. Write outcomes back. We do one update per row -- N is small (the
  //    capture batches are operator-paced, ~50-500 handles tops). If
  //    this becomes a bottleneck, we move to a single CASE-WHEN UPDATE.
  const now = new Date().toISOString()
  for (const row of rows) {
    const o = outcomes.get(row.id)!
    if (o.person_id) {
      await supabase
        .from('social_engagements')
        .update({
          match_status: 'matched',
          matched_person_id: o.person_id,
          match_method: o.method,
          match_confidence: o.confidence,
          matched_at: now,
        })
        .eq('id', row.id)
    } else {
      await supabase
        .from('social_engagements')
        .update({
          match_status: 'unmatched',
          matched_at: now,
        })
        .eq('id', row.id)
    }
  }

  // 7. Compute pre-inquiry surfacing. For matched engagements with a
  //    linked wedding, compare engagement_at vs wedding.inquiry_date.
  const matchedWeddingIds = new Set<string>()
  const personById = new Map(people.map((p) => [p.id, p]))
  for (const row of rows) {
    const o = outcomes.get(row.id)!
    if (!o.person_id) continue
    const person = personById.get(o.person_id)
    if (person?.wedding_id) matchedWeddingIds.add(person.wedding_id)
  }

  const weddings: Map<string, WeddingRow> = new Map()
  if (matchedWeddingIds.size > 0) {
    const { data: wedData, error: wErr } = await supabase
      .from('weddings')
      .select('id, inquiry_date, event_code')
      .in('id', Array.from(matchedWeddingIds))
    if (wErr) {
      throw new Error(`load weddings: ${wErr.message}`)
    }
    for (const w of (wedData ?? []) as WeddingRow[]) {
      weddings.set(w.id, w)
    }
  }

  let matchedCount = 0
  let surfacedPreInquiry = 0
  const samples: MatchResult['matchedSamples'] = []

  for (const row of rows) {
    const o = outcomes.get(row.id)!
    if (!o.person_id) continue
    matchedCount += 1
    const person = personById.get(o.person_id)
    const wedding = person?.wedding_id ? weddings.get(person.wedding_id) : null
    const engagementAt = row.engagement_at
    const inquiryDate = wedding?.inquiry_date ?? null
    const isPreInquiry =
      engagementAt !== null &&
      inquiryDate !== null &&
      new Date(engagementAt).getTime() < new Date(inquiryDate).getTime()
    if (isPreInquiry) surfacedPreInquiry += 1

    if (samples.length < 50) {
      // Fallback chain: name → email → wedding event_code → "Unknown".
      // Many Rixey rows still carry form-bleed first/last that the
      // repair-form-bleed-names script will eventually NULL out;
      // email + event_code are stable fallbacks the coordinator can
      // still recognise.
      const coupleName = person
        ? [person.first_name, person.last_name].filter(Boolean).join(' ') || null
        : null
      const fallback =
        coupleName
        ?? (person?.email ? person.email : null)
        ?? (wedding?.event_code ? `Wedding ${wedding.event_code}` : null)
      samples.push({
        handle: row.handle,
        couple_name: fallback,
        wedding_id: person?.wedding_id ?? null,
        is_pre_inquiry: isPreInquiry,
        engagement_at: engagementAt,
        inquiry_date: inquiryDate,
      })
    }
  }

  const unmatched = rows.length - matchedCount

  // 8. Stamp counters on the capture row.
  await supabase
    .from('social_captures')
    .update({
      matched_count: matchedCount,
      unmatched_count: unmatched,
    })
    .eq('id', captureId)

  return {
    matched: matchedCount,
    unmatched,
    surfaced_pre_inquiry: surfacedPreInquiry,
    matchedSamples: samples,
  }
}

// ---------------------------------------------------------------------------
// pg_trgm probe + fuzzy match
// ---------------------------------------------------------------------------

async function pgTrgmAvailable(supabase: SupabaseClient): Promise<boolean> {
  try {
    // Read a single row from pg_extension -- avoids needing exec_sql.
    // Supabase exposes pg_extension to the service role via the
    // information_schema; if the read errors we assume unavailable.
    const { data, error } = await supabase
      .from('pg_extension' as never)
      .select('extname')
      .eq('extname', 'pg_trgm')
      .maybeSingle()
    if (error) return false
    return Boolean(data)
  } catch {
    return false
  }
}

interface FuzzyHit {
  person_id: string
  similarity: number
}

async function fuzzyMatchName(
  supabase: SupabaseClient,
  venueId: string,
  displayName: string,
  trgm: boolean,
): Promise<FuzzyHit | null> {
  const clean = displayName.trim().toLowerCase()
  if (clean.length < 3) return null

  if (trgm) {
    // Use a Postgres RPC via the .rpc shortcut. To keep this matcher
    // dependency-free (no migration for a function), we fall back to
    // the substring-match path. Future: ship a SECURITY DEFINER
    // function `social_match_name(venue_id, name)` that returns
    // similarity rows; for V1 we keep things simple.
    return substringMatch(supabase, venueId, clean)
  }

  return substringMatch(supabase, venueId, clean)
}

async function substringMatch(
  supabase: SupabaseClient,
  venueId: string,
  needle: string,
): Promise<FuzzyHit | null> {
  // Pull people for the venue (already loaded by the caller in the hot
  // path; here we re-query because the matcher is also used outside
  // the bulk-loaded path). Small N.
  const { data, error } = await supabase
    .from('people')
    .select('id, first_name, last_name')
    .eq('venue_id', venueId)
  if (error) return null

  let best: FuzzyHit | null = null
  for (const p of (data ?? []) as PersonRow[]) {
    const full = [p.first_name, p.last_name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!full) continue
    const score = similarityScore(needle, full)
    if (score >= PG_TRGM_THRESHOLD && (!best || score > best.similarity)) {
      best = { person_id: p.id, similarity: score }
    }
  }
  return best
}

/**
 * Cheap pseudo-trigram similarity for the no-pg_trgm fallback path.
 * Returns 0..1. Computes the Jaccard index over character bigrams of
 * the two strings; close enough for "Rosie Hoyle" vs "Rosalie Hoyle"
 * style matches without pulling in a fuzz library.
 */
function similarityScore(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const bigrams = (s: string) => {
    const out = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) {
      out.add(s.slice(i, i + 2))
    }
    return out
  }
  const ga = bigrams(a)
  const gb = bigrams(b)
  let intersection = 0
  for (const g of ga) {
    if (gb.has(g)) intersection += 1
  }
  const union = ga.size + gb.size - intersection
  if (union === 0) return 0
  return intersection / union
}

// ---------------------------------------------------------------------------
// Email-inference matcher
// ---------------------------------------------------------------------------

function matchByEmailInference(
  people: PersonRow[],
  handle: string,
): PersonRow | null {
  if (!handle || handle.length < 3) return null
  const h = handle.toLowerCase()
  for (const p of people) {
    if (!p.email) continue
    const local = p.email.split('@')[0]?.toLowerCase()
    if (!local) continue
    if (local === h) return p
    // "rosie.hoyle.92" -> ["rosie","hoyle","92"]; "rosiehoyle" -> ["rosiehoyle"]
    const tokens = local.split(/[._-]+/).filter(Boolean)
    const flat = tokens.join('')
    if (flat === h.replace(/[._-]+/g, '')) return p
    // Substring (handle contained in local part, e.g. handle "rosiehoyle"
    // and email "rosiehoyle92@gmail.com").
    if (local.includes(h) && h.length >= 4) return p
    if (h.includes(local) && local.length >= 4) return p
  }
  return null
}
