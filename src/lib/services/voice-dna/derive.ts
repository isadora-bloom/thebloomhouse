/**
 * Bloom House — Wave 20 Voice DNA derivation service.
 *
 * Anchor docs (~/.claude memory/):
 *   - bloom-constitution.md (operator authority — this service produces
 *     PROPOSALS only; the brain continues reading voice_preferences as
 *     the source of truth)
 *   - feedback_deep_fix_vs_bandaid.md (Pattern 7 — one-derive-all)
 *   - feedback_no_em_dash.md (em-dash check is required in the prompt)
 *   - Wave 4 — every derived claim carries an evidence_quote
 *
 * What this does
 * --------------
 * 1. Load up to 50 recent coordinator outbound emails (the human's
 *    actual writing voice).
 * 2. Load up to 30 recent draft edits (draft_feedback.action='edited'
 *    rows with both original_body and edited_body set — Sage's draft
 *    vs the operator's edited version captures their preference signal
 *    as a clean diff).
 * 3. Load existing voice_preferences (so derivation AUGMENTS rather
 *    than overrides).
 * 4. Call Sonnet with the voice-dna-derive prompt (Wave 20 prompt
 *    config).
 * 5. Persist the four derived buckets to voice_dna_derivations with
 *    applied=false. Operator must explicitly accept via the apply
 *    service to merge into voice_preferences.
 *
 * Cost: ~$0.03-0.08 per derivation. Sonnet, single call, ~50 emails +
 * 30 edit-diffs fit in one context. Cost-cap gate before fire.
 *
 * Idempotency: re-running creates a NEW derivation row. The operator
 * can compare runs by browsing the history list. Each row is its own
 * audit anchor — no in-place mutation, no overwrite.
 *
 * White-label safety: every query is venue_id-scoped. Coordinator
 * sender allowlist filters via gmail_connections so we never capture
 * outbound from unrelated addresses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson } from '@/lib/ai/client'
import { createServiceClient } from '@/lib/supabase/service'
import { gateForBrainCall, nextUtcMidnightIso } from '@/lib/services/cost-ceiling'
import { createLogger, newCorrelationId } from '@/lib/observability/logger'
import { redactError } from '@/lib/observability/redact'
import {
  VOICE_DNA_DERIVE_PROMPT_VERSION,
  buildVoiceDNADeriveSystemPrompt,
  buildVoiceDNADeriveUserPrompt,
  validateVoiceDNADeriveOutput,
  type VoiceDNADeriveOutput,
  type VoiceDNAEvidence,
  type CoordinatorEmail,
  type DraftEdit,
  type ExistingVoicePreference,
} from '@/config/prompts/voice-dna-derive'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const DEFAULT_EMAIL_LIMIT = 50
export const DEFAULT_EDIT_LIMIT = 30
export const DEFAULT_WINDOW_DAYS = 365

/** Lower bound. Below this combined evidence count, we don't spend AI
 *  budget — the signal is too weak to produce a useful derivation. */
export const MIN_TOTAL_EVIDENCE = 5

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeriveOptions {
  venueId: string
  supabase?: SupabaseClient
  /** Default 365. Lower for more recent-voice-only derivations. */
  windowDays?: number
  emailLimit?: number
  editLimit?: number
  correlationId?: string
  actor?: string
  /** When set, the derivation is linked back to this voice_dna_jobs row. */
  jobId?: string
}

export interface DeriveSuccess {
  ok: true
  derivationId: string
  derivation: VoiceDNADeriveOutput
  sourceSummary: {
    coordinator_emails_count: number
    draft_edits_count: number
    time_window_days: number
    correlation_id: string
  }
  costCents: number  // dollars (kept name per spec)
  correlationId: string
}

export interface DeriveFailure {
  ok: false
  reason:
    | 'gated'
    | 'insufficient_evidence'
    | 'llm_failed'
    | 'persist_failed'
    | 'invalid_output'
  details?: string
  resumeAt?: string
  correlationId: string
}

export type DeriveResult = DeriveSuccess | DeriveFailure

// ---------------------------------------------------------------------------
// Evidence loaders
// ---------------------------------------------------------------------------

interface VenueRow {
  id: string
  name: string | null
}

