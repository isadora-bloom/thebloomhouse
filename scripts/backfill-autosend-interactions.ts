/**
 * scripts/backfill-autosend-interactions.ts
 * =========================================
 * One-time backfill for the C3 pre-existing gap (PHASE-1-BATCH-1 §3
 * "Pressure-test findings"): `flushPendingAutoSends` has been writing
 * draft.status='sent' but producing NO `interactions` row and NO
 * `linkSignal` call since the autonomous-send loop was built. The
 * going-forward fix landed in `307ffd6` (`pipeline.ts` ~4769-4910).
 *
 * Historical autonomous sends are invisible to:
 *   - `follow-up-sequences.ts:179` (last outbound for daysSinceContact)
 *   - `signal-inference.ts:388` (outbound dedup)
 *   - `voice-dna-extract.ts:153` (coordinator-voice corpus filter)
 *   - `intel/clients/[id]` thread view
 *
 * This backfill writes the missing pair PER historical `drafts.auto_sent=true`
 * row:
 *   (1) a legacy `interactions` row — byte-identical to the going-forward
 *       shape in `flushPendingAutoSends` (pipeline.ts:4977-4990).
 *   (2) a cascade `linkSignal` call — same shape M6/M7/C3 use
 *       (`actionType:'venue_sent'`, `signalTier:'medium'`).
 *
 * VERIFY-THEN-BUILD: every shape decision in this script is sourced
 * from the actual code. See "VERIFIED SHAPE FACTS" below.
 *
 * SAFETY
 * ------
 * - service_role key is read from `process.env.BRANCH_KEY` — NEVER
 *   written into this file.
 * - Refuses to run against the prod project ref `jsxxgwprxuqgcauzlxcb`
 *   (mirror of `verify-m1-binding.ts` / `verify-m8-coverage.ts`).
 * - Default mode is DRY-RUN. `--apply` is required for any write.
 * - Idempotent: re-runs after the first successful apply write 0 rows
 *   (see "IDEMPOTENCY KEY" below).
 * - Per-draft try/catch — one draft's failure never aborts the batch.
 *
 * USAGE
 * -----
 *   BRANCH_URL=https://<ref>.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/backfill-autosend-interactions.ts                 # dry-run, all venues
 *   npx tsx scripts/backfill-autosend-interactions.ts --venue=<uuid>  # dry-run, scoped
 *   npx tsx scripts/backfill-autosend-interactions.ts --apply         # actually write
 *
 * VERIFIED SHAPE FACTS (read before edits, per VERIFY-THEN-BUILD)
 * ---------------------------------------------------------------
 * 1. `drafts` columns the backfill relies on (mig 002 + 067 + 072 + 128):
 *      id (uuid), venue_id (uuid), wedding_id (uuid|null),
 *      interaction_id (uuid|null)  -- the PARENT inbound the draft replies to
 *      to_email (text), subject (text), draft_body (text),
 *      status (text), auto_sent (boolean DEFAULT false),
 *      approved_at (timestamptz),
 *      sent_at (timestamptz)       -- mig 072 (the only "when did this go out")
 *      correlation_id (text)       -- mig 128 (inbound-event correlation)
 *
 *    CRITICAL — `drafts` has NO `gmail_message_id` column. The Gmail
 *    message id returned by `sendEmail` is captured ONLY on the going-
 *    forward `interactions` insert (pipeline.ts:4986). Historical
 *    autosends have NO recoverable `gmail_message_id` for the outbound
 *    leg. See "HONEST GAPS" below.
 *
 * 2. Going-forward outbound `interactions` shape (pipeline.ts:4977-4990,
 *    post-307ffd6) — the backfill writes byte-identical rows except for
 *    the irrecoverable `gmail_message_id`:
 *      {
 *        venue_id, wedding_id: null, type: 'email',
 *        direction: 'outbound', subject, body_preview (first 300 chars),
 *        full_body, to_email, gmail_message_id, gmail_thread_id: null,
 *        timestamp, signal_class: 'unclassified',
 *        [correlation_id if present]
 *      }
 *
 * 3. Going-forward cascade call shape (pipeline.ts:5011-5044):
 *      linkSignal({
 *        supabase, venueId,
 *        signal: emailToNormalizedSignal({
 *          email: { messageId, threadId, subject },
 *          interactionId, emailDate,
 *          rawFromName: null, rawFromEmail: null,
 *          draftId, weddingId: parentWeddingId,
 *          actionType: 'venue_sent', signalTier: 'medium',
 *        }),
 *        correlationId, source: 'live:autosend_flush',
 *      })
 *    Backfill uses `source: 'backfill:autosend'` so live vs. backfilled
 *    touchpoints are distinguishable in `link_decisions` telemetry.
 *
 * 4. `email-to-signal.ts` sets `external_id = email.messageId ?? interactionId`.
 *    Since historical drafts have no recoverable `messageId`, the cascade
 *    touchpoint's `external_id` falls back to the newly-created
 *    `interactionId`. This is consistent with the M1 verification model
 *    (`raw_payload.interaction_id` is the durable join key).
 *
 * IDEMPOTENCY KEY (chosen + why)
 * ------------------------------
 * The link from `drafts` to its outbound `interactions` row is NOT
 * stored as a column on either table (interactions has no `draft_id`;
 * drafts has no `gmail_message_id`). The going-forward code carries
 * the link only via:
 *   - shared `correlation_id` (when both are non-null), and
 *   - shared `full_body` + outbound + venue + timestamp proximity
 *
 * Chain (cheap → expensive):
 *   (A) PRIMARY: `interactions.correlation_id = draft.correlation_id`
 *       AND `direction='outbound'` AND `venue_id=draft.venue_id`. This
 *       is the going-forward shape (pipeline.ts:4991) and is indexed
 *       (mig 128 idx_drafts_correlation_id — drafts side; interactions
 *       side relies on the existing venue_id+direction filter cost).
 *       Skips drafts where correlation_id is null on either side.
 *   (B) FALLBACK: `interactions.full_body = draft.draft_body`
 *       AND `direction='outbound'`
 *       AND `venue_id=draft.venue_id`
 *       AND `to_email = draft.to_email`
 *       AND `timestamp` within ±10min of `draft.sent_at` (or approved_at).
 *       Body equality is the strongest signal short of an id (draft
 *       bodies are typically multi-paragraph; collision risk is low).
 *
 * False-positive risk: if a coordinator manually sent a verbatim copy
 * of an auto-drafted body (e.g. operator rejected the auto-send, then
 * later approved a clone), the fallback could match the wrong row. We
 * accept this — the cost is "no backfill row written" (idempotent skip),
 * NOT "wrong data written". Safer than the dual.
 *
 * Why not match on `gmail_message_id`: drafts don't store one. That's
 * the irrecoverable bit.
 *
 * HONEST GAPS
 * -----------
 * - Drafts with no recoverable Gmail message id (ALL historical autosends):
 *   the backfilled `interactions.gmail_message_id` will be NULL. The
 *   cascade touchpoint's `external_id` falls back to the interaction id.
 *   Downstream readers (`follow-up-sequences`, `signal-inference`,
 *   `voice-dna-extract`, thread view) do NOT key on gmail_message_id;
 *   they query by `direction='outbound' + venue_id + timestamp`, so
 *   the gap is information-only.
 *
 * - Drafts with `auto_sent=true` but `sent_at` AND `approved_at` BOTH
 *   null: no recoverable send-time. The script LOGS these and SKIPS
 *   them (cannot synthesize a timestamp without lying). Counted in the
 *   "skipped:no_timestamp" bucket.
 *
 * - Drafts where the parent `interaction_id` is null OR the parent
 *   interaction has been deleted: the backfill still writes the legacy
 *   `interactions` row (with `wedding_id:null`, matching M7's shape),
 *   and the cascade call resolves identity without the wedding hint.
 *   This is the same degradation path the going-forward code uses
 *   (pipeline.ts:4964-4971 "parent-context lookup is best-effort").
 *
 * - Drafts with `auto_sent=true` whose existing `interactions` row
 *   was written by some OTHER mechanism (e.g. a hand-merge, an earlier
 *   ad-hoc backfill): the PRIMARY/FALLBACK match treats them as
 *   already-covered and skips. Counted in "already_backfilled".
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROD_REF = 'jsxxgwprxuqgcauzlxcb'
const PAGE = 1000
/** Fallback timestamp tolerance for the body-equality match. */
const FALLBACK_TIME_TOLERANCE_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// Types — mirror the verified column lists, nothing more.
// ---------------------------------------------------------------------------

