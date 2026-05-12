/**
 * Retroactive duplicate-people merge sweep — IDENTITY-RESOLUTION-AUDIT
 * F10 (2026-05-12).
 *
 * Why this exists
 * ---------------
 * The Crystal Fuller (RM-0480) case surfaced two `partner1` people rows
 * on the same wedding, both carrying `crystalgailfuller@gmail.com`. The
 * `mintWedding` chokepoint shipped alongside this sweep prevents NEW
 * duplicates from ever being minted, but legacy duplicates (created
 * before the chokepoint or via the legacy direct-INSERT paths flagged
 * in F7) need a cleanup pass.
 *
 * F10 from the audit ledger: "Daily cron that looks for `people` rows
 * with matching email or matching phone across different IDs in the
 * same venue, runs through enqueueIdentityMatch for tier-1 exacts,
 * lets the existing review-queue handle ambiguous cases." This sweep
 * is the email-exact + phone-exact half; the same-name-different-email
 * case (couples with both a personal Gmail and a business address)
 * needs the AI adjudicator and is explicitly OUT of scope here — see
 * the comment block on Pass 3 below.
 *
 * Relationship to people-merge-aliases.ts (T5-Rixey-EEE Bug 1)
 * ------------------------------------------------------------
 * That sister sweep collapses rows where ONE row holds a real-domain
 * email and EVERY other row holds a known platform-alias domain
 * (member.theknot.com, notifications.honeybook.com, etc.). It bails
 * the moment both rows have real-domain emails — exactly the case
 * Crystal Fuller hit (both rows held the same gmail.com address). That
 * gap is what this sweep closes: when (wedding_id, role, lower(email))
 * is identical across multiple rows, the two are the same human by
 * exact-evidence match — safe to collapse without name-bucket
 * ambiguity.
 *
 * Scope
 * -----
 * Pass 1 — same (wedding_id, role, lower(email)) on 2+ active rows.
 * Pass 2 — same (wedding_id, role, phone) on 2+ active rows where
 *          BOTH rows have email IS NULL (i.e. SMS-only Justin class).
 *          We keep the email-null gate so a phone collision between
 *          one canonical row (email + phone) and a stripped no-email
 *          duplicate is NOT auto-merged; that scenario is genuinely
 *          ambiguous and belongs in the review queue.
 * Pass 3 — DEFERRED. Same-name-different-email is the trickiest
 *          duplicate class (personal gmail + business email for the
 *          same human). Needs the AI adjudicator
 *          (candidate-ai-adjudicator.ts) plus a confidence gate.
 *          Tracked separately.
 *
 * "Best" row pick (deterministic, no ties)
 * ----------------------------------------
 *   1. Highest `name_confidence` (mig 255). NULL is treated as -1
 *      so any populated value wins.
 *   2. Most populated fields (count of non-null first_name /
 *      last_name / email / phone / display_handle).
 *   3. Earliest `created_at` (stable tie-break).
 *
 * Logging + idempotency
 * ---------------------
 * Every action logs via logEvent under event_type
 * `auto_merge_duplicates.*`. Re-running is a no-op: mergePeople()
 * deletes the merged row, so the next sweep's GROUP BY tuple shrinks
 * to size 1 and the bucket is skipped.
 *
 * Wiring
 * ------
 * Registered in src/app/api/cron/route.ts as
 * `auto_merge_duplicate_partners`. Vercel Pro is at the 40-cron cap;
 * the job is not in vercel.json — operator triggers via
 * /api/cron?job=auto_merge_duplicate_partners until a shared
 * maintenance cron picks it up.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'
import { mergePeople } from './merge-people'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DuplicateGroup {
  wedding_id: string
  role: string
  /** Lowercased email key for email-match passes; null for phone-match passes. */
  email_lower: string | null
  /** Normalised phone (E.164 best-effort) for phone-match passes; null for email-match. */
  phone_key: string | null
  /** Every person id in the duplicate group, sorted ascending. */
  person_ids: string[]
  /** Deterministic pick of the row to keep. */
  best_id: string
  /** Every person id to fold into best_id (i.e. person_ids minus best_id). */
  mergeable_ids: string[]
  /** Which pass detected this group — drives the signal we record on the merge audit row. */
  match_kind: 'email' | 'phone'
}

