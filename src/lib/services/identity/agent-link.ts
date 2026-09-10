/**
 * Agent branch of the Forwards Linker (W20, 2026-09-09).
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §1, the Agent class — "a real
 * human acting on behalf of one or more couples (planner, parent,
 * coordinator)". Migration 346 shipped the storage for it (a `couples`
 * row at lifecycle_state='agent' plus `agent_couple_links`) and nothing
 * had ever written one. This file is the writer.
 *
 * Why a branch rather than the normal matcher path
 * ------------------------------------------------
 * A parent or a planner on a CRM project shares a surname, a wedding
 * date and often a household with the couple. Run through the ordinary
 * `linkSignal` route they do one of two wrong things: score high and get
 * absorbed as a touchpoint on the couple (the human disappears), or
 * score below threshold and mint a channel-scoped couple that shows up
 * in the Weddings tab as a second, fake wedding. Neither is what the
 * doctrine asks for. When the caller already KNOWS the person is an
 * agent and knows which couple they act for, there is nothing for the
 * matcher to decide, so the signal skips it.
 *
 * What one call writes
 * --------------------
 *   couples                 one row for the agent, lifecycle_state='agent'.
 *                           Minted through `lockAndMintCouple`, the same
 *                           advisory-locked chokepoint every other mint
 *                           uses, so the mint is race-safe, idempotent
 *                           and audited in couple_merge_events.
 *   touchpoints             one row on the AGENT's record (the RPC
 *                           attaches it), keyed on the signal's
 *                           external_id so a re-import is a no-op.
 *   agent_couple_links      (agent_id, couple_id) — the join that makes
 *                           "who is on this file" answerable, and the
 *                           reason a planner with twelve weddings is one
 *                           record rather than twelve.
 *   wedding_relationships   the role (mother / planner / parent / ...),
 *                           on the legacy limb, where migration 255
 *                           already put the column. Read-before-write:
 *                           the table has no unique key.
 *
 * The agent's own couples row is found by email or phone inside the
 * mint RPC, so the same planner across five projects mints once and
 * collects five links. That is the whole point of the class.
 *
 * What it never does
 * ------------------
 * It never flips an EXISTING couples row to lifecycle_state='agent'.
 * Promotion happens only on the branch where this call minted the row
 * itself. A venue's past bride who now turns up as her sister's planner
 * stays a couple; she gets the link, not a demotion.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { writeOrLog } from '@/lib/db/write-or-log'
import { lockAndMintCouple } from './mint-couple'
import { findCoupleForLegacyWedding, insertFragment } from './tracer'
import type { NormalizedSignal } from './sources/types'
import type { LinkResult } from './forwards-linker'

/** What the Agent branch did, in the caller's terms. Rides on
 *  `LinkResult.agent_link` so an importer can count created / linked /
 *  skipped without re-reading the database. */
export interface AgentLinkOutcome {
  /** couples.id of the agent's own record. Null when nothing was written. */
  agent_couple_id: string | null
  /** couples.id of the couple they act for. Null when it isn't on the
   *  spine yet. */
  couple_id: string | null
  /** A NEW agent-class couples row was minted by this call. False on a
   *  re-import and on the planner's second, third, fourth project. */
  created: boolean
  /** An agent_couple_links row exists for (agent, couple) after this
   *  call, whether this call wrote it or a previous one did. */
  linked: boolean
  /** A wedding_relationships row carrying the role was written by this
   *  call. False when one was already there. */
  role_recorded: boolean
  /** Set when the branch declined to write. Never a silent no-op. */
  skipped_reason: string | null
}

function emptyResult(): LinkResult {
  return {
    action: 'fragment',
    matched_couple_id: null,
    tier: null,
    matcher_score: null,
    judge_invoked: false,
    judge_outcome: null,
    touchpoint_id: null,
    candidate_match_queued: false,
    reason: '',
    duplicate: false,
  }
}

/** Enough of a human to be worth a record of their own. Mirrors
 *  `hasSufficientIdentity` in mint-couple.ts, minus the Gmail author
 *  clause: an agent arrives already classified, so the noise the Gmail
 *  clause exists to filter cannot reach here. */
