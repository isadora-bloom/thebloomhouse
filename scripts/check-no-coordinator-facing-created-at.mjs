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
// Allowlist:
//   - Lines that target a TELEMETRY_TABLES table (api_costs.created_at,
//     cron_runs.started_at, etc.) — see TELEMETRY_TABLES below
//   - Lines explicitly tagged with the comment marker
//     `// created-at-ok: <reason>` on the same line or immediately above
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

// Patterns that indicate a created_at column read on a Supabase query.
//   .gte('created_at', ...)
//   .lte('created_at', ...)
//   .lt('created_at',  ...)
//   .gt('created_at',  ...)
const SUPABASE_DATE_FILTER = /\.\s*(?:gte|lte|lt|gt)\s*\(\s*['"]created_at['"]/

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

function isOptedOut(lines, lineIdx) {
  // Inline marker on the same line wins.
  if (OPT_OUT_MARKER.test(lines[lineIdx] ?? '')) return true
  // Walk back through contiguous comment lines (// or empty) up to 6
  // lines. The marker can sit at the top of a multi-line comment block
  // explaining the opt-out.
  for (let i = 1; i <= 6; i++) {
    const line = lines[lineIdx - i]
    if (line === undefined) break
    const trimmed = line.trim()
    if (trimmed === '') break
    if (!trimmed.startsWith('//')) break
    if (OPT_OUT_MARKER.test(line)) return true
  }
  return false
}

const files = SCAN_DIRS.flatMap((d) => walk(d))
const violations = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!SUPABASE_DATE_FILTER.test(line)) continue
    if (isOptedOut(lines, i)) continue
    const table = nearestFromTable(lines, i)
    if (table && TELEMETRY_TABLES.has(table)) continue
    violations.push({
      file: file.replace(/\\/g, '/'),
      line: i + 1,
      table: table ?? '<unknown>',
      text: line.trim().slice(0, 140),
    })
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
  process.exit(1)
}

console.log('No coordinator-facing created_at filters found.')