interface DraftRow {
  id: string
  venue_id: string
  wedding_id: string | null
  interaction_id: string | null
  to_email: string | null
  subject: string | null
  draft_body: string
  status: string
  auto_sent: boolean
  approved_at: string | null
  sent_at: string | null
  correlation_id: string | null
}

interface ExistingOutboundRow {
  id: string
  full_body: string | null
  to_email: string | null
  timestamp: string | null
  correlation_id: string | null
}

interface ParentInteractionRow {
  wedding_id: string | null
  correlation_id: string | null
  gmail_thread_id: string | null
}

interface CliArgs {
  apply: boolean
  venueId: string | null
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(): CliArgs {
  const apply = process.argv.includes('--apply')
  const venueArg = process.argv.find((a) => a.startsWith('--venue='))
  const venueId = venueArg ? venueArg.slice('--venue='.length) : null
  if (venueId && !/^[0-9a-f-]{36}$/i.test(venueId)) {
    console.error(`ERROR: --venue must be a UUID (got "${venueId}")`)
    process.exit(1)
  }
  return { apply, venueId }
}

// ---------------------------------------------------------------------------
// Paginated fetch helper (shared shape with verify-m1-binding.ts).
// ---------------------------------------------------------------------------

async function fetchAll<T>(
  label: string,
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = data ?? []
    out.push(...batch)
    if (batch.length < PAGE) break
    from += PAGE
  }
  return out
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/**
 * Returns the id of the existing outbound `interactions` row that
 * corresponds to this auto-sent draft, or null if no match.
 *
 * Two-stage chain (see IDEMPOTENCY KEY note above):
 *   (A) correlation_id equality (cheap, exact)
 *   (B) full_body + to_email + venue + timestamp ±10min
 */
async function findExistingOutbound(
  supabase: SupabaseClient,
  draft: DraftRow,
): Promise<{ id: string; matchedBy: 'correlation_id' | 'body_window' } | null> {
  // Stage A — correlation_id (only when both sides carry one).
  if (draft.correlation_id) {
    const { data, error } = await supabase
      .from('interactions')
      .select('id')
      .eq('venue_id', draft.venue_id)
      .eq('direction', 'outbound')
      .eq('correlation_id', draft.correlation_id)
      .limit(1)
    if (error) {
      console.warn(
        `[backfill] correlation_id check failed for draft ${draft.id}: ${error.message}`,
      )
    } else if (data && data.length > 0) {
      return { id: data[0].id as string, matchedBy: 'correlation_id' }
    }
  }

  // Stage B — body window. Needs a usable send timestamp.
  const sentAt = draft.sent_at ?? draft.approved_at
  if (!sentAt || !draft.to_email) return null
  const sentMs = new Date(sentAt).getTime()
  if (!Number.isFinite(sentMs)) return null
  const lo = new Date(sentMs - FALLBACK_TIME_TOLERANCE_MS).toISOString()
  const hi = new Date(sentMs + FALLBACK_TIME_TOLERANCE_MS).toISOString()

  const { data, error } = await supabase
    .from('interactions')
    .select('id, full_body, to_email, timestamp, correlation_id')
    .eq('venue_id', draft.venue_id)
    .eq('direction', 'outbound')
    .eq('to_email', draft.to_email)
    .gte('timestamp', lo)
    .lte('timestamp', hi)
    .limit(20)
  if (error) {
    console.warn(
      `[backfill] body-window check failed for draft ${draft.id}: ${error.message}`,
    )
    return null
  }
  for (const row of (data ?? []) as ExistingOutboundRow[]) {
    if (row.full_body === draft.draft_body) {
      return { id: row.id, matchedBy: 'body_window' }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Parent-context lookup (best-effort, mirrors pipeline.ts:4948-4972)
// ---------------------------------------------------------------------------

async function loadParentContext(
  supabase: SupabaseClient,
  draft: DraftRow,
): Promise<{
  parentWeddingId: string | null
  parentCorrelationId: string | null
  parentThreadId: string | null
}> {
  if (!draft.interaction_id) {
    return {
      parentWeddingId: null,
      parentCorrelationId: draft.correlation_id ?? null,
      parentThreadId: null,
    }
  }
  try {
    const { data } = await supabase
      .from('interactions')
      .select('wedding_id, correlation_id, gmail_thread_id')
      .eq('id', draft.interaction_id)
      .maybeSingle<ParentInteractionRow>()
    return {
      parentWeddingId: data?.wedding_id ?? null,
      // Prefer the parent's correlation_id (matches the live path), fall
      // back to the draft's correlation_id (mig 128 puts it on drafts too).
      parentCorrelationId: data?.correlation_id ?? draft.correlation_id ?? null,
      parentThreadId: data?.gmail_thread_id ?? null,
    }
  } catch (err) {
    console.warn(
      `[backfill] parent-context lookup failed for draft ${draft.id}:`,
      err instanceof Error ? err.message : err,
    )
    return {
      parentWeddingId: null,
      parentCorrelationId: draft.correlation_id ?? null,
      parentThreadId: null,
    }
  }
}

// ---------------------------------------------------------------------------
// Per-draft backfill (dry-run + apply)
// ---------------------------------------------------------------------------

interface BackfillStats {
  total: number
  alreadyByCorrelation: number
  alreadyByBodyWindow: number
  needBackfill: number
  skippedNoTimestamp: number
  wroteInteraction: number
  wroteCascade: number
  failedInteraction: number
  failedCascade: number
}

async function backfillOne(
  supabase: SupabaseClient,
  draft: DraftRow,
  apply: boolean,
  stats: BackfillStats,
): Promise<void> {
  stats.total++

  // No usable send timestamp → cannot synthesize, skip.
  const sentAt = draft.sent_at ?? draft.approved_at
  if (!sentAt) {
    stats.skippedNoTimestamp++
    console.log(
      `[backfill] SKIP draft ${draft.id} venue ${draft.venue_id} — no sent_at / approved_at`,
    )
    return
  }

  // Idempotency check.
  const existing = await findExistingOutbound(supabase, draft)
  if (existing) {
    if (existing.matchedBy === 'correlation_id') stats.alreadyByCorrelation++
    else stats.alreadyByBodyWindow++
    return
  }
  stats.needBackfill++

  const ctx = await loadParentContext(supabase, draft)

  // (1) Legacy interactions row — byte-identical to pipeline.ts:4977-4990
  //     except `gmail_message_id` is null (irrecoverable) and
  //     `gmail_thread_id` is borrowed from the parent inbound if known.
  const outboundPayload: Record<string, unknown> = {
    venue_id: draft.venue_id,
    wedding_id: null,
    type: 'email',
    direction: 'outbound',
    subject: draft.subject,
    body_preview: draft.draft_body.slice(0, 300),
    full_body: draft.draft_body,
    to_email: draft.to_email,
    gmail_message_id: null,
    gmail_thread_id: ctx.parentThreadId,
    timestamp: sentAt,
    signal_class: 'unclassified',
  }
  if (ctx.parentCorrelationId) outboundPayload.correlation_id = ctx.parentCorrelationId

  if (!apply) {
    console.log(
      `[backfill] DRY-RUN would write: draft=${draft.id} venue=${draft.venue_id} ` +
        `to=${draft.to_email ?? 'null'} sent=${sentAt} ` +
        `parent_wedding=${ctx.parentWeddingId ?? 'none'} ` +
        `parent_corr=${ctx.parentCorrelationId ?? 'none'}`,
    )
    return
  }

  // APPLY MODE — actually insert.
  let outboundInteractionId: string | null = null
  try {
    const { data, error } = await supabase
      .from('interactions')
      .insert(outboundPayload)
      .select('id')
      .single()
    if (error) throw error
    outboundInteractionId = (data?.id as string | null) ?? null
    if (outboundInteractionId) stats.wroteInteraction++
  } catch (err) {
    stats.failedInteraction++
    console.error(
      `[backfill] FAILED legacy insert for draft ${draft.id}:`,
      err instanceof Error ? err.message : err,
    )
    return
  }

  // (2) Cascade linkSignal — same shape as M6/M7/C3 going-forward.
  //     Source tag 'backfill:autosend' so live vs. backfilled
  //     touchpoints are distinguishable in `link_decisions` telemetry.
  if (!outboundInteractionId) return
  try {
    const { linkSignal } = await import('@/lib/services/identity/forwards-linker')
    const { emailToNormalizedSignal } = await import('@/lib/services/identity/email-to-signal')
    const linkResult = await linkSignal({
      supabase,
      venueId: draft.venue_id,
      signal: emailToNormalizedSignal({
        email: {
          // Historical drafts have no recoverable messageId — the adapter
          // falls back to external_id = interactionId.
          messageId: null,
          threadId: ctx.parentThreadId,
          subject: draft.subject ?? null,
        },
        interactionId: outboundInteractionId,
        emailDate: sentAt,
        // Outbound: no inbound sender identity. Couple resolved via
        // parent wedding anchor hint (same as going-forward C3).
        rawFromName: null,
        rawFromEmail: null,
        draftId: draft.id,
        weddingId: ctx.parentWeddingId,
        actionType: 'venue_sent',
        signalTier: 'medium',
      }),
      correlationId: ctx.parentCorrelationId ?? undefined,
      source: 'backfill:autosend',
    })
    stats.wroteCascade++
    console.log(
      `[backfill] WROTE draft=${draft.id} interaction=${outboundInteractionId} ` +
        `cascade action=${linkResult.action} couple=${linkResult.matched_couple_id ?? 'none'} ` +
        `touchpoint=${linkResult.touchpoint_id ?? 'none'}`,
    )
  } catch (err) {
    stats.failedCascade++
    console.error(
      `[backfill] FAILED cascade for draft ${draft.id} interaction ${outboundInteractionId}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { apply, venueId } = parseArgs()

  const url = process.env.BRANCH_URL
  const key = process.env.BRANCH_KEY
  if (!url || !key) {
    console.error(
      'ERROR: BRANCH_URL and BRANCH_KEY must be set in the environment.\n' +
        'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> ' +
        'npx tsx scripts/backfill-autosend-interactions.ts',
    )
    process.exit(1)
  }
  // Operator guard — refuse production.
  if (url.includes(PROD_REF)) {
    console.error(
      `ERROR: BRANCH_URL points at the production project ref (${PROD_REF}). Refusing.`,
    )
    process.exit(1)
  }

  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false },
  })

  console.log('='.repeat(78))
  console.log('AUTOSEND-INTERACTIONS BACKFILL')
  console.log('='.repeat(78))
  console.log(`Target DB   : ${url}`)
  console.log(`Mode        : ${apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`)
  console.log(`Venue scope : ${venueId ?? 'ALL VENUES'}`)
  console.log('')

  // -------------------------------------------------------------------------
  // 1. Pull every auto-sent draft.
  // -------------------------------------------------------------------------
  const drafts = await fetchAll<DraftRow>('drafts', (from, to) => {
    let q = supabase
      .from('drafts')
      .select(
        'id, venue_id, wedding_id, interaction_id, to_email, subject, ' +
          'draft_body, status, auto_sent, approved_at, sent_at, correlation_id',
      )
      .eq('auto_sent', true)
      .order('sent_at', { ascending: true })
      .range(from, to)
    if (venueId) q = q.eq('venue_id', venueId)
    // Cast around the PostgrestFilterBuilder's typed-column inference;
    // verify-m1-binding.ts hits the same client unconditionally and its
    // single ascending order keeps the inferred type compatible.
    return q as unknown as PromiseLike<{
      data: DraftRow[] | null
      error: { message: string } | null
    }>
  })

  console.log(`[1] auto_sent=true drafts in scope: ${drafts.length}`)
  if (drafts.length === 0) {
    console.log('Nothing to backfill.')
    return
  }
  console.log('')

  // -------------------------------------------------------------------------
  // 2. Per-draft check + (apply only) write.
  // -------------------------------------------------------------------------
  const stats: BackfillStats = {
    total: 0,
    alreadyByCorrelation: 0,
    alreadyByBodyWindow: 0,
    needBackfill: 0,
    skippedNoTimestamp: 0,
    wroteInteraction: 0,
    wroteCascade: 0,
    failedInteraction: 0,
    failedCascade: 0,
  }

  for (const draft of drafts) {
    try {
      await backfillOne(supabase, draft, apply, stats)
    } catch (err) {
      console.error(
        `[backfill] uncaught error processing draft ${draft.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // -------------------------------------------------------------------------
  // 3. Report.
  // -------------------------------------------------------------------------
  const pct = (n: number, d: number) =>
    d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`

  console.log('')
  console.log('-'.repeat(78))
  console.log('SUMMARY')
  console.log('-'.repeat(78))
  console.log(`  total auto_sent=true drafts            : ${stats.total}`)
  console.log(
    `  already covered (correlation_id match) : ${stats.alreadyByCorrelation} ` +
      `(${pct(stats.alreadyByCorrelation, stats.total)})`,
  )
  console.log(
    `  already covered (body+window match)    : ${stats.alreadyByBodyWindow} ` +
      `(${pct(stats.alreadyByBodyWindow, stats.total)})`,
  )
  console.log(
    `  need backfill                          : ${stats.needBackfill} ` +
      `(${pct(stats.needBackfill, stats.total)})`,
  )
  console.log(
    `  skipped (no sent_at / approved_at)     : ${stats.skippedNoTimestamp} ` +
      `(${pct(stats.skippedNoTimestamp, stats.total)})`,
  )
  console.log('')
  if (apply) {
    console.log('  APPLY MODE — writes attempted:')
    console.log(`    legacy interactions inserted        : ${stats.wroteInteraction}`)
    console.log(`    cascade linkSignal calls            : ${stats.wroteCascade}`)
    console.log(`    legacy insert failures              : ${stats.failedInteraction}`)
    console.log(`    cascade failures                    : ${stats.failedCascade}`)
  } else {
    console.log('  DRY-RUN — no writes. Re-run with --apply to backfill.')
  }
  console.log('='.repeat(78))
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