export function agentHasSufficientIdentity(signal: NormalizedSignal): boolean {
  if (signal.primary_email || signal.primary_phone) return true
  const name = (signal.primary_name ?? '').trim()
  return name.split(/\s+/).filter(Boolean).length >= 2
}

/**
 * Link one agent-class signal. Called by `linkSignal` when the signal
 * carries `agent_context`; not meant to be called directly from outside
 * the identity module.
 *
 * Never throws for a data reason. A genuinely broken database call still
 * throws, and the linker's own catch turns that into a failed
 * tracer_run_events row.
 */
export async function linkAgentSignal(args: {
  supabase: SupabaseClient
  venueId: string
  signal: NormalizedSignal
}): Promise<LinkResult> {
  const { supabase, venueId, signal } = args
  const ctx = signal.agent_context
  const result = emptyResult()
  const outcome: AgentLinkOutcome = {
    agent_couple_id: null,
    couple_id: null,
    created: false,
    linked: false,
    role_recorded: false,
    skipped_reason: null,
  }
  result.agent_link = outcome

  if (!ctx) {
    outcome.skipped_reason = 'no agent_context on signal'
    result.reason = 'agent_link: called without agent_context'
    return result
  }

  // A person with no reachable identifier and no real name is not a
  // record, they are a mention. Fragment, same as the ordinary path.
  if (!agentHasSufficientIdentity(signal)) {
    const f = await insertFragment(supabase, venueId, signal)
    outcome.skipped_reason = 'identity_too_thin'
    result.action = f.inserted ? 'fragment' : 'duplicate'
    result.duplicate = !f.inserted
    result.reason = 'agent_link: no email, no phone, no two-token name'
    return result
  }

  // 1. Which couple do they act for?
  let coupleId = ctx.for_couple_id ?? null
  if (!coupleId && ctx.for_legacy_wedding_id) {
    coupleId = await findCoupleForLegacyWedding(
      supabase,
      venueId,
      ctx.for_legacy_wedding_id,
    )
  }
  if (!coupleId) {
    // The couple has not been mirrored onto the spine yet. Keep the
    // signal as a fragment rather than dropping it; a later sweep can
    // promote it once the couple exists.
    const f = await insertFragment(supabase, venueId, signal)
    outcome.skipped_reason = 'couple_not_on_spine'
    result.action = f.inserted ? 'fragment' : 'duplicate'
    result.duplicate = !f.inserted
    result.reason =
      'agent_link: no couples row for '
      + `wedding=${ctx.for_legacy_wedding_id ?? '(none)'} yet`
    return result
  }
  outcome.couple_id = coupleId

  // 2. Mint (or find) the agent's own record through the shared
  //    chokepoint. The RPC re-checks by email and phone inside the
  //    advisory lock, which is what collapses one planner across many
  //    projects into a single agent row.
  const mint = await lockAndMintCouple(supabase, venueId, signal)
  if (!mint.coupleId) {
    outcome.skipped_reason = 'mint_returned_no_row'
    result.reason = 'agent_link: lock_and_mint_couple returned no couple'
    return result
  }
  outcome.agent_couple_id = mint.coupleId
  result.matched_couple_id = mint.coupleId
  result.touchpoint_id = mint.touchpointId
  result.tier = 'high'
  result.action = mint.minted
    ? 'minted'
    : mint.touchpointInserted
      ? 'attached'
      : 'duplicate'
  result.duplicate = !mint.touchpointInserted && !mint.minted

  // 3. The identifier we were given already belongs to the couple. That
  //    is one human wearing two hats in the export, not an agent.
  //    agent_couple_links has CHECK (agent_id <> couple_id) so this
  //    would fail anyway; refuse it with a reason instead.
  if (mint.coupleId === coupleId) {
    outcome.skipped_reason = 'same_record_as_couple'
    result.reason =
      'agent_link: the agent identifier resolves to the couple itself'
    return result
  }

  // 4. Promote to the Agent class. Guarded twice: only when THIS call
  //    minted the row, and only while it is still the channel_scoped
  //    shell the RPC created. An existing couple is never demoted.
  if (mint.minted) {
    const { error: promoteErr } = await writeOrLog(
      supabase
        .from('couples')
        .update({ lifecycle_state: 'agent', channel_scope: null })
        .eq('id', mint.coupleId)
        .eq('venue_id', venueId)
        .eq('lifecycle_state', 'channel_scoped'),
      { op: 'couples.update.promote_agent', venueId },
    )
    outcome.created = !promoteErr
    if (promoteErr) {
      result.reason = `agent_link: promote to agent failed: ${promoteErr.message}`
    }
  }

  // 5. The join. Primary key is (agent_id, couple_id), so a re-import
  //    conflicts and is ignored — the link is still there afterwards,
  //    which is what `linked` reports.
  const { error: linkErr } = await writeOrLog(
    supabase
      .from('agent_couple_links')
      .upsert(
        {
          agent_id: mint.coupleId,
          couple_id: coupleId,
          source: ctx.link_source ?? 'operator_confirmed',
        },
        { onConflict: 'agent_id,couple_id', ignoreDuplicates: true },
      ),
    { op: 'agent_couple_links.upsert', venueId, ignoreCodes: ['23505'] },
  )
  outcome.linked = !linkErr || linkErr.code === '23505'
  if (!outcome.linked) {
    outcome.skipped_reason = `link_failed:${linkErr?.message ?? 'unknown'}`
  }

  // 6. The role, on the legacy limb where migration 255 put the column.
  //    Only when we know the wedding: wedding_relationships is keyed on
  //    weddings.id, not couples.id.
  if (ctx.for_legacy_wedding_id) {
    outcome.role_recorded = await recordRelationshipRole({
      supabase,
      venueId,
      weddingId: ctx.for_legacy_wedding_id,
      fullName: signal.primary_name ?? signal.identity_hint ?? '(unnamed)',
      role: ctx.role,
      detail: ctx.relationship_detail ?? null,
      email: signal.primary_email ?? null,
      phone: signal.primary_phone ?? null,
      roleSource: ctx.role_source ?? 'csv_import',
    })
  }

  result.reason =
    `agent_link: role=${ctx.role} agent=${mint.coupleId.slice(0, 8)} `
    + `couple=${coupleId.slice(0, 8)} `
    + `created=${outcome.created} linked=${outcome.linked}`
  return result
}

