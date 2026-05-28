/**
 * scripts/replay-backlog-drafts.ts
 * ================================
 * Backlog Sage-draft replay for two operator-curated cohorts of stale
 * Rixey interactions (2026-05-27).
 *
 * BACKGROUND
 * ----------
 * Today's inbox-misclassification fix (commit 4b05c44) is the upstream
 * repair — going forward every calculator submission and warm reply gets
 * unifiedVerdict stamped + a draft generated. Historical rows that landed
 * BEFORE the fix never got that treatment; the operator audited Gmail
 * this morning and surfaced two cohorts that need a draft minted by hand:
 *
 *   Cohort A (calc)   — 10 calculator submissions, no Sage reply.
 *                       Re-run `generateInquiryDraft` with taskType
 *                       'new_inquiry' + source 'website' (calculator is
 *                       served from the venue's own site).
 *
 *   Cohort B (urgent) — 6 inbox items that need a human-touch reply
 *                       today. ONE of them (Cynthia Johanson) explicitly
 *                       asked for a real person — Sage replied twice and
 *                       she still needs human voice. The script mints a
 *                       low-Sage, high-personal draft for her (NOT routed
 *                       through generateInquiryDraft so the AI-disclosure
 *                       phrasing doesn't sneak back in). The other 5 in
 *                       cohort B get `generateInquiryDraft` as usual.
 *
 * MATCHING
 * --------
 * Operator's list is human-readable (first names, partial dates), not
 * DB-precise. For each cohort entry the script searches `interactions` by:
 *   (a) from_name OR from_email containing any name token (case-insensitive)
 *   (b) timestamp within ±2 days of the stated date
 *   (c) direction='inbound'
 *   (d) venue_id matches --venue-id
 *
 * Resolution buckets:
 *   - matched (single best candidate, unambiguous)
 *   - ambiguous (>1 candidate) — flagged for operator review in --apply
 *   - unfound (zero candidates) — surfaced as information for the operator
 *
 * SAFETY
 * ------
 * - service_role key is read from `process.env.BRANCH_KEY` — NEVER
 *   written into this file.
 * - Refuses to run against the prod project ref `jsxxgwprxuqgcauzlxcb`
 *   unless `--allow-prod` is explicitly passed.
 * - Default mode is DRY-RUN. `--apply` is required for any write.
 * - Idempotent: skips entries that already have a non-rejected draft
 *   on the same interaction.
 * - Per-entry try/catch — one entry's failure never aborts the batch.
 * - --venue-id <uuid> is REQUIRED so the operator has to think about
 *   scope on every run.
 *
 * USAGE
 * -----
 *   # dry-run, all cohorts, against the prod ref
 *   BRANCH_URL=https://jsxxgwprxuqgcauzlxcb.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/replay-backlog-drafts.ts \
 *     --venue-id f3d10226-4c5c-47ad-b89b-98ad63842492 \
 *     --allow-prod
 *
 *   # apply just the calculator cohort
 *   BRANCH_URL=... BRANCH_KEY=... \
 *   npx tsx scripts/replay-backlog-drafts.ts \
 *     --venue-id f3d10226-4c5c-47ad-b89b-98ad63842492 \
 *     --cohort calc \
 *     --apply --allow-prod
 *
 * VERIFIED SHAPE FACTS
 * --------------------
 *  - `interactions` columns used here:
 *      id, venue_id, wedding_id, direction, type, subject, from_email,
 *      from_name, full_body, body_preview, timestamp, gmail_thread_id,
 *      gmail_connection_id, intent_class
 *    (002_agent_tables.sql + 063_interactions_sender_fields.sql)
 *
 *  - `drafts` insert shape mirrors the canonical pipeline insert at
 *    src/lib/services/email/pipeline.ts:4608-4628:
 *      venue_id, wedding_id, interaction_id, to_email, subject,
 *      draft_body, original_sage_body, status='pending',
 *      context_type='inquiry', brain_used='inquiry' (or 'manual_human'
 *      for the Cynthia branch), confidence_score, auto_sent=false,
 *      prompt_version_used, correlation_id.
 *
 *  - For the Cynthia (human-voice) branch we mint a draft directly
 *    WITHOUT calling the inquiry brain — using brain_used='manual_human'
 *    and prompt_version_used='manual-human.replay.v1' so it's
 *    distinguishable in `drafts` analytics. The text is a short, low-Sage
 *    nudge from Isadora offering a real call.
 */
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// .env.local hydration (same pattern as scripts/recover-gmail-window.ts).
// Brain code under src/ reads ANTHROPIC_API_KEY + Supabase URLs from env at
// import time, so we hydrate process.env BEFORE dynamic-importing the brain.
// ---------------------------------------------------------------------------
try {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
  for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
} catch {
  // .env.local is optional — BRANCH_URL / BRANCH_KEY can be set directly
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROD_REF = 'jsxxgwprxuqgcauzlxcb'
const MATCH_WINDOW_DAYS = 2

// ---------------------------------------------------------------------------
// Cohort definitions — operator's audit list, verbatim.
// ---------------------------------------------------------------------------

type CohortKind = 'calc' | 'urgent'

interface CohortEntry {
  cohort: CohortKind
  /** Display label — what the operator wrote. */
  label: string
  /**
   * Name tokens to OR-search against from_name and from_email.
   * Lowercase. Use distinctive tokens (first + last names). The matcher
   * already case-folds, so just enter natural casing or lowercase.
   */
  nameTokens: string[]
  /** Anchor date for the ±MATCH_WINDOW_DAYS lookup. ISO date string. */
  anchorDate: string
  /**
   * Optional override for the human-voice path in cohort B. When true,
   * the script mints a hand-written draft offering a real call instead
   * of routing through generateInquiryDraft.
   */
  humanVoice?: boolean
  /** Optional note rendered in dry-run output. */
  note?: string
}

const COHORTS: CohortEntry[] = [
  // --- Cohort A: 10 calculator submissions, no Sage reply ----------------
  { cohort: 'calc', label: 'Ava Rowse & Tuvia Reback',  nameTokens: ['ava', 'rowse', 'tuvia', 'reback'],   anchorDate: '2026-05-26' },
  { cohort: 'calc', label: 'Ellie Tidman & Braden Mills', nameTokens: ['ellie', 'tidman', 'braden', 'mills'], anchorDate: '2026-05-26' },
  { cohort: 'calc', label: 'Peyton',                     nameTokens: ['peyton'],                              anchorDate: '2026-05-20' },
  { cohort: 'calc', label: 'Jennifer & Robert',          nameTokens: ['jennifer', 'robert'],                  anchorDate: '2026-05-18' },
  { cohort: 'calc', label: 'Miya Washington & Ethan Aus', nameTokens: ['miya', 'washington', 'ethan', 'aus'], anchorDate: '2026-05-17' },
  { cohort: 'calc', label: 'Rachel',                     nameTokens: ['rachel'],                              anchorDate: '2026-05-11' },
  { cohort: 'calc', label: 'Ethan Thomas',               nameTokens: ['ethan', 'thomas'],                     anchorDate: '2026-04-27' },
  { cohort: 'calc', label: 'Glenda Barfell',             nameTokens: ['glenda', 'barfell'],                   anchorDate: '2026-05-14' },
  { cohort: 'calc', label: 'Emma Bergstedt',             nameTokens: ['emma', 'bergstedt'],                   anchorDate: '2026-05-14' },
  { cohort: 'calc', label: 'Shannon Traynor',            nameTokens: ['shannon', 'traynor'],                  anchorDate: '2026-05-04' },

  // --- Cohort B: 6 urgent personal replies needed today ------------------
  {
    cohort: 'urgent',
    label: 'Cynthia Johanson',
    nameTokens: ['cynthia', 'johanson'],
    anchorDate: '2026-05-27',
    humanVoice: true,
    note: 'Asked for a real person; Sage replied twice. Mint a human-voice nudge offering a call.',
  },
  {
    cohort: 'urgent',
    label: 'Jocelyn Wiese',
    nameTokens: ['jocelyn', 'wiese'],
    anchorDate: '2026-05-27',
    note: 'Post-tour thank-you + follow-up about April 2027 date.',
  },
  {
    cohort: 'urgent',
    label: 'Sarah D & Arlie M (Zola)',
    nameTokens: ['sarah', 'arlie'],
    anchorDate: '2026-05-27',
    note: 'New Zola inquiry this morning, $65k budget.',
  },
  {
    cohort: 'urgent',
    label: 'Erin A & Zachary G (Zola)',
    nameTokens: ['erin', 'zachary'],
    anchorDate: '2026-05-22',
    note: 'Zola inquiry, $30-40k, Oct 2027.',
  },
  {
    cohort: 'urgent',
    label: 'Olivia & Vishal (operationolivish)',
    // Distinctive handle "operationolivish" is a strong from_email signal.
    nameTokens: ['olivia', 'vishal', 'operationolivish'],
    anchorDate: '2026-05-22',
    note: '110 guests, Sept 2027. Also toured May 25 — match the earliest inquiry.',
  },
  {
    cohort: 'urgent',
    label: 'Kristiana Leicht',
    nameTokens: ['kristiana', 'leicht'],
    anchorDate: '2026-05-11',
    note: 'Replied questioning AI message content on May 11; never followed up.',
  },
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CliArgs {
  cohort: 'calc' | 'urgent' | 'all'
  apply: boolean
  allowProd: boolean
  venueId: string
  /**
   * Operator-supplied disambiguation map: label → interaction_id.
   * Bypasses the matcher for that label and uses the given interaction
   * directly. Set via repeated `--pick "<label>=<uuid>"` flags.
   * Lookup is case-insensitive on label.
   */
  picks: Record<string, string>
  /**
   * If true, only process entries that have a --pick override. Lets the
   * operator replay just the disambiguated rows without touching the rest.
   */
  picksOnly: boolean
}

interface InteractionRow {
  id: string
  venue_id: string
  wedding_id: string | null
  direction: string
  type: string | null
  subject: string | null
  from_email: string | null
  from_name: string | null
  full_body: string | null
  body_preview: string | null
  timestamp: string
  gmail_thread_id: string | null
  gmail_connection_id: string | null
  intent_class: string | null
}

interface ExistingDraftRow {
  id: string
  status: string | null
  created_at: string | null
}

type ResolveOutcome =
  | { kind: 'matched'; interaction: InteractionRow; candidates: number }
  | { kind: 'ambiguous'; candidates: InteractionRow[] }
  | { kind: 'unfound' }

interface ReplayStats {
  total: number
  matched: number
  ambiguous: number
  unfound: number
  skippedExistingDraft: number
  wroteDraft: number
  errored: number
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2)
  const cohortArg = (() => {
    const i = argv.indexOf('--cohort')
    if (i === -1) return 'all' as const
    const v = argv[i + 1]
    if (v !== 'calc' && v !== 'urgent' && v !== 'all') {
      console.error(`ERROR: --cohort must be calc|urgent|all (got "${v}")`)
      process.exit(1)
    }
    return v
  })()
  const venueArg = (() => {
    const i = argv.indexOf('--venue-id')
    if (i === -1) return null
    return argv[i + 1] ?? null
  })()
  if (!venueArg) {
    console.error('ERROR: --venue-id <uuid> is required')
    process.exit(1)
  }
  if (!/^[0-9a-f-]{36}$/i.test(venueArg)) {
    console.error(`ERROR: --venue-id must be a UUID (got "${venueArg}")`)
    process.exit(1)
  }
  // --pick "Label=<uuid>" — may be repeated
  const picks: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--pick') continue
    const val = argv[i + 1] ?? ''
    const eq = val.indexOf('=')
    if (eq === -1) {
      console.error(`ERROR: --pick expects "<label>=<uuid>" (got "${val}")`)
      process.exit(1)
    }
    const label = val.slice(0, eq).trim()
    const id = val.slice(eq + 1).trim()
    if (!label || !/^[0-9a-f-]{36}$/i.test(id)) {
      console.error(`ERROR: --pick "${val}" is malformed (need label=uuid)`)
      process.exit(1)
    }
    picks[label.toLowerCase()] = id
  }

  return {
    cohort: cohortArg,
    apply: argv.includes('--apply'),
    allowProd: argv.includes('--allow-prod'),
    venueId: venueArg,
    picks,
    picksOnly: argv.includes('--picks-only'),
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24)
}

