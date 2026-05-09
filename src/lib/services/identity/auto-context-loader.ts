/**
 * Bloom House: Auto-Context Loader (single source of truth)
 *
 * One canonical reader for `wedding_auto_context` notes. Every brain
 * that wants emotional truths about a couple — inquiry first reply,
 * follow-up, client onboarding, couple-portal Sage chat, post-tour
 * brief, review-response, re-engagement-drafter — calls THIS loader.
 *
 * Why one loader:
 *   - Sort + cap rules used to live in five different places with
 *     three different limits (5, 10, 14). Drift made some replies cite
 *     pinned notes and others miss them entirely.
 *   - The "do NOT quote verbatim" instruction was inlined per brain.
 *     A new brain forgetting to add it would leak a couple's grief
 *     mention into a public review reply. The loader now produces a
 *     pre-formatted brain block; the universal-rules layer carries the
 *     handling rule. Both safety nets live in one place.
 *   - When mig 255 lands `sensitive` + `expires_at` columns, only
 *     this loader needs to grow. The four wired brains inherit the
 *     change for free.
 *
 * Forensic record posture (Constitution §4): the loader NEVER
 * mutates. Pinning, archiving, expiry are coordinator-side concerns
 * handled by the lead-profile UI / API. The loader only reads.
 *
 * Failure mode: if the table query throws (RLS misfire, missing
 * column on a stale environment, network blip), `loadAutoContextForWedding`
 * returns `{ notes: [], brainBlock: null }`. Soft-context is enrichment;
 * a load failure must NEVER block a brain call.
 *
 * 2026-05-09 — Wave 1A.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface AutoContextNote {
  id: string
  body: string
  category: string | null
  source: string
  /** True when the note carries an emotional truth that must never be
   *  quoted back at the couple verbatim (health, grief, financial
   *  stress, mental health, family conflict). Coordinator-overridable. */
  sensitive: boolean
  /** Coordinator-flagged must-know — always renders first in the
   *  brain block. */
  pinned: boolean
  /** TTL for time-bound emotional truths. Notes with `expires_at` in
   *  the past are excluded by default. NULL = no TTL. */
  expires_at: string | null
  confidence: number | null
  captured_at: string
}

export interface LoadAutoContextOptions {
  /** Hard cap on returned notes. Default 12. */
  limit?: number
  /** When true, excludes rows where `expires_at <= now()`. Default true. */
  excludeExpired?: boolean
  /** Brain context formatting. Currently only `brain_block` is wired
   *  for prompt injection; the others are reserved for the UI / digest
   *  surfaces (Wave 1C / future). When set to anything other than
   *  `brain_block`, the loader still returns the structured `notes`
   *  array but `brainBlock` will be null. */
  format?: 'structured' | 'brain_block' | 'rollup'
}

/**
 * Load auto-context notes for a single wedding.
 *
 * Sort: pinned first, then `confidence DESC NULLS LAST, captured_at
 * DESC`. Capped at `limit`. Excludes `is_active=false` and (by
 * default) expired rows.
 *
 * The `brainBlock` is a pre-formatted COUPLE'S NOTES section ready to
 * paste into a system prompt assembly. When the wedding has zero
 * eligible notes the block is `null` so callers can skip the section
 * entirely (no empty header pollution).
 *
 * Sensitive + pinned notes are ALWAYS included in the brain block —
 * the universal-rules layer carries the handling rule that forbids
 * verbatim echo of sensitive content. Hiding sensitive notes from the
 * model would defeat the tone-shaping goal.
 */
