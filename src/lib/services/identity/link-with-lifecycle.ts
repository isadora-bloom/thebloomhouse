/**
 * Phase 1 Batch 2 — Pbatch2-8: linkSignal + per-channel lifecycle dispatch.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-8 v2.
 *
 * Why this file exists
 * --------------------
 * Three adapter flips (SMS / OpenPhone / Zoom) need to call `linkSignal`
 * AND the right per-channel lifecycle helper. Pre-Batch-2:
 *
 *   - Twilio webhook       calls `recordSmsLifecycleSignal`         ✓
 *   - OpenPhone cron       does NOT                                  ✗  (same SMS, different bookkeeping)
 *   - Zoom cron            does NOT call `recordZoomLifecycleSignal` ✗  (helper defined, never invoked)
 *
 * The Batch-2 flips add `linkSignal` to all three call sites. Those
 * sites need a uniform way to ALSO fire the matching lifecycle helper.
 *
 * Design choice: wrapper, not hook
 * --------------------------------
 * `linkSignal` currently has NO post-route hook surface (verified
 * 2026-05-26 against `forwards-linker.ts` — the function returns
 * directly after `emitLinkEvent`, no extension points). Building a
 * generic hook system (hook API + per-channel registration + CI guard
 * that every signal-builder routes through it) is correct-shaped but
 * expensive for a three-call-site problem.
 *
 * Wrapper pattern: NEW shared helper that each Batch-2 flip uses
 * INSTEAD of bare `linkSignal`. Existing Batch-1 callers keep using
 * bare `linkSignal` — this is NET-ADDITIVE. Calendly + HoneyBook flips
 * also keep using bare `linkSignal` (no lifecycle dispatch needed for
 * those channels).
 *
 * Lifecycle dispatch table
 * ------------------------
 *   channel='sms'                  → recordSmsLifecycleSignal  (if legacy_wedding_id set)
 *   channel='zoom'                 → recordZoomLifecycleSignal (if legacy_wedding_id set)
 *   channel='phone' | 'voicemail'  → no dispatch (see REVIEW Pbatch2-8 below)
 *   channel='gmail' | 'calendly' | 'honeybook' | anything else → no dispatch
 *
 * REVIEW Pbatch2-8 — phone/voicemail lifecycle coverage gap
 * ---------------------------------------------------------
 * The `wedding_lifecycle_events` table is free-form on its `kind`
 * column, BUT `recordSmsLifecycleSignal` is named + documented as
 * SMS-specific and stamps `evidence.source='twilio'`. Reusing it for
 * `phone`/`voicemail` would either (a) lie about the source or
 * (b) require modifying `state-machine.ts` (out of scope per Pbatch2-8
 * constraints).
 *
 * Decision: phone/voicemail flips DO call linkSignal (so the cascade
 * runs) but do NOT call a lifecycle helper. Lifecycle coverage for
 * voice signals is a follow-up: either (a) a new
 * `recordVoiceLifecycleSignal` in state-machine.ts, or (b) extending
 * `recordSmsLifecycleSignal` to accept a `channel: 'sms' | 'phone' |
 * 'voicemail'` arg and dispatch `kind` + `evidence.source` accordingly.
 * Both are state-machine.ts edits; Pbatch2-8 leaves them as a tracked
 * gap rather than half-shipping the wrong shape.
 *
 * Fire-and-forget semantics
 * -------------------------
 * The lifecycle dispatch is wrapped in its OWN try/catch and run AFTER
 * `linkSignal` returns. The wrapper NEVER blocks the LinkResult on
 * lifecycle failure — that matches the existing Twilio call-site
 * pattern (webhooks/twilio/route.ts:410 `void (async () => { ... })()`).
 * If the lifecycle write fails, we log a warn and return the linkSignal
 * result anyway.
 *
 * Multi-venue safety
 * ------------------
 * Every dispatch passes `venueId` from the wrapper args explicitly.
 * The lifecycle helpers themselves filter by venueId on every DB
 * operation. There is no path where a wedding-id from venue A could
 * cause a lifecycle write against venue B's row — the helper's UPDATE
 * uses `weddingId` from the signal, which the cascade already
 * resolved against venueId.
 *
 * No spine writes here
 * --------------------
 * This file is a dispatcher, not a chokepoint. It calls `linkSignal`
 * (which IS the chokepoint) and lifecycle helpers (which write
 * `wedding_lifecycle_events` + bump `weddings.first_response_at`,
 * neither guarded by check-cascade-only-writer.mjs). No need to add
 * this file to CHOKEPOINT_FILES.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  linkSignal,
  type LinkSignalArgs,
  type LinkResult,
} from './forwards-linker'
import {
  recordSmsLifecycleSignal,
  recordZoomLifecycleSignal,
} from '@/lib/services/lifecycle/state-machine'

// ---------------------------------------------------------------------------
// Per-channel dispatchers. Each returns a promise of void; the wrapper
// fire-and-forgets after awaiting (errors land in the inner try/catch
// inside the helper itself, but we belt-and-brace).
// ---------------------------------------------------------------------------

async function dispatchSmsLifecycle(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  args: LinkSignalArgs,
): Promise<void> {
  // sms-to-signal.ts encodes direction via action_type ('sms_inbound'
  // vs 'sms_outbound') and re-stamps the raw direction in raw_payload.
  // Prefer raw_payload.direction (explicit) and fall back to action_type
  // for resilience against future builder variants.
  const rawDirection =
    typeof args.signal.raw_payload?.direction === 'string'
      ? (args.signal.raw_payload.direction as string)
      : null
  const direction: 'inbound' | 'outbound' =
    rawDirection === 'outbound'
      ? 'outbound'
      : rawDirection === 'inbound'
        ? 'inbound'
        : args.signal.action_type === 'sms_outbound'
          ? 'outbound'
          : 'inbound'

  // raw_payload.full_body is the canonical body field from sms-to-signal.
  const body =
    typeof args.signal.raw_payload?.full_body === 'string'
      ? (args.signal.raw_payload.full_body as string)
      : ''

  await recordSmsLifecycleSignal({
    supabase,
    venueId,
    weddingId,
    direction,
    body,
  })
}

async function dispatchZoomLifecycle(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  args: LinkSignalArgs,
): Promise<void> {
  // zoom-to-signal sets occurred_at to the meeting start_time. The
  // lifecycle helper accepts that ISO string directly.
  const meetingStartTime: string | null = args.signal.occurred_at ?? null
  await recordZoomLifecycleSignal({
    supabase,
    venueId,
    weddingId,
    meetingStartTime,
  })
}

// ---------------------------------------------------------------------------
// Public entry: wrapper around linkSignal that also dispatches the
// matching lifecycle helper after linkSignal returns.
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for `linkSignal` that adds per-channel lifecycle
 * dispatch. Returns the same `LinkResult` shape as `linkSignal`.
 *
 * - Always calls `linkSignal(args)` and returns its result (or throws
 *   the same errors `linkSignal` throws).
 * - For SMS / Zoom signals carrying `legacy_wedding_id`, ALSO fires the
 *   matching lifecycle helper after linkSignal completes. Lifecycle
 *   failures are swallowed (warn-logged) and never affect the returned
 *   LinkResult.
 * - For all other channels (or SMS/Zoom signals without
 *   `legacy_wedding_id`), behaves exactly like bare `linkSignal`.
 *
 * Batch-1 callers should keep using `linkSignal`. Use this wrapper at
 * the three Batch-2 SMS/Zoom flip sites (Twilio webhook, OpenPhone
 * cron SMS branch, Zoom cron). Phone/voicemail Batch-2 flips can use
 * this wrapper too — the dispatcher will simply skip the lifecycle
 * call until Pbatch2-8's REVIEW gap is closed.
 */
