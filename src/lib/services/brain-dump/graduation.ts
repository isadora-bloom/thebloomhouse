/**
 * Brain-dump pattern graduation (T4-E / Playbook Part 20.5).
 *
 * When a coordinator confirms the same brain-dump shape >=3 times,
 * the system surfaces a "remember this rule?" prompt. Confirmed
 * rules become brain_dump_pattern_grants rows that future entries
 * with a matching pattern_signature can auto-route through without
 * the per-instance propose-and-confirm round-trip.
 *
 * Pattern signature is a stable FNV-1a hash of (intent + parser-
 * output shape). Same intent + same parsed-payload-shape = same
 * signature. Hash collision risk is acceptable for grant-keying;
 * the grant carries description + intent so a coordinator can spot
 * mis-routed grants.
 *
 * This module is the read+write side. Auto-routing decisions live
 * in /api/brain-dump/[id]/resolve (and brain-dump.ts proper) — both
 * call hasActivePatternGrant() before triggering propose-and-confirm.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const REPEAT_THRESHOLD = 3  // 3 confirmations before graduation prompt fires

/**
 * Stable signature for the parsed brain-dump shape. Mirrors
 * insights/confidence.ts buildCacheKey (FNV-1a 32-bit, hex). Intent
 * + payload-shape are the only inputs — actual content (note body,
 * email addresses) is excluded so unrelated occurrences of the
 * same shape collide deterministically.
 */
export function patternSignature(args: {
  intent: string
  /** Sorted-key shape descriptor — keys present in the parser output,
   *  not their values. e.g. {clientNote: true, weddingId: true} for a
   *  client_note targeting a known couple. */
  shape: Record<string, boolean>
}): string {
  const sortedShape = Object.keys(args.shape)
    .sort()
    .filter((k) => args.shape[k])
    .join('|')
  const composite = `${args.intent}::${sortedShape}`
  let h = 0x811c9dc5
  for (let i = 0; i < composite.length; i++) {
    h ^= composite.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export interface GraduationCheckResult {
  /** Number of confirmed entries with this signature (lifetime, this venue). */
  confirmedCount: number
  /** True when count >= REPEAT_THRESHOLD AND no active grant exists. */
  shouldOfferGraduation: boolean
  /** Existing grant if one is already active (auto-route path). */
  activeGrantId: string | null
}

/**
 * Check whether a freshly-confirmed entry should trigger a
 * "remember this rule?" graduation prompt.
 */
export async function evaluateGraduation(
  supabase: SupabaseClient,
  venueId: string,
  signature: string,
): Promise<GraduationCheckResult> {
  if (!signature) {
    return { confirmedCount: 0, shouldOfferGraduation: false, activeGrantId: null }
  }

  // Active grant check first — if one already exists, no graduation
  // prompt needed (coordinator already opted in). Migration 248 added
  // is_active; we filter on that for forward compatibility with future
  // soft-pause UX while keeping the revoked_at filter as belt-and-
  // suspenders for any legacy rows that may have only the timestamp set.
  const { data: grant } = await supabase
    .from('brain_dump_pattern_grants')
    .select('id')
    .eq('venue_id', venueId)
    .eq('pattern_signature', signature)
    .eq('is_active', true)
    .is('revoked_at', null)
    .maybeSingle()
  if (grant?.id) {
    return { confirmedCount: 0, shouldOfferGraduation: false, activeGrantId: grant.id as string }
  }

  // Count confirmed entries with this signature.
  const { count } = await supabase
    .from('brain_dump_entries')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('pattern_signature', signature)
    .eq('parse_status', 'confirmed')
  const confirmedCount = count ?? 0

  return {
    confirmedCount,
    shouldOfferGraduation: confirmedCount >= REPEAT_THRESHOLD,
    activeGrantId: null,
  }
}

export interface GrantPatternArgs {
  venueId: string
  signature: string
  description: string
  intent: string
  routedTable?: string | null
  routedAction?: string | null
  grantedBy: string | null
}

/**
 * Coordinator confirms graduation: persist the standing rule.
 * Idempotent on (venue_id, pattern_signature) where revoked_at IS NULL.
 */
export async function grantPattern(
  supabase: SupabaseClient,
  args: GrantPatternArgs,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  // Re-check for existing active grant (race window between
  // evaluateGraduation and grantPattern call). is_active gate per
  // migration 248.
  const { data: existing } = await supabase
    .from('brain_dump_pattern_grants')
    .select('id')
    .eq('venue_id', args.venueId)
    .eq('pattern_signature', args.signature)
    .eq('is_active', true)
    .is('revoked_at', null)
    .maybeSingle()
  if (existing?.id) return { ok: true, id: existing.id as string }

  const { data, error } = await supabase
    .from('brain_dump_pattern_grants')
    .insert({
      venue_id: args.venueId,
      pattern_signature: args.signature,
      description: args.description.slice(0, 240),
      intent: args.intent,
      routed_table: args.routedTable ?? null,
      routed_action: args.routedAction ?? null,
      granted_by: args.grantedBy,
    })
    .select('id')
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? 'insert failed' }
  return { ok: true, id: data.id as string }
}

/**
 * Coordinator revokes a grant from /agent/brain-dump/grants (or the
 * legacy /settings/brain-dump-log surface). Future entries with this
 * signature go back to propose-and-confirm.
 *
 * Per Bug 6 / migration 248: revoke flips is_active=false AND stamps
 * revoked_at + revoked_by. Audit row is preserved (no DELETE) so the
 * coordinator can see who revoked when, and the trigger in 248 syncs
 * is_active down if a legacy caller updates revoked_at alone.
 */
export async function revokePatternGrant(
  supabase: SupabaseClient,
  args: { grantId: string; revokedBy: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('brain_dump_pattern_grants')
    .update({
      is_active: false,
      revoked_at: new Date().toISOString(),
      revoked_by: args.revokedBy,
    })
    .eq('id', args.grantId)
    .eq('is_active', true)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Auto-route check: does an active grant cover this signature?
 * Increments hit_count + last_used_at on hit so a coordinator can
 * see grant usage in the audit log.
 */
export async function consumeGrantIfActive(
  supabase: SupabaseClient,
  venueId: string,
  signature: string,
): Promise<{ id: string; intent: string; routedTable: string | null; routedAction: string | null } | null> {
  const { data } = await supabase
    .from('brain_dump_pattern_grants')
    .select('id, intent, routed_table, routed_action, hit_count')
    .eq('venue_id', venueId)
    .eq('pattern_signature', signature)
    .eq('is_active', true)
    .is('revoked_at', null)
    .maybeSingle()
  if (!data?.id) return null

  // Fire-and-forget hit-count bump. Stale on race is acceptable
  // for telemetry.
  void supabase
    .from('brain_dump_pattern_grants')
    .update({
      hit_count: (data.hit_count as number ?? 0) + 1,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', data.id as string)

  return {
    id: data.id as string,
    intent: data.intent as string,
    routedTable: (data.routed_table as string | null) ?? null,
    routedAction: (data.routed_action as string | null) ?? null,
  }
}

// Pure helpers exported for unit tests.
export const __test__ = {
  patternSignature,
  REPEAT_THRESHOLD,
}