export async function loadAutoContextForWedding(
  supabase: SupabaseClient,
  weddingId: string,
  options: LoadAutoContextOptions = {},
): Promise<{ notes: AutoContextNote[]; brainBlock: string | null }> {
  if (!weddingId) {
    return { notes: [], brainBlock: null }
  }

  const limit = options.limit ?? 12
  const excludeExpired = options.excludeExpired ?? true
  const format = options.format ?? 'brain_block'

  let notes: AutoContextNote[] = []

  try {
    let query = supabase
      .from('wedding_auto_context')
      .select(
        'id, body, category, source, sensitive, pinned, expires_at, confidence, created_at',
      )
      .eq('wedding_id', weddingId)
      .eq('is_active', true)
      // pinned-first then confidence (NULLS LAST handled below in JS so
      // a stale Supabase client without nullsLast support still sorts
      // correctly), then most-recent capture.
      .order('pinned', { ascending: false })
      .order('confidence', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit)

    if (excludeExpired) {
      // expires_at IS NULL OR expires_at > now()
      query = query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    }

    const { data, error } = await query

    if (error) {
      // Stale schema (mig 255 not applied yet) lands here with
      // "column ... does not exist". Retry with the legacy column
      // surface so the loader still returns useful data on
      // pre-mig-255 environments. Wave 1A ship-safe behaviour.
      const message = (error as { message?: string }).message ?? ''
      if (/column .* does not exist/i.test(message)) {
        const legacy = await supabase
          .from('wedding_auto_context')
          .select('id, body, category, source, pinned, confidence, created_at')
          .eq('wedding_id', weddingId)
          .eq('is_active', true)
          .order('pinned', { ascending: false })
          .order('confidence', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(limit)
        notes = ((legacy.data ?? []) as Array<{
          id: string
          body: string
          category: string | null
          source: string
          pinned: boolean
          confidence: number | null
          created_at: string
        }>).map((r) => ({
          id: r.id,
          body: r.body,
          category: r.category,
          source: r.source,
          sensitive: false,
          pinned: r.pinned === true,
          expires_at: null,
          confidence: r.confidence ?? null,
          captured_at: r.created_at,
        }))
      } else {
        // Any other error — return empty. Soft-context is enrichment.
        return { notes: [], brainBlock: null }
      }
    } else {
      notes = ((data ?? []) as Array<{
        id: string
        body: string
        category: string | null
        source: string
        sensitive: boolean | null
        pinned: boolean
        expires_at: string | null
        confidence: number | null
        created_at: string
      }>).map((r) => ({
        id: r.id,
        body: r.body,
        category: r.category,
        source: r.source,
        sensitive: r.sensitive === true,
        pinned: r.pinned === true,
        expires_at: r.expires_at,
        confidence: r.confidence ?? null,
        captured_at: r.created_at,
      }))
    }
  } catch {
    // Network / unexpected client error — return empty. Soft-context
    // failures must never block a brain call.
    return { notes: [], brainBlock: null }
  }

  if (notes.length === 0 || format !== 'brain_block') {
    return { notes, brainBlock: null }
  }

  return { notes, brainBlock: formatBrainBlock(notes) }
}

/**
 * Format a list of auto-context notes as a COUPLE'S NOTES block ready
 * for system-prompt insertion. The format intentionally stays terse:
 *
 *   --- COUPLE'S NOTES (DO NOT QUOTE VERBATIM) ---
 *   - [PINNED] (life_context) Jen mentioned starting a new job March 12.
 *   - (family) Bride's grandmother in poor health, may not attend.
 *   - [SENSITIVE] (health) Mum is sick (do not echo).
 *   - (preferences) Hates flowers, prefers candles + foliage.
 *   - (vendors) Loved Sweet Grass florals at sister's wedding.
 *   --- END COUPLE'S NOTES ---
 *
 * Rules:
 *   - PINNED prefix renders before category — coordinator emphasis
 *     should be the first thing the model sees on a line.
 *   - SENSITIVE prefix flags content the universal-rules layer treats
 *     as voice-shaping only (never echoed). Pinned + sensitive both
 *     render: `[PINNED][SENSITIVE]`.
 *   - Category falls back to `misc` so every line carries a tag — a
 *     model parsing the block can rely on the shape.
 *   - The header explicitly forbids verbatim quoting. The
 *     universal-rules SOFT-CONTEXT NOTES POLICY is the load-bearing
 *     rule; this header is a second reminder at the data site.
 */
export function formatBrainBlock(notes: AutoContextNote[]): string {
  const lines = notes.map((n) => {
    const tags: string[] = []
    if (n.pinned) tags.push('[PINNED]')
    if (n.sensitive) tags.push('[SENSITIVE]')
    const tagPrefix = tags.length > 0 ? `${tags.join('')} ` : ''
    const category = n.category && n.category.trim().length > 0 ? n.category : 'misc'
    return `- ${tagPrefix}(${category}) ${n.body}`
  })

  return [
    "--- COUPLE'S NOTES (DO NOT QUOTE VERBATIM) ---",
    ...lines,
    "--- END COUPLE'S NOTES ---",
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Wave 1C — venue-aggregate rollup
// ---------------------------------------------------------------------------
//
// Aggregate ≠ disclose.
//
// The per-couple loader above is the craft layer: Sage gets every
// emotional truth so a draft can land with appropriate tone. The
// aggregate rollup below is the strategy layer: the venue gets COUNTS
// and CATEGORIES so marketing decisions can reflect what couples are
// actually carrying. These two layers must not collapse.
//
// Hard rules for aggregate views (briefings, digests, intelligence
// engine, source-quality):
//   1. Theme rollups carry counts + trend deltas + category labels.
//   2. Exemplar bodies are included for color, but rows tagged
//      `sensitive=true` are redacted to a generic placeholder
//      ("(sensitive note redacted from rollup)"). The wedding_id is
//      retained on the exemplar so a coordinator-only follow-on UI
//      could deep-link, but UI surfaces MUST NOT name the couple
//      alongside a sensitive theme — that's the line we don't cross.
//   3. The categories that auto-flag sensitive (health, grief,
//      financial_stress, family_conflict, mental_health) are reported
//      as counts, never as quotes. Coordinator strategy doesn't need
//      the quote — it needs the volume.
//
// Sensitive-redaction defaults to ON. Brain prompts only — never UI.

const SENSITIVE_CATEGORIES = new Set<string>([
  'health',
  'grief',
  'financial_stress',
  'family_conflict',
  'mental_health',
])

export interface AutoContextThemeRollupExemplar {
  body: string
  sensitive: boolean
  weddingId: string
}

export interface AutoContextThemeRollup {
  category: string
  noteCount: number
  /** Distinct couples mentioning this category in the window. */
  weddingCount: number
  /** Percentage change vs the prior identical-length window. Returns 0
   *  when both windows are zero, 100 when prior was zero and current
   *  is non-zero. Capped at 999 to avoid runaway values dominating
   *  the prompt. */
  trendDelta: number
  /** Up to 3 short exemplars. Sensitive bodies are redacted. */
  exemplars: AutoContextThemeRollupExemplar[]
  /** True when ANY contributing note had sensitive=true OR the
   *  category itself is in the sensitive allowlist. Used by callers to
   *  apply the "do not name couples" rule when rendering. */
  containsSensitive: boolean
}

export interface AggregateAutoContextOptions {
  /** Hard cap on returned themes. Default 12 (covers all known
   *  categories + a buffer). */
  limit?: number
  /** Override the redaction placeholder. Defaults to the canonical
   *  string used across briefings + digests. */
  redactionPlaceholder?: string
}

const DEFAULT_REDACTION = '(sensitive note redacted from rollup)'

/**
 * Aggregate active wedding_auto_context notes by category for one
 * venue over the last `windowDays`, alongside the prior identical
 * window for trend deltas.
 *
 * Returns one row per category with:
 *   - noteCount, weddingCount, trendDelta
 *   - up to 3 exemplar bodies (sensitive ones replaced with a
 *     redaction placeholder; the wedding_id is preserved)
 *   - containsSensitive flag for downstream UI handling
 *
 * Sort: noteCount DESC, weddingCount DESC.
 *
 * Failure mode: any query error returns []. Aggregate views are
 * enrichment — never block a digest / briefing / detector.
 */
export async function aggregateAutoContextThemes(
  supabase: SupabaseClient,
  venueId: string,
  windowDays: number,
  options: AggregateAutoContextOptions = {},
): Promise<AutoContextThemeRollup[]> {
  if (!venueId || !Number.isFinite(windowDays) || windowDays <= 0) {
    return []
  }

  const limit = options.limit ?? 12
  const placeholder = options.redactionPlaceholder ?? DEFAULT_REDACTION

  const now = Date.now()
  const dayMs = 86_400_000
  const windowStartIso = new Date(now - windowDays * dayMs).toISOString()
  const priorStartIso = new Date(now - 2 * windowDays * dayMs).toISOString()
  const priorEndIso = windowStartIso

  // Two parallel reads. Defensive try/catch — schema variance between
  // pre-mig-255 and post-mig-255 environments is handled the same way
  // the per-wedding loader does (graceful degrade on column error).
  type Row = {
    body: string
    category: string | null
    sensitive: boolean | null
    pinned: boolean | null
    wedding_id: string
    created_at: string
  }

  async function fetchWindow(fromIso: string, toIso?: string): Promise<Row[]> {
    try {
      let q = supabase
        .from('wedding_auto_context')
        .select('body, category, sensitive, pinned, wedding_id, created_at')
        .eq('venue_id', venueId)
        .eq('is_active', true)
        .gte('created_at', fromIso)
      if (toIso) q = q.lt('created_at', toIso)
      const { data, error } = await q
      if (error) {
        const message = (error as { message?: string }).message ?? ''
        if (/column .* does not exist/i.test(message)) {
          // Pre-mig-255: no `sensitive` column. Re-fetch without it.
          let lq = supabase
            .from('wedding_auto_context')
            .select('body, category, pinned, wedding_id, created_at')
            .eq('venue_id', venueId)
            .eq('is_active', true)
            .gte('created_at', fromIso)
          if (toIso) lq = lq.lt('created_at', toIso)
          const legacy = await lq
          return ((legacy.data ?? []) as Array<Omit<Row, 'sensitive'>>).map(
            (r) => ({ ...r, sensitive: null }),
          )
        }
        return []
      }
      return (data ?? []) as Row[]
    } catch {
      return []
    }
  }

  const [currentRows, priorRows] = await Promise.all([
    fetchWindow(windowStartIso),
    fetchWindow(priorStartIso, priorEndIso),
  ])

  // Group prior counts by category for trend delta.
  const priorByCategory = new Map<string, number>()
  for (const r of priorRows) {
    const cat = (r.category && r.category.trim().length > 0 ? r.category : 'misc')
    priorByCategory.set(cat, (priorByCategory.get(cat) ?? 0) + 1)
  }

  // Group current rows by category.
  type Bucket = {
    notes: Row[]
    weddings: Set<string>
    sensitiveSeen: boolean
  }
  const buckets = new Map<string, Bucket>()
  for (const r of currentRows) {
    const cat = (r.category && r.category.trim().length > 0 ? r.category : 'misc')
    const b = buckets.get(cat) ?? { notes: [], weddings: new Set<string>(), sensitiveSeen: false }
    b.notes.push(r)
    if (r.wedding_id) b.weddings.add(r.wedding_id)
    if (r.sensitive === true || SENSITIVE_CATEGORIES.has(cat)) {
      b.sensitiveSeen = true
    }
    buckets.set(cat, b)
  }

  const rollups: AutoContextThemeRollup[] = []
  for (const [category, bucket] of buckets) {
    const noteCount = bucket.notes.length
    const priorCount = priorByCategory.get(category) ?? 0
    let trendDelta: number
    if (priorCount === 0) {
      trendDelta = noteCount === 0 ? 0 : 100
    } else {
      const raw = ((noteCount - priorCount) / priorCount) * 100
      trendDelta = Math.round(raw * 10) / 10
    }
    if (trendDelta > 999) trendDelta = 999
    if (trendDelta < -999) trendDelta = -999

    // Pick up to 3 exemplars, preferring pinned then most-recent.
    const sortedNotes = [...bucket.notes].sort((a, b) => {
      const ap = a.pinned === true ? 1 : 0
      const bp = b.pinned === true ? 1 : 0
      if (ap !== bp) return bp - ap
      return b.created_at.localeCompare(a.created_at)
    })
    const exemplars: AutoContextThemeRollupExemplar[] = []
    for (const n of sortedNotes) {
      if (exemplars.length >= 3) break
      const isSensitive =
        n.sensitive === true || SENSITIVE_CATEGORIES.has(category)
      exemplars.push({
        body: isSensitive ? placeholder : truncateExemplar(n.body),
        sensitive: isSensitive,
        weddingId: n.wedding_id,
      })
    }

    rollups.push({
      category,
      noteCount,
      weddingCount: bucket.weddings.size,
      trendDelta,
      exemplars,
      containsSensitive: bucket.sensitiveSeen,
    })
  }

  rollups.sort((a, b) => {
    if (b.noteCount !== a.noteCount) return b.noteCount - a.noteCount
    return b.weddingCount - a.weddingCount
  })

  return rollups.slice(0, limit)
}

function truncateExemplar(body: string): string {
  const cleaned = body.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= 160) return cleaned
  return cleaned.slice(0, 157) + '...'
}

/**
 * Format a list of theme rollups as a venue-aggregate brain block
 * ready for system-prompt insertion. Used by briefings, digests, and
 * the emotional-theme intelligence detector. UI surfaces (briefing
 * page, leads list) consume the structured rollup directly and
 * compose their own markup, which is why this returns a plain string
 * for prompts only.
 *
 * Sensitive bodies have already been redacted by
 * `aggregateAutoContextThemes`; this formatter does not re-redact.
 * It DOES suppress couple-naming when a category contains sensitive
 * content (per the doctrine note above), even though the rollup
 * exemplars carry wedding IDs.
 */
export function formatThemeRollupBlock(
  rollups: AutoContextThemeRollup[],
  options: { headerLabel?: string; maxThemes?: number } = {},
): string | null {
  const headerLabel =
    options.headerLabel ?? "EMOTIONAL THEMES (couples beyond logistics)"
  const cap = Math.max(1, Math.min(options.maxThemes ?? 8, 16))
  const filtered = rollups.filter((r) => r.noteCount > 0).slice(0, cap)
  if (filtered.length === 0) return null

  const lines = filtered.map((r) => {
    const trendPart =
      r.trendDelta === 0
        ? 'flat vs prior period'
        : r.trendDelta > 0
          ? `up ${r.trendDelta.toFixed(0)}% vs prior period`
          : `down ${Math.abs(r.trendDelta).toFixed(0)}% vs prior period`
    const exemplarPart = r.exemplars.length > 0
      ? r.exemplars
          .map((e) => `      • ${e.body}`)
          .join('\n')
      : ''
    const heading =
      `  - ${r.category}: ${r.noteCount} note${r.noteCount === 1 ? '' : 's'} ` +
      `from ${r.weddingCount} couple${r.weddingCount === 1 ? '' : 's'}, ` +
      `${trendPart}${r.containsSensitive ? ' [contains sensitive — do not name couples]' : ''}`
    return exemplarPart ? `${heading}\n${exemplarPart}` : heading
  })

  return `${headerLabel}:\n${lines.join('\n')}`
}

/**
 * Convenience wrapper for venue-aggregate brain calls. Returns the
 * rollup AND a pre-formatted block. Callers that just need the
 * structured rollup (intelligence-engine detector, source-quality
 * correlator) can ignore `block`; callers that paste straight into a
 * system prompt (briefings, digests) use the block.
 */
export async function loadVenueAutoContextRollup(
  supabase: SupabaseClient,
  venueId: string,
  windowDays: number,
  options: { headerLabel?: string; limit?: number; maxThemes?: number } = {},
): Promise<{ rollups: AutoContextThemeRollup[]; block: string | null }> {
  const rollups = await aggregateAutoContextThemes(
    supabase,
    venueId,
    windowDays,
    { limit: options.limit },
  )
  const block = formatThemeRollupBlock(rollups, {
    headerLabel: options.headerLabel,
    maxThemes: options.maxThemes,
  })
  return { rollups, block }
}