export async function linkSignalWithLifecycle(
  args: LinkSignalArgs,
): Promise<LinkResult> {
  const result = await linkSignal(args)

  // Lifecycle dispatch ONLY when the signal anchored to a legacy
  // wedding (either via legacy_wedding_id fast path OR via tier=high
  // matched_couple_id mapped back through the legacy mirror). The
  // legacy_wedding_id check is the cheap conservative gate — the
  // lifecycle helpers themselves write the wedding-keyed table, so
  // without a wedding id there is nothing to write.
  const weddingId = args.signal.legacy_wedding_id ?? null
  if (!weddingId) return result

  // Fire-and-forget per-channel dispatch. Each helper has its own
  // try/catch + warn; this outer guard protects against an unhandled
  // throw bubbling up and contaminating the linkSignal return.
  try {
    const channel = args.signal.channel
    if (channel === 'sms') {
      await dispatchSmsLifecycle(args.supabase, args.venueId, weddingId, args)
    } else if (channel === 'zoom') {
      await dispatchZoomLifecycle(args.supabase, args.venueId, weddingId, args)
    } else if (channel === 'phone' || channel === 'voicemail') {
      // REVIEW Pbatch2-8: no lifecycle helper exists for voice signals
      // yet. Tracked gap — see file header. Skipping is the correct
      // shape today; voice signals still get a touchpoint via the
      // linkSignal call above. Lifecycle coverage requires a
      // state-machine.ts edit (out of Pbatch2-8 scope).
    } else {
      // gmail / calendly / honeybook / knot / instagram / web / review /
      // ... — no per-channel lifecycle dispatch. The email pipeline
      // owns Gmail lifecycle independently; Calendly / HoneyBook
      // lifecycle is derived from their respective sweepers.
    }
  } catch (err) {
    // Lifecycle dispatch failures NEVER affect the LinkResult. Match
    // the existing Twilio call-site pattern that swallows the same
    // error class today.
    // eslint-disable-next-line no-console
    console.warn(
      '[link-with-lifecycle] dispatch failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  return result
}

// Re-export the underlying types so call sites that import this file
// don't also need to import from forwards-linker. Keeps the wrapper
// site's import footprint to a single path.
export type { LinkSignalArgs, LinkResult } from './forwards-linker'
