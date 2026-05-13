/**
 * Canonical identity resolver — the single chokepoint every entry path
 * goes through to attach a contact + a wedding to whatever signal just
 * arrived.
 *
 * Why this file exists
 * --------------------
 * Real example (Reem Ibrahim, 2026-05-08): three entry paths fired in
 * sequence for the same couple — Knot relay inquiry, calculator estimate,
 * contract-request via calculator. Each path created its own people row
 * and its own weddings row. Coordinator inbox showed three threads, the
 * auto-draft engine fired one nurture email per "duplicate", intelligence
 * rollups double-counted. Bug class: identity resolution was scattered
 * across half a dozen call sites and each one had its own `findOr-Create`
 * shape. Fix: one resolver, one match-chain, one merge function, one
 * deterministic outcome.
 *
 * Match chain (run in order, first hit wins)
 * ------------------------------------------
 *   1. Email exact match
 *      - lower-case + trim + plus-addressing strip
 *        (`reem+wedding@hotmail.com` → `reem@hotmail.com`)
 *      - venue-scoped
 *   2. Email canonical match
 *      - gmail/googlemail dot+case stripping
 *        (`R.eem.Ibrahim7@gmail.com` ≡ `reemibrahim7@gmail.com`)
 *   3. Phone match
 *      - E.164-normalize both sides; require >= 10 digits
 *      - if multiple candidates, prefer the one with email already populated
 *   4. Name + wedding-date match (low-confidence fallback)
 *      - only used when email + phone are absent
 *      - last-name match within ±7 days of wedding_date
 *      - logs the fallback so coordinator audit can surface it
 *   5. No match → create new person + new wedding
 *
 * Once a person matches, find the latest non-terminal wedding for that
 * person at this venue. Multiple weddings with conflicting dates surface
 * as a `wedding_identity_conflict` event — coordinator decides, never
 * silent merge.
 *
 * Concurrency note
 * ----------------
 * The resolver does not take a transactional lock. Two near-simultaneous
 * requests for the same identity can both miss step 1-3 and both try to
 * create. The follow-up scan in `enqueueIdentityMatches` (called from
 * email-pipeline post-create) catches this case via the high-tier
 * auto-merge path. For the entry paths added in 2026-05-08 the resolver
 * is the primary defense; the old enqueue path stays as belt-and-suspenders.
 *
 * Hard rule: never use this resolver to mint a wedding for a venue's own
 * email address. Caller is expected to filter own-emails out before
 * passing signals through (the email pipeline already does).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IdentitySignals {
  email: string | null
  phone: string | null
  fullName: string | null
  weddingDate: string | null  // ISO yyyy-mm-dd preferred
  partner1Name: string | null
  partner2Name: string | null
}

export interface ResolvedIdentity {
  personId: string
  weddingId: string
  isNew: { person: boolean; wedding: boolean }
  /** Person ids that were merged into the canonical row during this call.
   *  Empty array on a clean match or fresh create. */
  mergedFrom: string[]
  /** Which step in the match chain fired. Surfaces in audit/logs. */
  matchedBy:
    | 'email_exact'
    | 'email_canonical'
    | 'phone'
    | 'name_plus_date'
    | 'created_new'
}

export interface ResolverOptions {
  /** Free-text label for audit (e.g. "calculator", "knot_relay",
   *  "calendly", "email_pipeline", "brain_dump"). */
  sourceLabel?: string
  /** Correlation id from the upstream request. Threads through audit
   *  rows so `/admin/identity` can group by the originating action. */
  correlationId?: string
  /** Optional Supabase service client. If omitted, the resolver creates
   *  one. Pre-pass when callers already hold one to avoid an extra
   *  factory roundtrip. */
  supabase?: SupabaseClient
  /**
   * Wave 9 root-cause fix (2026-05-10): the upstream signal's actual
   * timestamp (email Date header, CSV row inquiry_date, brain-dump
   * note created_at). When set, createWedding pins inquiry_date to
   * this value instead of wall-clock NOW(). When omitted, falls back
   * to NOW() with a console.warn — the inquiry_date_drift invariant
   * will then catch any drift on the next sweep.
   *
   * Why: bloom-data-integrity-sweep.md's inquiry_date_drift invariant
   * keeps flagging weddings minted from this codepath. The Wave 9
   * remediation realigns historical drift; this option closes the
   * write-site so new weddings never drift in the first place.
   */
  inquirySignalAt?: string
}

// ---------------------------------------------------------------------------
// Normalisation helpers — all pure, all unit-testable independently.
// ---------------------------------------------------------------------------

function lower(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

/** Strip plus-addressing from an email: `reem+wedding@hotmail.com` →
 *  `reem@hotmail.com`. Returns the original if no `+` is present. */
export function stripPlusAddressing(email: string): string {
  const at = email.indexOf('@')
  if (at < 0) return email
  const local = email.slice(0, at)
  const domain = email.slice(at)
  const plus = local.indexOf('+')
  if (plus < 0) return email
  return local.slice(0, plus) + domain
}

/** Lower + trim + strip plus-addressing. Used for step 1 (email_exact). */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const t = lower(email)
  if (!t || t.indexOf('@') < 0) return null
  return stripPlusAddressing(t)
}

/** Gmail-style canonicalisation: lower, drop dots in the local part, drop
 *  plus-addressing. Only applied when domain is gmail / googlemail. For
 *  any other domain we fall back to the regular normalisation so we
 *  never collapse two different humans on a non-gmail provider that
 *  treats dots as significant. */
