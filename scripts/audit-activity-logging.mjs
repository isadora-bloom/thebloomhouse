/**
 * Changes to a venue's or a couple's data that leave no trace in activity_log.
 *
 * A Rixey couple spent three days telling us her wedding party was missing from
 * her website. It was a section toggle. Nobody could see when it had been set,
 * by whom, or what it had been before, because saving the website wrote nothing
 * to the activity log. The answer came from reading code and guessing at a
 * history rather than looking it up.
 *
 * Bloom has a better logger than Rixey did — venue, wedding, entity, a JSON
 * details blob, plus a separate read-side audit — and almost nothing calls it.
 *
 * Scope is decided by the table, not the route: any handler that writes a table
 * carrying a venue_id or a wedding_id is in scope, whoever calls it. Deciding by
 * route prefix would excuse the admin side, and the venue editing on a couple's
 * behalf is exactly the case worth tracing. At Rixey it was an admin-side save
 * that finally moved the toggle nobody could account for.
 *
 * MACHINERY lists the tables that are bookkeeping rather than somebody's data,
 * each with its reason. Add to it rather than leaving a route looking like an
 * oversight.
 *
 *   node scripts/audit-activity-logging.mjs
 *   node scripts/audit-activity-logging.mjs --list
 *   node scripts/audit-activity-logging.mjs --area couple
 *   node scripts/audit-activity-logging.mjs --max 0
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = process.cwd()
const argv = process.argv.slice(2)
const LIST = argv.includes('--list')
const areaIdx = argv.indexOf('--area')
const AREA = areaIdx > -1 ? argv[areaIdx + 1] : null
const maxIdx = argv.indexOf('--max')
const MAX = maxIdx > -1 ? Number(argv[maxIdx + 1]) : null

// ---------------------------------------------------------------------------
// Which tables belong to somebody
// ---------------------------------------------------------------------------

const types = readFileSync(join(root, 'src/lib/supabase/types.generated.ts'), 'utf8')

/** Tables carrying a venue_id or wedding_id, from the generated types. */
function scopedTables() {
  const out = new Set()
  const re = /^ {6}([a-z0-9_]+): \{\n {8}Row: \{\n([\s\S]*?)\n {8}\}/gm
  for (const m of types.matchAll(re)) {
    if (/^\s+(venue_id|wedding_id):/m.test(m[2])) out.add(m[1])
  }
  return out
}

const SCOPED = scopedTables()

/**
 * Scoped tables that are still not somebody's data, and why. A line in a feed
 * saying "we processed an email" is noise; one saying a couple changed their
 * shuttle times is not.
 */
const MACHINERY = {
  activity_log: 'the feed itself',
  agency_activity_log: 'the agency feed, written by its own cron',
  api_costs: 'token accounting',
  ai_calls: 'token accounting',
  bulk_read_log: 'the read-side audit',
  channel_truth_audits: 'derived by the tracer',
  client_errors: 'crash telemetry',
  knot_visitor_activity: 'scraped visitor counts',
  processed_emails: 'ingestion bookkeeping',
  processed_quo_messages: 'ingestion bookkeeping',
  processed_zoom_meetings: 'ingestion bookkeeping',
  sheet_sync_log: 'sync bookkeeping',
  usage_logs: 'usage accounting',
  vendor_contact_evidence: 'derived by the tracer, not entered by anyone',
  webhook_events: 'raw inbound payloads',
}

/** Routes that are not a person changing anything. */
const NOT_A_CHANGE = [
  [/^auth\//, 'authentication'],
  [/^webhooks?\//, 'inbound webhook; the pipeline logs its own run'],
  [/^cron$/, 'the scheduler itself; each job logs its own run'],
  [/^stripe\//, 'billing webhooks and checkout sessions'],
  [/(^|\/)(health|ping|status)$/, 'liveness'],
  [/\/(read|mark-read|seen)$/, 'marking something read'],
]

// ---------------------------------------------------------------------------
// Walk the routes
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name === 'route.ts') out.push(full)
  }
  return out
}

const MUTATING_METHOD = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/
const MUTATES = /\.(insert|update|upsert|delete)\(/
const LOGS = /logActivity\(|logRow\(|logBurst\(|logCoupleWrite\(/

/**
 * Which tables a file writes.
 *
 * The mutation has to belong to the same chain as the `.from()`, so the scan
 * stops at the end of the statement. Scanning a fixed number of characters
 * instead paired a read on one table with the next statement's write to
 * another, which is how an earlier version of this audit put two routes on the
 * list for writes neither of them makes.
 */
/**
 * True when the file writes a table chosen at runtime, e.g. the configured
 * couple route's `.from(resource.table)`.
 *
 * Worth detecting rather than ignoring. A route like that is invisible to the
 * literal scan below, so without this it looks as though it writes nothing and
 * drops off the report entirely — which is exactly what happened to
 * /api/couple/[resource] the first time this ran. One that logs is fine. One
 * that does not is the worst case on the list, because it could be writing
 * anything the config allows.
 */
function writesDynamicTable(src) {
  const re = /\.from\(\s*([A-Za-z_$][\w$.]*)\s*\)/g
  for (const m of src.matchAll(re)) {
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400)
    if (MUTATES.test(after)) return m[1]
  }
  return null
}

function tablesWritten(src) {
  const out = new Set()
  const re = /\.from\(\s*['"`]([a-z0-9_]+)['"`]\s*\)/g
  for (const m of src.matchAll(re)) {
    // `storage.from('bucket')` is not a table.
    const before = src.slice(Math.max(0, m.index - 30), m.index)
    if (/storage\s*\.\s*$/.test(before)) continue
    const after = src.slice(m.index + m[0].length)
    let depth = 0
    let chain = ''
    for (let i = 0; i < after.length && i < 1500; i++) {
      const c = after[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth < 0) break
      } else if (c === ';' && depth === 0) break
      chain += c
    }
    if (MUTATES.test(chain)) out.add(m[1])
  }
  return [...out]
}

const routes = []
for (const file of walk(join(root, 'src/app/api'))) {
  const src = readFileSync(file, 'utf8')
  if (!MUTATING_METHOD.test(src)) continue
  const rel = relative(join(root, 'src/app/api'), file).split(sep).join('/').replace(/\/route\.ts$/, '')
  const written = tablesWritten(src).filter((t) => SCOPED.has(t) && !MACHINERY[t])
  const dynamic = writesDynamicTable(src)
  if (!written.length && !dynamic) continue
  const excuse = NOT_A_CHANGE.find(([re]) => re.test(rel))
  routes.push({
    path: rel,
    area: rel.split('/')[0],
    tables: written.length ? written : [`«${dynamic}» chosen at runtime`],
    logs: LOGS.test(src),
    excused: excuse ? excuse[1] : null,
  })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const inScope = routes.filter((r) => !r.excused)
const unlogged = inScope.filter((r) => !r.logs).filter((r) => !AREA || r.area === AREA)

const byArea = new Map()
for (const r of inScope) {
  if (!byArea.has(r.area)) byArea.set(r.area, { total: 0, unlogged: 0 })
  const a = byArea.get(r.area)
  a.total++
  if (!r.logs) a.unlogged++
}

console.log(`Scoped tables (venue_id or wedding_id): ${SCOPED.size}, of which ${Object.keys(MACHINERY).length} are machinery`)
console.log(`Mutating API routes that write one: ${inScope.length}`)
console.log(`Of those, routes that write no activity entry: ${inScope.filter((r) => !r.logs).length}\n`)

console.log('By area:')
for (const [area, a] of [...byArea].sort((x, y) => y[1].unlogged - x[1].unlogged)) {
  const bar = a.unlogged === 0 ? 'all logged' : `${a.unlogged} of ${a.total} unlogged`
  console.log(`  ${area.padEnd(14)} ${bar}`)
}

if (unlogged.length) {
  console.log(`\nUnlogged${AREA ? ` in ${AREA}` : ''}: ${unlogged.length}`)
  if (LIST) {
    for (const r of unlogged.sort((a, b) => a.path.localeCompare(b.path))) {
      console.log(`  ${r.path}`)
      console.log(`      ${r.tables.join(', ')}`)
    }
  } else {
    console.log('  Run with --list for the routes, or --area <name> to narrow.')
  }
  console.log(`
Fix shape, after the write has succeeded:

  logActivity({
    venueId: auth.venueId,
    weddingId: auth.weddingId,
    userId: auth.userId,
    activityType: 'wedding_details_updated',
    entityType: 'wedding_details',
    entityId: data?.id,
    details: { updatedFields: Object.keys(fields) },
  })

logActivity never throws, so it does not need guarding. For a couple-facing
write, prefer the configured route at /api/couple/[resource], which logs from
one place. For a table that is bookkeeping rather than somebody's data, add it
to MACHINERY in this file with its reason.`)
}

if (MAX !== null && unlogged.length > MAX) {
  console.error(`\nFAIL: ${unlogged.length} unlogged, over the ceiling of ${MAX}.`)
  process.exit(1)
}