/**
 * Build a Supabase OR-filter string that matches from_name OR from_email
 * containing ANY of the entry's name tokens (case-insensitive).
 */
function buildNameOrFilter(tokens: string[]): string {
  const parts: string[] = []
  for (const t of tokens) {
    const safe = t.replace(/[%,()]/g, '') // strip PostgREST OR-syntax chars
    if (!safe) continue
    parts.push(`from_name.ilike.%${safe}%`)
    parts.push(`from_email.ilike.%${safe}%`)
  }
  return parts.join(',')
}

/**
 * Score a candidate by (a) distinct token hits across name/email/subject
 * (b) date closeness. Lower distance = better; higher tokens = better.
 * Returns null if the candidate is outside the date window or has zero
 * token hits (defense in depth — the ilike OR should already filter).
 */
function scoreCandidate(
  row: InteractionRow,
  entry: CohortEntry,
): { tokenHits: number; daysAway: number } | null {
  const tokens = entry.nameTokens.map((t) => t.toLowerCase())
  const hay = [
    row.from_name ?? '',
    row.from_email ?? '',
    row.subject ?? '',
  ]
    .join(' ')
    .toLowerCase()
  const tokenHits = tokens.filter((t) => hay.includes(t)).length
  if (tokenHits === 0) return null

  const anchor = new Date(entry.anchorDate + 'T12:00:00Z')
  const occurred = new Date(row.timestamp)
  const daysAway = daysBetween(anchor, occurred)
  if (daysAway > MATCH_WINDOW_DAYS) return null

  return { tokenHits, daysAway }
}