/**
 * Write the role onto `wedding_relationships` (migration 255) unless an
 * equivalent row is already there. The table carries no unique key, so
 * the dedup is a read on (wedding_id, lower(full_name), relationship_role)
 * first. Returns true when this call wrote the row.
 */
async function recordRelationshipRole(args: {
  supabase: SupabaseClient
  venueId: string
  weddingId: string
  fullName: string
  role: string
  detail: string | null
  email: string | null
  phone: string | null
  roleSource: string
}): Promise<boolean> {
  const { supabase, venueId, weddingId } = args
  const fullName = args.fullName.trim()
  if (!fullName) return false

  const { data: existing, error: readErr } = await supabase
    .from('wedding_relationships')
    .select('id, full_name, relationship_role')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .limit(200)
  if (readErr) {
    // A read failure means we cannot tell duplicate from new. Refuse to
    // write rather than risk a second copy of the mother on every
    // re-import; the caller counts it as not recorded.
    return false
  }
  const already = (existing ?? []).some(
    (r: { full_name: string | null; relationship_role: string | null }) =>
      (r.full_name ?? '').trim().toLowerCase() === fullName.toLowerCase()
      && (r.relationship_role ?? '') === args.role,
  )
  if (already) return false

  const { error: insErr } = await writeOrLog(
    supabase.from('wedding_relationships').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      full_name: fullName,
      relationship_role: args.role,
      detail: args.detail,
      email: args.email,
      phone: args.phone,
      source: args.roleSource,
      confidence: 80,
    }),
    { op: 'wedding_relationships.insert', venueId },
  )
  return !insErr
}
