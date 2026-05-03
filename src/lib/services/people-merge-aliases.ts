/**
 * People-merge — alias detection (T5-Rixey-EEE Bug 1).
 *
 * The Stream KK service (identity-reconciliation.ts) consolidates
 * duplicate WEDDINGS that share an email — same human inquired through
 * two channels, two wedding rows get merged via merged_into_id. KK does
 * NOT merge duplicate PEOPLE rows attached to ONE wedding, so when a
 * single human is contacted under multiple email aliases (Knot proxy +
 * real Gmail; Knot + WW proxies + real Gmail), each address still
 * spawns a separate `people` row.
 *
 * This shows up on lead detail as "Sarah & Sarah & Sarah" — the
 * headline-builder iterates every contact row and joins the first
 * names. Sarah Rohrschneider (RM-0027) had three rows on 2026-05-02:
 *
 *   1. Sarah Rohrschneider (partner1) — sarah.rohrschneider.1.772357@member.theknot.com
 *   2. Sarah Rohrschneider (partner1) — s.rohrschneider@gmail.com
 *   3. Sarah Olkowski        (partner2) — olkowskiee1@gmail.com
 *
 * Rows 1 + 2 are the same human. We collapse them by:
 *
 *   1. Bucketing the wedding's people rows by (normalized first +
 *      last name).
 *   2. For each bucket of 2+ rows, checking that EXACTLY ONE row
 *      carries a real-domain email (gmail/outlook/icloud/yahoo/etc.
 *      OR a corporate domain that is NOT in the platform-alias list)
 *      AND every other row carries a known platform-alias email
 *      (member.theknot.com / notifications.honeybook.com / etc.).
 *   3. Picking the real-email row as canonical and folding the alias
 *      rows in: alias addresses get appended to canonical.alias_emails
 *      (migration 194), then the alias people rows are deleted via
 *      mergePeople() so the existing audit + child-row reassignment
 *      machinery handles the consolidation.
 *
 * Conservative gate. Per the constitution (forensic preservation +
 * "false positives are MUCH worse than false negatives" rule), we
 * NEVER auto-merge when:
 *   - Two rows in the same bucket both have real emails (could be
 *     one human with two addresses but could also be twins / family).
 *   - Two rows in the same bucket both have alias emails (no
 *     canonical to pick — leave coordinator to decide).
 *   - Names don't normalise to identical strings.
 *
 * Anything ambiguous gets logged but no rows are touched. The
 * existing /onboarding/identity-reconciliation Tier 2 surface is the
 * place coordinators handle the harder cases.
 *
 * Wired into the cron via `merge_people_aliases` (registered in
 * src/app/api/cron/route.ts) AND inline at the end of
 * reconcileVenue() so a freshly-merged wedding gets alias-collapsed
 * immediately. Backfill for existing data happens via the cron's
 * first run + the manual `runForVenue` exposed below.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'
import { mergePeople } from './merge-people'

// ---------------------------------------------------------------------------
// Platform alias-domain registry
// ---------------------------------------------------------------------------

/**
 * Email domain patterns recognised as platform-generated aliases —
 * the lead never sees mail sent here; the platform proxies. When we
 * see two `people` rows for the same name where one is one of these
 * and the other is a real address, we treat the alias as folded.
 *
 * Patterns are matched as plain `endsWith` against the lowercased
 * email's domain, so 'member.theknot.com' matches both
 * 'sarah.1.772357@member.theknot.com' and any future subdomain that
 * ends with the same suffix.
 *
 * Sourced from observed Rixey + Sage seed data + the platform
 * detectors (theknot.ts, wedding-wire.ts) so additions here are
 * keyed off real proof we've seen.
 */