interface PersonRow {
  id: string
  venue_id: string
  wedding_id: string | null
  role: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  display_handle: string | null
  name_confidence: number | null
  created_at: string | null
  merged_into_id: string | null
}

export interface AutoMergeOptions {
  /** Restrict the sweep to a single venue. Omit to walk every venue. */
  venueId?: string
  /** Detect and log groups but skip the actual mergePeople() call. */
  dryRun?: boolean
}

export interface AutoMergeResult {
  groupsFound: number
  merged: number
  skipped: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const trimmed = email.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Loose phone key — strips every non-digit so '+1 (302) 555-1234'
 * and '3025551234' bucket together. We don't bother with full E.164
 * because the goal is "do these two strings refer to the same line".
 * Anything shorter than 7 digits is rejected (extension fragments,
 * partial captures, etc.).
 */
function normalisePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D+/g, '')
  if (digits.length < 7) return null
  // Drop a single leading '1' country code so '13025551234' and
  // '3025551234' collide.
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return digits
}

/**
 * Deterministic best-row pick. See file header for the priority chain.
 * Never returns null — caller guarantees rows.length >= 1.
 */
function pickBestRow(rows: PersonRow[]): PersonRow {
  const scored = rows.map((r) => {
    const populated = [r.first_name, r.last_name, r.email, r.phone, r.display_handle]
      .filter((v) => v !== null && v !== undefined && String(v).trim().length > 0)
      .length
    const nameConfidence = typeof r.name_confidence === 'number' ? r.name_confidence : -1
    const createdAt = r.created_at ? new Date(r.created_at).getTime() : Number.MAX_SAFE_INTEGER
    return { row: r, nameConfidence, populated, createdAt }
  })
  scored.sort((a, b) => {
    if (b.nameConfidence !== a.nameConfidence) return b.nameConfidence - a.nameConfidence
    if (b.populated !== a.populated) return b.populated - a.populated
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    // Final stable tie-break: id lexicographic asc so re-runs pick the
    // same winner if every other field is identical.
    return a.row.id.localeCompare(b.row.id)
  })
  return scored[0].row
}

// ---------------------------------------------------------------------------
// findDuplicatePartnerRows — pure read
// ---------------------------------------------------------------------------

/**
 * Detect duplicate `people` rows on the same wedding+role keyed by
 * either shared email or shared phone. No writes.
 *
 * Strategy: page the active-set partial index
 * (idx_people_active_venue, migration 247) — which filters
 * merged_into_id IS NULL — and bucket in TypeScript. Cheap because
 * the Crystal Fuller bug only spawns a handful of duplicates per
 * venue per year; the entire active people set on Rixey today is a
 * few thousand rows.
 */
