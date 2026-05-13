/**
 * POST /api/admin/force-draft
 *
 * One-shot: find the most recent inbound for each named lead and
 * force-generate a Sage draft. Inserts as status='pending' so the
 * coordinator reviews before sending.
 *
 * Use when a draft should have generated but didn't (e.g. Calendly
 * notification arrived before the tour-welcome flow shipped, or a
 * Knot Pro Inbox inquiry hit a misclassifier in an earlier prompt
 * revision).
 *
 * Body shape:
 *   { names?: string[]; weddingIds?: string[]; interactionIds?: string[] }
 *
 * At least one of the three arrays must be non-empty. Names match
 * against people.first_name + people.last_name AND weddings.couple_name
 * AND interactions.from_name (case-insensitive ILIKE).
 *
 * Returns per-target { matched, drafted, draftId | error }.
 *
 * Auth: getPlatformAuth(). Demo blocked. Per-venue scoped.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, forbidden, badRequest } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  generateInquiryDraft,
  BRAIN_PROMPT_VERSION as INQUIRY_BRAIN_PROMPT_VERSION,
} from '@/lib/services/brain/inquiry'

export const maxDuration = 120

interface ForceDraftBody {
  names?: string[]
  weddingIds?: string[]
  interactionIds?: string[]
}

interface TargetResult {
  target: string
  matched: boolean
  weddingId?: string
  interactionId?: string
  drafted: boolean
  draftId?: string
  error?: string
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo blocked')
  if (!auth.venueId) return forbidden('no venue scope')
  const venueId = auth.venueId

  const body = (await req.json().catch(() => null)) as ForceDraftBody | null
  if (!body) return badRequest('missing body')

  const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === 'string' && n.trim()) : []
  const weddingIds = Array.isArray(body.weddingIds) ? body.weddingIds.filter((w) => typeof w === 'string') : []
  const interactionIds = Array.isArray(body.interactionIds)
    ? body.interactionIds.filter((i) => typeof i === 'string')
    : []

  if (names.length === 0 && weddingIds.length === 0 && interactionIds.length === 0) {
    return badRequest('one of names / weddingIds / interactionIds must be non-empty')
  }

  const supabase = createServiceClient()
  const results: TargetResult[] = []

  // ---- Resolve names → interactionId for the latest inbound -----
  for (const name of names) {
    const result: TargetResult = { target: `name:${name}`, matched: false, drafted: false }
    try {
      const trimmed = name.trim()
      const pattern = `%${trimmed}%`

      // Try interactions.from_name first (most reliable for the
      // historical rows that landed before identity resolution).
      const { data: byFromName } = await supabase
        .from('interactions')
        .select('id, wedding_id, from_email, from_name, subject, full_body, lifecycle_folder')
        .eq('venue_id', venueId)
        .eq('type', 'email')
        .eq('direction', 'inbound')
        .ilike('from_name', pattern)
        .order('timestamp', { ascending: false })
        .limit(1)

      let match = byFromName?.[0] ?? null

      // Fall back to people.first_name + people.last_name -> wedding ->
      // latest inbound on that wedding.
      if (!match) {
        const { data: people } = await supabase
          .from('people')
          .select('id, wedding_id, first_name, last_name')
          .eq('venue_id', venueId)
          .or(`first_name.ilike.${pattern},last_name.ilike.${pattern}`)
          .limit(5)

        const weddingIdsFound = (people ?? [])
          .map((p) => p.wedding_id as string | null)
          .filter((w): w is string => !!w)

        if (weddingIdsFound.length > 0) {
          const { data: byWedding } = await supabase
            .from('interactions')
            .select('id, wedding_id, from_email, from_name, subject, full_body, lifecycle_folder')
            .eq('venue_id', venueId)
            .eq('type', 'email')
            .eq('direction', 'inbound')
            .in('wedding_id', weddingIdsFound)
            .order('timestamp', { ascending: false })
            .limit(1)
          match = byWedding?.[0] ?? null
        }
      }

      if (!match) {
        result.error = 'no inbound interaction found'
        results.push(result)
        continue
      }

      result.matched = true
      result.weddingId = (match.wedding_id as string | null) ?? undefined
      result.interactionId = match.id as string

      const draftResult = await draftForInteraction(supabase, venueId, match)
      Object.assign(result, draftResult)
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
    }
    results.push(result)
  }

  // ---- weddingIds path -----
  for (const wid of weddingIds) {
    const result: TargetResult = { target: `wedding:${wid}`, matched: false, drafted: false }
    try {
      const { data: rows } = await supabase
        .from('interactions')
        .select('id, wedding_id, from_email, from_name, subject, full_body, lifecycle_folder')
        .eq('venue_id', venueId)
        .eq('wedding_id', wid)
        .eq('type', 'email')
        .eq('direction', 'inbound')
        .order('timestamp', { ascending: false })
        .limit(1)
      const match = rows?.[0]
      if (!match) {
        result.error = 'no inbound interaction on that wedding'
        results.push(result)
        continue
      }
      result.matched = true
      result.weddingId = wid
      result.interactionId = match.id as string
      Object.assign(result, await draftForInteraction(supabase, venueId, match))
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
    }
    results.push(result)
  }

  // ---- interactionIds path -----
  for (const iid of interactionIds) {
    const result: TargetResult = { target: `interaction:${iid}`, matched: false, drafted: false }
    try {
      const { data: row } = await supabase
        .from('interactions')
        .select('id, wedding_id, from_email, from_name, subject, full_body, lifecycle_folder')
        .eq('venue_id', venueId)
        .eq('id', iid)
        .maybeSingle()
      if (!row) {
        result.error = 'interaction not found / not in your venue'
        results.push(result)
        continue
      }
      result.matched = true
      result.weddingId = (row.wedding_id as string | null) ?? undefined
      result.interactionId = iid
      Object.assign(result, await draftForInteraction(supabase, venueId, row))
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
    }
    results.push(result)
  }

  return NextResponse.json({ ok: true, results })
}

interface InteractionLite {
  id: string
  wedding_id: string | null
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  lifecycle_folder: string | null
}

async function draftForInteraction(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  interaction: InteractionLite,
): Promise<Pick<TargetResult, 'drafted' | 'draftId' | 'error'>> {
  const fromEmail = (interaction.from_email as string | null) ?? ''
  if (!fromEmail) {
    return { drafted: false, error: 'interaction has no from_email' }
  }

  // Refuse to double-draft when a pending draft already exists for this
  // interaction. Coordinator should regenerate instead.
  const { data: existing } = await supabase
    .from('drafts')
    .select('id, status')
    .eq('venue_id', venueId)
    .eq('interaction_id', interaction.id)
    .in('status', ['pending', 'approved'])
    .limit(1)
  if (existing && existing.length > 0) {
    return {
      drafted: false,
      error: `draft ${existing[0].id} already exists in status ${existing[0].status} — use Regenerate instead`,
    }
  }

  const correlationId = `force-draft-${interaction.id}-${Date.now()}`

  const result = await generateInquiryDraft({
    venueId,
    contactEmail: fromEmail,
    inquiry: {
      from: fromEmail,
      subject: (interaction.subject as string | null) ?? '',
      body: (interaction.full_body as string | null) ?? '',
    },
    extractedData: { questions: [] },
    taskType: 'new_inquiry',
    weddingId: (interaction.wedding_id as string | null) ?? undefined,
    correlationId,
  })

  if (!result.draft || result.draft.trim().length === 0) {
    return { drafted: false, error: 'brain returned empty draft' }
  }

  const subject =
    interaction.subject && (interaction.subject as string).toLowerCase().startsWith('re:')
      ? (interaction.subject as string)
      : `Re: ${interaction.subject ?? 'your inquiry'}`

  const { data: draftRow, error: insertErr } = await supabase
    .from('drafts')
    .insert({
      venue_id: venueId,
      wedding_id: interaction.wedding_id,
      interaction_id: interaction.id,
      to_email: fromEmail,
      subject,
      draft_body: result.draft,
      original_sage_body: result.draft,
      confidence_score: result.confidence,
      status: 'pending',
      context_type: 'inquiry',
      brain_used: 'inquiry',
      prompt_version_used: INQUIRY_BRAIN_PROMPT_VERSION,
      correlation_id: correlationId,
      auto_sent: false,
    })
    .select('id')
    .single()

  if (insertErr) {
    return { drafted: false, error: insertErr.message }
  }

  return { drafted: true, draftId: draftRow?.id as string }
}
