/**
 * Phase 1 Batch 2 — Pbatch2-2: shared raw_payload base shape.
 *
 * Anchor: PHASE-1-BATCH-2.md §2 Pbatch2-2.
 *
 * Downstream readers of `touchpoints.raw_payload` (most notably
 * `judge-context.ts:33-52`'s SNIPPET_FIELDS scan) probe a fixed
 * list of fields by name. Today each adapter shapes its raw_payload
 * differently — gmail uses `subject` + `body_preview`, calendly uses
 * `calendly_uri` + `scheduled_at`, sms/voice/zoom none-of-the-above —
 * which makes the snippet probe a per-channel guess.
 *
 * `BaseRawPayload` is the common slot layout every builder should
 * conform to. Channel-specific extras are merged in via
 * `mergeRawPayload`. The slots match SNIPPET_FIELDS so the judge's
 * timeline-snippet probe finds *something* on every channel.
 *
 * Pure: no DB / network.
 */

export interface BaseRawPayload {
  /** Probed by judge-context SNIPPET_FIELDS first. */
  subject?: string | null
  /** Probed second; primary body slot for chat-style channels. */
  body_preview?: string | null
  /** Channel-native thread/conversation id (gmail thread, sms
   *  conversation, zoom meeting series). */
  thread_id?: string | null
  /** Operator-clickable canonical URL (calendly event uri, zoom
   *  recording link, honeybook project page). */
  external_url?: string | null
  /** Legacy interactions.id when the writer also creates one. Lets
   *  the spine row point back to the inbox row. */
  interaction_id?: string | null
}

/** Channel-specific extras live alongside the base slots. */
export function mergeRawPayload(
  base: BaseRawPayload,
  channelExtras: Record<string, unknown>,
): Record<string, unknown> {
  // Drop undefined values from the base so the payload is JSON-clean
  // (`JSON.stringify` keeps `null` but drops `undefined`; we prefer
  // explicit `null` so the GIN index reflects "field exists, no value").
  const merged: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) merged[k] = v
  }
  for (const [k, v] of Object.entries(channelExtras)) {
    if (v !== undefined) merged[k] = v
  }
  return merged
}
