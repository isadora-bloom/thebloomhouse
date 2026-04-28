// For every couple-portal page, list the tables it reads via
// .from('table').select(...). Cross-reference against the writer
// classification from audit-table-writers.ts to flag pages whose
// reads are SEED_ONLY or ORPHAN — those will render empty for any
// brand-new venue.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

function walkDir(dir: string, ext: RegExp, out: string[] = []): string[] {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walkDir(p, ext, out)
    else if (ext.test(name)) out.push(p)
  }
  return out
}

function findReads(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const tables = new Set<string>()
  // .from('table') — capture the table name
  const re = /\.from\(['"`]([a-z_][a-z0-9_]*)['"`]\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) tables.add(m[1])
  return [...tables].sort()
}

// From the writer-audit run: 1 ORPHAN, 10 SEED_ONLY, 1 MIG_DML.
// Hard-code the lists here for the cross-reference.
const ORPHAN = new Set(['wedding_timeline'])
const SEED_ONLY = new Set([
  'booked_dates',
  'budget',
  'client_codes',
  'couple_budget',
  'follow_up_sequence_templates',
  'heat_score_config',
  'industry_benchmarks',
  'notifications',
  'seating_assignments',
  'wedding_sequences',
])
const MIG_DML = new Set(['rate_limits'])
const RENAMED_AWAY = new Set([
  'booked_dates', // → venue_availability (073)
  'wedding_timeline', // dropped (076)
  'follow_up_sequence_templates', // → _archived_* (040)
  'wedding_sequences', // → _archived_* (040)
])

async function main() {
  const couplePages = walkDir('src/app/_couple-pages', /\bpage\.tsx$/)
  console.log(`\nCouple-portal pages: ${couplePages.length}\n`)

  const allReadsByPage: Record<string, string[]> = {}
  const flagsByPage: Record<string, Array<{ table: string; reason: string }>> = {}

  for (const f of couplePages) {
    const tables = findReads(f)
    const path = relative(ROOT, f).replace(/\\/g, '/')
    allReadsByPage[path] = tables

    const flags: Array<{ table: string; reason: string }> = []
    for (const t of tables) {
      if (RENAMED_AWAY.has(t)) {
        flags.push({ table: t, reason: 'renamed/dropped — read will fail on fresh DB' })
      } else if (ORPHAN.has(t)) {
        flags.push({ table: t, reason: 'orphan (no writer anywhere)' })
      } else if (SEED_ONLY.has(t)) {
        flags.push({ table: t, reason: 'seed-only (empty for new venues unless seeded)' })
      } else if (MIG_DML.has(t)) {
        flags.push({ table: t, reason: 'populated by migration DML / RPC only' })
      }
    }
    if (flags.length > 0) flagsByPage[path] = flags
  }

  console.log('=== Pages with at-risk reads ===\n')
  if (Object.keys(flagsByPage).length === 0) {
    console.log('  (none)')
  } else {
    for (const [path, flags] of Object.entries(flagsByPage)) {
      console.log(`${path}:`)
      for (const { table, reason } of flags) {
        console.log(`  - ${table}: ${reason}`)
      }
    }
  }

  // Also check coordinator-portal and intel pages
  console.log('\n\n=== Coordinator (platform) pages with at-risk reads ===\n')
  const coordPages = [
    ...walkDir('src/app/(platform)/portal', /\bpage\.tsx$/),
    ...walkDir('src/app/(platform)/intel', /\bpage\.tsx$/),
    ...walkDir('src/app/(platform)/agent', /\bpage\.tsx$/),
    ...walkDir('src/app/(platform)/settings', /\bpage\.tsx$/),
  ]
  let hits = 0
  for (const f of coordPages) {
    const tables = findReads(f)
    const path = relative(ROOT, f).replace(/\\/g, '/')
    const flags: Array<{ table: string; reason: string }> = []
    for (const t of tables) {
      if (RENAMED_AWAY.has(t)) flags.push({ table: t, reason: 'renamed/dropped' })
      else if (ORPHAN.has(t)) flags.push({ table: t, reason: 'orphan' })
      else if (SEED_ONLY.has(t) && !['heat_score_config', 'industry_benchmarks', 'client_codes'].includes(t)) {
        flags.push({ table: t, reason: 'seed-only' })
      }
    }
    if (flags.length > 0) {
      hits++
      console.log(`${path}:`)
      for (const { table, reason } of flags) console.log(`  - ${table}: ${reason}`)
    }
  }
  if (hits === 0) console.log('  (none beyond expected reference data)')
}

main().catch((err) => { console.error(err); process.exit(1) })
