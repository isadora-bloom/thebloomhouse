/**
 * binder-cron — deferred identity binder.
 *
 * Audit IDENTITY-RESOLUTION-AUDIT-2026-05-12.md F1/F2/F3 documented the
 * problem: identity resolution runs SYNCHRONOUSLY inline in every write
 * path. When the resolver throws (timeout, RLS race, transient service
 * unavailable) or when the inbound signal isn't strong enough to match
 * inline (extracted-only identity, mid-thread reply with no body
 * signature, etc.), the interaction lands with `wedding_id = NULL` and
 * stays orphaned until either a manual sweep or a downstream signal
 * happens to bind it.
 *
 * This binder is the missing scheduled tick. Once per cron cadence it:
 *
 *   1. Pulls a bounded batch of recent unbound interactions whose
 *      `extracted_identity` carries at least one email or phone signal.
 *   2. For each row, scores against the venue's people pool via the
 *      READ-ONLY `findIdentityMatches` engine.
 *   3. Routes by tier:
 *      - `high` → bind in place (update `interactions.wedding_id` +
 *        `interactions.person_id`)
 *      - `medium` → enqueue the pair via the existing
 *        `enqueueIdentityMatches` path so the coordinator can confirm
 *      - no match AND a primary email or phone is present → mint a
 *        fresh wedding via `mintWedding`
 *   4. Fires `triggerIdentityCascade` per newly-bound wedding (fire-
 *      and-forget) so pre-zero signals attached to that wedding get
 *      re-evaluated immediately.
 *
 * No new migrations. Avoiding a `binder_attempted_at` column means
 * no-signal rows get re-scanned each tick — but the filter is narrow
 * enough (last 7 days, extracted_identity IS NOT NULL) that the wasted
 * read is bounded. TODO: add a `binder_attempted_at` column in a future
 * migration so we can skip already-evaluated rows entirely.
 *
 * Anchor: bloom-constitution.md Point-Zero doctrine. The binder is what
 * makes "an unbound signal eventually finds its couple" durable rather
 * than dependent on whichever code path happens to run next.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { findIdentityMatches } from './resolution'
import { mintWedding } from './mint-wedding'
import { logEvent } from '@/lib/observability/logger'

export interface BinderResult {
  scanned: number
  bound: number
  /** Rows that produced an ambiguous (medium-tier) match and were
   *  enqueued via client_match_queue rather than bound silently. */
  deferred: number
  /** Rows for which we minted a fresh person + wedding because no
   *  match was found AND the row had a primary email or phone. */
  minted: number
  /** Rows skipped because their `extracted_identity` had no usable
   *  signal (no email + no phone). These are re-scanned next tick. */
  noSignal: number
  errors: string[]
  latencyMs: number
}

export interface BinderOptions {
  /** Cap on rows scanned per tick. Default 100 — enough to drain the
   *  steady-state arrival rate of unbound rows without burning the
   *  cron budget on a single run. */
  limit?: number
}

// Days back we consider for unbound interactions. Older orphans are the
// daily safety-net cron's job (identity_cascade_sweep + phase_b_sweep);
// the binder is a fast catch-up for fresh writes.
const LOOKBACK_DAYS = 7

interface UnboundRow {
  id: string
  venue_id: string
  created_at: string
  direction: string | null
  extracted_identity: Record<string, unknown> | null
  from_email: string | null
}

/**
 * Run one binder tick. Always resolves, never rejects. Per-row errors
 * land in `result.errors[]` and the structured log.
 */