export async function findDuplicatePartnerRows(
  supabase: SupabaseClient,
  options?: AutoMergeOptions,
): Promise<DuplicateGroup[]> {
  const venueId = options?.venueId
  const groups: DuplicateGroup[] = []

  // Pull the active set. Page in chunks of 1000 so a venue with a
  // pathological back-catalogue doesn't blow the response limit.
  const PAGE = 1000
  let from = 0
  const all: PersonRow[] = []
  // Loop is bounded by the count of active people per venue —
  // breaks as soon as a page returns < PAGE rows.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase
      .from('people')
      .select(
        'id, venue_id, wedding_id, role, first_name, last_name, email, phone, display_handle, name_confidence, created_at, merged_into_id',
      )
      .is('merged_into_id', null)
      .not('wedding_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (venueId) q = q.eq('venue_id', venueId)
    const { data, error } = await q
    if (error) {
      logEvent({
        level: 'error',
        msg: 'auto_merge_duplicates.load_failed',
        event_type: 'auto_merge_duplicates.load',
        venueId: venueId ?? null,
        outcome: 'fail',
        data: { error: error.message, from },
      })
      return groups
    }
    const page = (data ?? []) as PersonRow[]
    all.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }

  if (all.length === 0) return groups

  // Pass 1 — same (venue_id, wedding_id, role, lower(email)).
  // The venue_id key isn't strictly needed because wedding_id already
  // bottlenecks per-venue, but folding it in keeps the bucket key
  // self-documenting and survives any future cross-venue wedding
  // sharing scheme.
  const emailBuckets = new Map<string, PersonRow[]>()
  for (const p of all) {
    const emailKey = normaliseEmail(p.email)
    if (!emailKey) continue
    if (!p.wedding_id || !p.role) continue
    const key = `${p.venue_id}|${p.wedding_id}|${p.role}|${emailKey}`
    const arr = emailBuckets.get(key) ?? []
    arr.push(p)
    emailBuckets.set(key, arr)
  }
  for (const [, bucket] of emailBuckets) {
    if (bucket.length < 2) continue
    const best = pickBestRow(bucket)
    const ids = bucket.map((r) => r.id).sort()
    groups.push({
      wedding_id: bucket[0].wedding_id!,
      role: bucket[0].role!,
      email_lower: normaliseEmail(bucket[0].email),
      phone_key: null,
      person_ids: ids,
      best_id: best.id,
      mergeable_ids: ids.filter((id) => id !== best.id),
      match_kind: 'email',
    })
  }

  // Pass 2 — same (venue_id, wedding_id, role, phone_key) WHERE
  // every row in the bucket has email IS NULL. The email-null gate
  // is intentional: if a canonical row carries email + phone and a
  // duplicate row carries phone-only, the phone match is suggestive
  // but the missing-email row could equally be a partner contact
  // captured from a different surface. Sending it through the
  // review queue is the safer call — leave it for the
  // enqueueIdentityMatch path the audit's full F10 fix calls for.
  const phoneBuckets = new Map<string, PersonRow[]>()
  for (const p of all) {
    if (p.email) continue
    const phoneKey = normalisePhone(p.phone)
    if (!phoneKey) continue
    if (!p.wedding_id || !p.role) continue
    const key = `${p.venue_id}|${p.wedding_id}|${p.role}|${phoneKey}`
    const arr = phoneBuckets.get(key) ?? []
    arr.push(p)
    phoneBuckets.set(key, arr)
  }
  for (const [, bucket] of phoneBuckets) {
    if (bucket.length < 2) continue
    const best = pickBestRow(bucket)
    const ids = bucket.map((r) => r.id).sort()
    groups.push({
      wedding_id: bucket[0].wedding_id!,
      role: bucket[0].role!,
      email_lower: null,
      phone_key: normalisePhone(bucket[0].phone),
      person_ids: ids,
      best_id: best.id,
      mergeable_ids: ids.filter((id) => id !== best.id),
      match_kind: 'phone',
    })
  }

  // Pass 3 — same-name-different-email. DEFERRED.
  // The trickiest duplicate class is two rows on the same wedding
  // with first_name + last_name matching but different real-domain
  // emails (personal Gmail + business Outlook for the same human is
  // the canonical case; twins / father-and-son sharing a surname are
  // the false-positive shape we have to defend against). Email
  // exact-match and phone exact-match are evidence enough to merge
  // automatically; name-only needs the
  // candidate-ai-adjudicator.ts judge to score the pair and a
  // confidence gate before it can ship as auto-merge.
  // Tracked in the F10 closeout — out of scope here.

  return groups
}

// ---------------------------------------------------------------------------
// autoMergeDuplicatePartners — orchestrator
// ---------------------------------------------------------------------------

/**
 * Detect every same-evidence duplicate group via
 * findDuplicatePartnerRows and fold non-best rows into the best row
 * via mergePeople. Pure orchestration — mergePeople handles every
 * FK reassignment, the person_merges audit row, and the tombstone /
 * deletion. dryRun=true short-circuits before the merge call but
 * still emits the per-group log so an operator can see what would
 * happen.
 *
 * Returns aggregate counts. Per-group errors collect into the
 * errors array; one bad bucket does not abort the sweep.
 */
