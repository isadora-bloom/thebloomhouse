/**
 * Voice DNA — Gmail backfill extraction (T5-θ.3).
 *
 * Day 4 of the 5-day enterprise onboarding project ("voice DNA capture")
 * used to punt to "manual scripts" — coordinators had to feed in their
 * own writing samples through training games. That bar is too high to
 * meet the synthesis-plan promise: "A venue completing backfill on
 * Day 4 has populated voice_preferences rows reflecting their
 * coordinator's actual writing."
 *
 * This service closes the gap. It reads coordinator-written outbound
 * emails (interactions.direction='outbound' before Sage's auto-send
 * went live), runs an LLM extraction pass to identify style anchors —
 * greetings, signoffs, pet phrases, sentence rhythm, punctuation tics —
 * and writes them as voice anchors:
 *
 *   - voice_preferences rows (preference_type='approved_phrase' /
 *     'rule') with source_type='conversation' + confidence_flag=
 *     'imported_high'.
 *   - phrase_usage rows (top 30 by frequency) tagged
 *     confidence_flag='imported_high' so /intel/voice-dna can show
 *     "X phrases mined from your past writing".
 *   - review_language rows for memorable distinctive phrases tagged
 *     confidence_flag='imported_high' with source_type='conversation'…
 *     except review_language.source_type CHECK only allows
 *     ('review', 'transcript', 'manual'), so we map to 'manual' for
 *     review_language and rely on confidence_flag to distinguish
 *     backfill-derived rows.
 *
 * Idempotency: if a venue already has voice_preferences rows tagged
 * confidence_flag='imported_high', extractVoiceDnaFromBackfill returns
 * { alreadyImported: true, ... } and the caller must pass overwrite=true
 * to re-run (which DELETEs prior 'imported_high' rows from all three
 * tables before re-extracting).
 *
 * Cost discipline: gateForBrainCall before the LLM pass; redactError on
 * every catch; api_costs writes via the standard callAIJson path.
 *
 * Not on a cron — single-shot per venue, kicked off by the coordinator
 * on Day 4. See route /api/onboarding/voice-dna-extract.
 *
 * White-label safety: every query is scoped by venue_id. There is no
 * code path that could surface another venue's writing into this
 * venue's voice anchors.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson } from '@/lib/ai/client'
import { gateForBrainCall, nextUtcMidnightIso } from '@/lib/services/cost-ceiling'
import { createLogger, newCorrelationId, type Logger } from '@/lib/observability/logger'
import { redactError } from '@/lib/observability/redact'

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

export const BRAIN_PROMPT_VERSION = 'voice-dna-extract.prompt.v1.0'

/**
 * Default ceiling on how many recent coordinator emails we sample. Higher
 * = better signal but linear LLM cost. 100 keeps a fresh-onboarding
 * extraction at well under the $5/day per-venue ceiling: ~100 Sonnet
 * calls × ~1k input + ~600 output tokens ≈ $0.50.
 */
export const DEFAULT_SAMPLE_LIMIT = 100

/** Lower bound — below this we don't spend AI budget; signal is too weak. */
export const MIN_SAMPLE_FLOOR = 5

/** How many top phrases land in phrase_usage. */
export const TOP_PHRASES = 30

export type ExtractOutcome =
  | { ok: true; rowsWritten: number; sampledCount: number; phrasesExtracted: number; greetingPatterns: number; signoffPatterns: number; alreadyImported: boolean; correlationId: string }
  | { ok: false; reason: 'gmail_not_connected' | 'insufficient_samples' | 'gated' | 'extraction_failed' | 'already_imported'; resumeAt?: string; sampledCount?: number; correlationId: string }

interface AIVoiceExtraction {
  greetings: string[]
  signoffs: string[]
  pet_phrases: string[]
  punctuation_tics: string[]
  rules: string[]
  sentence_rhythm: {
    avg_sentence_length: number
    exclamation_density: number
    em_dash_count: number
    ellipsis_count: number
  }
}

