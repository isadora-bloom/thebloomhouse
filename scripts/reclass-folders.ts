#!/usr/bin/env tsx
/**
 * reclass-folders.ts — CLI wrapper around the historical reclass loop.
 *
 * The /api/admin/reclass-folders-ai endpoint requires browser session
 * auth (getPlatformAuth). This script does the same work via the
 * service-role client so an operator can fire it from the CLI without
 * spinning up the Next.js server or doing a manual login.
 *
 * Default scope: ['vendor', 'advertiser', 'other'] — exactly the folders
 * the 2026-05-27 form-relay-misclassification fix needs to repair on
 * historical rows. (The endpoint defaults to ['other']; this CLI broadens
 * because we KNOW vendor + advertiser hold mis-bucketed new inquiries
 * post-fix.)
 *
 * Usage
 * -----
 *   BRANCH_URL=https://<ref>.supabase.co \
 *   BRANCH_KEY=<service_role_key> \
 *   npx tsx scripts/reclass-folders.ts \
 *     --venue-id <uuid> \
 *     [--source-folders vendor,advertiser,other] \
 *     [--max-rows 500] \
 *     [--batch-size 10] \
 *     [--apply]               # without this, dry-run (count candidates)
 *     [--allow-prod]          # required for prod ref (jsxxgwprxuqgcauzlxcb)
 *
 * Safety
 * ------
 *   - Refuse-by-default for the prod ref. --allow-prod required.
 *   - Dry-run by default. --apply required to call AI + write rows.
 *   - --venue-id is REQUIRED so the operator never accidentally fans out
 *     across every venue in the same sweep.
 *   - Idempotent. Re-run resumes where it left off (forceOverwrite=true
 *     means re-walks always re-stamp the latest verdict).
 *
 * Cost: ~$0.0003/row Haiku. At 500 rows = ~$0.15.
 */

import { createClient } from '@supabase/supabase-js'
import {
  classifyInboundRaw,
  stampInboundVerdict,
} from '../src/lib/services/intel/inbound-intent-classifier'
import {
  updateThreadLifecycleFolder,
  type LifecycleFolder,
} from '../src/lib/services/inbox/lifecycle'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function getFlag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return null
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) return null
  return v
}

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')
const VENUE_ID = getFlag('venue-id') ?? process.env.RECLASS_VENUE_ID ?? null
const SOURCE_FOLDERS_ARG =
  getFlag('source-folders') ?? 'vendor,advertiser,other'
const MAX_ROWS = parseInt(getFlag('max-rows') ?? '500', 10)
const BATCH_SIZE = parseInt(getFlag('batch-size') ?? '10', 10)

const PROD_REF = 'jsxxgwprxuqgcauzlxcb'
// CLI has no Vercel maxDuration constraint — bump to 10min so a single
// sweep covers the full 500-row Rixey backlog without leaving a tail.
const TIME_BUDGET_MS = 600_000

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------

const BRANCH_URL = process.env.BRANCH_URL
const BRANCH_KEY = process.env.BRANCH_KEY

if (!BRANCH_URL || !BRANCH_KEY) {
  console.error(
    'ERROR: BRANCH_URL and BRANCH_KEY must be set in the environment.',
  )
  console.error(
    'Run: BRANCH_URL=https://<ref>.supabase.co BRANCH_KEY=<service_role_key> \\\n' +
      '     npx tsx scripts/reclass-folders.ts --venue-id <uuid> [--apply] [--allow-prod]',
  )
  process.exit(1)
}

if (!VENUE_ID) {
  console.error(
    'ERROR: --venue-id <uuid> is required. Never accidentally fan out across all venues.',
  )
  process.exit(1)
}

if (BRANCH_URL.includes(PROD_REF) && !ALLOW_PROD) {
  console.error(
    `ERROR: BRANCH_URL points at production (${PROD_REF}). Refusing.`,
  )
  console.error(
    'Pass --allow-prod to confirm the run is intentional. (Dry-run still ~$0; --apply costs ~$0.0003/row Haiku.)',
  )
  process.exit(1)
}

const SOURCE_FOLDERS = SOURCE_FOLDERS_ARG.split(',')
  .map((s) => s.trim())
  .filter((s): s is LifecycleFolder =>
    ['new_inquiry', 'potential_client', 'client', 'vendor', 'advertiser', 'other'].includes(
      s,
    ),
  )