export async function autoMergeDuplicatePartners(
  supabase: SupabaseClient,
  options?: AutoMergeOptions,
): Promise<AutoMergeResult> {
  const result: AutoMergeResult = {
    groupsFound: 0,
    merged: 0,
    skipped: 0,
    errors: [],
  }
  const dryRun = options?.dryRun === true
  const venueScope = options?.venueId ?? null

  const groups = await findDuplicatePartnerRows(supabase, options)
  result.groupsFound = groups.length

  if (groups.length === 0) {
    logEvent({
      level: 'info',
      msg: 'auto_merge_duplicates.no_groups',
      event_type: 'auto_merge_duplicates.sweep',
      venueId: venueScope,
      outcome: 'ok',
      data: { dry_run: dryRun, venue_scope: venueScope },
    })
    return result
  }

  for (const group of groups) {
    if (dryRun) {
      result.skipped += group.mergeable_ids.length
      logEvent({
        level: 'info',
        msg: 'auto_merge_duplicates.dry_run',
        event_type: 'auto_merge_duplicates.skip',
        venueId: venueScope,
        outcome: 'skip',
        data: {
          wedding_id: group.wedding_id,
          role: group.role,
          match_kind: group.match_kind,
          email_lower: group.email_lower,
          phone_key: group.phone_key,
          person_ids: group.person_ids,
          best_id: group.best_id,
          mergeable_ids: group.mergeable_ids,
        },
      })
      continue
    }

    // mergePeople requires a venueId. Pull it from the best row's
    // wedding via a tiny lookup — the group itself doesn't track
    // venue_id directly because findDuplicatePartnerRows bucketed on
    // wedding_id (which is per-venue) without re-emitting the
    // venue. Cheaper than dragging it through the type.
    const { data: bestRow } = await supabase
      .from('people')
      .select('id, venue_id, email, phone')
      .eq('id', group.best_id)
      .maybeSingle()
    if (!bestRow?.venue_id) {
      result.errors.push(`group wedding=${group.wedding_id} role=${group.role}: best row ${group.best_id} missing venue_id`)
      continue
    }
    const venueId = bestRow.venue_id as string

    for (const mergeId of group.mergeable_ids) {
      try {
        const signalDetail =
          group.match_kind === 'email'
            ? `exact email match (${group.email_lower}) on (wedding_id, role)`
            : `exact phone match (${group.phone_key}) on (wedding_id, role); both rows email-null`
        const merged = await mergePeople({
          supabase,
          venueId,
          keepPersonId: group.best_id,
          mergePersonId: mergeId,
          tier: 'high',
          signals: [
            {
              type:
                group.match_kind === 'email'
                  ? 'auto_merge_exact_email'
                  : 'auto_merge_exact_phone',
              detail: signalDetail,
              weight: 1.0,
            },
          ],
          // confidence is a 0-100 score per the resolve route's pattern.
          confidence: 100,
          mergedBy: 'system:auto_merge_duplicate_partners',
          matchQueueId: null,
        })
        result.merged += 1
        logEvent({
          level: 'info',
          msg: 'auto_merge_duplicates.merged',
          event_type: 'auto_merge_duplicates.merge',
          venueId,
          outcome: 'ok',
          data: {
            wedding_id: group.wedding_id,
            role: group.role,
            match_kind: group.match_kind,
            email_lower: group.email_lower,
            phone_key: group.phone_key,
            kept_person_id: group.best_id,
            merged_person_id: mergeId,
            merge_id: merged.mergeId,
            reassigned: merged.reassignedCounts,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown merge error'
        result.errors.push(
          `merge person ${mergeId} into ${group.best_id} (wedding=${group.wedding_id}, role=${group.role}, kind=${group.match_kind}): ${msg}`,
        )
        logEvent({
          level: 'warn',
          msg: 'auto_merge_duplicates.merge_failed',
          event_type: 'auto_merge_duplicates.merge',
          venueId,
          outcome: 'fail',
          data: {
            wedding_id: group.wedding_id,
            role: group.role,
            match_kind: group.match_kind,
            kept_person_id: group.best_id,
            merged_person_id: mergeId,
            error: msg,
          },
        })
      }
    }
  }

  logEvent({
    level: 'info',
    msg: 'auto_merge_duplicates.sweep_complete',
    event_type: 'auto_merge_duplicates.sweep',
    venueId: venueScope,
    outcome: result.errors.length === 0 ? 'ok' : 'fail',
    data: {
      groups_found: result.groupsFound,
      merged: result.merged,
      skipped: result.skipped,
      error_count: result.errors.length,
      dry_run: dryRun,
      venue_scope: venueScope,
    },
  })

  return result
}