interface OutboundRow {
  id: string
  subject: string | null
  full_body: string | null
  body_preview: string | null
  from_email: string | null
  created_at: string
  timestamp: string | null
}

interface DraftFeedbackRow {
  original_body: string | null
  edited_body: string | null
  created_at: string
}

interface ExistingVPRow {
  preference_type: string
  content: string
}

async function loadVenueName(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  return (data as VenueRow | null)?.name ?? null
}

/**
 * Sample the coordinator's recent outbound emails. Filtered by
 * gmail_connections so we only capture writing from the venue's
 * connected coordinator addresses (no random unrelated outbound).
 *
 * If gmail_connections is empty (rare; covers venues that imported
 * outbound before connections were tracked), we fall through and
 * accept any outbound from the venue. Better than dropping all
 * candidates.
 */
async function loadCoordinatorEmails(
  supabase: SupabaseClient,
  venueId: string,
  limit: number,
  windowDays: number,
): Promise<CoordinatorEmail[]> {
  const { data: connections } = await supabase
    .from('gmail_connections')
    .select('email_address')
    .eq('venue_id', venueId)
    .eq('status', 'active')

  const ownEmails = new Set<string>(
    ((connections ?? []) as Array<{ email_address: string | null }>)
      .map((r) => r.email_address?.toLowerCase())
      .filter(Boolean) as string[],
  )

  const sinceIso = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, subject, full_body, body_preview, from_email, created_at, timestamp')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'outbound')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(Math.max(limit * 2, limit + 30))  // over-pull, post-filter

  if (error) return []

  const candidates = (rows ?? []) as OutboundRow[]

  const filtered = ownEmails.size > 0
    ? candidates.filter((r) => {
        const from = r.from_email?.toLowerCase()
        return from ? ownEmails.has(from) : false
      })
    : candidates

  // Drop empty bodies — they carry no voice signal.
  const withBody = filtered.filter((r) => {
    const body = (r.full_body ?? r.body_preview ?? '').trim()
    return body.length > 40  // tiny "ok thanks" replies don't help
  })

  return withBody.slice(0, limit).map((r) => ({
    sent_at: r.timestamp ?? r.created_at,
    subject: r.subject,
    body: ((r.full_body ?? r.body_preview ?? '') as string).trim(),
  }))
}

/**
 * Sample the operator's draft edits — moments where Sage drafted X and
 * the operator edited to Y before sending. The diff IS the operator's
 * voice signal: what they ADDED, what they REMOVED, what they
 * REPHRASED.
 *
 * Filter: action='edited' AND both original_body+edited_body set AND
 * the bodies differ in a meaningful way (>10% length-delta or
 * character-level non-trivial difference). Identical-content rows
 * carry no signal and just inflate the corpus.
 */
async function loadDraftEdits(
  supabase: SupabaseClient,
  venueId: string,
  limit: number,
  windowDays: number,
): Promise<DraftEdit[]> {
  const sinceIso = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data, error } = await supabase
    .from('draft_feedback')
    .select('original_body, edited_body, created_at')
    .eq('venue_id', venueId)
    .eq('action', 'edited')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(Math.max(limit * 2, limit + 20))

  if (error) return []
  const rows = (data ?? []) as DraftFeedbackRow[]

  const meaningful = rows.filter((r) => {
    if (!r.original_body || !r.edited_body) return false
    const orig = r.original_body.trim()
    const sent = r.edited_body.trim()
    if (orig.length < 50 || sent.length < 50) return false
    if (orig === sent) return false
    // Drop trivial whitespace-only deltas.
    const diff = Math.abs(orig.length - sent.length)
    const longer = Math.max(orig.length, sent.length)
    const ratio = diff / longer
    // If the bodies differ by <2% in length AND are otherwise similar
    // (one substring of the other), treat as noise. Otherwise include.
    if (ratio < 0.02 && (orig.includes(sent) || sent.includes(orig))) return false
    return true
  })

  return meaningful.slice(0, limit).map((r) => ({
    edited_at: r.created_at,
    sage_draft: (r.original_body as string).trim(),
    operator_sent: (r.edited_body as string).trim(),
  }))
}