export async function runIdentityBinder(
  supabase?: SupabaseClient,
  options: BinderOptions = {},
): Promise<BinderResult> {
  const client = supabase ?? createServiceClient()
  const limit = options.limit ?? 100
  const started = Date.now()
  const result: BinderResult = {
    scanned: 0,
    bound: 0,
    deferred: 0,
    minted: 0,
    noSignal: 0,
    errors: [],
    latencyMs: 0,
  }

  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

  // Pull a bounded batch. `extracted_identity IS NOT NULL` is the
  // cheap filter that keeps the binder off of historical orphans (the
  // universal-extractor rolled out 2026-04-30 in migration 113; older
  // rows have null and are the daily-sweep's problem). `direction =
  // 'inbound'` per feedback_inbox_lifecycle_inbound_only.md — Sage
  // outbound rows have no identity to bind.
  const { data, error } = await client
    .from('interactions')
    .select('id, venue_id, created_at, direction, extracted_identity, from_email')
    .is('wedding_id', null)
    .gte('created_at', sinceIso)
    .not('extracted_identity', 'is', null)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    result.errors.push(`fetch_unbound: ${error.message}`)
    result.latencyMs = Date.now() - started
    logEvent({
      level: 'error',
      msg: 'identity.binder',
      actor: 'cron:identity_binder',
      event_type: 'identity.binder',
      outcome: 'fail',
      latency_ms: result.latencyMs,
      data: { error: error.message },
    })
    return result
  }

  const rows = (data ?? []) as UnboundRow[]
  result.scanned = rows.length

  // Track wedding ids that received fresh binds in this tick so we
  // fire the cascade exactly once per wedding even when multiple
  // orphan rows just landed on the same couple. Cascade is the most
  // expensive side-effect (3 services back to back) so dedup matters.
  const cascadeQueue = new Set<string>()
  const cascadeVenue = new Map<string, string>()

  for (const row of rows) {
    try {
      const ext = (row.extracted_identity ?? {}) as Record<string, unknown>
      const emails = Array.isArray(ext.emails) ? (ext.emails as unknown[]) : []
      const phones = Array.isArray(ext.phones) ? (ext.phones as unknown[]) : []
      const names = Array.isArray(ext.names) ? (ext.names as unknown[]) : []
      const dateHints = Array.isArray(ext.date_hints) ? (ext.date_hints as unknown[]) : []
      const primaryEmail = typeof ext.primary_email === 'string'
        ? (ext.primary_email as string)
        : null

      // Pick the best email/phone signal. Primary first, then first
      // entry from the arrays, then the row's from_email as last
      // resort (gmail-pulled rows always have one, brain-dump rows
      // sometimes don't).
      const email =
        primaryEmail ??
        (typeof emails[0] === 'string' ? (emails[0] as string) : null) ??
        row.from_email
      const phone = typeof phones[0] === 'string' ? (phones[0] as string) : null
      const fullName = typeof names[0] === 'string' ? (names[0] as string) : null
      const weddingDate = typeof dateHints[0] === 'string' ? (dateHints[0] as string) : null

      if (!email && !phone) {
        // No actionable signal. The row's extracted_identity got
        // populated with names / date_hints only — we can't match a
        // wedding off names alone (too many false positives). Skip
        // and let the daily cascade-sweep / brain-dump enrichment
        // path handle it once stronger signal arrives.
        result.noSignal++
        continue
      }

      // Score against the venue's people pool.
      const matches = await findIdentityMatches(client, {
        venueId: row.venue_id,
        email,
        phone,
        firstName: fullName ? fullName.trim().split(/\s+/)[0] ?? null : null,
        lastName: fullName
          ? fullName.trim().split(/\s+/).slice(1).join(' ') || null
          : null,
        weddingDate,
        signalDate: row.created_at,
      })

      const high = matches.find((m) => m.tier === 'high')
      const medium = matches.find((m) => m.tier === 'medium')

      if (high) {
        // Tier high: bind in place. Look up the person's wedding so
        // we stamp both columns on the interaction. We don't trust
        // matches.weddingId because the read engine only returns
        // personId; the wedding is one indirection away.
        const { data: personRow, error: personErr } = await client
          .from('people')
          .select('id, wedding_id')
          .eq('id', high.personId)
          .maybeSingle()
        if (personErr || !personRow) {
          result.errors.push(
            `bind_person_lookup ${row.id}: ${personErr?.message ?? 'no-row'}`,
          )
          continue
        }
        const weddingId = (personRow.wedding_id as string | null) ?? null
        if (!weddingId) {
          // High-tier person match but no wedding attached. Rare
          // but possible — log + skip; the operator review will
          // surface it via client_match_queue if needed.
          result.errors.push(
            `bind_no_wedding ${row.id}: person ${high.personId} has no wedding_id`,
          )
          continue
        }
        const { error: updErr } = await client
          .from('interactions')
          .update({ person_id: high.personId, wedding_id: weddingId })
          .eq('id', row.id)
        if (updErr) {
          result.errors.push(`bind_update ${row.id}: ${updErr.message}`)
          continue
        }
        result.bound++
        cascadeQueue.add(weddingId)
        cascadeVenue.set(weddingId, row.venue_id)
      } else if (medium) {
        // Tier medium: ambiguous. Do NOT bind silently — enqueue the
        // pair via client_match_queue so the coordinator confirms.
        // The interaction stays unbound until they decide; the next
        // tick will re-score (cheap given the LOOKBACK_DAYS filter)
        // and the daily sweep is the final backstop.
        await enqueueAmbiguousMatch(client, {
          venueId: row.venue_id,
          interactionId: row.id,
          match: medium,
        })
        result.deferred++
      } else if (email || phone) {
        // No match AND we have a real identity hook. Mint a wedding.
        // The resolver writer at resolver.ts:732 handles the full
        // match-chain again (including the canonical paths we already
        // ran — cheap to re-check, gives us defence-in-depth against
        // a race that landed an exact match in the time between our
        // findIdentityMatches read and now).
        const minted = await mintWedding({
          venueId: row.venue_id,
          source: 'email_pipeline',
          reason: 'binder_cron',
          supabase: client,
          signals: {
            email,
            phone,
            fullName,
            weddingDate,
            inquiryDate: row.created_at,
          },
        })
        // Stamp the interaction with the minted ids.
        const { error: stampErr } = await client
          .from('interactions')
          .update({ person_id: minted.personId, wedding_id: minted.weddingId })
          .eq('id', row.id)
        if (stampErr) {
          result.errors.push(`mint_stamp ${row.id}: ${stampErr.message}`)
        }
        result.minted++
        // The mintWedding helper fires its own cascade — don't
        // double-fire on the queue. Only `bound` rows need the
        // separate cascade trigger because they updated an existing
        // wedding, not a freshly-minted one.
      } else {
        // Unreachable: we already guard email/phone above. Defensive
        // path so a future code change doesn't silently swallow.
        result.noSignal++
      }
    } catch (err) {
      result.errors.push(
        `row ${row.id} threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Fire the identity cascade once per wedding that received a fresh
  // bind. Fire-and-forget — never block the cron return on cascade
  // latency. Dynamic import keeps the cascade out of the warm path
  // for ticks where nothing bound.
  if (cascadeQueue.size > 0) {
    void (async () => {
      try {
        const { triggerIdentityCascade } = await import('./cascade-on-enrichment')
        for (const weddingId of cascadeQueue) {
          const venueId = cascadeVenue.get(weddingId) ?? ''
          if (!venueId) continue
          try {
            await triggerIdentityCascade({
              venueId,
              weddingId,
              supabase: client,
              reason: 'binder_cron',
            })
          } catch (err) {
            logEvent({
              level: 'warn',
              msg: 'identity.binder.cascade_failed',
              venueId,
              actor: 'cron:identity_binder',
              event_type: 'identity.binder',
              outcome: 'fail',
              data: {
                wedding_id: weddingId,
                error: err instanceof Error ? err.message : String(err),
              },
            })
          }
        }
      } catch (err) {
        logEvent({
          level: 'warn',
          msg: 'identity.binder.cascade_import_failed',
          actor: 'cron:identity_binder',
          event_type: 'identity.binder',
          outcome: 'fail',
          data: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    })()
  }

  result.latencyMs = Date.now() - started
  logEvent({
    level: result.errors.length > 0 ? 'warn' : 'info',
    msg: 'identity.binder',
    actor: 'cron:identity_binder',
    event_type: 'identity.binder',
    outcome: result.errors.length > 0 ? 'fail' : 'ok',
    latency_ms: result.latencyMs,
    data: {
      scanned: result.scanned,
      bound: result.bound,
      deferred: result.deferred,
      minted: result.minted,
      no_signal: result.noSignal,
      error_count: result.errors.length,
      first_error: result.errors[0] ?? null,
      cascades_queued: cascadeQueue.size,
    },
  })

  return result
}

/**
 * Push an ambiguous match into client_match_queue. The pair is
 * (matched-person, interaction-id) — we don't have a synthetic person
 * for the interaction yet, so the queue row references the
 * interaction directly via the `signals` jsonb payload. The
 * coordinator UI at /intel/identity-queue reads this and either
 * confirms (creates the binding) or rejects (marks no_match).
 *
 * Dedup is best-effort: re-running on the same interaction will
 * insert another queue row only when the match score has changed
 * since the previous tick. The queue UI batches by interaction so the
 * coordinator still sees a single review item.
 */
async function enqueueAmbiguousMatch(
  supabase: SupabaseClient,
  args: {
    venueId: string
    interactionId: string
    match: { personId: string; tier: string; confidence: number; signals: unknown[] }
  },
): Promise<void> {
  const { venueId, interactionId, match } = args
  // Check for an existing pending row on this interaction so we
  // don't double-queue when the binder re-scans the same row on the
  // next tick.
  const { data: existing } = await supabase
    .from('client_match_queue')
    .select('id')
    .eq('venue_id', venueId)
    .eq('person_a_id', match.personId)
    .in('status', ['pending', 'snoozed'])
    .contains('signals', [{ interaction_id: interactionId }])
    .limit(1)
  if (existing && existing.length > 0) return

  // Stash the interaction id in the signals payload so the queue UI
  // can surface "binder couldn't bind this auto" review.
  const signals = [
    { interaction_id: interactionId, binder_proposed_match: true },
    ...(Array.isArray(match.signals) ? match.signals : []),
  ]
  await supabase.from('client_match_queue').insert({
    venue_id: venueId,
    person_a_id: match.personId,
    person_b_id: null,
    match_type: 'binder_ambiguous',
    confidence: match.confidence,
    signals,
    tier: match.tier,
    status: 'pending',
  })
}