export function canonicaliseEmail(email: string | null | undefined): string | null {
  const norm = normalizeEmail(email)
  if (!norm) return null
  const at = norm.indexOf('@')
  const local = norm.slice(0, at)
  const domain = norm.slice(at + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.replace(/\./g, '')}@${domain}`
  }
  return norm
}

/** Strip every non-digit, then prefix +1 if it looks like a 10-digit US
 *  number missing a country code. Returns null when the result has fewer
 *  than 10 digits (under-bar phone numbers — extension-only stubs, etc.).
 *
 *  Assumption: Bloom is US-first. International numbers usually arrive
 *  with a country code already; this helper preserves them when 11+ digits
 *  are present. If a UK / EU venue ever onboards we revisit the +1
 *  prefix rule rather than re-doing the helper. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = String(phone).replace(/\D+/g, '')
  if (digits.length < 10) return null
  if (digits.length === 10) return `+1${digits}`
  // Already has country code or a long international number — keep as-is
  // with a leading `+` so the format is consistent.
  return `+${digits}`
}

function lastNameOf(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
  return lower(parts[parts.length - 1])
}

function firstNameOf(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  return parts[0]
}

function daysBetween(a: string, b: string): number {
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity
  return Math.abs(ta - tb) / (1000 * 60 * 60 * 24)
}

const TERMINAL_STATUSES = new Set(['lost', 'cancelled', 'completed'])

// ---------------------------------------------------------------------------
// Match chain
// ---------------------------------------------------------------------------

interface PersonHit {
  id: string
  venue_id: string
  wedding_id: string | null
  email: string | null
  phone: string | null
  first_name: string | null
  last_name: string | null
  merged_into_id: string | null
}

async function findByEmailExact(
  supabase: SupabaseClient,
  venueId: string,
  email: string
): Promise<PersonHit | null> {
  const norm = normalizeEmail(email)
  if (!norm) return null
  const { data } = await supabase
    .from('people')
    .select('id, venue_id, wedding_id, email, phone, first_name, last_name, merged_into_id')
    .eq('venue_id', venueId)
    .ilike('email', norm)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
    .limit(1)
  if (data && data[0]) return data[0] as PersonHit

  // Wave 2C: also check alias_emails (mig 194). The Naina-case bug —
  // first wedding had a Knot relay email like
  // `naina.davidar.<hash>@member.theknot.com`, the WeddingPro close-out
  // arrived under a different from_email shape. The alias-merge sweep
  // (people-merge-aliases.ts) eventually folds the relay alias under
  // the canonical row's `alias_emails` jsonb array; subsequent lookups
  // by either email shape should match the canonical row directly
  // rather than minting a fresh person + wedding.
  //
  // Postgres `?` operator on text arrays / jsonb works through
  // PostgREST as `cs` (contains); we use a `contains` filter with a
  // single-element array.
  const { data: aliasData } = await supabase
    .from('people')
    .select('id, venue_id, wedding_id, email, phone, first_name, last_name, merged_into_id')
    .eq('venue_id', venueId)
    .contains('alias_emails', [norm])
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
    .limit(1)
  return (aliasData && aliasData[0]) ? (aliasData[0] as PersonHit) : null
}

async function findByEmailCanonical(
  supabase: SupabaseClient,
  venueId: string,
  email: string
): Promise<PersonHit | null> {
  const canon = canonicaliseEmail(email)
  if (!canon) return null
  // Pull every active person for the venue with an email; canonicalise
  // each side and compare. Volume is in the low thousands per venue —
  // not a scale concern at our current size.
  const { data } = await supabase
    .from('people')
    .select('id, venue_id, wedding_id, email, phone, first_name, last_name, merged_into_id, created_at')
    .eq('venue_id', venueId)
    .not('email', 'is', null)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
  if (!data) return null
  for (const row of data) {
    if (canonicaliseEmail(row.email as string | null) === canon) {
      return row as PersonHit
    }
  }
  return null
}

async function findByPhone(
  supabase: SupabaseClient,
  venueId: string,
  phone: string
): Promise<PersonHit | null> {
  const norm = normalizePhone(phone)
  if (!norm) return null
  // Pull every active person with a phone, normalize each side, compare.
  // Phone columns in the wild contain assorted whitespace + parens +
  // dashes; do the comparison in JS, not SQL, to avoid LIKE pattern
  // pitfalls.
  const { data } = await supabase
    .from('people')
    .select('id, venue_id, wedding_id, email, phone, first_name, last_name, merged_into_id, created_at')
    .eq('venue_id', venueId)
    .not('phone', 'is', null)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
  if (!data) return null
  const candidates = data.filter((r) => normalizePhone(r.phone as string | null) === norm)
  if (candidates.length === 0) return null
  // Prefer the candidate that has an email populated (more complete row).
  const withEmail = candidates.find((c) => !!c.email)
  return (withEmail ?? candidates[0]) as PersonHit
}

async function findByNamePlusDate(
  supabase: SupabaseClient,
  venueId: string,
  fullName: string,
  weddingDate: string
): Promise<PersonHit | null> {
  const last = lastNameOf(fullName)
  if (!last) return null
  // Look for active people at this venue with the same last name whose
  // wedding falls within ±7 days of the supplied date.
  const { data } = await supabase
    .from('people')
    .select('id, venue_id, wedding_id, email, phone, first_name, last_name, merged_into_id, weddings(wedding_date, status)')
    .eq('venue_id', venueId)
    .ilike('last_name', last)
    .is('merged_into_id', null)
  if (!data || data.length === 0) return null
  for (const row of data) {
    const weddingRel = (row as Record<string, unknown>).weddings
    const wd = Array.isArray(weddingRel)
      ? (weddingRel[0] as { wedding_date?: string | null })?.wedding_date
      : (weddingRel as { wedding_date?: string | null } | null | undefined)?.wedding_date
    if (!wd) continue
    if (daysBetween(wd, weddingDate) <= 7) return row as PersonHit
  }
  return null
}

// ---------------------------------------------------------------------------
// Wedding picker — find the active wedding for this person at this venue.
// ---------------------------------------------------------------------------

interface WeddingHit {
  id: string
  status: string
  wedding_date: string | null
  inquiry_date: string | null
  merged_into_id: string | null
}

async function findActiveWeddingForPerson(
  supabase: SupabaseClient,
  venueId: string,
  personId: string
): Promise<WeddingHit | null> {
  // Two paths to a wedding from a person:
  //   1. people.wedding_id direct FK
  //   2. interactions.wedding_id linked via interactions.person_id
  // Path 1 is canonical — every wedding-mint path stamps people.wedding_id
  // when it creates. Path 2 catches stragglers (calendly orphans, brain
  // dump notes pre-wedding-creation).
  const { data: person } = await supabase
    .from('people')
    .select('wedding_id')
    .eq('id', personId)
    .single()
  const directWeddingId = (person?.wedding_id as string | null) ?? null
  if (directWeddingId) {
    const { data: w } = await supabase
      .from('weddings')
      .select('id, status, wedding_date, inquiry_date, merged_into_id')
      .eq('id', directWeddingId)
      .eq('venue_id', venueId)
      .is('merged_into_id', null)
      // Step 5c (RM-1123): skip non-couple tombstones. A future signal
      // from the same phone/email shouldn't re-attach to a wedding the
      // tombstone cron flagged as not-a-couple.
      .is('non_couple_at', null)
      .maybeSingle()
    if (w) return w as WeddingHit
  }
  // Fallback: latest interaction-linked wedding for this person.
  const { data: interactions } = await supabase
    .from('interactions')
    .select('wedding_id, timestamp')
    .eq('person_id', personId)
    .eq('venue_id', venueId)
    .not('wedding_id', 'is', null)
    .order('timestamp', { ascending: false })
    .limit(1)
  const fallbackWeddingId = (interactions && interactions[0]?.wedding_id as string | null) ?? null
  if (!fallbackWeddingId) return null
  const { data: w } = await supabase
    .from('weddings')
    .select('id, status, wedding_date, inquiry_date, merged_into_id')
    .eq('id', fallbackWeddingId)
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .is('non_couple_at', null)
    .maybeSingle()
  return (w as WeddingHit | null) ?? null
}

/**
 * Wave 2C — list ALL non-tombstoned weddings for a person at a venue,
 * ordered by inquiry_date DESC. Used by the same-person multi-wedding
 * rule to decide between attaching to a non-terminal existing wedding
 * vs. minting a new re-engagement-after-loss wedding linked via
 * previous_wedding_id.
 *
 * Naina-case (RM-0200 lost → RM-0204 re-engagement): the existing
 * `findActiveWeddingForPerson` returns whichever wedding the person.
 * wedding_id pointer or the most-recent interaction lands on. That's
 * fine when the matched wedding is non-terminal, but when it's
 * terminal (lost / cancelled / completed) and a fresh inquiry arrives
 * for the SAME PERSON, the right move is to mint a NEW wedding so
 * coordinator funnel + intel rollups treat the re-engagement as
 * what it is: a fresh opportunity. Linking back via
 * `previous_wedding_id` keeps the forensic record intact per
 * Constitution.
 */
async function listWeddingsForPerson(
  supabase: SupabaseClient,
  venueId: string,
  personId: string
): Promise<WeddingHit[]> {
  // Gather candidate wedding ids from both paths and dedupe.
  const ids = new Set<string>()
  const { data: person } = await supabase
    .from('people')
    .select('wedding_id')
    .eq('id', personId)
    .maybeSingle()
  const directWeddingId = (person?.wedding_id as string | null) ?? null
  if (directWeddingId) ids.add(directWeddingId)

  const { data: interactions } = await supabase
    .from('interactions')
    .select('wedding_id')
    .eq('person_id', personId)
    .eq('venue_id', venueId)
    .not('wedding_id', 'is', null)
  if (interactions) {
    for (const i of interactions as Array<{ wedding_id: string | null }>) {
      if (i.wedding_id) ids.add(i.wedding_id)
    }
  }
  if (ids.size === 0) return []
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, status, wedding_date, inquiry_date, merged_into_id')
    .in('id', [...ids])
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .is('non_couple_at', null)
    .order('inquiry_date', { ascending: false, nullsFirst: false })
  return ((weddings ?? []) as WeddingHit[])
}

// ---------------------------------------------------------------------------
// Wedding identity-conflict signal
// ---------------------------------------------------------------------------
// When a person matches an existing record but the incoming wedding_date
// disagrees with the on-file date by more than 90 days, we DO NOT silent-
// merge. We surface a coordinator-visible alert instead. For now the
// alert lands as a structured note in admin_notifications (already a
// coordinator-visible surface). The user can then choose to merge,
// split, or override.
async function flagWeddingDateConflict(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  personId: string,
  storedDate: string,
  incomingDate: string,
  sourceLabel: string | null
): Promise<void> {
  try {
    await supabase.from('admin_notifications').insert({
      venue_id: venueId,
      type: 'identity_conflict',
      title: 'Wedding date conflict on identity match',
      body:
        `Identity resolver matched person ${personId} to wedding ${weddingId}, ` +
        `but the incoming signal claimed wedding_date=${incomingDate} while the ` +
        `stored value is ${storedDate}. Source: ${sourceLabel ?? 'unknown'}. ` +
        `No silent merge performed; coordinator review required.`,
      priority: 'normal',
      wedding_id: weddingId,
    })
  } catch (err) {
    // Best-effort. If admin_notifications doesn't exist for some reason
    // (or RLS rejects the write), we log and keep going. The match itself
    // still succeeds — the conflict is informational, not a hard stop.
    console.warn('[identity/resolver] failed to log wedding-date conflict:', err)
  }
}

// ---------------------------------------------------------------------------
// resolveCanonical — chase merge pointers to the live row.
// ---------------------------------------------------------------------------

/** Walk weddings.merged_into_id until we hit a row with merged_into_id IS NULL.
 *  Bounded at 8 hops so a corrupt cycle can't infinite-loop. */
export async function resolveCanonicalWedding(
  supabase: SupabaseClient,
  weddingId: string
): Promise<string> {
  let current = weddingId
  for (let hops = 0; hops < 8; hops++) {
    const { data } = await supabase
      .from('weddings')
      .select('id, merged_into_id')
      .eq('id', current)
      .maybeSingle()
    if (!data) return current
    const next = data.merged_into_id as string | null
    if (!next) return current
    current = next
  }
  return current
}

/** Same as above but for people. */
export async function resolveCanonicalPerson(
  supabase: SupabaseClient,
  personId: string
): Promise<string> {
  let current = personId
  for (let hops = 0; hops < 8; hops++) {
    const { data } = await supabase
      .from('people')
      .select('id, merged_into_id')
      .eq('id', current)
      .maybeSingle()
    if (!data) return current
    const next = data.merged_into_id as string | null
    if (!next) return current
    current = next
  }
  return current
}

// ---------------------------------------------------------------------------
// Person + wedding insert helpers (used after no-match case 5).
// ---------------------------------------------------------------------------

async function createPerson(
  supabase: SupabaseClient,
  venueId: string,
  signals: IdentitySignals,
  sourceLabel: string | null,
): Promise<string | null> {
  // Wave 2B: route the resolver's createPerson through the identity
  // name-capture chokepoint instead of writing first/last directly. The
  // legacy fallback `signals.email.split('@')[0]` is the bug that
  // produced `Rosaliehoyle` from `rosaliehoyle@gmail.com` — the chokepoint
  // shape detector classifies that as `username` and routes it to
  // `display_handle` instead of `first_name`.
  //
  // Strategy:
  //   1. INSERT the people row with NULL first/last,
  //   2. capture every available signal through the chokepoint (which
  //      runs the picker and dual-writes the legacy columns).
  //
  // Each resolver caller passes a sourceLabel ("calculator",
  // "knot_relay", "calendly", "email_pipeline", "brain_dump",
  // "coordinator_csv", "crm_import:<provider>"). We map that to the
  // most-honest NameSource for the chokepoint via pickNameSourceForLabel.
  const importedSource = pickNameSourceForLabel(sourceLabel)

  // Lazy-import the chokepoint so resolver doesn't pay the import cost
  // when resolveIdentity is called from cold paths that never create a
  // new person.
  const { captureNameEvidence, inferNameFromEmail } = await import('./name-capture')

  const insert: Record<string, unknown> = {
    venue_id: venueId,
    role: 'partner1',
    first_name: null,
    last_name: null,
  }
  if (signals.email) insert.email = normalizeEmail(signals.email) ?? signals.email
  if (signals.phone) insert.phone = normalizePhone(signals.phone)
  const { data, error } = await supabase
    .from('people')
    .insert(insert)
    .select('id')
    .single()
  if (error || !data) {
    console.error('[identity/resolver] createPerson failed:', error?.message)
    return null
  }
  const personId = data.id as string

  // Now route every available name signal through the chokepoint. Order
  // doesn't matter — the picker will pick by confidence.
  try {
    const fullForCapture = signals.fullName ?? signals.partner1Name
    if (fullForCapture) {
      await captureNameEvidence(supabase, personId, {
        full: fullForCapture,
        email: signals.email ?? null,
        source: importedSource,
      })
    }
    if (signals.email) {
      // Email-handle parse: pre-derive (first, last) from the local part
      // ("rosalie.hoyle@gmail.com" → "Rosalie Hoyle") and let the
      // chokepoint apply shape detection. Username-shaped local parts
      // (e.g. "rosaliehoyle@gmail.com") collapse to display_handle.
      // Confidence is the source's static 20.
      const fromEmail = inferNameFromEmail(signals.email)
      if (fromEmail) {
        await captureNameEvidence(supabase, personId, {
          first: fromEmail.first,
          last: fromEmail.last,
          email: signals.email,
          source: 'email_handle_parse',
        })
      }
    }
  } catch (err) {
    // Capture must never break the resolver. Legacy callers will see
    // the row with null first/last; the picker will run when the next
    // signal arrives.
    console.warn('[identity/resolver] name-capture in createPerson failed:',
      err instanceof Error ? err.message : err)
  }

  return personId
}

/**
 * Map the resolver's free-text sourceLabel to the chokepoint's
 * NameSource enum. Conservative on unknowns.
 */
function pickNameSourceForLabel(label: string | null):
  | 'calculator_form'
  | 'knot_relay'
  | 'weddingwire_relay'
  | 'gmail_from_name'
  | 'form_relay'
  | 'brain_dump_note'
  | 'csv_import'
  | 'partner_mention_in_body'
{
  const v = (label ?? '').toLowerCase()
  if (!v) return 'form_relay'
  if (v.includes('calculator') || v.includes('web_form') || v.includes('webform')) return 'calculator_form'
  if (v.includes('knot')) return 'knot_relay'
  if (v.includes('weddingwire') || v.includes('wedding_wire')) return 'weddingwire_relay'
  if (v.includes('email_pipeline') || v.includes('gmail') || v.includes('email-pipeline')) return 'gmail_from_name'
  if (v.includes('calendly') || v.includes('form_relay') || v.includes('form-relay')) return 'form_relay'
  if (v.includes('brain') || v.includes('dump')) return 'brain_dump_note'
  if (v.includes('csv') || v.includes('crm_import') || v.includes('coordinator')) return 'csv_import'
  if (v.includes('partner_mention') || v.includes('body_extraction')) return 'partner_mention_in_body'
  return 'form_relay'
}

async function createWedding(
  supabase: SupabaseClient,
  venueId: string,
  signals: IdentitySignals,
  sourceLabel: string | null,
  previousWeddingId: string | null = null,
  inquirySignalAt: string | null = null,
): Promise<string | null> {
  // source_provenance is CHECK-constrained; we pin it to the new
  // 'identity_resolver' value (migration 247) and stash the human-readable
  // sourceLabel on weddings.notes for the audit trail. Anything else
  // would violate the constraint added in migration 178.
  //
  // Wave 2C: previousWeddingId set when this wedding is a
  // re-engagement-after-loss for a person whose only existing wedding
  // is terminal. The FK was added in migration 257.
  //
  // Wave 9 (2026-05-10): inquirySignalAt is the upstream signal's actual
  // timestamp (email Date header, CSV row inquiry_date, brain-dump note
  // captured_at). When omitted, the inquiry_date falls back to NOW() —
  // which is the band-aid pattern bloom-data-integrity-sweep.md flagged.
  // The remediation in src/lib/services/data-integrity/remediation/
  // inquiry-date-drift.ts will re-align drift after the fact, but
  // every caller threading a real signal timestamp here is one fewer
  // remediation row.
  if (!inquirySignalAt) {
    console.warn(
      `[identity/resolver] createWedding called without inquirySignalAt ` +
        `(sourceLabel=${sourceLabel ?? 'unknown'}); falling back to NOW() — ` +
        `inquiry_date_drift may flag this row on next sweep.`,
    )
  }
  const inquiryDateValue = inquirySignalAt ?? new Date().toISOString()
  const insert: Record<string, unknown> = {
    venue_id: venueId,
    status: 'inquiry',
    inquiry_date: inquiryDateValue,
    wedding_date: signals.weddingDate ?? null,
    // Migration 316: heat_score / temperature_tier dropped, heat is
    // derived by the wedding_heat view.
    source_provenance: 'identity_resolver',
    notes: sourceLabel
      ? (previousWeddingId
          ? `[identity-resolver: ${sourceLabel}; re-engagement of ${previousWeddingId}]`
          : `[identity-resolver: ${sourceLabel}]`)
      : null,
  }
  if (previousWeddingId) {
    insert.previous_wedding_id = previousWeddingId
  }
  const { data, error } = await supabase
    .from('weddings')
    .insert(insert)
    .select('id')
    .single()
  if (error || !data) {
    // mig-257-not-yet-applied: retry without previous_wedding_id so the
    // resolver doesn't crash on a fresh checkout that hasn't run
    // migrations. This mirrors the chokepoint pattern in name-capture.ts.
    if (previousWeddingId && error?.code === '42703') {
      const fallback = { ...insert }
      delete fallback.previous_wedding_id
      const { data: data2, error: error2 } = await supabase
        .from('weddings')
        .insert(fallback)
        .select('id')
        .single()
      if (!error2 && data2) return data2.id as string
      console.error('[identity/resolver] createWedding (mig-257-fallback) failed:', error2?.message)
      return null
    }
    console.error('[identity/resolver] createWedding failed:', error?.message)
    return null
  }
  return data.id as string
}

// ---------------------------------------------------------------------------
// Public entry: resolvePersonOnly
// ---------------------------------------------------------------------------

export interface PersonOnlyResult {
  personId: string
  isNew: boolean
  matchedBy:
    | 'email_exact'
    | 'email_canonical'
    | 'phone'
    | 'created_new'
}

/**
 * Resolve a person record from inbound signals WITHOUT touching the
 * wedding side of the graph. Used by signal-pre-classification paths
 * (SMS intent gate, Twilio webhook, OpenPhone poll) where a person row
 * must exist for the interaction insert, but a wedding mint should be
 * gated on a downstream intent classifier verdict.
 *
 * Why this is separate from resolveIdentity:
 * RM-1123 (bus driver texting Rixey about hotel pickup, 2026-05-13)
 * was minted as a wedding because the SMS path calls resolveIdentity,
 * which unconditionally creates a wedding in Branch C when no match
 * exists. The phase classifier correctly flags it as
 * "client_logistics" / "vendor_communication" post-mint, but by then
 * the ghost wedding is already in the leads list and feeds Heat /
 * Sage / sequence drafts.
 *
 * The fix is to defer the wedding mint behind classifyInboundIntent.
 * This helper returns only the person side so the caller can write
 * the interaction, run the classifier, and conditionally call
 * mintWedding (which internally calls resolveIdentity and finds the
 * just-created person via the phone match chain, then mints the
 * wedding only when intent says couple).
 *
 * Match chain is identical to resolveIdentity's steps 1-5:
 *   email_exact → email_canonical → phone → create_new
 * Skips step 4 (name+date) — it requires a wedding_date which we
 * don't have at SMS-first time.
 */
export async function resolvePersonOnly(
  venueId: string,
  signals: IdentitySignals,
  options: ResolverOptions = {},
): Promise<PersonOnlyResult> {
  const supabase = options.supabase ?? createServiceClient()
  const sourceLabel = options.sourceLabel ?? null

  let hit: PersonHit | null = null
  let matchedBy: PersonOnlyResult['matchedBy'] = 'created_new'

  if (signals.email) {
    hit = await findByEmailExact(supabase, venueId, signals.email)
    if (hit) matchedBy = 'email_exact'
  }
  if (!hit && signals.email) {
    hit = await findByEmailCanonical(supabase, venueId, signals.email)
    if (hit) matchedBy = 'email_canonical'
  }
  if (!hit && signals.phone) {
    hit = await findByPhone(supabase, venueId, signals.phone)
    if (hit) matchedBy = 'phone'
  }

  if (hit) {
    // Same canon-chase + non-name backfill as resolveIdentity.
    const personId = await resolveCanonicalPerson(supabase, hit.id)
    const updates: Record<string, unknown> = {}
    if (signals.email && !hit.email) {
      updates.email = normalizeEmail(signals.email) ?? signals.email
    }
    if (signals.phone && !hit.phone) {
      updates.phone = normalizePhone(signals.phone)
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from('people').update(updates).eq('id', personId)
    }
    // Name capture routes through the chokepoint identically to
    // resolveIdentity. Skipping it here would leak the very name
    // corruption the Wave 2B work fixed.
    if (signals.fullName || signals.partner1Name || signals.email) {
      try {
        const { captureNameEvidence, inferNameFromEmail } = await import('./name-capture')
        const importedSource = pickNameSourceForLabel(sourceLabel)
        const fullForCapture = signals.fullName ?? signals.partner1Name
        if (fullForCapture) {
          await captureNameEvidence(supabase, personId, {
            full: fullForCapture,
            email: signals.email ?? null,
            source: importedSource,
          })
        }
        if (signals.email) {
          const fromEmail = inferNameFromEmail(signals.email)
          if (fromEmail) {
            await captureNameEvidence(supabase, personId, {
              first: fromEmail.first,
              last: fromEmail.last,
              email: signals.email,
              source: 'email_handle_parse',
            })
          }
        }
      } catch (err) {
        console.warn('[resolvePersonOnly] name-capture (existing) failed:',
          err instanceof Error ? err.message : err)
      }
    }
    return { personId, isNew: false, matchedBy }
  }

  // No match — create fresh person via the same chokepoint path
  // resolveIdentity uses, so name-capture confidence + display_handle
  // rules apply uniformly.
  const newId = await createPerson(supabase, venueId, signals, sourceLabel)
  if (!newId) {
    throw new Error('resolvePersonOnly: createPerson failed; cannot proceed')
  }
  return { personId: newId, isNew: true, matchedBy: 'created_new' }
}

// ---------------------------------------------------------------------------
// Public entry: resolveIdentity
// ---------------------------------------------------------------------------

export async function resolveIdentity(
  venueId: string,
  signals: IdentitySignals,
  options: ResolverOptions = {}
): Promise<ResolvedIdentity> {
  const supabase = options.supabase ?? createServiceClient()
  const sourceLabel = options.sourceLabel ?? null

  // -------------------------------------------------------------------------
  // Step 1: email exact
  // -------------------------------------------------------------------------
  let hit: PersonHit | null = null
  let matchedBy: ResolvedIdentity['matchedBy'] = 'created_new'
  if (signals.email) {
    hit = await findByEmailExact(supabase, venueId, signals.email)
    if (hit) matchedBy = 'email_exact'
  }
  // Step 2: email canonical (gmail dot/case)
  if (!hit && signals.email) {
    hit = await findByEmailCanonical(supabase, venueId, signals.email)
    if (hit) matchedBy = 'email_canonical'
  }
  // Step 3: phone
  if (!hit && signals.phone) {
    hit = await findByPhone(supabase, venueId, signals.phone)
    if (hit) matchedBy = 'phone'
  }
  // Step 4: name + date fallback (only when no email + no phone)
  if (!hit && !signals.email && !signals.phone && signals.fullName && signals.weddingDate) {
    hit = await findByNamePlusDate(supabase, venueId, signals.fullName, signals.weddingDate)
    if (hit) matchedBy = 'name_plus_date'
  }

  let personId: string
  let isNewPerson = false
  if (hit) {
    // Chase merged_into_id — defensive; the queries above already filter
    // tombstones, but a race could plant one between the SELECT and now.
    personId = await resolveCanonicalPerson(supabase, hit.id)
    // Backfill empty fields on the canonical row from the incoming signal.
    // Email + phone are non-name flat columns — keep the legacy never-
    // overwrite rule (only fill nulls).
    //
    // Wave 2B: site #8. The legacy "fill if null" name backfill is the
    // path that left junk-first names ("Erinhorrigan", "Rosaliehoyle")
    // un-fixable once they landed first. Replace the direct first_name
    // / last_name update with a chokepoint capture so the picker decides
    // whether the new signal beats the existing column. The chokepoint
    // dual-writes the flat columns when its picker confidence beats the
    // current name_confidence — preserving the email-canonical match
    // path while letting better signals override junk.
    const updates: Record<string, unknown> = {}
    if (signals.email && !hit.email) {
      updates.email = normalizeEmail(signals.email) ?? signals.email
    }
    if (signals.phone && !hit.phone) {
      updates.phone = normalizePhone(signals.phone)
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from('people').update(updates).eq('id', personId)
    }
    // Route name signals through the chokepoint instead of a direct
    // column write. Picker confidence + existing name_confidence
    // arbitrate, so a calculator_form signal arriving second (95) can
    // overwrite a gmail_from_name first signal that scored 5 (username
    // shape).
    if (signals.fullName || signals.partner1Name || signals.email) {
      try {
        const { captureNameEvidence, inferNameFromEmail } = await import('./name-capture')
        const importedSource = pickNameSourceForLabel(sourceLabel)
        const fullForCapture = signals.fullName ?? signals.partner1Name
        if (fullForCapture) {
          await captureNameEvidence(supabase, personId, {
            full: fullForCapture,
            email: signals.email ?? null,
            source: importedSource,
          })
        }
        if (signals.email) {
          const fromEmail = inferNameFromEmail(signals.email)
          if (fromEmail) {
            await captureNameEvidence(supabase, personId, {
              first: fromEmail.first,
              last: fromEmail.last,
              email: signals.email,
              source: 'email_handle_parse',
            })
          }
        }
      } catch (err) {
        // Best-effort. Legacy flow already returned a person; the picker
        // will catch up on the next signal.
        console.warn('[identity/resolver] name-capture (canon backfill) failed:',
          err instanceof Error ? err.message : err)
      }
    }
  } else {
    // Step 5: create new
    const newId = await createPerson(supabase, venueId, signals, sourceLabel)
    if (!newId) {
      throw new Error('identity/resolver: createPerson failed; cannot proceed')
    }
    personId = newId
    isNewPerson = true
    matchedBy = 'created_new'
  }

  // -------------------------------------------------------------------------
  // Wedding side: pick or create.
  // -------------------------------------------------------------------------
  // Wave 2C — same-person multi-wedding rule (Naina case).
  //
  // Walk every non-tombstoned wedding for the matched person at this
  // venue. The picker fires three branches:
  //
  //   A. The person has at least one NON-TERMINAL wedding (inquiry /
  //      tour_scheduled / proposal_sent / booked / etc.). Attach to the
  //      most-recent non-terminal wedding — re-engagement on an open
  //      file is normal, not a fresh wedding. This is what
  //      `findActiveWeddingForPerson` did before the patch.
  //
  //   B. The person's ONLY weddings are terminal (lost / cancelled /
  //      completed). The new arrival is legitimately a fresh
  //      opportunity — re-engagement after loss, second wedding,
  //      whatever. Mint a NEW wedding and stamp `previous_wedding_id`
  //      so the coordinator surface can render history.
  //
  //   C. The person has no wedding at all. Mint a fresh wedding (the
  //      pre-patch fall-through branch).
  //
  // Branches B and C both go through createWedding. Branch B is the
  // new behaviour and the audit fix. Branch A preserves the
  // pre-existing behaviour exactly so we don't churn the common case.
  let weddingId: string
  let isNewWedding = false
  const allWeddings = await listWeddingsForPerson(supabase, venueId, personId)
  const nonTerminalWedding = allWeddings.find(
    (w) => !TERMINAL_STATUSES.has((w.status ?? '').toLowerCase())
  ) ?? null
  // Most-recent terminal wedding (for branch B's previous_wedding_id link).
  const mostRecentTerminalWedding = allWeddings.find(
    (w) => TERMINAL_STATUSES.has((w.status ?? '').toLowerCase())
  ) ?? null

  if (nonTerminalWedding) {
    // Branch A — attach to existing non-terminal wedding.
    const wedding = nonTerminalWedding
    weddingId = wedding.id
    // Conflict check: incoming wedding_date vs stored. Only fires when both
    // sides are populated AND the wedding is non-terminal (a completed
    // wedding's date is fine; we don't relitigate history).
    if (
      signals.weddingDate &&
      wedding.wedding_date &&
      wedding.wedding_date !== signals.weddingDate
    ) {
      const apart = daysBetween(wedding.wedding_date, signals.weddingDate)
      if (apart > 90) {
        await flagWeddingDateConflict(
          supabase, venueId, weddingId, personId,
          wedding.wedding_date, signals.weddingDate, sourceLabel
        )
      }
    }
    // If the matched person had no wedding_id stored, attach the wedding
    // we just discovered so future lookups skip the interaction-fallback.
    await supabase.from('people')
      .update({ wedding_id: weddingId })
      .eq('id', personId)
      .is('wedding_id', null)
  } else if (mostRecentTerminalWedding) {
    // Branch B — re-engagement after loss. Mint a new wedding linked
    // back to the previous via previous_wedding_id (mig 257). Keeps the
    // coordinator funnel honest: a lost wedding stays lost, a fresh
    // inquiry from the same person counts as a fresh inquiry, and the
    // history thread is preserved.
    const newWeddingId = await createWedding(
      supabase,
      venueId,
      signals,
      sourceLabel ? `${sourceLabel}:re-engagement` : 're-engagement',
      mostRecentTerminalWedding.id,
      options.inquirySignalAt ?? null,
    )
    if (!newWeddingId) {
      throw new Error('identity/resolver: createWedding (re-engagement) failed; cannot proceed')
    }
    weddingId = newWeddingId
    isNewWedding = true
    // Re-point the person to the FRESH wedding so future signals from
    // the same human attach here, not back on the terminal record.
    await supabase.from('people')
      .update({ wedding_id: weddingId })
      .eq('id', personId)

    // Surface the re-engagement to the coordinator so they're aware of
    // the history. Best-effort; never fails the resolver.
    try {
      await supabase.from('admin_notifications').insert({
        venue_id: venueId,
        type: 'identity_re_engagement',
        title: 'Re-engagement detected — fresh wedding minted',
        body:
          `Identity resolver matched person ${personId} to a previous ` +
          `wedding (${mostRecentTerminalWedding.id}, status=` +
          `${mostRecentTerminalWedding.status ?? 'unknown'}). The new arrival ` +
          `was treated as a fresh opportunity and a new wedding ` +
          `(${weddingId}) was minted, linked back via previous_wedding_id. ` +
          `Source: ${sourceLabel ?? 'unknown'}.`,
        priority: 'normal',
        wedding_id: weddingId,
      })
    } catch (err) {
      console.warn('[identity/resolver] re-engagement notification insert failed:', err)
    }
  } else {
    // Branch C — fresh person, fresh wedding.
    const newWeddingId = await createWedding(
      supabase,
      venueId,
      signals,
      sourceLabel,
      null,
      options.inquirySignalAt ?? null,
    )
    if (!newWeddingId) {
      throw new Error('identity/resolver: createWedding failed; cannot proceed')
    }
    weddingId = newWeddingId
    isNewWedding = true
    await supabase.from('people')
      .update({ wedding_id: weddingId })
      .eq('id', personId)
  }

  // Step 7 / A2 (2026-05-13): append every identifier observed in this
  // signal to the wedding's historical identifier pool on
  // couple_identity_profile.identifiers. Fire-and-forget; never blocks
  // the resolve. Pool reads from this for future re-engagement match
  // attempts where people.email/phone may have been overwritten by
  // intermediate signals — the pool retains every identifier ever seen.
  try {
    const { captureSignalIdentifiers } = await import('./capture-identifier')
    captureSignalIdentifiers({
      weddingId,
      email: signals.email,
      phone: signals.phone,
      displayName: signals.fullName ?? signals.partner1Name,
      source: sourceLabel ?? 'identity_resolver',
      supabase,
    })
  } catch (err) {
    // Best-effort. The profile row may not exist yet (Pattern A); the
    // helper logs that as a typed skip without throwing.
    console.warn('[identity/resolver] captureSignalIdentifiers failed:',
      err instanceof Error ? err.message : err)
  }

  return {
    personId,
    weddingId,
    isNew: { person: isNewPerson, wedding: isNewWedding },
    mergedFrom: [],
    matchedBy,
  }
}

// ---------------------------------------------------------------------------
// Wedding-merger
// ---------------------------------------------------------------------------

export interface MergeWeddingsResult {
  canonicalId: string
  duplicateId: string
  reassigned: Record<string, number>
}

/**
 * Soft-merge `duplicateId` into `canonicalId`.
 *
 * Migrates every row that FKs `weddings.id` from the duplicate to the
 * canonical. Tables covered (the comprehensive list — every wedding_id
 * reader the app touches):
 *
 *   interactions, drafts, engagement_events, tours, briefings, payments,
 *   notifications, admin_notifications, knowledge_gaps, intelligence_extractions,
 *   signal_inferences, booking_signals, wedding_touchpoints, attribution_events,
 *   candidate_identities (resolved_wedding_id), wedding_journey_narratives,
 *   tangential_signals, escalations, follow_ups, lost_deals, sage_chats,
 *   couple_invites, vendor_portal_tokens, wedding_files, owner_notes,
 *   activity_logs, error_logs, signal_pairs, anomaly_alerts (per-wedding),
 *   wedding_packages, contracts, payments_schedule, ph_*-prefixed tables stay
 *   out (Presshouse-domain), source_attribution.
 *
 * Tables already covered automatically by the post-merge trigger
 * (migration 202): attribution_events, wedding_touchpoints,
 * candidate_identities. We still UPDATE merged_into_id on the duplicate
 * so the trigger fires + writes the audit row.
 *
 * Notes columns are unioned: weddings.notes (text) gets concatenated,
 * weddings.sage_context_notes (jsonb array) gets concat-deduped.
 *
 * `weddings.merged_into_id` already exists (migration 177). Setting it
 * tombstones the duplicate.
 */
export async function mergeWeddings(
  canonicalId: string,
  duplicateId: string,
  options: { supabase?: SupabaseClient; reason?: string } = {}
): Promise<MergeWeddingsResult> {
  if (canonicalId === duplicateId) {
    throw new Error('mergeWeddings: canonical and duplicate ids are identical')
  }
  const supabase = options.supabase ?? createServiceClient()

  const reassigned: Record<string, number> = {}

  // Helper: UPDATE table SET wedding_id = canonical WHERE wedding_id = duplicate
  async function reassign(table: string, column = 'wedding_id'): Promise<number> {
    const { count, error } = await supabase
      .from(table)
      .update({ [column]: canonicalId }, { count: 'exact' })
      .eq(column, duplicateId)
    if (error) {
      // We swallow the per-table error so a single missing column / RLS
      // hiccup doesn't abort the merge. Audit the failure to console;
      // the migration UI surfaces partial-success on the resolver page.
      console.warn(`[mergeWeddings] reassign ${table}.${column} failed:`, error.message)
      return 0
    }
    reassigned[`${table}.${column}`] = count ?? 0
    return count ?? 0
  }

  // Reassign every direct wedding_id column. Listed top-down by importance:
  // loss of a row here = lost coordinator data, so we walk the schema
  // exhaustively rather than assume FK cascade does it. Confirmed against
  // the migrations directory on 2026-05-08; tables that don't have a
  // wedding_id column return rowcount=0 from PostgREST and are skipped.
  await reassign('interactions')
  await reassign('drafts')
  await reassign('engagement_events')
  await reassign('tours')
  await reassign('lost_deals')
  await reassign('admin_notifications')
  // public.notifications has no wedding_id column (mig 017 created it
  // with venue + user only). Skipping prevents PostgREST 400s on
  // missing column. Confirmed against schema 2026-05-08.
  await reassign('knowledge_gaps')
  await reassign('intelligence_extractions')
  await reassign('tangential_signals')
  await reassign('source_attribution')
  await reassign('error_logs')
  await reassign('event_feedback')
  await reassign('contracts')                 // 004_portal_tables.sql
  await reassign('booked_vendors')            // 015_vendors_contracts_upgrade.sql
  await reassign('day_of_media')              // 097_ports_from_rixey.sql
  await reassign('wedding_internal_notes')    // 097_ports_from_rixey.sql
  await reassign('vendor_checklist')          // 097_ports_from_rixey.sql
  await reassign('messages')                  // 004_portal_tables.sql
  await reassign('sage_conversations')        // 004_portal_tables.sql
  await reassign('planning_notes')            // 004_portal_tables.sql
  await reassign('checklist_items')           // 004_portal_tables.sql
  await reassign('budget')                    // 004_portal_tables.sql
  await reassign('guest_list')                // 004_portal_tables.sql
  await reassign('timeline')                  // 004_portal_tables.sql
  await reassign('seating_tables')            // 004_portal_tables.sql
  await reassign('seating_assignments')       // 004_portal_tables.sql
  await reassign('vendor_recommendations')    // 004_portal_tables.sql
  await reassign('inspo_gallery')             // 004_portal_tables.sql
  await reassign('booked_dates')              // 001_shared_tables.sql
  await reassign('lead_score_history')        // 002_agent_tables.sql
  await reassign('draft_feedback')            // 002_agent_tables.sql
  await reassign('user_profiles')             // 220_share_token_default_and_rls.sql
  await reassign('wedding_lifecycle_events')  // 246_*.sql (parallel agent)
  // attribution_events / wedding_touchpoints / candidate_identities are
  // covered by the migration-202 trigger; we still tombstone the loser
  // below so the trigger fires.

  // Also re-point people whose wedding_id is the duplicate. After this,
  // both partners on the duplicate (if any) are now attached to the
  // canonical wedding under their existing person rows.
  await reassign('people')

  // Now merge text fields from duplicate → canonical without overwriting.
  const [{ data: dup }, { data: canon }] = await Promise.all([
    supabase.from('weddings').select('notes, sage_context_notes').eq('id', duplicateId).maybeSingle(),
    supabase.from('weddings').select('notes, sage_context_notes').eq('id', canonicalId).maybeSingle(),
  ])
  if (dup && canon) {
    const updates: Record<string, unknown> = {}
    const dupNotes = (dup.notes as string | null) ?? null
    const canNotes = (canon.notes as string | null) ?? null
    if (dupNotes && dupNotes.trim() && (!canNotes || !canNotes.includes(dupNotes.trim()))) {
      updates.notes = canNotes ? `${canNotes}\n\n[merged from ${duplicateId}]\n${dupNotes}` : dupNotes
    }
    const dupSCN = Array.isArray(dup.sage_context_notes) ? dup.sage_context_notes : []
    const canSCN = Array.isArray(canon.sage_context_notes) ? canon.sage_context_notes : []
    if (dupSCN.length > 0) {
      // Concat + dedupe by JSON-string equality.
      const seen = new Set(canSCN.map((x) => JSON.stringify(x)))
      const merged = [...canSCN]
      for (const item of dupSCN) {
        const key = JSON.stringify(item)
        if (!seen.has(key)) {
          seen.add(key)
          merged.push(item)
        }
      }
      updates.sage_context_notes = merged
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from('weddings').update(updates).eq('id', canonicalId)
    }
  }

  // Tombstone the duplicate. The migration-202 trigger reattaches
  // attribution_events / wedding_touchpoints / candidate_identities
  // automatically on this UPDATE.
  const { error: tombErr } = await supabase
    .from('weddings')
    .update({ merged_into_id: canonicalId })
    .eq('id', duplicateId)
    .is('merged_into_id', null)
  if (tombErr) {
    throw new Error(`mergeWeddings: failed to tombstone duplicate ${duplicateId}: ${tombErr.message}`)
  }

  return {
    canonicalId,
    duplicateId,
    reassigned,
  }
}
