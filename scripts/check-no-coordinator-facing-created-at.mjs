// T5-Rixey-LL: CI guard — fail when a coordinator-facing service or
// insight queries a non-telemetry table by `created_at`. Coordinator-
// facing reads MUST window on the REAL event-date column (inquiry_date
// for weddings, occurred_at for engagement_events, signal_date for
// voice_*, etc.) so a Day-0 historical import doesn't make the page
// look broken.
//
// What this catches: future refactors that add `.gte('created_at', ...)`
// to a service whose output renders on a coordinator surface. The
// post-import looks-broken bugs all share that shape, and the only
// reliable defense is a static guard.
//
// T5-Rixey-UU Bug F extension: `updated_at` is also banned as a
// "last activity" / "last seen" / "freshness" column on tables where a
// real activity column exists (interactions.timestamp,
// engagement_events.occurred_at, etc.). The trigger is the same shape
// as the created_at trap — every batch import / reconciliation /
// derivation pass bumps weddings.updated_at to NOW(), so any
// coordinator surface that reads it as "when did this lead last move"
// renders today's date for every row.
//
// Allowlist:
//   - Lines that target a TELEMETRY_TABLES table (api_costs.created_at,
//     cron_runs.started_at, etc.) — see TELEMETRY_TABLES below
//   - Lines explicitly tagged with the comment marker
//     `// created-at-ok: <reason>` on the same line or immediately above
//   - For updated_at: lines tagged `// updated-at-ok: <reason>` on the
//     same line or immediately above
//
// To allowlist a new file or call, prefer either:
//   1. Tagging the call with `// created-at-ok: <reason>` (preferred)
//   2. Adding the table to TELEMETRY_TABLES in src/lib/services/date-windows.ts
//      AND keeping the table here in sync.
//
// Run:
//   node scripts/check-no-coordinator-facing-created-at.mjs
//
// Wired into .github/workflows/ci.yml.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Scopes scanned by this guard. Coordinator-facing services + insights
// + intel admin pages that read time-windowed data. Couple-portal
// reads are a different audience and are skipped.
const SCAN_DIRS = [
  'src/lib/services',
  'src/lib/services/insights',
  'src/lib/services/external-context',
  'src/lib/services/crm-import',
  'src/lib/services/platform-detectors',
  'src/lib/services/scheduling-tool-parsers',
  'src/lib/services/audio-capture',
  'src/lib/services/form-relay-parsers',
  'src/app/(platform)/intel',
  'src/app/(platform)/portal/sage-queue',
  'src/app/(platform)/agent/analytics',
  'src/app/(platform)/agent/learning',
]

// T5-Rixey-UU Bug F: additional scopes for the updated_at-as-freshness
// trap. The leads + pipeline pages are coordinator-facing list surfaces
// where every `updated_at` read is a "Last Activity" / "Days in Stage"
// computation, and both have the import-bumps-row trap.
//
// We keep this list NARROWER than SCAN_DIRS for the updated_at filter
// scan so we don't trip CI on legacy services uses that Stream LL is
// covering on a different track. The display-context heuristic
// (FRESHNESS_UPDATED_AT_USE) still runs across all SCAN_DIRS.
const UPDATED_AT_FILTER_SCAN_DIRS = [
  'src/app/(platform)/agent/leads',
  'src/app/(platform)/agent/pipeline',
]

// Tables where created_at IS the meaningful timestamp.
// Keep this in sync with TELEMETRY_TABLES in src/lib/services/date-windows.ts.
const TELEMETRY_TABLES = new Set([
  'api_costs',
  'cron_runs',
  'metered_events',
  'admin_notifications',
  'pulse_snoozes',
  'anomaly_alerts',
  'intelligence_insights',
  'ai_briefings',
  'planning_notes',
  'drafts',
  'messages',
  'sage_conversations',
  'checklist_items',
  'audit_logs',
  'essentials_action_log',
  'paused_period_skipped',
  'api_health_pings',
  'voice_training_sessions',
  // Workflow / dedup-only created_at usage. Listed for completeness.
  'draft_feedback',
  'inbox_filters',
  'sequences',
  'follow_up_drafts',
  'sage_drafts',
  'sage_queue',
  'wedding_drafts',
  'sequence_steps',
  'consultant_metrics',
  'lead_score_history',
  'lock_holders',
  'pipeline_health',
  'health_pings',
  'cost_ceiling_state',
  'circuit_breaker_state',
  'system_locks',
  'venue_health',
  'venue_status',
  'team_invites',
  'gmail_credentials',
  'gmail_connections',
])

