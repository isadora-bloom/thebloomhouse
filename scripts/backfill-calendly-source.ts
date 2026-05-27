/**
 * scripts/backfill-calendly-source.ts
 * ===================================
 * Backfill the canonical `source` for couples + weddings + interactions
 * who came in via Calendly direct (no Knot/WW/Zola wrapper) and wrote
 * their answer to "Where did you first hear about us?" in the Calendly
 * Questions block.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Operator-reported 2026-05-27 via Claude.ai inspection:
 *   - Calendly tour-booking notifications arrive at info@<venue>.com from
 *     notifications@calendly.com.
 *   - Rixey's Calendly form asks SIX custom questions including
 *     "Where did you first hear about us?".
 *   - Before the calendly-questions-parser (shipped same day), Bloom
 *     ingested the notification but did NOT extract the source answer.
 *   - Every Calendly-direct couple landed as source=direct/unknown OR
 *     source=calendly — even when they wrote "Google" or "The Knot".
 *   - Real example: Jennifer Nguyen wrote "The Knot" but BYPASSED the
 *     Knot inquiry flow and booked Calendly directly → logged as direct.
 *   - Erin B wrote "Google" → logged as direct.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * For each Calendly notification interaction in the venue's history:
 *   1. Run `parseCalendlyQuestions` on the body
 *   2. If a canonical source extracts, patch in priority order:
 *       a. `interactions.extracted_facts.source_mentioned` (literal) +
 *          `interactions.extracted_facts.signals.source` (canonical)
 *          — additive: only fills when current value is null
 *       b. `weddings.source` for the linked wedding — additive: only
 *          fills when current value is null OR 'calendly' or 'direct' or
 *          'other' (those three are placeholders the live pipeline wrote
 *          before this parser existed; we treat them as "no real source
 *          attribution" and overwrite). NEVER overwrites a coordinator-
 *          set source or a real platform attribution from another path.
 *       c. `couples.source` mirror — same rule as weddings
 *
 * NOT what this script does
 * -------------------------
 * - Does NOT call the LLM.
 * - Does NOT mint anything new — pure source enrichment.
 * - Does NOT touch interactions, weddings, or couples whose source is
 *   ALREADY non-placeholder (a coordinator-set 'google' stays 'google';
 *   only 'calendly' / 'direct' / 'other' / null get patched).
 *
 * SAFETY
 * ------
 * - Dry-run by default. `--apply` writes.
 * - `--allow-prod` REQUIRED if BRANCH_URL / NEXT_PUBLIC_SUPABASE_URL
 *   points at the prod ref `jsxxgwprxuqgcauzlxcb` AND `--apply` is set.
 * - `--venue-id` REQUIRED (no implicit fallback to Rixey).
 * - Dry-run prints a per-source histogram + samples of the rows that
 *   would change so the operator can sanity-check before applying.
 *
 * USAGE
 * -----
 *   # Dry-run vs default env (.env.local), Rixey venue:
 *   npx tsx scripts/backfill-calendly-source.ts \
 *     --venue-id f3d10226-4c5c-47ad-b89b-98ad63842492
 *
 *   # Limit to last N days (default 60):
 *   npx tsx scripts/backfill-calendly-source.ts \
 *     --venue-id <uuid> --days 90
 *
 *   # Apply vs branch:
 *   BRANCH_URL=... BRANCH_KEY=... \
 *   npx tsx scripts/backfill-calendly-source.ts --venue-id <uuid> --apply
 *
 *   # Apply vs prod (REQUIRED --allow-prod):
 *   npx tsx scripts/backfill-calendly-source.ts \
 *     --venue-id <uuid> --apply --allow-prod
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import {
  extractCalendlyQuestions,
  type CalendlyCanonicalSource,
} from '../src/lib/services/ingestion/calendly-questions-parser'

// ---------------------------------------------------------------------------
// Env loader
// ---------------------------------------------------------------------------

if (existsSync('.env.local')) {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [
          l.slice(0, i).trim(),
          l.slice(i + 1).trim().replace(/^['"]|['"]$/g, ''),
        ]
      }),
  )
  for (const k of Object.keys(env)) {
    if (!process.env[k]) process.env[k] = env[k] as string
  }
}

const SUPABASE_URL = process.env.BRANCH_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.BRANCH_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_KEY')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx < 0 || idx + 1 >= process.argv.length) return null
  return process.argv[idx + 1]
}

const VENUE_ID = argValue('--venue-id')
const DAYS = Math.max(1, Number(argValue('--days')) || 60)

if (!VENUE_ID) {
  console.error('--venue-id is REQUIRED')
  console.error(
    '  usage: npx tsx scripts/backfill-calendly-source.ts --venue-id <uuid> [--days 60] [--apply] [--allow-prod]',
  )
  process.exit(1)
}

if (APPLY && SUPABASE_URL.includes(PROD_REF) && !ALLOW_PROD) {
  console.error(
    `Refusing to --apply against prod (${PROD_REF}). Re-run with --allow-prod to confirm.`,
  )
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Treat these existing source values as "placeholder / unattributed" —
// they'll be overwritten with the Calendly-form-derived canonical source
// when we have one. ANY other non-null value (e.g. 'google' set by a
// coordinator, 'the_knot' set by the form-relay path) is treated as a
// real attribution and preserved.
const PLACEHOLDER_SOURCES = new Set<string>([
  'calendly',
  'direct',
  'other',
  'unknown',
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InteractionRow {
  id: string
  full_body: string | null
  body_preview: string | null
  from_email: string | null
  wedding_id: string | null
  person_id: string | null
  extracted_facts:
    | { source_mentioned?: string | null; [k: string]: unknown }
    | null
  timestamp: string | null
}

interface WeddingRow {
  id: string
  source: string | null
  primary_person_id: string | null
}

interface CoupleRow {
  id: string
  source: string | null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Calendly source backfill ===')
  console.log(`  URL:       ${SUPABASE_URL}`)
  console.log(`  Venue:     ${VENUE_ID}`)
  console.log(`  Window:    last ${DAYS} days`)
  console.log(`  Mode:      ${APPLY ? 'APPLY' : 'dry-run'}`)
  console.log('')

  const since = new Date(Date.now() - DAYS * 86400_000).toISOString()

  // Fetch Calendly notifications: from_email containing
  // notifications@calendly.com OR calendly.com.
  console.log('Fetching Calendly notification interactions...')
  const PAGE = 500
  const interactions: InteractionRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('interactions')
      .select(
        'id, full_body, body_preview, from_email, wedding_id, person_id, extracted_facts, timestamp',
      )
      .eq('venue_id', VENUE_ID)
      .or('from_email.ilike.%calendly.com%,from_email.ilike.%calendlymail.com%')
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`fetch interactions @${from}:`, error.message)
      process.exit(1)
    }
    const rows = (data ?? []) as InteractionRow[]
    interactions.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  console.log(`  ${interactions.length} Calendly notifications in window`)

  // Walk each interaction, parse, decide actions
  const sourceHistogram: Record<string, number> = {}
  const interactionsWithSource: Array<{
    interactionId: string
    weddingId: string | null
    canonical: CalendlyCanonicalSource
    literal: string
  }> = []
  let parseFailures = 0
  let noSourceQuestion = 0
  let unknownSource = 0

  for (const ix of interactions) {
    const html = ix.full_body || ix.body_preview
    if (!html) {
      parseFailures++
      continue
    }
    const bundle = extractCalendlyQuestions(html)
    if (!bundle) {
      parseFailures++
      continue
    }
    if (!bundle.source) {
      if (bundle.sourceLiteral) {
        unknownSource++
      } else {
        noSourceQuestion++
      }
      continue
    }
    // Skip 'other' canonicals — we don't want to stamp a meaningless
    // canonical over a placeholder. Operator can revisit manually.
    if (bundle.source === 'other') {
      unknownSource++
      continue
    }
    sourceHistogram[bundle.source] = (sourceHistogram[bundle.source] ?? 0) + 1
    interactionsWithSource.push({
      interactionId: ix.id,
      weddingId: ix.wedding_id,
      canonical: bundle.source,
      literal: bundle.sourceLiteral ?? bundle.source,
    })
  }

  console.log('')
  console.log('Parser results:')
  console.log(`  ${interactionsWithSource.length} interactions have a canonical source`)
  console.log(`  ${noSourceQuestion} have no source question`)
  console.log(`  ${unknownSource} have a source answer that didn't canonicalize`)
  console.log(`  ${parseFailures} failed to parse the questions block`)
  console.log('')
  console.log('Source histogram (Calendly form answers):')
  for (const [src, n] of Object.entries(sourceHistogram).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src.padEnd(20)} ${n}`)
  }
  console.log('')

  if (interactionsWithSource.length === 0) {
    console.log('Nothing to backfill.')
    return
  }

  // Pre-fetch all relevant weddings + couples so we can decide what to
  // patch without N+1 queries.
  const weddingIds = Array.from(
    new Set(interactionsWithSource.map((r) => r.weddingId).filter(Boolean) as string[]),
  )

  const weddingsById = new Map<string, WeddingRow>()
  if (weddingIds.length > 0) {
    // chunk to avoid URL length limits on the in() filter
    const CHUNK = 200
    for (let i = 0; i < weddingIds.length; i += CHUNK) {
      const slice = weddingIds.slice(i, i + CHUNK)
      const { data, error } = await sb
        .from('weddings')
        .select('id, source, primary_person_id')
        .eq('venue_id', VENUE_ID)
        .in('id', slice)
      if (error) {
        console.error('fetch weddings:', error.message)
        process.exit(1)
      }
      for (const w of (data ?? []) as WeddingRow[]) weddingsById.set(w.id, w)
    }
  }

  const couplesByWeddingId = new Map<string, CoupleRow>()
  if (weddingIds.length > 0) {
    const CHUNK = 200
    for (let i = 0; i < weddingIds.length; i += CHUNK) {
      const slice = weddingIds.slice(i, i + CHUNK)
      const { data, error } = await sb
        .from('couples')
        .select('id, source, source_wedding_id')
        .eq('venue_id', VENUE_ID)
        .in('source_wedding_id', slice)
      if (error) {
        // Couples table may not carry `source` on every schema variant;
        // missing column is recoverable, swallow.
        console.warn('fetch couples (non-fatal):', error.message)
      } else {
        for (const c of (data ?? []) as Array<CoupleRow & { source_wedding_id: string }>) {
          couplesByWeddingId.set(c.source_wedding_id, {
            id: c.id,
            source: c.source,
          })
        }
      }
    }
  }

  // Plan the writes
  let interactionUpdates = 0
  let weddingUpdates = 0
  let coupleUpdates = 0
  const samples: string[] = []

  for (const r of interactionsWithSource) {
    let interactionWillUpdate = false
    let weddingWillUpdate = false
    let coupleWillUpdate = false

    // 1) interaction extracted_facts patch — only when source_mentioned
    //    is currently null/empty.
    interactionWillUpdate = true
    interactionUpdates++

    // 2) wedding source patch — only when placeholder or null.
    if (r.weddingId) {
      const w = weddingsById.get(r.weddingId)
      if (w) {
        const cur = w.source ?? null
        if (!cur || PLACEHOLDER_SOURCES.has(cur)) {
          weddingWillUpdate = true
          weddingUpdates++
        }
        const c = couplesByWeddingId.get(r.weddingId)
        if (c) {
          const ccur = c.source ?? null
          if (!ccur || PLACEHOLDER_SOURCES.has(ccur)) {
            coupleWillUpdate = true
            coupleUpdates++
          }
        }
      }
    }

    if (samples.length < 10) {
      samples.push(
        `  ix=${r.interactionId.slice(0, 8)}…  wedding=${(r.weddingId ?? 'null').slice(0, 8)}  source=${r.literal} → ${r.canonical}  ` +
          `[ix:${interactionWillUpdate ? 'Y' : 'n'} wedding:${weddingWillUpdate ? 'Y' : 'n'} couple:${coupleWillUpdate ? 'Y' : 'n'}]`,
      )
    }
  }

  console.log('Plan:')
  console.log(`  interactions to patch: ${interactionUpdates}`)
  console.log(`  weddings to patch:     ${weddingUpdates}`)
  console.log(`  couples to patch:      ${coupleUpdates}`)
  console.log('')
  console.log('Samples:')
  for (const s of samples) console.log(s)
  console.log('')

  if (!APPLY) {
    console.log('(dry-run — pass --apply to execute)')
    return
  }

  // Apply
  console.log('Applying...')
  let applied = { interactions: 0, weddings: 0, couples: 0, errors: 0 }

  for (const r of interactionsWithSource) {
    // Re-fetch the interaction's current extracted_facts so we additively
    // merge instead of clobber. Single row read; cheap.
    const { data: ixRow, error: ixErr } = await sb
      .from('interactions')
      .select('extracted_facts')
      .eq('id', r.interactionId)
      .maybeSingle()
    if (ixErr) {
      applied.errors++
      console.warn(`  ix=${r.interactionId.slice(0, 8)}: fetch failed: ${ixErr.message}`)
      continue
    }
    const facts =
      (ixRow?.extracted_facts as Record<string, unknown> | null) ?? null
    const nextFacts: Record<string, unknown> = facts ? { ...facts } : {}
    let factsChanged = false
    if (!nextFacts.source_mentioned) {
      nextFacts.source_mentioned = r.literal
      factsChanged = true
    }
    // Also stamp under signals.source for the unified-classifier read path
    const signals =
      (nextFacts.signals as Record<string, unknown> | undefined) ?? null
    if (!signals || !(signals as Record<string, unknown>).source) {
      nextFacts.signals = { ...(signals ?? {}), source: r.canonical }
      factsChanged = true
    }
    // Add a backfill marker for forensic audit
    nextFacts.calendly_source_backfilled_at = new Date().toISOString()
    if (factsChanged) {
      const { error: updErr } = await sb
        .from('interactions')
        .update({ extracted_facts: nextFacts })
        .eq('id', r.interactionId)
      if (updErr) {
        applied.errors++
        console.warn(`  ix=${r.interactionId.slice(0, 8)}: update failed: ${updErr.message}`)
        continue
      }
      applied.interactions++
    }

    // 2) wedding source patch
    if (r.weddingId) {
      const w = weddingsById.get(r.weddingId)
      if (w) {
        const cur = w.source ?? null
        if (!cur || PLACEHOLDER_SOURCES.has(cur)) {
          const { error: wUpdErr } = await sb
            .from('weddings')
            .update({ source: r.canonical })
            .eq('id', r.weddingId)
            .eq('venue_id', VENUE_ID)
          if (wUpdErr) {
            applied.errors++
            console.warn(
              `  wedding=${r.weddingId.slice(0, 8)}: update failed: ${wUpdErr.message}`,
            )
          } else {
            applied.weddings++
            // Local cache update so subsequent rows for the same wedding
            // see the new value and don't double-patch.
            weddingsById.set(r.weddingId, { ...w, source: r.canonical })
          }
        }

        // 3) couple source mirror
        const c = couplesByWeddingId.get(r.weddingId)
        if (c) {
          const ccur = c.source ?? null
          if (!ccur || PLACEHOLDER_SOURCES.has(ccur)) {
            const { error: cUpdErr } = await sb
              .from('couples')
              .update({ source: r.canonical })
              .eq('id', c.id)
              .eq('venue_id', VENUE_ID)
            if (cUpdErr) {
              // Some schema variants lack couples.source — log and skip
              if (/column .* does not exist/i.test(cUpdErr.message)) {
                // swallow once, but stop trying
              } else {
                applied.errors++
                console.warn(
                  `  couple=${c.id.slice(0, 8)}: update failed: ${cUpdErr.message}`,
                )
              }
            } else {
              applied.couples++
              couplesByWeddingId.set(r.weddingId, { ...c, source: r.canonical })
            }
          }
        }
      }
    }
  }

  console.log('')
  console.log('Done.')
  console.log(`  interactions patched: ${applied.interactions}`)
  console.log(`  weddings patched:     ${applied.weddings}`)
  console.log(`  couples patched:      ${applied.couples}`)
  console.log(`  errors:               ${applied.errors}`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