const PLATFORM_ALIAS_DOMAINS = new Set<string>([
  // The Knot — proxy alias used in the Member Inbox flow. Saw 28 of
  // these on Rixey alone. Wedding-detail headline triple-counted
  // every one before the alias merge.
  'member.theknot.com',
  // HoneyBook — notifications.honeybook.com is the proxy that fires
  // when a coordinator replies inside HoneyBook UI (the lead replies
  // to that alias, the message round-trips through HB).
  'notifications.honeybook.com',
  'mail.honeybook.com',
  // WeddingWire — observed on a handful of WW relays. The bareword
  // weddingwire.com is the marketing/publisher domain, NOT the
  // proxy; we keep that out of the alias set so we don't fold real
  // WW staff replies.
  'reply.weddingwire.com',
  'mail.weddingwire.com',
  'authsolic.com',
  // Calendly — these addresses are bot-only (no human behind them)
  // so we never want a `people` row for them at all. Kept here so
  // the alias merge can clean any historical rows that did get
  // created (a pre-2026-04-22 bug). Live pipeline filters them out
  // via venue_email_filters per the bloom-reply-guard-audit.
  'calendly.com',
  'reply.calendly.com',
  // Other CRM proxies observed in the wild on imported brain-dump
  // CSV exports.
  'reply.dubsado.com',
  'mail.dubsado.com',
])

/**
 * Email-provider domains that are unambiguously "real human"
 * addresses. We use the AVAILABILITY of one of these as the cue to
 * pick the canonical row. Corporate domains (rixeymanor.com,
 * gmail.com, etc.) are also real but we capture those by negation:
 * any email whose domain is NOT in PLATFORM_ALIAS_DOMAINS counts
 * as real for canonical-pick purposes.
 *
 * Kept here for documentation / future reference; the actual gate
 * is `isPlatformAlias(email)`.
 */
const KNOWN_REAL_EMAIL_PROVIDERS = new Set<string>([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
])
void KNOWN_REAL_EMAIL_PROVIDERS

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeName(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .trim()
    // Accent fold — NFD then strip combining marks. Catches "Renée" vs
    // "Renee" without the alias merge mis-bucketing them.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
}

function emailDomain(email: string | null | undefined): string {
  if (!email) return ''
  const at = email.lastIndexOf('@')
  if (at < 0) return ''
  return email.slice(at + 1).toLowerCase().trim()
}

/**
 * Returns true when the email's domain matches a known platform-alias
 * pattern (Knot member proxy, HoneyBook notifications, etc.). Match
 * is suffix-based so 'member.theknot.com' covers any subdomain that
 * ends in the listed suffix.
 */
