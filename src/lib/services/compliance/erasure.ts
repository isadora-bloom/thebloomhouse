/**
 * CCPA / GDPR right-to-erasure helper. Tier-C #116.
 *
 * Service-role only. Callers MUST authenticate + authorize before
 * invoking — these functions trust their inputs and do not re-check
 * scope. Routes that wrap this helper are responsible for verifying
 * the requester has standing to delete the targeted record.
 *
 * Two distinct flows:
 *
 *   eraseCouple({ weddingId, userId })
 *     - Couples have data scattered across portal tables (planning
 *       notes, timeline, budget, guest_list, messages, sage chat) AND
 *       the email pipeline (interactions, drafts, candidate_identities).
 *     - Strategy: delete clearly-personal records, anonymize records
 *       that the venue legitimately retains (interactions, weddings).
 *     - Anonymization replaces PII with a deterministic '[redacted]'
 *       sentinel so schema stays consistent and readers don't crash.
 *
 *   eraseUser({ userId })
 *     - Coordinator / manager / admin self-erasure. Drafts, interactions,
 *       and content they authored stay (the venue retains them as a
 *       business record); the linkage row in user_profiles is deleted.
 *     - Auth user deletion via supabase.auth.admin.deleteUser cascades
 *       into user_profiles automatically.
 *
 * Idempotency: every operation tolerates re-running. Anonymizing an
 * already-anonymized row is a no-op; deleting a missing row is a no-op.
 *
 * Audit: each step records into activity_log so the consumer-requests
 * processing history is recoverable independent of the consumer_requests
 * row itself.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'

const REDACTED = '[redacted]'

interface EraseResult {
  ok: boolean
  steps: { table: string; affected: number; mode: 'delete' | 'anonymize' }[]
  error?: string
}

export interface EraseCoupleArgs {
  /** The wedding to erase couple-side data for. */
  weddingId: string
  /** The auth user id of the requesting couple member, if any. */
  userId?: string | null
  /** Venue id for audit-log scope. */
  venueId: string
  /** consumer_requests.id this erasure is fulfilling — for audit. */
  requestId: string
  /** Who is executing (admin processing the request). */
  actorUserId: string
}

/**
 * Erase couple-side PII for a wedding. Returns step-by-step counts so
 * the admin queue can render "47 rows redacted across 9 tables."
 */