async function resolveEntry(
  supabase: SupabaseClient,
  venueId: string,
  entry: CohortEntry,
): Promise<ResolveOutcome> {
  const anchor = new Date(entry.anchorDate + 'T12:00:00Z')
  const since = new Date(anchor.getTime() - MATCH_WINDOW_DAYS * 86400 * 1000).toISOString()
  const until = new Date(anchor.getTime() + MATCH_WINDOW_DAYS * 86400 * 1000).toISOString()

  const orFilter = buildNameOrFilter(entry.nameTokens)
  if (!orFilter) return { kind: 'unfound' }

  const { data, error } = await supabase
    .from('interactions')
    .select(
      'id, venue_id, wedding_id, direction, type, subject, from_email, from_name, ' +
        'full_body, body_preview, timestamp, gmail_thread_id, gmail_connection_id, intent_class',
    )
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .gte('timestamp', since)
    .lte('timestamp', until)
    .or(orFilter)
    .order('timestamp', { ascending: true })
    .limit(50)

  if (error) {
    console.error(`  search error for "${entry.label}": ${error.message}`)
    return { kind: 'unfound' }
  }

  const rows = (data ?? []) as unknown as InteractionRow[]
  const scored = rows
    .map((r) => ({ row: r, score: scoreCandidate(r, entry) }))
    .filter(
      (s): s is { row: InteractionRow; score: { tokenHits: number; daysAway: number } } =>
        s.score !== null,
    )

  if (scored.length === 0) return { kind: 'unfound' }

  // Sort: more token hits first, then closer in time.
  scored.sort((a, b) => {
    if (b.score.tokenHits !== a.score.tokenHits) return b.score.tokenHits - a.score.tokenHits
    return a.score.daysAway - b.score.daysAway
  })

  // Single hit OR a clear winner (more token hits than the runner-up).
  if (scored.length === 1) {
    return { kind: 'matched', interaction: scored[0].row, candidates: 1 }
  }
  if (scored[0].score.tokenHits > scored[1].score.tokenHits) {
    return { kind: 'matched', interaction: scored[0].row, candidates: scored.length }
  }
  // Tie on token hits — only safe if one is dramatically closer in time
  // (within half a day, and the runner-up is at least a full day away).
  const a = scored[0].score
  const b = scored[1].score
  if (a.daysAway < 0.5 && b.daysAway > 1) {
    return { kind: 'matched', interaction: scored[0].row, candidates: scored.length }
  }
  return { kind: 'ambiguous', candidates: scored.map((s) => s.row) }
}

