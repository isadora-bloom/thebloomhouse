// Mechanical writer-classification audit using Node fs only (no
// shell-out to ripgrep). For each CREATE TABLE in
// supabase/migrations/, find every writer (.insert / .upsert /
// .update / .delete on .from('table'), plus raw INSERT INTO/UPDATE in
// SQL files) across src/, supabase/functions/, supabase/migrations/,
// supabase/seed*.sql, scripts/.
//
// Classifies each table:
//   WIRED          — at least one writer in src/ or supabase/functions/
//   SEED_ONLY      — only seed file inserts
//   MIG_DML        — populated only by migration-internal DML / triggers
//   ORPHAN         — no writer anywhere
//
// Cites file:line for every writer.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

interface WriteRef {
  file: string
  line: number
  op: 'insert' | 'upsert' | 'update' | 'delete' | 'sql_insert' | 'sql_update'
}

const ROOT = process.cwd()

function listTables(): string[] {
  const dir = 'supabase/migrations'
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'))
  const tables = new Set<string>()
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8')
    const re = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gim
    let m: RegExpExecArray | null
    while ((m = re.exec(sql))) tables.add(m[1])
  }
  return [...tables].sort()
}

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

interface FileBlob { path: string; lines: string[] }

function loadFiles(dirs: string[], ext: RegExp): FileBlob[] {
  const blobs: FileBlob[] = []
  for (const d of dirs) {
    const files = walkDir(d, ext)
    for (const f of files) {
      try {
        const text = readFileSync(f, 'utf8')
        blobs.push({ path: relative(ROOT, f).replace(/\\/g, '/'), lines: text.split('\n') })
      } catch { /* ignore */ }
    }
  }
  return blobs
}

function findWriters(table: string, codeBlobs: FileBlob[], sqlBlobs: FileBlob[]): WriteRef[] {
  const refs: WriteRef[] = []

  // Code: search for `.from('TABLE')` and look for write op on same line OR
  // within next 6 lines (handles chained calls).
  const fromRe = new RegExp(`\\.from\\(['"\`]${escapeRe(table)}['"\`]\\)`)
  const opRe = /\.(insert|upsert|update|delete)\b/

  for (const b of codeBlobs) {
    for (let i = 0; i < b.lines.length; i++) {
      if (!fromRe.test(b.lines[i])) continue
      const window = b.lines.slice(i, Math.min(i + 8, b.lines.length)).join(' ')
      const m = window.match(opRe)
      if (!m) continue
      refs.push({ file: b.path, line: i + 1, op: m[1] as WriteRef['op'] })
    }
  }

  // SQL: INSERT INTO <table> / UPDATE <table> SET. Allow optional `public.`
  // prefix and arbitrary whitespace.
  const insRe = new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${escapeRe(table)}\\b`, 'i')
  const updRe = new RegExp(`UPDATE\\s+(?:public\\.)?${escapeRe(table)}\\s+SET\\b`, 'i')
  for (const b of sqlBlobs) {
    for (let i = 0; i < b.lines.length; i++) {
      if (insRe.test(b.lines[i])) refs.push({ file: b.path, line: i + 1, op: 'sql_insert' })
      else if (updRe.test(b.lines[i])) refs.push({ file: b.path, line: i + 1, op: 'sql_update' })
    }
  }
  return refs
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function classify(writers: WriteRef[]): string {
  const codeWriters = writers.filter(
    (w) => (w.file.startsWith('src/') || w.file.startsWith('supabase/functions/')) && w.op !== 'sql_insert' && w.op !== 'sql_update'
  )
  const seedWriters = writers.filter((w) => w.file.includes('/seed') && (w.op === 'sql_insert' || w.op === 'sql_update'))
  const migDmlWriters = writers.filter((w) => w.file.startsWith('supabase/migrations/') && (w.op === 'sql_insert' || w.op === 'sql_update'))

  if (codeWriters.length > 0) return 'WIRED'
  if (seedWriters.length > 0) return 'SEED_ONLY'
  if (migDmlWriters.length > 0) return 'MIG_DML'
  return 'ORPHAN'
}

async function main() {
  const tables = listTables()

  console.log('Loading code files…')
  const codeBlobs = loadFiles(['src', 'supabase/functions', 'scripts'], /\.(ts|tsx|js|mjs|cjs)$/)
  console.log(`  ${codeBlobs.length} code files`)
  console.log('Loading SQL files…')
  const sqlBlobs = loadFiles(['supabase'], /\.sql$/)
  console.log(`  ${sqlBlobs.length} SQL files`)

  const buckets: Record<string, string[]> = { WIRED: [], SEED_ONLY: [], MIG_DML: [], ORPHAN: [] }
  const detail: Record<string, WriteRef[]> = {}

  for (const t of tables) {
    const writers = findWriters(t, codeBlobs, sqlBlobs)
    detail[t] = writers
    buckets[classify(writers)].push(t)
  }

  console.log(`\nTables scanned: ${tables.length}\n`)
  console.log('=== SUMMARY ===')
  for (const [k, list] of Object.entries(buckets)) {
    console.log(`  ${k.padEnd(12)} ${list.length}`)
  }

  console.log('\n=== ORPHANS (no writer anywhere) ===')
  if (buckets.ORPHAN.length === 0) console.log('  (none)')
  for (const t of buckets.ORPHAN) console.log(`  ${t}`)

  console.log('\n=== SEED ONLY (no app writer; only seed inserts) ===')
  if (buckets.SEED_ONLY.length === 0) console.log('  (none)')
  for (const t of buckets.SEED_ONLY) {
    console.log(`  ${t}`)
    for (const w of detail[t].slice(0, 2)) {
      console.log(`    ${w.file}:${w.line} (${w.op})`)
    }
  }

  console.log('\n=== MIG_DML (populated only by migration DML / trigger) ===')
  if (buckets.MIG_DML.length === 0) console.log('  (none)')
  for (const t of buckets.MIG_DML) {
    console.log(`  ${t}`)
    for (const w of detail[t].slice(0, 2)) {
      console.log(`    ${w.file}:${w.line} (${w.op})`)
    }
  }

  console.log('\n=== WIRED (sample writer per table) ===')
  for (const t of buckets.WIRED) {
    const w = detail[t].find((x) => x.file.startsWith('src/')) ?? detail[t][0]
    console.log(`  ${t.padEnd(36)} ${w.file}:${w.line} (${w.op})`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