async function loadExistingVoicePreferences(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ExistingVoicePreference[]> {
  const { data } = await supabase
    .from('voice_preferences')
    .select('preference_type, content')
    .eq('venue_id', venueId)
    .limit(200)

  const rows = (data ?? []) as ExistingVPRow[]
  return rows
    .filter((r) =>
      ['banned_phrase', 'approved_phrase', 'dimension', 'rule'].includes(r.preference_type)
    )
    .map((r) => ({
      preference_type: r.preference_type as ExistingVoicePreference['preference_type'],
      content: r.content,
    }))
}

// ---------------------------------------------------------------------------
// Cost accounting
// ---------------------------------------------------------------------------

/**
 * Sum the cost from api_costs rows that share our correlation_id. The
 * Sonnet call writes to api_costs via the standard logUsage path; we
 * read it back so the derivation row knows what it cost.
 *
 * logUsage is FIRE-AND-FORGET in src/lib/ai/client.ts (no await on the
 * inner insert), so when we query immediately after callAIJson returns
 * the row may not be there yet. Brief poll-with-backoff (max ~1.5s)
 * covers the race.
 */
async function sumCostByCorrelation(
  supabase: SupabaseClient,
  correlationId: string,
  venueId: string,
): Promise<number> {
  const attempts = [0, 200, 400, 800]
  for (const delay of attempts) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    try {
      const { data } = await supabase
        .from('api_costs')
        .select('cost')
        .eq('venue_id', venueId)
        .eq('correlation_id', correlationId)
      const rows = (data ?? []) as Array<{ cost: number | null }>
      if (rows.length > 0) {
        return rows.reduce((acc, r) => acc + (r.cost ?? 0), 0)
      }
    } catch {
      // continue retrying
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// Public entry — deriveVoiceDNA
// ---------------------------------------------------------------------------

/**
 * Derive voice DNA for a venue. Writes a voice_dna_derivations row in
 * applied=false state (proposal). The operator hits "apply" in the
 * Voice DNA UI to merge specific fields into voice_preferences.
 *
 * Doctrine:
 *   - Operator authority. Never auto-applies. The brain continues
 *     reading voice_preferences; this service only produces proposals.
 *   - Every derived claim has a verbatim evidence_quote (Wave 4).
 *   - Em-dash check is mandated by the prompt (feedback_no_em_dash.md).
 *   - Cost-cap gate before LLM fire (gateForBrainCall).
 *   - Tier-1 content (couple PII appears in outbound emails).
 */
export async function deriveVoiceDNA(opts: DeriveOptions): Promise<DeriveResult> {
  const correlationId = opts.correlationId ?? newCorrelationId()
  const supabase = opts.supabase ?? createServiceClient()
  const log = createLogger({
    venueId: opts.venueId,
    correlationId,
    actor: opts.actor ?? 'system',
  })
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS
  const emailLimit = opts.emailLimit ?? DEFAULT_EMAIL_LIMIT
  const editLimit = opts.editLimit ?? DEFAULT_EDIT_LIMIT

  // 1. Cost-cap gate.
  const gate = await gateForBrainCall(opts.venueId)
  if (!gate.ok) {
    log.warn('voice_dna_derive.gated', {
      event_type: 'voice_dna_derive',
      outcome: 'skip',
      data: { reason: gate.reason },
    })
    return {
      ok: false,
      reason: 'gated',
      resumeAt: nextUtcMidnightIso(),
      correlationId,
    }
  }

  // 2. Load evidence (parallel).
  const started = Date.now()
  const [venueName, emails, edits, existing] = await Promise.all([
    loadVenueName(supabase, opts.venueId),
    loadCoordinatorEmails(supabase, opts.venueId, emailLimit, windowDays),
    loadDraftEdits(supabase, opts.venueId, editLimit, windowDays),
    loadExistingVoicePreferences(supabase, opts.venueId),
  ])

  const totalEvidence = emails.length + edits.length
  if (totalEvidence < MIN_TOTAL_EVIDENCE) {
    log.info('voice_dna_derive.insufficient_evidence', {
      event_type: 'voice_dna_derive',
      outcome: 'skip',
      data: {
        coordinator_emails_count: emails.length,
        draft_edits_count: edits.length,
        floor: MIN_TOTAL_EVIDENCE,
      },
    })
    return {
      ok: false,
      reason: 'insufficient_evidence',
      details: `total evidence (${totalEvidence}) below floor (${MIN_TOTAL_EVIDENCE})`,
      correlationId,
    }
  }

  // 3. Build prompt + call Sonnet.
  const evidence: VoiceDNAEvidence = {
    venue_name: venueName,
    coordinator_emails: emails,
    draft_edits: edits,
    existing_voice_preferences: existing,
  }

  let raw: unknown
  try {
    raw = await callAIJson({
      systemPrompt: buildVoiceDNADeriveSystemPrompt(),
      userPrompt: buildVoiceDNADeriveUserPrompt(evidence),
      maxTokens: 4000,
      temperature: 0.2,
      venueId: opts.venueId,
      taskType: 'voice_dna_derive',
      // Outbound emails contain couple PII (names, dates, family
      // context). Strict retention path per OPS-21.3.5.
      contentTier: 1,
      tier: 'sonnet',
      promptVersion: VOICE_DNA_DERIVE_PROMPT_VERSION,
      correlationId,
    })
  } catch (err) {
    log.error('voice_dna_derive.llm_failed', {
      event_type: 'voice_dna_derive',
      outcome: 'fail',
      data: { error: redactError(err) },
    })
    return {
      ok: false,
      reason: 'llm_failed',
      details: err instanceof Error ? err.message : 'unknown',
      correlationId,
    }
  }

  // 4. Validate the output.
  const validated = validateVoiceDNADeriveOutput(raw)
  if (!validated.ok) {
    log.error('voice_dna_derive.invalid_output', {
      event_type: 'voice_dna_derive',
      outcome: 'fail',
      data: { error: validated.error },
    })
    return {
      ok: false,
      reason: 'invalid_output',
      details: validated.error,
      correlationId,
    }
  }
  const derivation = validated.output

  // 5. Cost rollup — read api_costs by correlation_id.
  const costCents = await sumCostByCorrelation(supabase, correlationId, opts.venueId)

  // 6. Persist the derivation row.
  const sourceSummary = {
    coordinator_emails_count: emails.length,
    draft_edits_count: edits.length,
    time_window_days: windowDays,
    correlation_id: correlationId,
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('voice_dna_derivations')
    .insert({
      venue_id: opts.venueId,
      source_summary: sourceSummary,
      derived_banned_phrases: derivation.banned_phrases,
      derived_approved_phrases: derivation.approved_phrases,
      derived_tone_descriptors: derivation.tone_descriptors,
      derived_voice_principles: derivation.voice_principles,
      cost_cents: costCents,
      prompt_version: VOICE_DNA_DERIVE_PROMPT_VERSION,
      applied: false,
      dismissed: false,
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    log.error('voice_dna_derive.persist_failed', {
      event_type: 'voice_dna_derive',
      outcome: 'fail',
      data: { error: insertErr?.message ?? 'no row returned' },
    })
    return {
      ok: false,
      reason: 'persist_failed',
      details: insertErr?.message ?? 'no row returned',
      correlationId,
    }
  }

  const derivationId = (inserted as { id: string }).id

  // 7. Link the job row if we were dispatched from the queue.
  if (opts.jobId) {
    try {
      await supabase
        .from('voice_dna_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
          derivation_id: derivationId,
        })
        .eq('id', opts.jobId)
    } catch (err) {
      log.warn('voice_dna_derive.job_link_failed', {
        event_type: 'voice_dna_derive',
        outcome: 'fail',
        data: { error: redactError(err), job_id: opts.jobId },
      })
    }
  }

  log.info('voice_dna_derive.success', {
    event_type: 'voice_dna_derive',
    outcome: 'ok',
    latency_ms: Date.now() - started,
    data: {
      derivation_id: derivationId,
      coordinator_emails_count: emails.length,
      draft_edits_count: edits.length,
      banned_count: derivation.banned_phrases.length,
      approved_count: derivation.approved_phrases.length,
      tone_count: derivation.tone_descriptors.length,
      principles_count: derivation.voice_principles.length,
      cost_dollars: costCents,
    },
  })

  return {
    ok: true,
    derivationId,
    derivation,
    sourceSummary,
    costCents,
    correlationId,
  }
}