if (SOURCE_FOLDERS.length === 0) {
  console.error(
    'ERROR: --source-folders produced an empty list. Use comma-separated values from: new_inquiry,potential_client,client,vendor,advertiser,other',
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ReclassRow {
  id: string
  venue_id: string
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  direction: string | null
  lifecycle_folder: LifecycleFolder | null
  gmail_thread_id: string | null
  type: string | null
}

async function main() {
  const banner = APPLY ? 'APPLY' : 'DRY-RUN'
  console.log(
    '\n==============================================================================',
  )
  console.log(`[${banner}] reclass-folders — historical lifecycle-folder repair`)
  console.log(
    '==============================================================================',
  )
  console.log(`Target DB       : ${BRANCH_URL}`)
  console.log(`Venue scope     : ${VENUE_ID}`)
  console.log(`Source folders  : ${SOURCE_FOLDERS.join(', ')}`)
  console.log(`Max rows        : ${MAX_ROWS}`)
  console.log(`Batch size      : ${BATCH_SIZE}`)
  console.log('')

  const supabase = createClient(BRANCH_URL!, BRANCH_KEY!, {
    auth: { persistSession: false },
  })

  const startedAt = Date.now()

  console.log('[1] Loading candidate interactions...')
  const { data: rows, error } = await supabase
    .from('interactions')
    .select(
      'id, venue_id, from_email, from_name, subject, full_body, direction, lifecycle_folder, gmail_thread_id, type',
    )
    .eq('venue_id', VENUE_ID)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .in('lifecycle_folder', SOURCE_FOLDERS)
    .not('from_email', 'is', null)
    .not('full_body', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS)

  if (error) {
    console.error(`FATAL: interactions lookup: ${error.message}`)
    process.exit(1)
  }

  const candidates = (rows ?? []).filter(
    (r) =>
      typeof r.full_body === 'string' &&
      r.full_body.length >= 30 &&
      typeof r.from_email === 'string' &&
      r.from_email.length > 0,
  ) as ReclassRow[]

  console.log(`    candidate pool: ${candidates.length}`)
  console.log('')

  if (!APPLY) {
    console.log('Per-folder breakdown:')
    const byFolder = new Map<string, number>()
    for (const r of candidates) {
      const k = r.lifecycle_folder ?? '(null)'
      byFolder.set(k, (byFolder.get(k) ?? 0) + 1)
    }
    for (const [folder, count] of Array.from(byFolder.entries()).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${folder.padEnd(20)}: ${count}`)
    }
    console.log('')
    console.log('DRY-RUN — no AI calls, no writes. Re-run with --apply to reclassify.')
    console.log(
      '==============================================================================\n',
    )
    return
  }

  console.log('[2] Reclassifying...')

  let scanned = 0
  let reclassified = 0
  let folderChanged = 0
  let aiErrors = 0
  const folderTransitions: Record<string, number> = {}
  const refoldedThreads = new Set<string>()

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      console.log(`    time-budget exhausted at row ${i} / ${candidates.length}`)
      break
    }

    const batch = candidates.slice(i, i + BATCH_SIZE)

    // Step A: Reclassify in parallel.
    await Promise.all(
      batch.map(async (row) => {
        scanned += 1
        const correlationId = `reclass-${row.id}-${startedAt}`
        try {
          const verdict = await classifyInboundRaw({
            body: row.full_body,
            subject: row.subject,
            venueId: VENUE_ID!,
            channel: 'email',
            fromEmail: row.from_email,
            correlationId,
          })
          await stampInboundVerdict(row.id, verdict, {
            venueId: VENUE_ID!,
            supabase,
            correlationId,
            forceOverwrite: true,
          })
          reclassified += 1
        } catch (err) {
          aiErrors += 1
          console.warn(
            `    [warn] reclassify failed id=${row.id} err=${err instanceof Error ? err.message : 'unknown'}`,
          )
        }
      }),
    )

    // Step B: Refold each thread once.
    const threadsInBatch = new Set<string | null>()
    for (const row of batch) {
      const key = row.gmail_thread_id ?? `solo:${row.id}`
      if (refoldedThreads.has(key)) continue
      refoldedThreads.add(key)
      threadsInBatch.add(row.gmail_thread_id)
    }

    for (const threadId of threadsInBatch) {
      try {
        const result = await updateThreadLifecycleFolder({
          supabase,
          venueId: VENUE_ID!,
          threadId: threadId ?? null,
          interactionId: threadId
            ? null
            : (batch.find((r) => !r.gmail_thread_id)?.id ?? null),
        })
        const newFolder = result.folder
        if (newFolder) {
          const sampleRow = batch.find(
            (r) => (r.gmail_thread_id ?? null) === (threadId ?? null),
          )
          const oldFolder = sampleRow?.lifecycle_folder ?? null
          if (oldFolder && oldFolder !== newFolder) {
            folderChanged += 1
            const key = `${oldFolder}→${newFolder}`
            folderTransitions[key] = (folderTransitions[key] ?? 0) + 1
          }
        }
      } catch (err) {
        console.warn(
          `    [warn] folder recompute failed thread=${threadId} err=${err instanceof Error ? err.message : 'unknown'}`,
        )
      }
    }

    // Progress chip every ~50 rows.
    if (scanned % 50 === 0 || scanned === candidates.length) {
      console.log(
        `    progress: scanned=${scanned}  reclassified=${reclassified}  folder_changed=${folderChanged}  errors=${aiErrors}`,
      )
    }
  }

  console.log('')
  console.log(
    '==============================================================================',
  )
  console.log('RESULT')
  console.log(
    '==============================================================================',
  )
  console.log(`  candidate pool        : ${candidates.length}`)
  console.log(`  scanned               : ${scanned}`)
  console.log(`  reclassified          : ${reclassified}`)
  console.log(`  folder changed        : ${folderChanged}`)
  console.log(`  ai errors             : ${aiErrors}`)
  console.log(`  duration              : ${Math.round((Date.now() - startedAt) / 1000)}s`)
  console.log('')
  console.log('FOLDER TRANSITIONS:')
  const transitions = Object.entries(folderTransitions).sort(
    (a, b) => b[1] - a[1],
  )
  if (transitions.length === 0) {
    console.log('  (no folder changes — all rows stayed in their original folder)')
  } else {
    for (const [transition, count] of transitions) {
      console.log(`  ${transition.padEnd(40)}: ${count}`)
    }
  }
  console.log(
    '==============================================================================\n',
  )
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