// Optional inline marker — `// created-at-ok: <reason>` on the same line
// or immediately above the offending line opts the call out.
const OPT_OUT_MARKER = /created-at-ok:/
// Same shape for updated_at opt-outs.
const UPDATED_AT_OPT_OUT_MARKER = /updated-at-ok:/

// Patterns that indicate a created_at column read on a Supabase query.
//   .gte('created_at', ...)
//   .lte('created_at', ...)
//   .lt('created_at',  ...)
//   .gt('created_at',  ...)
const SUPABASE_DATE_FILTER = /\.\s*(?:gte|lte|lt|gt)\s*\(\s*['"]created_at['"]/

// Same for updated_at — banned as a "last activity" / freshness window
// on tables that have a real activity column. T5-Rixey-UU Bug F.
const SUPABASE_UPDATED_AT_FILTER = /\.\s*(?:gte|lte|lt|gt)\s*\(\s*['"]updated_at['"]/

// updated_at sort axis on a coordinator surface — same trap. The
// pattern catches `.order('updated_at', ...)` in query chains.
const SUPABASE_UPDATED_AT_ORDER = /\.\s*order\s*\(\s*['"]updated_at['"]/

// Display / freshness identifiers in JSX or property reads. Catches
// the leads-page-style bug where a row's "Last Activity" cell is fed
// row.updated_at directly. Pattern looks for an identifier whose name
// contains last/seen/freshness/activity right before .updated_at /
// _updated_at, so generic .updated_at usage in non-display contexts
// (writes, logging) doesn't trip the guard.
const FRESHNESS_UPDATED_AT_USE = /\b(?:last[_\s]*activity|last[_\s]*seen|freshness|last[_\s]*updated|last[_\s]*touch|stale)[_a-zA-Z0-9]*[^=]{0,40}updated_at/i

// In the narrow filter scope (leads + pipeline coordinator surfaces)
// we also flag bare `.updated_at` reads. Those surfaces should be
// reading MAX(interactions.timestamp) for "last activity" or
// engagement_events.occurred_at for "last signal", not the row's
// modification stamp. The opt-out marker `// updated-at-ok: <reason>`
// covers the rare exceptions (status-change timestamps fed to a
// "Days in Stage" axis where stage was actually mutated).
const BARE_UPDATED_AT_READ = /\.updated_at\b/

// Tables where updated_at IS the meaningful "freshness" axis. Anything
// else gets flagged. Keep this ALSO in sync with TELEMETRY_TABLES so
// the two passes stay coherent.
const FRESHNESS_TABLES = new Set([
  'venue_settings',
  'venue_voice_profile',
  'people',
  'venues',
  // Cron / job state — updated_at IS the last-tick.
  'cron_runs',
  'pipeline_health',
  'venue_health',
  'venue_status',
])

// Extract `.from('<table>')` calls in scope. Two layers of fallback so
// renamed-then-windowed-later code still resolves.
const FROM_CLAUSE = /\.\s*from\s*\(\s*['"]([a-zA-Z_]+)['"]\s*\)/g

function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) out.push(...walk(full))
    else if (/\.(tsx|ts)$/.test(name)) out.push(full)
  }
  return out
}

function nearestFromTable(lines, lineIdx) {
  // Walk back up to 25 lines looking for a `.from('<table>')` call.
  // Supabase chains are usually short; 25 is a generous cap.
  const start = Math.max(0, lineIdx - 25)
  for (let i = lineIdx; i >= start; i--) {
    const line = lines[i]
    if (!line) continue
    const matches = [...line.matchAll(FROM_CLAUSE)]
    if (matches.length > 0) {
      // Last .from() on the line wins (multi-chain edge case).
      return matches[matches.length - 1][1]
    }
  }
  return null
}

function isOptedOut(lines, lineIdx, marker = OPT_OUT_MARKER) {
  // Inline marker on the same line wins.
  if (marker.test(lines[lineIdx] ?? '')) return true
  // Walk back through contiguous comment lines (// or empty) up to 6
  // lines. The marker can sit at the top of a multi-line comment block
  // explaining the opt-out.
  for (let i = 1; i <= 6; i++) {
    const line = lines[lineIdx - i]
    if (line === undefined) break
    const trimmed = line.trim()
    if (trimmed === '') break
    if (!trimmed.startsWith('//')) break
    if (marker.test(line)) return true
  }
  return false
}

const files = SCAN_DIRS.flatMap((d) => walk(d))
const updatedAtFilterFiles = new Set(
  UPDATED_AT_FILTER_SCAN_DIRS.flatMap((d) => walk(d)),
)
// Make sure the narrower updated_at filter scope is also walked even if
// it's not in the broader SCAN_DIRS — this keeps the leads/pipeline
// pages covered for the freshness display heuristic too.
const allFiles = new Set([...files, ...updatedAtFilterFiles])

const violations = []
const updatedAtViolations = []

for (const file of allFiles) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const isInBroadScope = files.includes(file)
  const isInFilterScope = updatedAtFilterFiles.has(file)

  // Track in-block-comment state across lines so JSX {/* ... */} or
  // /* ... */ multi-line comments don't trip the heuristic.
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const startedInBlock = inBlockComment
    // Update block-comment state — track the LAST open/close on the
    // line. Simple but adequate; handles JSX `{/* ... */}` because
    // those open and close on the same line OR span lines.
    let scan = line
    let cursor = 0
    while (cursor < scan.length) {
      if (inBlockComment) {
        const close = scan.indexOf('*/', cursor)
        if (close === -1) { cursor = scan.length; break }
        cursor = close + 2
        inBlockComment = false
      } else {
        const open = scan.indexOf('/*', cursor)
        if (open === -1) break
        cursor = open + 2
        inBlockComment = true
      }
    }
    // If the line BEGAN inside a block comment, treat it as comment-
    // only (its content is prose, not code).
    if (startedInBlock) continue

    // ----- created_at filter check (existing T5-Rixey-LL trap) -----
    // Only runs on the original SCAN_DIRS scope.
    if (isInBroadScope && SUPABASE_DATE_FILTER.test(line)) {
      if (!isOptedOut(lines, i, OPT_OUT_MARKER)) {
        const table = nearestFromTable(lines, i)
        if (!(table && TELEMETRY_TABLES.has(table))) {
          violations.push({
            file: file.replace(/\\/g, '/'),
            line: i + 1,
            table: table ?? '<unknown>',
            text: line.trim().slice(0, 140),
          })
        }
      }
    }

    // ----- updated_at-as-freshness trap (T5-Rixey-UU Bug F) -----
    // Three flavours, all the same root cause:
    //   1. .gte/.lte/.gt/.lt on updated_at  (only flagged in
    //      UPDATED_AT_FILTER_SCAN_DIRS — narrow scope keeps Stream LL's
    //      legacy services-dir uses out of CI until they're fixed)
    //   2. .order('updated_at', ...) on a coordinator surface (same
    //      narrow scope)
    //   3. JSX / property read like row.updated_at fed to a "Last
    //      Activity" / "Last Seen" / "freshness" cell (broad scope —
    //      display-context heuristic, very low false-positive rate)
    // Skip pure-comment lines so prose like "// Not weddings.updated_at"
    // doesn't trip the heuristic. Inline comments after code still
    // scan because the code part of the line matters.
    const trimmedLine = line.trim()
    const isCommentOnly = trimmedLine.startsWith('//') || trimmedLine.startsWith('*')

    let updatedAtMatch = false
    if (!isCommentOnly && isInFilterScope && (
      SUPABASE_UPDATED_AT_FILTER.test(line) ||
      SUPABASE_UPDATED_AT_ORDER.test(line) ||
      // Narrow-scope surfaces also flag any bare `.updated_at` read —
      // those pages should be reading the real activity column.
      BARE_UPDATED_AT_READ.test(line)
    )) {
      updatedAtMatch = true
    } else if (!isCommentOnly && isInBroadScope && FRESHNESS_UPDATED_AT_USE.test(line)) {
      updatedAtMatch = true
    }
    if (updatedAtMatch) {
      if (isOptedOut(lines, i, UPDATED_AT_OPT_OUT_MARKER)) continue
      // Allow opt-out via the same created-at-ok marker if a single
      // tag covers both axes — keeps comments tidy.
      if (isOptedOut(lines, i, OPT_OUT_MARKER)) continue
      const table = nearestFromTable(lines, i)
      // Tables whose updated_at IS the freshness axis are allowlisted.
      if (table && FRESHNESS_TABLES.has(table)) continue
      updatedAtViolations.push({
        file: file.replace(/\\/g, '/'),
        line: i + 1,
        table: table ?? '<unknown>',
        text: line.trim().slice(0, 140),
      })
    }
  }
}

if (violations.length > 0) {
  console.log(
    `\nFound ${violations.length} coordinator-facing created_at filter(s) (T5-Rixey-LL):`,
  )
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  table=${v.table}`)
    console.log(`    ${v.text}`)
  }
  console.log(
    '\nFix: window on the REAL event-date column for the table:',
  )
  console.log('  weddings           → inquiry_date (arrival), booked_at (booking), wedding_date (event)')
  console.log('  interactions       → timestamp')
  console.log('  engagement_events  → occurred_at')
  console.log('  attribution_events → occurred_at  (decided_at also accepted)')
  console.log('  tangential_signals → signal_date')
  console.log('  candidate_identities → first_seen')
  console.log('  voice_preferences  → signal_date  (migration 179)')
  console.log('  voice_training_responses → signal_date  (migration 179)')
  console.log('  phrase_usage       → used_at')
  console.log('  lost_deals         → lost_at')
  console.log('  cultural_moments   → start_at')
  console.log('  marketing_spend    → period_month')
  console.log('  pricing_history    → effective_date')
  console.log(
    '\nIf the call is genuinely telemetry (insertion-time IS the event), tag it:',
  )
  console.log('  // created-at-ok: <reason>')
  console.log(
    '\nOr add the table to TELEMETRY_TABLES in scripts/check-no-coordinator-facing-created-at.mjs',
  )
  console.log('AND src/lib/services/date-windows.ts.')
}

if (updatedAtViolations.length > 0) {
  console.log(
    `\nFound ${updatedAtViolations.length} coordinator-facing updated_at-as-freshness use(s) (T5-Rixey-UU Bug F):`,
  )
  for (const v of updatedAtViolations) {
    console.log(`  ${v.file}:${v.line}  table=${v.table}`)
    console.log(`    ${v.text}`)
  }
  console.log(
    '\nFix: read freshness from the REAL activity column for the table:',
  )
  console.log('  weddings           → MAX(interactions.timestamp)  (last contact)')
  console.log('                       MAX(engagement_events.occurred_at) (last signal)')
  console.log('  attribution_events → occurred_at')
  console.log('  candidate_identities → last_seen')
  console.log(
    '\nupdated_at gets bumped to NOW() by every batch import / reconciliation /')
  console.log(
    'derivation pass, so coordinator surfaces that read it as "last activity"')
  console.log(
    'render today\'s date for every row.')
  console.log(
    '\nIf the call is genuinely about row-modification time (audit, sync), tag it:',
  )
  console.log('  // updated-at-ok: <reason>')
  console.log(
    '\nOr add the table to FRESHNESS_TABLES in scripts/check-no-coordinator-facing-created-at.mjs.',
  )
}

if (violations.length > 0 || updatedAtViolations.length > 0) {
  process.exit(1)
}

console.log('No coordinator-facing created_at filters found.')
console.log('No coordinator-facing updated_at-as-freshness uses found.')