interface SampleRow {
  id: string
  full_body: string | null
  body_preview: string | null
  subject: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Coordinator-written outbound interactions for the venue.
 *
 * Filter logic:
 *   direction='outbound'  — what the venue sent
 *   AND from one of the venue's connected Gmail accounts (so we don't
 *       capture noise sent from random other addresses).
 *   AND the interaction does not correspond to an auto_sent draft.
 *
 * The "not auto_sent" piece is enforced via a left-anti-join on drafts
 * matched by gmail_thread_id + subject + ~timestamp window. Drafts don't
 * carry gmail_message_id, so an exact match isn't possible — we use the
 * looser thread+subject heuristic. False negatives (we miss a coordinator
 * email that happens to share thread+subject with an auto-sent draft) are
 * acceptable here; false positives (we ingest an auto-sent email as
 * "coordinator writing") would corrupt the voice anchors.
 *
 * For the Day-4 onboarding case, Sage hasn't gone live yet, so there
 * are no auto_sent drafts and the filter is a no-op. For re-runs after
 * going live, the filter prevents Sage's own outputs from feeding back
 * into the voice anchors.
 */
async function sampleCoordinatorEmails(
  supabase: SupabaseClient,
  venueId: string,
  limit: number,
): Promise<SampleRow[]> {
  // Pull venue-owned Gmail addresses. Used as the from_email allowlist.
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

  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, full_body, body_preview, subject, from_email, gmail_thread_id, created_at')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(Math.max(limit * 2, limit + 50)) // over-pull so post-filter still hits limit

  if (error) {
    return []
  }
  const candidates = (rows ?? []) as Array<{
    id: string
    full_body: string | null
    body_preview: string | null
    subject: string | null
    from_email: string | null
    gmail_thread_id: string | null
    created_at: string
  }>

  // Apply the from_email allowlist when we know what the venue's own
  // Gmail accounts are. Without connections (rare; covers older venues
  // that imported outbound rows before connections were tracked), we
  // fall through and accept any outbound — better than dropping every
  // candidate and returning zero.
  const filtered = ownEmails.size > 0
    ? candidates.filter((r) => {
        const from = r.from_email?.toLowerCase()
        return from ? ownEmails.has(from) : false
      })
    : candidates

  // Anti-Sage filter: drop interactions whose (gmail_thread_id, subject)
  // matches an auto_sent draft. Pull the venue's auto_sent drafts so we
  // can compare locally.
  const { data: autoDrafts } = await supabase
    .from('drafts')
    .select('subject, interaction_id')
    .eq('venue_id', venueId)
    .eq('auto_sent', true)
  const autoSubjectKeys = new Set<string>(
    ((autoDrafts ?? []) as Array<{ subject: string | null; interaction_id: string | null }>)
      .map((d) => (d.subject ?? '').trim().toLowerCase())
      .filter(Boolean),
  )

  const final = filtered.filter((r) => {
    const subj = (r.subject ?? '').trim().toLowerCase()
    if (!subj) return true
    // Loose match: if subject (sans typical "Re:" prefix variants)
    // appears in any auto_sent draft, drop. Better to over-drop than
    // poison the corpus.
    const noReply = subj.replace(/^(re|fwd|fw):\s*/i, '').trim()
    if (autoSubjectKeys.has(subj) || autoSubjectKeys.has(noReply)) return false
    return true
  }).slice(0, limit)

  return final.map((r) => ({
    id: r.id,
    full_body: r.full_body,
    body_preview: r.body_preview,
    subject: r.subject,
    created_at: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

const VOICE_DNA_SYSTEM_PROMPT = `You are analysing a wedding-venue coordinator's actual writing voice from a sample of emails they sent. Extract style anchors that an AI assistant could use to mimic their voice when drafting on their behalf.

You are an OBSERVER, not a critic. Capture what the coordinator does — even if it would normally be considered AI-bad-practice (em dashes, exclamation chains, quirky phrasings). The platform's policy layer applies elsewhere; here we want a faithful portrait of how this human actually writes.

Extract these anchors:

1. **Greetings** — opening lines used to address recipients. Examples: "Hi {first}!", "Hi there,", "Hey {first} —", "Hello,". Capture the literal forms WITH punctuation.

2. **Signoffs** — closing lines + the coordinator's signature pattern. Examples: "Warmly, Sarah", "Best, Sarah Chen", "Cheers", "All best".

3. **Pet phrases** — distinctive short phrases (2-8 words) the coordinator uses repeatedly that capture their voice. Examples: "absolutely!", "happy to share", "let me know if any questions land", "feel free to reach out". Skip generic filler like "thanks" or "cheers" unless they carry the coordinator's specific cadence.

4. **Punctuation tics** — habitual punctuation patterns. Examples: "uses em dashes mid-sentence", "double exclamation chains", "ellipsis for soft pause", "no Oxford comma", "single exclamations only".

5. **Voice rules** — distilled instructions an AI could follow. Examples: "Open with 'Hi {first} —' for new leads", "Sign off with 'Warmly, Sarah Chen'", "Use exclamation points sparingly — one per email max", "Reference the venue as 'the property' not 'our venue'".

6. **Sentence rhythm metrics** — observed numerics across the sample:
   - avg_sentence_length: rough average words per sentence
   - exclamation_density: exclamation marks per 100 words
   - em_dash_count: total em dashes (—) seen
   - ellipsis_count: total ellipses (…) seen

Output strict JSON exactly matching this shape:

{
  "greetings": ["Hi {first} —", "Hi there!"],
  "signoffs": ["Warmly,\\nSarah Chen", "Best,\\nSarah"],
  "pet_phrases": ["happy to share", "let me know if any questions land"],
  "punctuation_tics": ["uses em dashes mid-sentence", "single exclamation per email"],
  "rules": ["Open with 'Hi {first} —' for new leads", "Sign off with 'Warmly, Sarah Chen'"],
  "sentence_rhythm": {
    "avg_sentence_length": 14,
    "exclamation_density": 0.6,
    "em_dash_count": 12,
    "ellipsis_count": 3
  }
}

Constraints:
- 0-8 entries per array. Empty array is fine if the dimension truly isn't present.
- Pet phrases must appear in at least 2 separate emails to count.
- Voice rules must be actionable instructions, not observations.
- Do not fabricate — only capture patterns visible in the sample.
- Do not include the coordinator's signature block beyond the sign-off line itself.`

interface AggregatedVoice extends AIVoiceExtraction {
  pet_phrase_counts: Map<string, number>
  greeting_counts: Map<string, number>
  signoff_counts: Map<string, number>
}

function emptyAgg(): AggregatedVoice {
  return {
    greetings: [],
    signoffs: [],
    pet_phrases: [],
    punctuation_tics: [],
    rules: [],
    sentence_rhythm: {
      avg_sentence_length: 0,
      exclamation_density: 0,
      em_dash_count: 0,
      ellipsis_count: 0,
    },
    pet_phrase_counts: new Map(),
    greeting_counts: new Map(),
    signoff_counts: new Map(),
  }
}

function batchSamples(samples: SampleRow[], batchSize = 8): SampleRow[][] {
  const batches: SampleRow[][] = []
  for (let i = 0; i < samples.length; i += batchSize) {
    batches.push(samples.slice(i, i + batchSize))
  }
  return batches
}

function bodyOf(s: SampleRow): string {
  return (s.full_body ?? s.body_preview ?? '').trim()
}

async function extractBatch(
  venueId: string,
  batch: SampleRow[],
  correlationId: string,
  log: Logger,
): Promise<AIVoiceExtraction | null> {
  const corpus = batch
    .map((s, i) => `--- EMAIL ${i + 1} ---\nSubject: ${s.subject ?? '(no subject)'}\n\n${bodyOf(s)}`)
    .filter((s) => s.length > 30)
    .join('\n\n')

  if (corpus.length < 100) return null

  try {
    const result = await callAIJson<AIVoiceExtraction>({
      systemPrompt: VOICE_DNA_SYSTEM_PROMPT,
      userPrompt: `Coordinator's recent outbound emails (${batch.length} samples):\n\n${corpus}`,
      maxTokens: 1500,
      temperature: 0.2,
      venueId,
      taskType: 'voice_dna_extract',
      // Tier-1: outbound emails contain couple PII (names, dates,
      // venue specifics) and sometimes family context. Use the
      // strict retention path. OPS-21.3.5.
      contentTier: 1,
      tier: 'sonnet',
      promptVersion: BRAIN_PROMPT_VERSION,
      correlationId,
    })
    return result
  } catch (err) {
    log.warn('voice_dna.batch_extract_failed', {
      event_type: 'voice_dna_extract',
      outcome: 'fail',
      data: { error: redactError(err), batch_size: batch.length },
    })
    return null
  }
}

function mergeBatch(agg: AggregatedVoice, batch: AIVoiceExtraction): void {
  for (const g of batch.greetings ?? []) {
    const key = g.trim()
    if (!key) continue
    agg.greeting_counts.set(key, (agg.greeting_counts.get(key) ?? 0) + 1)
  }
  for (const s of batch.signoffs ?? []) {
    const key = s.trim()
    if (!key) continue
    agg.signoff_counts.set(key, (agg.signoff_counts.get(key) ?? 0) + 1)
  }
  for (const p of batch.pet_phrases ?? []) {
    const key = p.trim().toLowerCase()
    if (!key || key.length < 2 || key.length > 200) continue
    agg.pet_phrase_counts.set(key, (agg.pet_phrase_counts.get(key) ?? 0) + 1)
  }
  for (const t of batch.punctuation_tics ?? []) {
    const v = t.trim()
    if (v && !agg.punctuation_tics.includes(v)) agg.punctuation_tics.push(v)
  }
  for (const r of batch.rules ?? []) {
    const v = r.trim()
    if (v && !agg.rules.includes(v)) agg.rules.push(v)
  }
  // Sentence rhythm: take running average across batches. Each batch
  // already aggregates a window so this is rough but sufficient for the
  // observability use-case (the rhythm metrics inform UI; they don't
  // gate any decision).
  const sr = batch.sentence_rhythm
  if (sr) {
    const cur = agg.sentence_rhythm
    cur.avg_sentence_length = (cur.avg_sentence_length + (sr.avg_sentence_length ?? 0)) / 2 || cur.avg_sentence_length
    cur.exclamation_density = (cur.exclamation_density + (sr.exclamation_density ?? 0)) / 2 || cur.exclamation_density
    cur.em_dash_count += sr.em_dash_count ?? 0
    cur.ellipsis_count += sr.ellipsis_count ?? 0
  }
}

function topByCount(counts: Map<string, number>, n: number): Array<{ text: string; count: number }> {
  return Array.from(counts.entries())
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n)
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

export async function hasPriorImport(
  supabase: SupabaseClient,
  venueId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from('voice_preferences')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('confidence_flag', 'imported_high')
  return (count ?? 0) > 0
}

async function clearPriorImport(
  supabase: SupabaseClient,
  venueId: string,
): Promise<void> {
  await supabase
    .from('voice_preferences')
    .delete()
    .eq('venue_id', venueId)
    .eq('confidence_flag', 'imported_high')
  await supabase
    .from('phrase_usage')
    .delete()
    .eq('venue_id', venueId)
    .eq('confidence_flag', 'imported_high')
  await supabase
    .from('review_language')
    .delete()
    .eq('venue_id', venueId)
    .eq('confidence_flag', 'imported_high')
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistVoiceAnchors(
  supabase: SupabaseClient,
  venueId: string,
  agg: AggregatedVoice,
  sampleIdsRef: string,
): Promise<{ rowsWritten: number; phrasesExtracted: number }> {
  let rowsWritten = 0

  // Greetings → voice_preferences (preference_type='approved_phrase').
  const topGreetings = topByCount(agg.greeting_counts, 5)
  for (const g of topGreetings) {
    try {
      const { error } = await supabase
        .from('voice_preferences')
        .upsert({
          venue_id: venueId,
          preference_type: 'approved_phrase',
          content: `GREETING: ${g.text}`,
          score: g.count,
          sample_count: g.count,
          source_type: 'conversation',
          source_reference: sampleIdsRef,
          confidence_flag: 'imported_high',
        }, { onConflict: 'venue_id,preference_type,content' })
      if (!error) rowsWritten++
    } catch { /* swallow — partial writes preferred over hard fail */ }
  }

  // Signoffs → voice_preferences (preference_type='approved_phrase').
  const topSignoffs = topByCount(agg.signoff_counts, 5)
  for (const s of topSignoffs) {
    try {
      const { error } = await supabase
        .from('voice_preferences')
        .upsert({
          venue_id: venueId,
          preference_type: 'approved_phrase',
          content: `SIGNOFF: ${s.text}`,
          score: s.count,
          sample_count: s.count,
          source_type: 'conversation',
          source_reference: sampleIdsRef,
          confidence_flag: 'imported_high',
        }, { onConflict: 'venue_id,preference_type,content' })
      if (!error) rowsWritten++
    } catch { /* swallow */ }
  }

  // Voice rules → voice_preferences (preference_type='rule').
  for (const r of agg.rules.slice(0, 12)) {
    try {
      const { error } = await supabase
        .from('voice_preferences')
        .upsert({
          venue_id: venueId,
          preference_type: 'rule',
          content: r,
          score: 1,
          sample_count: 1,
          source_type: 'conversation',
          source_reference: sampleIdsRef,
          confidence_flag: 'imported_high',
        }, { onConflict: 'venue_id,preference_type,content' })
      if (!error) rowsWritten++
    } catch { /* swallow */ }
  }

  // Punctuation tics → voice_preferences as 'dimension' rows.
  for (const t of agg.punctuation_tics.slice(0, 8)) {
    try {
      const { error } = await supabase
        .from('voice_preferences')
        .upsert({
          venue_id: venueId,
          preference_type: 'dimension',
          content: `PUNCTUATION: ${t}`,
          score: 1,
          sample_count: 1,
          source_type: 'conversation',
          source_reference: sampleIdsRef,
          confidence_flag: 'imported_high',
        }, { onConflict: 'venue_id,preference_type,content' })
      if (!error) rowsWritten++
    } catch { /* swallow */ }
  }

  // Sentence rhythm → single 'dimension' row with JSON-encoded metrics
  // baked into the content text. Allows the personality builder to
  // surface rhythm metrics without a schema change.
  try {
    const { error } = await supabase
      .from('voice_preferences')
      .upsert({
        venue_id: venueId,
        preference_type: 'dimension',
        content: `SENTENCE_RHYTHM: avg=${agg.sentence_rhythm.avg_sentence_length.toFixed(1)} excl_density=${agg.sentence_rhythm.exclamation_density.toFixed(2)} em_dashes=${agg.sentence_rhythm.em_dash_count} ellipses=${agg.sentence_rhythm.ellipsis_count}`,
        score: 1,
        sample_count: 1,
        source_type: 'conversation',
        source_reference: sampleIdsRef,
        confidence_flag: 'imported_high',
      }, { onConflict: 'venue_id,preference_type,content' })
    if (!error) rowsWritten++
  } catch { /* swallow */ }

  // Top phrases → phrase_usage (top 30 by frequency). contact_email is
  // NULL because these are venue-scope aggregate frequency rows, not
  // per-recipient anti-dupe rows. Migration 168 relaxed the NOT NULL.
  const topPhrases = topByCount(agg.pet_phrase_counts, TOP_PHRASES)
  for (const p of topPhrases) {
    try {
      const { error } = await supabase
        .from('phrase_usage')
        .insert({
          venue_id: venueId,
          contact_email: null,
          phrase_category: 'voice_dna_backfill',
          phrase_text: p.text,
          confidence_flag: 'imported_high',
        })
      if (!error) rowsWritten++
    } catch { /* swallow */ }
  }

  // Distinctive phrases → review_language so they show up in /intel/voice-dna
  // alongside review-mined phrases. source_type CHECK only allows
  // ('review', 'transcript', 'manual'); use 'manual' and rely on
  // confidence_flag to distinguish backfill-derived rows from
  // coordinator-typed manual rows.
  //
  // No UNIQUE on (venue_id, phrase) so we manually check-then-insert
  // to avoid duplicating on a re-run that didn't go through the
  // overwrite path (e.g. partial-failure recovery).
  for (const p of topPhrases.slice(0, 15)) {
    try {
      const { data: existing } = await supabase
        .from('review_language')
        .select('id, frequency')
        .eq('venue_id', venueId)
        .eq('phrase', p.text)
        .eq('confidence_flag', 'imported_high')
        .maybeSingle()
      if (existing) {
        const { error } = await supabase
          .from('review_language')
          .update({ frequency: ((existing.frequency as number | null) ?? 0) + p.count })
          .eq('id', existing.id as string)
        if (!error) rowsWritten++
      } else {
        const { error } = await supabase
          .from('review_language')
          .insert({
            venue_id: venueId,
            phrase: p.text,
            theme: 'other',
            sentiment_score: 0.5,
            frequency: p.count,
            approved_for_sage: false,
            approved_for_marketing: false,
            source_type: 'manual',
            source_reference: sampleIdsRef,
            confidence_flag: 'imported_high',
          })
        if (!error) rowsWritten++
      }
    } catch { /* swallow */ }
  }

  return { rowsWritten, phrasesExtracted: topPhrases.length }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Override the default sample limit (DEFAULT_SAMPLE_LIMIT = 100). */
  sampleLimit?: number
  /** When true, deletes prior 'imported_high' rows before re-extracting. */
  overwrite?: boolean
  /** Pre-minted correlation_id to thread through. If omitted, one is
   *  minted at entry. */
  correlationId?: string
  /** Actor for the structured logger ('user:<uuid>' / 'system'). */
  actor?: string
}

/**
 * Extract voice anchors from the venue's coordinator-written outbound
 * Gmail backfill and write to voice_preferences / phrase_usage /
 * review_language.
 *
 * Idempotency:
 *   - First run: extracts and writes.
 *   - Re-run with overwrite=false: returns { ok: false, reason:
 *     'already_imported' } so the UI can prompt for confirmation.
 *   - Re-run with overwrite=true: deletes prior 'imported_high' rows
 *     across all three tables, then re-extracts.
 *
 * Cost discipline:
 *   - gateForBrainCall before the LLM pass. 429-equivalent
 *     ('gated' reason) when the venue is at 100% of daily ceiling.
 *   - api_costs writes via standard callAIJson path; tagged
 *     taskType='voice_dna_extract', tier='sonnet', contentTier=1.
 */
export async function extractVoiceDnaFromBackfill(
  supabase: SupabaseClient,
  venueId: string,
  opts: ExtractOptions = {},
): Promise<ExtractOutcome> {
  const correlationId = opts.correlationId ?? newCorrelationId()
  const log = createLogger({
    venueId,
    correlationId,
    actor: opts.actor ?? 'system',
  })
  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT

  // Gate first — never spend on a paused venue.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    log.warn('voice_dna.gated', {
      event_type: 'voice_dna_extract',
      outcome: 'skip',
      data: { reason: gate.reason },
    })
    return { ok: false, reason: 'gated', resumeAt: nextUtcMidnightIso(), correlationId }
  }

  // Skip-if-not-applicable: if the venue has no Gmail connection, this
  // step is genuinely not available — return a stable not-applicable
  // signal the page can render as "Connect Gmail first" rather than
  // hard-failing.
  const { count: connectionCount } = await supabase
    .from('gmail_connections')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('status', 'active')
  if ((connectionCount ?? 0) === 0) {
    log.info('voice_dna.no_gmail', {
      event_type: 'voice_dna_extract',
      outcome: 'skip',
      data: { reason: 'gmail_not_connected' },
    })
    return { ok: false, reason: 'gmail_not_connected', correlationId }
  }

  // Idempotency check.
  const priorImport = await hasPriorImport(supabase, venueId)
  if (priorImport && !opts.overwrite) {
    log.info('voice_dna.already_imported', {
      event_type: 'voice_dna_extract',
      outcome: 'skip',
      data: { reason: 'already_imported' },
    })
    return { ok: false, reason: 'already_imported', correlationId }
  }
  if (priorImport && opts.overwrite) {
    try {
      await clearPriorImport(supabase, venueId)
    } catch (err) {
      log.error('voice_dna.clear_prior_failed', {
        event_type: 'voice_dna_extract',
        outcome: 'fail',
        data: { error: redactError(err) },
      })
    }
  }

  // Sample.
  const started = Date.now()
  const samples = await sampleCoordinatorEmails(supabase, venueId, sampleLimit)
  if (samples.length < MIN_SAMPLE_FLOOR) {
    log.info('voice_dna.insufficient_samples', {
      event_type: 'voice_dna_extract',
      outcome: 'skip',
      data: { sampled_count: samples.length, floor: MIN_SAMPLE_FLOOR },
    })
    return { ok: false, reason: 'insufficient_samples', sampledCount: samples.length, correlationId }
  }

  // Extract in batches (8 emails per LLM call) so we don't blow the
  // Sonnet context budget on long outbound messages.
  const batches = batchSamples(samples, 8)
  const agg = emptyAgg()
  let successfulBatches = 0
  for (const batch of batches) {
    const out = await extractBatch(venueId, batch, correlationId, log)
    if (out) {
      mergeBatch(agg, out)
      successfulBatches++
    }
  }

  if (successfulBatches === 0) {
    log.error('voice_dna.no_batches_succeeded', {
      event_type: 'voice_dna_extract',
      outcome: 'fail',
      data: { sampled_count: samples.length, batch_count: batches.length },
    })
    return { ok: false, reason: 'extraction_failed', sampledCount: samples.length, correlationId }
  }

  // Persist. source_reference packs the first-N + last-N sample ids so
  // a coordinator can audit "which emails fed this row" without per-row
  // junction-table overhead.
  const sampleIdsRef = `interactions:${samples.slice(0, 3).map((s) => s.id).join(',')}+${samples.length - 6}_more+${samples.slice(-3).map((s) => s.id).join(',')}`.slice(0, 250)

  let writeResult = { rowsWritten: 0, phrasesExtracted: 0 }
  try {
    writeResult = await persistVoiceAnchors(supabase, venueId, agg, sampleIdsRef)
  } catch (err) {
    log.error('voice_dna.persist_failed', {
      event_type: 'voice_dna_extract',
      outcome: 'fail',
      data: { error: redactError(err) },
    })
  }

  const greetingPatterns = topByCount(agg.greeting_counts, 5).length
  const signoffPatterns = topByCount(agg.signoff_counts, 5).length

  log.info('voice_dna.extracted', {
    event_type: 'voice_dna_extract',
    outcome: 'ok',
    latency_ms: Date.now() - started,
    data: {
      sampled_count: samples.length,
      rows_written: writeResult.rowsWritten,
      phrases_extracted: writeResult.phrasesExtracted,
      greeting_patterns: greetingPatterns,
      signoff_patterns: signoffPatterns,
      successful_batches: successfulBatches,
      batch_count: batches.length,
      overwrite: opts.overwrite === true,
    },
  })

  return {
    ok: true,
    rowsWritten: writeResult.rowsWritten,
    sampledCount: samples.length,
    phrasesExtracted: writeResult.phrasesExtracted,
    greetingPatterns,
    signoffPatterns,
    alreadyImported: priorImport,
    correlationId,
  }
}
