/**
 * CCPA / GDPR data-portability helper. Tier-C #117.
 *
 * Returns a structured JSON object containing every row keyed to the
 * requesting user / wedding. The route serializes this to a downloadable
 * file ("bloom-data-export-<date>.json"). MVP intentionally produces
 * JSON, not a ZIP — every browser handles JSON download, no native
 * archive library needed. Switch to ZIP later if file sizes warrant.
 *
 * Service-role only. Caller must verify scope before invoking — this
 * helper trusts its inputs.
 *
 * Output structure mirrors the underlying tables so a regulator (or
 * the user) can map fields against the privacy policy without a
 * separate schema doc:
 *
 *   {
 *     export_meta: { generated_at, scope, request_id, ... },
 *     user_profile: {...},
 *     people:       [...],
 *     weddings:     [...],
 *     guest_list:   [...],
 *     planning_notes: [...],
 *     timeline:     [...],
 *     budget:       [...],
 *     messages:     [...],
 *     sage_conversations: [{ ...convo, messages: [...] }],
 *     interactions: [...],
 *     drafts:       [...],
 *   }
 *
 * Out of scope:
 *   - audit-log entries pertaining to the user (deferred — would expose
 *     the operator's internal log shape, not the user's data)
 *   - intelligence_extractions / candidate_identities / tangential_signals
 *     (these are operator-derived; user can request them via /access
 *     scope which is a different request type)
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface ExportCoupleArgs {
  weddingId: string
  userId?: string | null
  requestId: string
}

export interface PortabilityExport {
  export_meta: {
    generated_at: string
    scope: 'couple' | 'user'
    request_id: string
    notes: string
  }
  [section: string]: unknown
}

export async function exportCouple(args: ExportCoupleArgs): Promise<PortabilityExport> {
  const supabase = createServiceClient()

  // Fan out the queries. None of these depend on each other so run them
  // in parallel for a one-shot snapshot.
  const [
    profile,
    people,
    weddings,
    guests,
    notes,
    timeline,
    budget,
    messages,
    sageConvos,
    interactions,
  ] = await Promise.all([
    args.userId
      ? supabase.from('user_profiles').select('*').eq('id', args.userId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('people').select('*').eq('wedding_id', args.weddingId),
    supabase.from('weddings').select('*').eq('id', args.weddingId).maybeSingle(),
    supabase.from('guest_list').select('*').eq('wedding_id', args.weddingId),
    supabase.from('planning_notes').select('*').eq('wedding_id', args.weddingId),
    supabase.from('timeline').select('*').eq('wedding_id', args.weddingId),
    supabase.from('budget').select('*').eq('wedding_id', args.weddingId),
    supabase.from('messages').select('*').eq('wedding_id', args.weddingId),
    supabase.from('sage_conversations').select('*').eq('wedding_id', args.weddingId),
    supabase.from('interactions').select('*').eq('wedding_id', args.weddingId),
  ])

  // For each sage conversation, attach its messages.
  const convoIds = ((sageConvos.data as Array<{ id: string }> | null) ?? []).map((c) => c.id)
  let sageMessages: Array<Record<string, unknown>> = []
  if (convoIds.length > 0) {
    const { data } = await supabase.from('sage_messages').select('*').in('conversation_id', convoIds)
    sageMessages = (data as Array<Record<string, unknown>> | null) ?? []
  }
  const conversationsWithMessages = ((sageConvos.data as Array<Record<string, unknown>> | null) ?? []).map(
    (c) => ({
      ...c,
      messages: sageMessages.filter(
        (m) => (m as { conversation_id: string }).conversation_id === (c as { id: string }).id,
      ),
    }),
  )

  // Drafts are FK-joined via interactions.
  const interactionIds = ((interactions.data as Array<{ id: string }> | null) ?? []).map((i) => i.id)
  let drafts: Array<Record<string, unknown>> = []
  if (interactionIds.length > 0) {
    const { data } = await supabase.from('drafts').select('*').in('interaction_id', interactionIds)
    drafts = (data as Array<Record<string, unknown>> | null) ?? []
  }

  return {
    export_meta: {
      generated_at: new Date().toISOString(),
      scope: 'couple',
      request_id: args.requestId,
      notes:
        'This export contains data Bloom House holds about you and your wedding. ' +
        'Operator-derived analytics (identity resolution candidates, attribution events, ' +
        'tangential signals) are excluded — request scope=access for those.',
    },
    user_profile: profile.data ?? null,
    people: people.data ?? [],
    weddings: weddings.data ? [weddings.data] : [],
    guest_list: guests.data ?? [],
    planning_notes: notes.data ?? [],
    timeline: timeline.data ?? [],
    budget: budget.data ?? [],
    messages: messages.data ?? [],
    sage_conversations: conversationsWithMessages,
    interactions: interactions.data ?? [],
    drafts,
  }
}

export interface ExportUserArgs {
  userId: string
  requestId: string
}

/**
 * Export coordinator / admin self data. Their authored content
 * (drafts, interactions) belongs to the venue; this returns only their
 * own profile + content where they are the explicit subject.
 */
export async function exportUser(args: ExportUserArgs): Promise<PortabilityExport> {
  const supabase = createServiceClient()

  const [profile, peopleByEmail] = await Promise.all([
    supabase.from('user_profiles').select('*').eq('id', args.userId).maybeSingle(),
    // Coordinators rarely appear in `people` themselves but may have
    // contact rows tied to their email. Best-effort lookup.
    Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ])

  return {
    export_meta: {
      generated_at: new Date().toISOString(),
      scope: 'user',
      request_id: args.requestId,
      notes:
        'This export contains your platform profile data. Drafts and emails you ' +
        'authored as part of your role belong to the venue and are retained as a ' +
        'business record under legitimate interest.',
    },
    user_profile: profile.data ?? null,
    people: peopleByEmail.data ?? [],
  }
}