export function isPlatformAlias(email: string | null | undefined): boolean {
  const d = emailDomain(email)
  if (!d) return false
  for (const pat of PLATFORM_ALIAS_DOMAINS) {
    if (d === pat || d.endsWith(`.${pat}`)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersonRow {
  id: string
  venue_id: string
  wedding_id: string | null
  role: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  alias_emails: string[] | null
}

export interface AliasMergeResult {
  /** Wedding scoped result. */
  weddingId: string
  /** Buckets that contained 2+ rows AND were collapsed. */
  bucketsCollapsed: number
  /** Total people rows folded into a canonical (i.e. deleted). */
  rowsCollapsed: number
  /** Total alias addresses appended to canonical rows. */
  aliasesAppended: number
  /** Buckets that were ambiguous (multiple real / multiple alias /
   *  partial-name conflict) and SKIPPED for coordinator review. */
  bucketsSkippedAmbiguous: number
  /** Per-row error messages — partial success is preferred to abort. */
  errors: string[]
}

export interface VenueAliasMergeResult {
  venueId: string
  weddingsScanned: number
  weddingsTouched: number
  bucketsCollapsed: number
  rowsCollapsed: number
  aliasesAppended: number
  bucketsSkippedAmbiguous: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Per-wedding alias merge
// ---------------------------------------------------------------------------

/**
 * Run alias-detection + merge for a single wedding. Idempotent —
 * re-running is a no-op once every same-name bucket has at most one
 * person row.
 */
export async function mergePeopleAliasesForWedding(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<AliasMergeResult> {
  const result: AliasMergeResult = {
    weddingId,
    bucketsCollapsed: 0,
    rowsCollapsed: 0,
    aliasesAppended: 0,
    bucketsSkippedAmbiguous: 0,
    errors: [],
  }

  const { data: peopleRaw, error } = await supabase
    .from('people')
    .select('id, venue_id, wedding_id, role, first_name, last_name, email, phone, alias_emails')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
  if (error) {
    result.errors.push(`load people failed: ${error.message}`)
    return result
  }
  const people = (peopleRaw ?? []) as PersonRow[]
  if (people.length < 2) return result // nothing to collapse

  // Bucket by (normalized first + last name). Buckets where both name
  // parts are empty are skipped (no signal).
  const buckets = new Map<string, PersonRow[]>()
  for (const p of people) {
    const fn = normalizeName(p.first_name)
    const ln = normalizeName(p.last_name)
    if (!fn && !ln) continue
    const key = `${fn}|${ln}`
    const arr = buckets.get(key) ?? []
    arr.push(p)
    buckets.set(key, arr)
  }

  for (const [key, bucket] of buckets.entries()) {
    if (bucket.length < 2) continue

    // Classify each row.
    const aliasRows = bucket.filter((p) => isPlatformAlias(p.email))
    const realRows = bucket.filter((p) => p.email && !isPlatformAlias(p.email))
    const noEmailRows = bucket.filter((p) => !p.email)

    // Conservative gate. We only auto-merge when:
    //   - exactly one canonical row holds a real-domain email
    //   - every other row in the bucket has either an alias email or
    //     no email at all (alias-noemail rows tag-along — name match
    //     is the safe case).
    if (realRows.length !== 1) {
      result.bucketsSkippedAmbiguous += 1
      logEvent({
        level: 'info',
        msg: 'people_alias_merge.skip_ambiguous',
        event_type: 'people_alias_merge.skip',
        venueId,
        outcome: 'skip',
        data: {
          wedding_id: weddingId,
          name_key: key,
          real_count: realRows.length,
          alias_count: aliasRows.length,
          no_email_count: noEmailRows.length,
          reason: realRows.length === 0 ? 'no_real_email' : 'multiple_real_emails',
        },
      })
      continue
    }
    // At least one alias row OR a no-email row to fold.
    const foldRows = [...aliasRows, ...noEmailRows]
    if (foldRows.length === 0) {
      // Bucket of 1 (already filtered above) — defensive no-op.
      continue
    }

    const canonical = realRows[0]

    // Build the new alias_emails set by union with whatever the
    // canonical already had.
    const existingAliases = new Set<string>(
      Array.isArray(canonical.alias_emails) ? canonical.alias_emails : [],
    )
    let aliasesAddedThisBucket = 0
    for (const fold of foldRows) {
      if (fold.email && !existingAliases.has(fold.email)) {
        existingAliases.add(fold.email)
        aliasesAddedThisBucket += 1
      }
    }

    // Persist the alias-emails first so a transient failure inside
    // mergePeople doesn't lose the alias address evidence.
    if (aliasesAddedThisBucket > 0) {
      const { error: updErr } = await supabase
        .from('people')
        .update({ alias_emails: Array.from(existingAliases) })
        .eq('id', canonical.id)
      if (updErr) {
        result.errors.push(`canonical ${canonical.id} alias_emails update failed: ${updErr.message}`)
        continue
      }
    }

    // Fold each non-canonical row into the canonical via mergePeople.
    // mergePeople handles child-row reassignment + audit row in
    // person_merges + the deletion of the merged person.
    let bucketCollapsedAtLeastOne = false
    for (const fold of foldRows) {
      // Defensive: never merge a row into itself.
      if (fold.id === canonical.id) continue
      try {
        const merged = await mergePeople({
          supabase,
          venueId,
          keepPersonId: canonical.id,
          mergePersonId: fold.id,
          tier: 'high',
          signals: [
            {
              type: 'platform_alias_match',
              detail: `name match (${key}) + canonical real email + folded ${
                fold.email ? `alias email ${emailDomain(fold.email)}` : 'no-email row'
              }`,
              weight: 1.0,
            },
          ],
          confidence: 0.95,
          mergedBy: 'system:people_alias_merge',
          matchQueueId: null,
        })
        result.rowsCollapsed += 1
        bucketCollapsedAtLeastOne = true
        logEvent({
          level: 'info',
          msg: 'people_merged',
          event_type: 'people_alias_merge.merged',
          venueId,
          outcome: 'ok',
          data: {
            wedding_id: weddingId,
            kept_person_id: canonical.id,
            merged_person_id: fold.id,
            merge_id: merged.mergeId,
            reassigned: merged.reassignedCounts,
            name_key: key,
            alias_email: fold.email ?? null,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown merge error'
        result.errors.push(`merge person ${fold.id} into ${canonical.id} failed: ${msg}`)
      }
    }
    if (bucketCollapsedAtLeastOne) {
      result.bucketsCollapsed += 1
      result.aliasesAppended += aliasesAddedThisBucket
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Per-venue alias merge
// ---------------------------------------------------------------------------

/**
 * Run alias-detection + merge across every active wedding for a
 * venue. Active = not soft-merged (merged_into_id IS NULL).
 *
 * Cheap: only weddings with 2+ same-name people rows touch
 * mergePeople. Most weddings are 0-touch.
 */
export async function mergePeopleAliasesForVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueAliasMergeResult> {
  const summary: VenueAliasMergeResult = {
    venueId,
    weddingsScanned: 0,
    weddingsTouched: 0,
    bucketsCollapsed: 0,
    rowsCollapsed: 0,
    aliasesAppended: 0,
    bucketsSkippedAmbiguous: 0,
    errors: [],
  }

  const { data: weddings, error } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
  if (error) {
    summary.errors.push(`load weddings failed: ${error.message}`)
    return summary
  }

  for (const w of (weddings ?? []) as Array<{ id: string }>) {
    summary.weddingsScanned += 1
    const r = await mergePeopleAliasesForWedding(supabase, venueId, w.id)
    if (r.bucketsCollapsed > 0 || r.bucketsSkippedAmbiguous > 0) {
      summary.weddingsTouched += 1
    }
    summary.bucketsCollapsed += r.bucketsCollapsed
    summary.rowsCollapsed += r.rowsCollapsed
    summary.aliasesAppended += r.aliasesAppended
    summary.bucketsSkippedAmbiguous += r.bucketsSkippedAmbiguous
    summary.errors.push(...r.errors)
  }

  logEvent({
    level: 'info',
    msg: 'people_alias_merge.venue_complete',
    event_type: 'people_alias_merge.venue_complete',
    venueId,
    outcome: summary.errors.length === 0 ? 'ok' : 'fail',
    data: {
      weddings_scanned: summary.weddingsScanned,
      weddings_touched: summary.weddingsTouched,
      buckets_collapsed: summary.bucketsCollapsed,
      rows_collapsed: summary.rowsCollapsed,
      aliases_appended: summary.aliasesAppended,
      buckets_skipped_ambiguous: summary.bucketsSkippedAmbiguous,
      error_count: summary.errors.length,
    },
  })
  return summary
}

// ---------------------------------------------------------------------------
// Cross-venue cron entrypoint
// ---------------------------------------------------------------------------

/**
 * Cron handler — sweep every venue. Called from
 * src/app/api/cron/route.ts under the `merge_people_aliases` job
 * key. Sequenced AFTER identity reconciliation (KK / phase_b_sweep)
 * and BEFORE lead-source derivation so the canonical-person view is
 * stable when source attribution computes.
 */
export async function mergePeopleAliasesAllVenues(
  supabase: SupabaseClient,
): Promise<{
  venues_scanned: number
  total_weddings_touched: number
  total_rows_collapsed: number
  total_aliases_appended: number
  total_buckets_skipped: number
  errors: string[]
}> {
  const out = {
    venues_scanned: 0,
    total_weddings_touched: 0,
    total_rows_collapsed: 0,
    total_aliases_appended: 0,
    total_buckets_skipped: 0,
    errors: [] as string[],
  }
  const { data: venues, error } = await supabase.from('venues').select('id, name')
  if (error) {
    out.errors.push(`load venues failed: ${error.message}`)
    return out
  }
  for (const v of (venues ?? []) as Array<{ id: string; name: string }>) {
    out.venues_scanned += 1
    try {
      const r = await mergePeopleAliasesForVenue(supabase, v.id)
      out.total_weddings_touched += r.weddingsTouched
      out.total_rows_collapsed += r.rowsCollapsed
      out.total_aliases_appended += r.aliasesAppended
      out.total_buckets_skipped += r.bucketsSkippedAmbiguous
      out.errors.push(...r.errors)
    } catch (err) {
      out.errors.push(`${v.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}