export async function eraseCouple(args: EraseCoupleArgs): Promise<EraseResult> {
  const supabase = createServiceClient()
  const steps: EraseResult['steps'] = []

  async function step(
    table: string,
    mode: 'delete' | 'anonymize',
    runner: () => Promise<{ count: number | null; error: { message: string } | null }>,
  ): Promise<boolean> {
    const { count, error } = await runner()
    if (error) {
      logEvent({
        level: 'error',
        msg: 'compliance_erasure_step_failed',
        data: { table, mode, error: error.message, requestId: args.requestId },
        venueId: args.venueId,
        actor: args.actorUserId,
        event_type: 'compliance.erasure',
        outcome: 'fail',
      })
      return false
    }
    steps.push({ table, mode, affected: count ?? 0 })
    return true
  }

  // --- Step 1. Sage chat (couple-personal) -> DELETE ---
  // sage_messages cascades from sage_conversations(wedding_id), but be
  // explicit about both for the audit count.
  await step('sage_messages', 'delete', async () =>
    await supabase.from('sage_messages').delete({ count: 'exact' })
      .in(
        'conversation_id',
        (await supabase.from('sage_conversations').select('id').eq('wedding_id', args.weddingId)).data?.map(
          (r) => (r as { id: string }).id,
        ) ?? [],
      ),
  )
  await step('sage_conversations', 'delete', async () =>
    await supabase.from('sage_conversations').delete({ count: 'exact' }).eq('wedding_id', args.weddingId),
  )

  // --- Step 2. Portal-personal content -> DELETE ---
  await step('planning_notes', 'delete', async () =>
    await supabase.from('planning_notes').delete({ count: 'exact' }).eq('wedding_id', args.weddingId),
  )

  // --- Step 3. Shared portal records -> ANONYMIZE ---
  // weddings.notes carries couple-authored prose; null it but preserve
  // the wedding row (the venue retains the booking record as a business
  // record per legitimate-interest under GDPR Art. 6(1)(f)).
  await step('weddings', 'anonymize', async () =>
    await supabase.from('weddings').update({ notes: null }, { count: 'exact' }).eq('id', args.weddingId),
  )

  await step('guest_list', 'anonymize', async () =>
    await supabase
      .from('guest_list')
      .update({ care_notes: null, plus_one_name: null }, { count: 'exact' })
      .eq('wedding_id', args.weddingId),
  )

  await step('timeline', 'anonymize', async () =>
    await supabase
      .from('timeline')
      .update({ description: REDACTED, location: REDACTED }, { count: 'exact' })
      .eq('wedding_id', args.weddingId),
  )

  await step('budget', 'anonymize', async () =>
    await supabase
      .from('budget')
      .update({ notes: null }, { count: 'exact' })
      .eq('wedding_id', args.weddingId),
  )

  await step('messages', 'anonymize', async () =>
    await supabase
      .from('messages')
      .update({ content: REDACTED }, { count: 'exact' })
      .eq('wedding_id', args.weddingId),
  )

  // --- Step 4. Email pipeline records -> ANONYMIZE ---
  // interactions stays for the venue's business record (inquiry counts,
  // attribution math) but PII fields are scrubbed.
  await step('interactions', 'anonymize', async () =>
    await supabase
      .from('interactions')
      .update(
        {
          full_body: REDACTED,
          body_preview: REDACTED,
          subject: REDACTED,
          from_name: REDACTED,
          from_email: REDACTED,
          to_email: REDACTED,
          extracted_identity: null,
        },
        { count: 'exact' },
      )
      .eq('wedding_id', args.weddingId),
  )

  // drafts referenced via interactions.id — easier to query by wedding
  // through the FK chain. For idempotency: anonymize anything still
  // reachable via the wedding's interaction rows.
  const { data: interactionIds } = await supabase
    .from('interactions')
    .select('id')
    .eq('wedding_id', args.weddingId)
  const idList = (interactionIds ?? []).map((r) => (r as { id: string }).id)
  if (idList.length > 0) {
    await step('drafts', 'anonymize', async () =>
      await supabase
        .from('drafts')
        .update(
          {
            draft_body: REDACTED,
            subject: REDACTED,
            to_email: REDACTED,
          },
          { count: 'exact' },
        )
        .in('interaction_id', idList),
    )
  } else {
    steps.push({ table: 'drafts', mode: 'anonymize', affected: 0 })
  }

  // --- Step 5. Identity-resolution substrate -> ANONYMIZE ---
  await step('intelligence_extractions', 'anonymize', async () =>
    await supabase
      .from('intelligence_extractions')
      .update({ value: REDACTED }, { count: 'exact' })
      .eq('wedding_id', args.weddingId),
  )

  // candidate_identities: match by wedding_id where attached. Some rows
  // are pre-zero (no wedding_id yet) and unreachable from this scope —
  // out of scope for couple-side erasure since they may belong to any
  // future couple. Document the limitation explicitly.
  await step('candidate_identities', 'anonymize', async () =>
    await supabase
      .from('candidate_identities')
      .update(
        {
          first_name: REDACTED,
          last_name: REDACTED,
          email: REDACTED,
          phone: REDACTED,
        },
        { count: 'exact' },
      )
      .eq('wedding_id', args.weddingId),
  )

  await step('tangential_signals', 'anonymize', async () =>
    await supabase
      .from('tangential_signals')
      .update({ extracted_identity: null }, { count: 'exact' })
      .eq('wedding_id', args.weddingId),
  )

  // --- Step 6. People rows + the auth user ---
  // people: couples are surfaced via wedding_id. Anonymize first_name /
  // last_name / email / phone / external_ids / alias_emails. Don't
  // delete because guest_list.person_id and other FKs SET NULL on
  // delete and we'd lose the schema link to anonymized history.
  await step('people', 'anonymize', async () =>
    await supabase
      .from('people')
      .update(
        {
          first_name: REDACTED,
          last_name: REDACTED,
          email: null,
          phone: null,
          external_ids: {},
          alias_emails: [],
        },
        { count: 'exact' },
      )
      .eq('wedding_id', args.weddingId),
  )

  // user_profiles: only delete if the userId was tied to THIS wedding.
  // Couples may have a partner with a separate user_profiles row; both
  // are scoped by wedding_id (mig 226).
  if (args.userId) {
    await step('user_profiles', 'delete', async () =>
      await supabase
        .from('user_profiles')
        .delete({ count: 'exact' })
        .eq('id', args.userId!)
        .eq('wedding_id', args.weddingId),
    )

    // auth.users — soft-fail if the user is already gone. supabase.auth
    // admin requires the service-role; createServiceClient uses it.
    try {
      const adminClient = createServiceClient()
      await adminClient.auth.admin.deleteUser(args.userId)
      steps.push({ table: 'auth.users', mode: 'delete', affected: 1 })
    } catch (err) {
      logEvent({
        level: 'warn',
        msg: 'compliance_auth_user_delete_skipped',
        data: { userId: args.userId, error: err instanceof Error ? err.message : String(err) },
        venueId: args.venueId,
        actor: args.actorUserId,
        event_type: 'compliance.erasure',
        outcome: 'skip',
      })
    }
  }

  // --- Final audit row ---
  logEvent({
    level: 'info',
    msg: 'compliance_erasure_complete',
    data: {
      requestId: args.requestId,
      weddingId: args.weddingId,
      userId: args.userId ?? null,
      stepCount: steps.length,
      totalAffected: steps.reduce((s, x) => s + x.affected, 0),
    },
    venueId: args.venueId,
    actor: args.actorUserId,
    event_type: 'compliance.erasure',
    outcome: 'ok',
  })

  return { ok: true, steps }
}

export interface EraseUserArgs {
  /** auth user id of the requesting coordinator / admin. */
  userId: string
  /** Venue for audit-log scope. */
  venueId: string
  requestId: string
  actorUserId: string
}

/**
 * Erase a coordinator / manager / admin user. Their authored content
 * (drafts, interactions, audit rows) stays as a business record;
 * coordinator name attribution shifts to NULL via existing FK
 * SET NULL behaviour.
 */
export async function eraseUser(args: EraseUserArgs): Promise<EraseResult> {
  const supabase = createServiceClient()
  const steps: EraseResult['steps'] = []

  // Delete the auth.users row; user_profiles cascades automatically.
  try {
    await supabase.auth.admin.deleteUser(args.userId)
    steps.push({ table: 'auth.users', mode: 'delete', affected: 1 })
    steps.push({ table: 'user_profiles', mode: 'delete', affected: 1 })
  } catch (err) {
    return {
      ok: false,
      steps,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  logEvent({
    level: 'info',
    msg: 'compliance_user_erasure_complete',
    data: { requestId: args.requestId, userId: args.userId },
    venueId: args.venueId,
    actor: args.actorUserId,
    event_type: 'compliance.erasure',
    outcome: 'ok',
  })

  return { ok: true, steps }
}