// ---------------------------------------------------------------------------
// Existing-draft check (idempotency)
// ---------------------------------------------------------------------------

async function findExistingNonRejectedDraft(
  supabase: SupabaseClient,
  interactionId: string,
): Promise<ExistingDraftRow | null> {
  const { data, error } = await supabase
    .from('drafts')
    .select('id, status, created_at')
    .eq('interaction_id', interactionId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error(`  existing-draft lookup failed for ${interactionId}: ${error.message}`)
    // Fail safe — refuse to write if we can't confirm idempotency.
    return { id: 'unknown', status: 'unknown', created_at: null }
  }
  const rows = (data ?? []) as ExistingDraftRow[]
  // "non-rejected" = anything that is NOT explicitly rejected / cancelled.
  // Status vocabulary in mig 002 + downstream: pending, sent, auto_sent,
  // auto_send_pending, auto_send_sending, rejected, cancelled.
  for (const r of rows) {
    const s = (r.status ?? '').toLowerCase()
    if (s !== 'rejected' && s !== 'cancelled') return r
  }
  return null
}

// ---------------------------------------------------------------------------
// Human-voice draft for Cynthia branch
// ---------------------------------------------------------------------------

function buildHumanVoiceDraft(opts: { firstName: string }): string {
  const { firstName } = opts
  return [
    `Hi ${firstName},`,
    '',
    "It's Isadora — the owner of Rixey Manor. I saw your note and want to be the one to follow up with you directly.",
    '',
    "I'd love to jump on a quick call this week (or meet in person at the manor if that's easier) so we can talk through what you're picturing without anything getting lost in email.",
    '',
    "What times work best for you over the next few days? Mornings are usually open for me, and I'm happy to make evenings work too if that fits your schedule better.",
    '',
    'Looking forward to hearing from you,',
    'Isadora',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Draft generation + insert
// ---------------------------------------------------------------------------

function extractFirstName(row: InteractionRow): string {
  const fromName = (row.from_name ?? '').trim()
  if (fromName) {
    const first = fromName.split(/\s+/)[0]
    if (first && first.length < 30) return first
  }
  // Fallback: local-part of the email.
  const email = row.from_email ?? ''
  const local = email.split('@')[0]
  if (local) return local.replace(/[._-]+/g, ' ').split(' ')[0] || 'there'
  return 'there'
}

function extractQuestionsFromBody(body: string | null): string[] {
  if (!body) return []
  return body
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith('?') && s.length > 10 && s.length < 300)
    .slice(0, 5)
}

async function fetchReceivedAtAddress(
  supabase: SupabaseClient,
  connectionId: string | null,
): Promise<string | null> {
  if (!connectionId) return null
  const { data } = await supabase
    .from('gmail_connections')
    .select('email_address')
    .eq('id', connectionId)
    .maybeSingle()
  return (data?.email_address as string | undefined) ?? null
}

async function generateAndInsertDraft(
  supabase: SupabaseClient,
  entry: CohortEntry,
  interaction: InteractionRow,
  args: CliArgs,
  stats: ReplayStats,
): Promise<void> {
  // Idempotency gate — applies in dry-run too so the operator can see the
  // skip reason before flipping to --apply.
  const existing = await findExistingNonRejectedDraft(supabase, interaction.id)
  if (existing) {
    console.log(
      `  SKIP — non-rejected draft already exists (id=${existing.id} status=${existing.status})`,
    )
    stats.skippedExistingDraft++
    return
  }

  const fromEmail = interaction.from_email ?? null
  if (!fromEmail) {
    console.log(`  SKIP — interaction has no from_email; cannot mint reply`)
    stats.errored++
    return
  }

  const body = interaction.full_body ?? interaction.body_preview ?? ''
  const subject = interaction.subject ?? ''
  const draftSubject = `Re: ${subject.replace(/^(Re:\s*)+/i, '')}`
  const correlationId = `replay-backlog-${Date.now()}-${interaction.id.slice(0, 8)}`

  let draftBody: string
  let brainUsed: string
  let promptVersionUsed: string
  let confidenceScore: number | null = null

  if (entry.humanVoice) {
    // ---- Cynthia branch — bypass the brain, use a hand-written nudge. -----
    const firstName = extractFirstName(interaction)
    draftBody = buildHumanVoiceDraft({ firstName })
    brainUsed = 'manual_human'
    promptVersionUsed = 'manual-human.replay.v1'
    console.log(
      `  prepared HUMAN-VOICE draft (${draftBody.length} chars) — bypasses Sage brain`,
    )
  } else {
    // ---- Standard cohort A + B branch — re-run inquiry brain. ------------
    const receivedAtAddress = await fetchReceivedAtAddress(
      supabase,
      interaction.gmail_connection_id,
    )

    // Body-derived hints (mirrors retro-draft-calculator-leads.mjs).
    const eventDateMatch =
      body.match(/wedding\s+date[:\s]+([^\n]+)/i) ||
      body.match(/event\s+date[:\s]+([^\n]+)/i)
    const guestMatch = body.match(/guests?\s*[:\s]+(\d+)/i)

    // Source hint: cohort A is calculator-on-own-website → 'website'.
    // Cohort B is mixed (Zola entries are flagged in the label, but for
    // robustness we don't override on label-text — leave the brain's
    // built-in detection to apply via the body, and pass a neutral
    // 'website' fallback. The brain treats anything other than the known
    // platform tokens as generic.)
    const sourceHint = entry.cohort === 'calc' ? 'website' : 'website'

    try {
      // Bare specifier path (no .ts extension) so `tsc --noEmit` is happy
      // under the project's bundler resolution; tsx resolves the .ts at runtime.
      const inquiryModule = await import('../src/lib/services/brain/inquiry')
      const result = await inquiryModule.generateInquiryDraft({
        venueId: args.venueId,
        contactEmail: fromEmail,
        inquiry: {
          from: fromEmail,
          subject,
          body,
        },
        extractedData: {
          questions: extractQuestionsFromBody(body),
          eventDate: eventDateMatch?.[1]?.trim() ?? undefined,
          guestCount: guestMatch ? parseInt(guestMatch[1], 10) : undefined,
        },
        taskType: 'new_inquiry',
        source: sourceHint,
        receivedAtAddress: receivedAtAddress ?? undefined,
        weddingId: interaction.wedding_id ?? undefined,
        correlationId,
      })
      if (!result.draft) {
        console.log(`  brain returned no draft text — skipping insert`)
        stats.errored++
        return
      }
      draftBody = result.draft
      confidenceScore = result.confidence ?? null
      brainUsed = 'inquiry'
      promptVersionUsed = inquiryModule.BRAIN_PROMPT_VERSION
      console.log(
        `  brain produced draft (${draftBody.length} chars, confidence=${confidenceScore ?? '—'})`,
      )
    } catch (err) {
      console.error(
        `  generateInquiryDraft threw: ${err instanceof Error ? err.message : String(err)}`,
      )
      stats.errored++
      return
    }
  }

  if (!args.apply) {
    console.log(
      `  DRY-RUN — would insert draft to=${fromEmail} subject="${draftSubject}" brain=${brainUsed}`,
    )
    return
  }

  // ---- APPLY: insert pending draft. ----
  const { data, error } = await supabase
    .from('drafts')
    .insert({
      venue_id: args.venueId,
      wedding_id: interaction.wedding_id,
      interaction_id: interaction.id,
      to_email: fromEmail,
      subject: draftSubject,
      draft_body: draftBody,
      original_sage_body: draftBody,
      status: 'pending',
      context_type: 'inquiry',
      brain_used: brainUsed,
      confidence_score: confidenceScore,
      auto_sent: false,
      prompt_version_used: promptVersionUsed,
      correlation_id: correlationId,
    })
    .select('id')
    .single()

  if (error) {
    console.error(`  draft insert failed: ${error.message}`)
    stats.errored++
    return
  }
  console.log(`  WROTE draft ${data.id} (status=pending, brain=${brainUsed})`)
  stats.wroteDraft++
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs()

  const url = process.env.BRANCH_URL
  const key = process.env.BRANCH_KEY
  if (!url || !key) {
    console.error(
      'ERROR: BRANCH_URL and BRANCH_KEY must be set in the environment.\n' +
        'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> ' +
        'npx tsx scripts/replay-backlog-drafts.ts --venue-id <uuid>',
    )
    process.exit(1)
  }
  if (url.includes(PROD_REF) && !args.allowProd) {
    console.error(
      `ERROR: BRANCH_URL points at the production project ref (${PROD_REF}). ` +
        `Pass --allow-prod to proceed.`,
    )
    process.exit(1)
  }

  const supabase: SupabaseClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const selectedCohort = args.cohort
  const entries = COHORTS.filter(
    (e) => selectedCohort === 'all' || e.cohort === selectedCohort,
  )

  console.log('='.repeat(78))
  console.log('BACKLOG SAGE-DRAFT REPLAY')
  console.log('='.repeat(78))
  console.log(`Target DB   : ${url}`)
  console.log(`Mode        : ${args.apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`)
  console.log(`Allow prod  : ${args.allowProd ? 'YES' : 'no'}`)
  console.log(`Venue id    : ${args.venueId}`)
  console.log(`Cohort      : ${selectedCohort} (${entries.length} entries)`)
  console.log(`Match window: ±${MATCH_WINDOW_DAYS} days, direction=inbound`)
  console.log('')

  const stats: ReplayStats = {
    total: entries.length,
    matched: 0,
    ambiguous: 0,
    unfound: 0,
    skippedExistingDraft: 0,
    wroteDraft: 0,
    errored: 0,
  }

  const ambiguousList: Array<{ entry: CohortEntry; candidates: InteractionRow[] }> = []
  const unfoundList: CohortEntry[] = []

  for (const entry of entries) {
    const pickedId = args.picks[entry.label.toLowerCase()]
    if (args.picksOnly && !pickedId) continue

    console.log(`--- [${entry.cohort}] ${entry.label} (anchor ${entry.anchorDate}) ---`)
    if (entry.note) console.log(`  note: ${entry.note}`)

    let resolution: ResolveOutcome
    if (pickedId) {
      // Operator-supplied disambiguation — fetch that exact interaction.
      const { data, error } = await supabase
        .from('interactions')
        .select(
          'id, venue_id, wedding_id, direction, type, subject, from_email, from_name, ' +
            'full_body, body_preview, timestamp, gmail_thread_id, gmail_connection_id, intent_class',
        )
        .eq('id', pickedId)
        .eq('venue_id', args.venueId)
        .maybeSingle()
      if (error || !data) {
        console.error(
          `  PICK ERROR — interaction ${pickedId} not found on venue (${error?.message ?? 'no row'})`,
        )
        stats.errored++
        console.log('')
        continue
      }
      console.log(`  PICK — using operator-supplied interaction ${pickedId}`)
      resolution = { kind: 'matched', interaction: data as unknown as InteractionRow, candidates: 1 }
    } else {
      try {
        resolution = await resolveEntry(supabase, args.venueId, entry)
      } catch (err) {
        console.error(`  resolve failed: ${err instanceof Error ? err.message : err}`)
        stats.errored++
        console.log('')
        continue
      }
    }

    if (resolution.kind === 'unfound') {
      console.log(`  UNFOUND — no inbound interaction matched within ±${MATCH_WINDOW_DAYS}d`)
      stats.unfound++
      unfoundList.push(entry)
      console.log('')
      continue
    }
    if (resolution.kind === 'ambiguous') {
      console.log(`  AMBIGUOUS — ${resolution.candidates.length} candidates:`)
      for (const c of resolution.candidates.slice(0, 5)) {
        console.log(
          `    - id=${c.id} ts=${c.timestamp} from="${c.from_name ?? ''}" ` +
            `<${c.from_email ?? ''}> subj="${(c.subject ?? '').slice(0, 80)}"`,
        )
      }
      if (args.apply) {
        console.log(`  apply mode — skipping; operator must disambiguate manually`)
      }
      stats.ambiguous++
      ambiguousList.push({ entry, candidates: resolution.candidates })
      console.log('')
      continue
    }

    // matched
    const i = resolution.interaction
    console.log(
      `  MATCHED interaction ${i.id} (${resolution.candidates} candidate(s) scored)`,
    )
    console.log(
      `    ts=${i.timestamp} from="${i.from_name ?? ''}" <${i.from_email ?? ''}> ` +
        `subj="${(i.subject ?? '').slice(0, 80)}"`,
    )
    stats.matched++

    try {
      await generateAndInsertDraft(supabase, entry, i, args, stats)
    } catch (err) {
      console.error(`  per-entry failure: ${err instanceof Error ? err.message : err}`)
      stats.errored++
    }
    console.log('')
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('='.repeat(78))
  console.log('SUMMARY')
  console.log('='.repeat(78))
  console.log(`  total entries        : ${stats.total}`)
  console.log(`  matched              : ${stats.matched}`)
  console.log(`  ambiguous            : ${stats.ambiguous}`)
  console.log(`  unfound              : ${stats.unfound}`)
  console.log(`  skipped (had draft)  : ${stats.skippedExistingDraft}`)
  console.log(
    `  drafts written       : ${stats.wroteDraft} ${args.apply ? '' : '(dry-run; would write)'}`,
  )
  console.log(`  errors               : ${stats.errored}`)

  if (ambiguousList.length > 0) {
    console.log('')
    console.log('AMBIGUOUS — operator needs to pick the right interaction:')
    for (const a of ambiguousList) {
      console.log(`  • ${a.entry.label} (${a.candidates.length} candidates, see log above)`)
    }
  }
  if (unfoundList.length > 0) {
    console.log('')
    console.log('UNFOUND — operator should verify these landed at the right venue/inbox:')
    for (const u of unfoundList) {
      console.log(`  • ${u.label} (anchor ${u.anchorDate})`)
    }
  }
}

main().catch((err) => {
  console.error('replay-backlog-drafts FAILED:', err)
  process.exit(1)
})
